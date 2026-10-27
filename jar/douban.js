/*
 * 豆瓣影视库 —— 独立版 JS Spider（替代 jar 内的 csp_DouDouGuard）
 * 目标：不依赖任何 jar，配置里 api 直接指向本文件即可。
 *
 * 数据源（2026-10 全量实测）：
 *   - 列表/筛选   m.douban.com/rexxar/api/v2/{movie,tv}/recommend
 *   - 详情        m.douban.com/rexxar/api/v2/{movie,tv}/{id}
 *
 * 为什么不再用 movie.douban.com/j/* ：
 *   j/new_search_subjects 对**出口 IP** 做风控，命中后固定返回
 *   {"msg":"检测到有异常请求从您的IP发出，请登录再试!","r":1}
 *   —— 加 Cookie(bid/ll)、换 Referer、加 X-Requested-With、改 UA 全部无效，
 *   因为判定在服务端按 IP 做。它在电视上表现为「有时能出、经常空」，
 *   比彻底挂掉更难用。rexxar 是豆瓣自家移动端页面在用的接口，
 *   不需要 cookie 也不需要签名，实测 42/42 次请求全部成功。
 *   j/* 仍保留为**兜底通道**（见 legacy*），rexxar 返回空时才试一次。
 *
 * rexxar 的 sort 语义（取自接口返回的 sorts 元数据，非猜测）：
 *   T=综合排序  U=近期热度  R=首映时间  S=高分优先
 *   ��意：sort=T 在**不带任何 tags** 时服务端只回 8 条，所以默认一律用 U。
 *
 * 网络说明：req() 底层走宿主 OkGoHelper.getDefaultClient()，与播放器同一套
 *           DNS 决议 / 连接池 / 双栈优选，不额外开连接。
 *
 * 版本：v2  改动请同步 bump 配置里的 ?v=N（否则客户端 7 天缓存不更新）
 */

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var HDR = {'User-Agent': UA, 'Referer': 'https://movie.douban.com/'};
var SITE = 'https://movie.douban.com';
var RX = 'https://m.douban.com/rexxar/api/v2';
var PAGE = 20;
var TTL = 15000;

/* ------------------------------------------------------------------ 基础 */

function enc(s) {
    try {
        return encodeURIComponent(String(s == null ? '' : s));
    } catch (e) {
        return '';
    }
}

// 豆瓣对同一 IP 有速率限制：短时间几十次请求后开始返回空 data。
// 这里做 60 秒的 URL 级缓存，翻页/来回切筛选时重复请求直接命中。
var CACHE = {};
var CACHE_MS = 60000;

function nowMs() {
    return new Date().getTime();
}

function httpText(url) {
    var hit = CACHE[url];
    if (hit && (nowMs() - hit.t) < CACHE_MS) return hit.c;
    var text = '';
    try {
        var r = req(url, {'headers': HDR, 'timeout': TTL});
        if (r) text = r.content || '';
    } catch (e) {
        text = '';
    }
    if (text) {
        // 只缓存成功响应，失败留给下一次重试；条目上限防止长期驻留累积
        var n = 0;
        for (var k in CACHE) {
            n++;
            if (n > 200) {
                CACHE = {};
                break;
            }
        }
        CACHE[url] = {'t': nowMs(), 'c': text};
    }
    return text;
}

function httpJson(url) {
    var s = httpText(url);
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch (e) {
        return null;
    }
}

// 豆瓣无评分时统一显示「评分：0」；有评分保留一位小数（7.0 不能变成 7）
function rateText(v) {
    if (v === null || v === undefined || v === '') return '0';
    var n = parseFloat(v);
    if (isNaN(n) || n <= 0) return '0';
    return n.toFixed(1);
}

function card(id, name, pic, rate) {
    return {
        'vod_id': String(id == null ? '' : id),
        'vod_name': String(name == null ? '' : name),
        'vod_pic': String(pic == null ? '' : pic),
        'vod_remarks': '评分：' + rateText(rate)
    };
}

/* --------------------------------------------------------- 列表源解析 */

// rexxar /recommend 的 items
// 坑 1：items 里会混进 type=chart 的「豆瓣榜单」条目（id 是 movie_comedy 这种
//       非数字串），点进去详情必然 404 ⇒ 一律丢弃，判据用「id 必须纯数字」。
// 坑 2：封面字段 movie/tv 两条线都统一用 pic.large，cover_url 常为 null。
function fromRecommend(j) {
    var out = [];
    if (!j) return out;
    var arr = j.items || [];
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        var id = String(it.id == null ? '' : it.id);
        if (!/^\d+$/.test(id)) continue;
        var cover = '';
        if (it.pic && it.pic.large) cover = it.pic.large;
        else if (it.pic && it.pic.normal) cover = it.pic.normal;
        else if (it.cover_url) cover = it.cover_url;
        var rate = (it.rating && it.rating.value) ? it.rating.value : 0;
        out.push(card(id, it.title, cover, rate));
    }
    return out;
}

function totalOf(j) {
    if (!j) return 0;
    var t = parseInt(j.total, 10);
    return isNaN(t) ? 0 : t;
}

/* ---------------------------------------------------- 兜底：j/* 老接口 */
// 仅在 rexxar 返回 0 条时调用一次。j/* 命中 IP 风控时返回的是
// {"msg":...,"r":1}，没有 data 字段，解析结果天然是空数组，不会再抛异常。

function legacySearch(kind, tag, sort, start) {
    var s = sort === 'R' ? 'time' : (sort === 'S' ? 'rank' : 'recommend');
    var url = SITE + '/j/search_subjects?type=' + (kind === 'tv' ? 'tv' : 'movie') +
        '&tag=' + enc(tag || '热门') + '&sort=' + s +
        '&page_limit=' + PAGE + '&page_start=' + start;
    var j = httpJson(url);
    var out = [];
    if (!j || !j.subjects) return out;
    for (var i = 0; i < j.subjects.length; i++) {
        var it = j.subjects[i];
        out.push(card(it.id, it.title, it.cover, it.rate));
    }
    return out;
}

function legacyNewSearch(tags, sort, start, countries) {
    var s = sort === 'R' ? 'T' : (sort === 'S' ? 'S' : 'U');
    var url = SITE + '/j/new_search_subjects?sort=' + s + '&range=0,10&tags=' + enc(tags) +
        '&start=' + start;
    if (countries) url += '&countries=' + enc(countries);
    var j = httpJson(url);
    var out = [];
    if (!j || !j.data) return out;
    for (var i = 0; i < j.data.length; i++) {
        var it = j.data[i];
        out.push(card(it.id, it.title, it.cover, it.rate));
    }
    return out;
}

function pack(list, pg, total) {
    var pagecount = total > 0 ? Math.ceil(total / PAGE) : 9999;
    if (pagecount < pg) pagecount = pg;
    return JSON.stringify({
        'list': list || [],
        'page': pg,
        'pagecount': pagecount,
        'limit': PAGE,
        'total': total > 0 ? total : 0
    });
}

/* ------------------------------------------------------------ 分类定义 */

var AREAS = ['华语', '欧美', '韩国', '日本', '中国大陆', '美国', '中国香港', '中国台湾',
    '英国', '法国', '德国', '意大利', '西班牙', '印度', '泰国', '俄罗斯', '加拿大', '澳大利亚'];

var MOVIE_GENRES = ['喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '冒险', '音乐',
    '历史', '奇幻', '恐怖', '战争', '传记', '歌舞', '武侠', '灾难'];

var TV_GENRES = ['喜剧', '爱情', '悬疑', '动画', '武侠', '古装', '家庭', '犯罪', '科幻', '恐怖',
    '历史', '战争', '动作', '冒险', '传记', '剧情', '奇幻', '惊悚'];

var SHOW_GENRES = ['真人秀', '脱口秀', '音乐', '歌舞'];

var PLATFORMS = ['腾讯视频', '爱奇艺', '优酷', '湖南卫视', 'Netflix', 'HBO', 'BBC', 'NHK', 'CBS', 'NBC', 'tvN'];

function opts(arr, head) {
    var out = [{'n': head, 'v': ''}];
    for (var i = 0; i < arr.length; i++) out.push({'n': arr[i], 'v': arr[i]});
    return out;
}

// 年代：豆瓣只认「具体年份」这种 tag，「2010年代 / 90年代」这类区间没有任何
// 可用参数（year、year_range 都被服务端忽略，tags 里写区间直接返回 0 条）。
function yearOpts() {
    var out = [{'n': '全部年代', 'v': ''}];
    var y = new Date().getFullYear();
    for (var i = 0; i < 16; i++) out.push({'n': String(y - i), 'v': String(y - i)});
    return out;
}

// 排序码 = rexxar 的 sort 元数据：T=综合 U=近期热度 R=首映时间 S=高分优先
// 默认给 U：sort=T 在不带 tags 时服务端只回 8 条，不能当默认档。
function sortOpts() {
    return [
        {'n': '近期热度', 'v': 'U'},
        {'n': '综合排序', 'v': 'T'},
        {'n': '首映时间', 'v': 'R'},
        {'n': '高分优先', 'v': 'S'}
    ];
}

var CLASSES = [
    {'type_id': 'hot_movie', 'type_name': '热播电影'},
    {'type_id': 'hot_tv', 'type_name': '热播剧集'},
    {'type_id': 'hot_show', 'type_name': '热播综艺'},
    {'type_id': 'filter_movie', 'type_name': '电影筛选'},
    {'type_id': 'filter_tv', 'type_name': '电视筛选'}
];

// 每个 filter key 在宿主里占**一行**，数组顺序就是从上到下的行序。
function buildFilters() {
    return {
        // 第 1 行 3 项：热门 / 最新 / 高分    第 2 行 5 项：全部 + 4 个地区
        'hot_movie': [
            {
                'key': 'sort', 'name': '排序', 'value': [
                    {'n': '热门电影', 'v': 'U'},
                    {'n': '最新电影', 'v': 'R'},
                    {'n': '豆瓣高分', 'v': 'S'}
                ]
            },
            {
                'key': 'area', 'name': '地区', 'value': [
                    {'n': '全部', 'v': ''},
                    {'n': '华语', 'v': '华语'},
                    {'n': '欧美', 'v': '欧美'},
                    {'n': '韩国', 'v': '韩国'},
                    {'n': '日本', 'v': '日本'}
                ]
            }
        ],
        // 一行 7 项。注意「欧美剧」在豆瓣的标签是「欧美」，写「欧美剧」会 0 条。
        'hot_tv': [
            {
                'key': 'cat', 'name': '类型', 'value': [
                    {'n': '综合', 'v': ''},
                    {'n': '国产剧', 'v': '国产剧'},
                    {'n': '欧美剧', 'v': '欧美'},
                    {'n': '日剧', 'v': '日剧'},
                    {'n': '韩剧', 'v': '韩剧'},
                    {'n': '动画', 'v': '动画'},
                    {'n': '纪录片', 'v': '纪录片'}
                ]
            }
        ],
        // 一行 3 项
        'hot_show': [
            {
                'key': 'area', 'name': '地区', 'value': [
                    {'n': '全部', 'v': ''},
                    {'n': '华语', 'v': '华语'},
                    {'n': '国外', 'v': '国外'}
                ]
            }
        ],
        'filter_movie': [
            {'key': 'genre', 'name': '类型', 'value': opts(MOVIE_GENRES, '全部类型')},
            {'key': 'area', 'name': '地区', 'value': opts(AREAS, '全部地区')},
            {'key': 'sort', 'name': '排序', 'value': sortOpts()},
            {'key': 'year', 'name': '年代', 'value': yearOpts()}
        ],
        'filter_tv': [
            {
                'key': 'type', 'name': '类型', 'value': [
                    {'n': '不限', 'v': ''},
                    {'n': '电视剧', 'v': '电视剧'},
                    {'n': '综艺', 'v': '综艺'}
                ]
            },
            {'key': 'genre', 'name': '电视剧形式', 'value': opts(TV_GENRES, '不限')},
            {'key': 'sgenre', 'name': '综艺形式', 'value': opts(SHOW_GENRES, '不限')},
            {'key': 'area', 'name': '地区', 'value': opts(AREAS, '全部地区')},
            {'key': 'sort', 'name': '排序', 'value': sortOpts()},
            {'key': 'year', 'name': '年代', 'value': yearOpts()},
            {'key': 'platform', 'name': '平台', 'value': opts(PLATFORMS, '全部')}
        ]
    };
}

/* -------------------------------------------------------------- home */

function home(filter) {
    try {
        return JSON.stringify({
            'class': CLASSES,
            'filters': buildFilters(),
            'list': []
        });
    } catch (e) {
        return JSON.stringify({'class': CLASSES, 'filters': {}, 'list': []});
    }
}

/* --------------------------------------------------------- rexxar 请求 */

function rxUrl(kind, tags, sort, start, count) {
    var q = '?refresh=0&start=' + start + '&count=' + (count || PAGE) + '&uncollect=false&sort=' + sort;
    if (tags) q += '&tags=' + enc(tags);
    return RX + '/' + kind + '/recommend' + q;
}

function rxList(kind, tags, sort, start) {
    var j = httpJson(rxUrl(kind, tags, sort, start));
    return {'list': fromRecommend(j), 'total': totalOf(j)};
}

// 统一入口：rexxar 空 → 老接口兜一次
function listWithFallback(kind, tags, sort, start, legacyTag) {
    var r = rxList(kind, tags, sort, start);
    if (r.list.length) return r;
    var lg = legacySearch(kind, legacyTag || tags, sort, start);
    return {'list': lg, 'total': 0};
}

/* ---------------------------------------------------------- category */

// 热播电影：行1 排序(U/R/S) × 行2 地区(空/华语/欧美/韩国/日本)
// 两个维度都是服务端 tags/sort 直出，没有本地过滤。
function hotMovie(extend, pg) {
    var sort = extend.sort || 'U';
    var area = extend.area || '';
    var start = (pg - 1) * PAGE;
    var tags = area; // rexxar 里地区就是 tags 的一项，不能再塞 countries
    var r = listWithFallback('movie', tags, sort, start,
        area ? ('电影,' + area) : '电影');
    return pack(r.list, pg, r.total);
}

// 热播剧集：一行 7 档，全部走 sort=U（豆瓣「最近热门剧集」）
function hotTv(extend, pg) {
    var cat = extend.cat || '';
    var start = (pg - 1) * PAGE;
    var r = listWithFallback('tv', cat, 'U', start, cat || '热门');
    return pack(r.list, pg, r.total);
}

// 热播综艺：一行 3 档。为什么「全部」要两路交错，见文件头部说明与
// v99r94 交付文档「综艺全部档为何合并」一节。
function hotShow(extend, pg) {
    var area = extend.area || '';
    var start = (pg - 1) * PAGE;
    if (area === '国外') {
        var r1 = listWithFallback('tv', '综艺,国外', 'R', start);
        return pack(r1.list, pg, r1.total);
    }
    if (area === '华语') {
        var r2 = listWithFallback('tv', '综艺,华语', 'U', start);
        return pack(r2.list, pg, r2.total);
    }
    // 全部：华语(U) 与 国外(R) 各取一侧 1:1 交错，凑满一页
    var ra = rxList('tv', '综艺,华语', 'U', start);
    var rb = rxList('tv', '综艺,国外', 'R', start);
    var a = ra.list;
    var b = rb.list;
    if (!a.length && !b.length) {
        return pack(listWithFallback('tv', '综艺', 'U', start, '综艺').list, pg, 0);
    }
    var out = [];
    var n = a.length > b.length ? a.length : b.length;
    for (var i = 0; i < n && out.length < PAGE; i++) {
        if (i < a.length) out.push(a[i]);
        if (i < b.length && out.length < PAGE) out.push(b[i]);
    }
    return pack(out, pg, ra.total > rb.total ? ra.total : rb.total);
}

// 电影筛选 / 电视筛选：所有条件都拼成 tags 的逗号项
// 实测有效组合：喜剧,华语 / 喜剧,2025 / 动画,日本,2024 / 悬疑,韩国 / 综艺,真人秀
// 平台名（腾讯视频/爱奇艺/Netflix…）作为 tag 也有效，且与类型能叠加。
function filterList(extend, pg, isTv) {
    var start = (pg - 1) * PAGE;
    var sort = extend.sort || 'U';
    var tags = [];
    var genre = extend.genre || '';
    var sgenre = extend.sgenre || '';
    var area = extend.area || '';
    var year = extend.year || '';
    var platform = extend.platform || '';

    var base = '电影';
    if (isTv) {
        var t = extend.type || '';
        base = t === '综艺' ? '综艺' : '电视剧';
        if (t === '综艺') {
            if (sgenre) tags.push(sgenre);
        } else if (genre) {
            tags.push(genre);
        }
        if (platform) tags.push(platform);
    } else if (genre) {
        tags.push(genre);
    }
    if (area) tags.push(area);
    // 年份只能作为 tags 的一项（year / year_range 参数被服务端忽略）
    if (year && /^\d{4}$/.test(year)) tags.push(year);

    // rexxar 只认「类型/地区/年代/平台」本身，不接受「电影」「电视剧」这种大类前缀
    // （大类由 movie|tv 两条接口区分）；而 j/new_search_subjects 恰恰必须带大类前缀。
    // 所以两套 tags 要分开拼，这是换接口时最容易踩的一个坑。
    // 唯一例外：「综艺」在 rexxar 里既是类型又是大类，必须保留，否则「综艺+真人秀」
    // 会退化成 tags=真人秀，把真人秀类的剧集也捞进来。
    var rxTags;
    if (isTv && base === '综艺') rxTags = ['综艺'].concat(tags).join(',');
    else rxTags = tags.join(',');
    // sort=T 在没有 tags 时服务端只回 8 条 ⇒ 强制退回 U
    var effSort = (!rxTags && sort === 'T') ? 'U' : sort;

    var r = rxList(isTv ? 'tv' : 'movie', rxTags, effSort, start);
    var list = r.list;
    var total = r.total;

    if (!list.length) {
        // 兜底一：老接口按 base+tags 再试一次
        var legacyTags = base + (tags.length ? ',' + tags.join(',') : '');
        list = legacyNewSearch(legacyTags, sort, start, '');
        // 兜底二：条件太窄真的没内容时，退到只有大类，避免白屏
        if (!list.length && tags.length) {
            list = legacyNewSearch(base, sort, start, '');
        }
        total = 0;
    }
    return pack(list, pg, total);
}

function category(tid, pg, filter, extend) {
    var p = parseInt(pg, 10);
    if (!p || p < 1) p = 1;
    extend = extend || {};
    try {
        if (tid === 'hot_movie') return hotMovie(extend, p);
        if (tid === 'hot_tv') return hotTv(extend, p);
        if (tid === 'hot_show') return hotShow(extend, p);
        if (tid === 'filter_movie') return filterList(extend, p, false);
        if (tid === 'filter_tv') return filterList(extend, p, true);
    } catch (e) {
        return pack([], p, 0);
    }
    return pack([], p, 0);
}

/* ------------------------------------------------------------- detail */

function joinNames(arr) {
    var out = [];
    if (!arr) return '';
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].name) out.push(arr[i].name);
    }
    return out.join(',');
}

function joinStr(arr) {
    return arr && arr.length ? arr.join(',') : '';
}

function detail(ids) {
    var empty = JSON.stringify({'list': []});
    var raw = String(ids == null ? '' : ids);
    if (!raw) return empty;
    var id = raw;
    if (id.indexOf('/') >= 0) {
        var m = id.match(/\/(\d+)/);
        id = m && m[1] ? m[1] : id;
    }
    if (!/^\d+$/.test(id)) return empty;

    var j = httpJson(RX + '/movie/' + id);
    if (!j || !j.title) j = httpJson(RX + '/tv/' + id);
    if (!j || !j.title) return empty;

    var rate = (j.rating && j.rating.value) ? j.rating.value : 0;
    var pic = (j.pic && j.pic.large) ? j.pic.large : (j.cover_url || '');
    var intro = j.intro || '';
    if (j.aka && j.aka.length) intro = intro + '\n\n又名：' + joinStr(j.aka);
    if (j.pubdate && j.pubdate.length) intro = intro + '\n上映：' + joinStr(j.pubdate);
    if (j.durations && j.durations.length) intro = intro + '\n片长：' + joinStr(j.durations);
    intro = intro + '\n\n（豆瓣影视库只提供索引，播放请用搜索找对应片源）';

    var vod = {
        'vod_id': id,
        'vod_name': j.title || '',
        'vod_pic': pic,
        'type_name': joinStr(j.genres),
        'vod_year': String(j.year || ''),
        'vod_area': joinStr(j.countries),
        'vod_lang': joinStr(j.languages),
        'vod_actor': joinNames(j.actors),
        'vod_director': joinNames(j.directors),
        'vod_remarks': '评分：' + rateText(rate),
        'vod_content': intro,
        'vod_play_from': '',
        'vod_play_url': '',
        // ★ 索引源自报身份：宿主 DetailActivity 见到 action=indexOnly 就知道
        //   「这个源只有影片资料、没有播放线路」，不会按坏死源自动切走。
        //   不认这个标记的宿主会原样忽略，行为与之前完全一致（向后兼容）。
        'action': 'indexOnly'
    };
    return JSON.stringify({'list': [vod]});
}

/* ------------------------------------------------------------- search */
// 站点 searchable=0，不参与聚合搜索；保留空实现以防被调用
function search(wd, quick, pg) {
    return JSON.stringify({'list': [], 'page': 1, 'pagecount': 0, 'limit': PAGE, 'total': 0});
}

function play(flag, id, flags) {
    return JSON.stringify({'parse': 0, 'playUrl': '', 'url': id});
}

var rule = {
    'title': '豆瓣影视库',
    'host': SITE,
    'url': '',
    'searchable': 0,
    'quickSearch': 0,
    'filterable': 1
};

export default {
    rule: rule,
    home: home,
    category: category,
    detail: detail,
    search: search,
    play: play
};
