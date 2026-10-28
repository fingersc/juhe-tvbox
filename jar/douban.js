/*
 * 豆瓣影视库 —— 独立版 JS Spider（替代 jar 内的 csp_DouDouGuard）
 * 目标：不依赖任何 jar，配置里 api 直接指向本文件即可。
 *
 * ============================ 数据源（v4 已修正） ============================
 * ★ 前两版都栽在「接口选错」上，这里把结论钉死，别再改回去：
 *
 *   网页版 movie.douban.com/explore 的每个 tab，背后只有一个接口：
 *
 *     GET m.douban.com/rexxar/api/v2/subject/recent_hot/{movie|tv}
 *         ?start=&limit=&category=&type=
 *
 *     category  电影：热门 | 最新 | 豆瓣高分 | 冷门佳片
 *               剧集：tv      综艺：show
 *     type      电影：全部 | 华语 | 欧美 | 韩国 | 日本
 *               剧集：tv | tv_domestic | tv_american | tv_japanese
 *                     | tv_korean | tv_animation | tv_documentary
 *               综艺：show | show_domestic | show_foreign
 *
 *   ★★ 这个接口是「网页池」= 热度与新增**混合**排序。
 *      j/search_subjects?sort=time（v3 用的）是另一个池子「纯新增」，
 *      缺热播片、顺序也不同 —— 这就是用户看到的「和网页版对不上」。
 *      j/search 的 sort=recommend 出来的也不是网页「热门电影」（那是 App 池）。
 *      ⇒ j/search_subjects 全部弃用，一行都不留。
 *
 *   详情（只用它）      m.douban.com/rexxar/api/v2/{movie,tv}/{id}
 *   组合筛选（选电影/选电视剧页）m.douban.com/rexxar/api/v2/{movie,tv}/recommend
 *
 * ============================== 参数速查（实测） ==============================
 *   ★ limit 实测可取到 100；首页 start=0，翻页 start += limit，越界返回空数组。
 *   ★ 返回体自带 tags 元数据（每个 tab 的 title/category/types），
 *     分栏和地区枚举就是照着它抄的，服务端加了新档位也能一眼看出来。
 *   ★ 电影「冷门佳片 + 韩国」只有 4 条 —— 是服务端真的只有这么多，不是 bug。
 *
 * ================================ 重要取舍 ================================
 *   失败（网络/风控/结构变更）时**不做跨池兜底**，直接返回空列表。
 *   理由：跨池兜底的后果是「列表看着有内容、但和网页版对不上」，
 *        这正是本次要修的 bug。宁可空，不可错。
 *   每个 URL 仍然有 60 秒缓存 + 一次重试，防抖不靠兜底。
 *
 * 网络说明：req() 底层走宿主 OkGoHelper.getDefaultClient()，与播放器同一套
 *           DNS 决议 / 连接池 / 双栈优选，不额外开连接。
 *
 * 版本：v4  改动请同步 bump 配置里的 ?v=N（否则客户端 7 天缓存不更新）
 */

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var HDR = {'User-Agent': UA, 'Referer': 'https://movie.douban.com/explore'};
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

function nowMs() {
    return new Date().getTime();
}

// 60 秒 URL 级缓存：翻页、来回切筛选、以及宿主翻屏重排都会重复请求同一页
var CACHE = {};
var CACHE_MS = 60000;

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
    // 只缓存成功响应，失败留给下一次重试；条目上限防止长期驻留累积
    if (text) {
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

function rateText(v) {
    if (v === null || v === undefined || v === '') return '暂无评分';
    var n = parseFloat(v);
    if (isNaN(n) || n <= 0) return '暂无评分';
    return '评分：' + n.toFixed(1);
}

function card(id, name, pic, rate) {
    return {
        'vod_id': String(id == null ? '' : id),
        'vod_name': String(name == null ? '' : name),
        'vod_pic': String(pic == null ? '' : pic),
        'vod_remarks': rateText(rate)
    };
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

/* =========================================================== 响应归一化 */
// 坑 1：items 里会混进 type=chart 的「豆瓣榜单」条目（id 是 movie_comedy 这种
//       非数字串），点进去详情必然 404 ⇒ 一律丢弃，判据用「id 必须纯数字」。
// 坑 2：封面统一取 pic.large，cover_url 常为 null。
function fromItems(j) {
    var out = [];
    if (!j || !j.items) return out;
    var arr = j.items;
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (!it) continue;
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

/* ========================================================== recent_hot */
// 网页版 explore 每个 tab 背后的唯一接口。order 与网页版**逐条同序**。
function recentHot(seg, category, type, start) {
    var url = RX + '/subject/recent_hot/' + seg +
        '?start=' + start + '&limit=' + PAGE +
        '&category=' + enc(category) + '&type=' + enc(type);
    var j = httpJson(url);
    if (!j) j = httpJson(url);          // 缓存未命中才会真打，这里最多多一次
    var total = j ? parseInt(j.total, 10) : 0;
    return {'list': fromItems(j), 'total': isNaN(total) ? 0 : total};
}

/* ========================================================== 组合筛选池 */
// 「选电影 / 选电视剧」页（explore-all）背后是 recommend，支持 tags 组合、
// sort、评分区间。和上面的 recent_hot 是两个接口，各司其职。
// rexxar 的 sort 语义（取自接口返回的 sorts 元数据，非猜测）：
//   T=综合排序  U=近期热度  R=首映时间  S=高分优先
//   注意 sort=T 在**不带任何 tags** 时服务端只回 8 条，所以默认一律用 U。
function rxList(kind, tags, sort, start) {
    var q = '?refresh=0&start=' + start + '&count=' + PAGE + '&uncollect=false&sort=' + sort;
    if (tags) q += '&tags=' + enc(tags);
    var j = httpJson(RX + '/' + kind + '/recommend' + q);
    var t = j ? parseInt(j.total, 10) : 0;
    return {'list': fromItems(j), 'total': isNaN(t) ? 0 : t};
}

/* ==================================================== 语义映射 / 归一化 */

// 电影分栏：filter 值 → recent_hot 的 category 中文值。
// 兼容三种入参：本版语义值、旧版的 recommend/time/rank、以及中文名。
// （v2/v3 都吃过亏：宿主会缓存旧的 filterSelect，界面上看不出筛选生效痕迹。
//   所以这里必须做兜底归一，不能只认一种写法。）
function normMovieCat(v) {
    if (v === 'time' || v === 'R' || v === '最新' || v === '最新电影') return '最新';
    if (v === 'rank' || v === 'S' || v === '豆瓣高分') return '豆瓣高分';
    return '热门';
}

// 电影地区：网页版 explore 的五个地区就是 recent_hot 的 type 原值
var MOVIE_AREA = {
    '': '全部', '全部': '全部', '华语': '华语', '欧美': '欧美', '韩国': '韩国', '日本': '日本'
};

// 剧集类型：显示名 → type 代码（取自接口返回的 tags 元数据）
var TV_CODE = {
    '': 'tv', '综合': 'tv', '国产剧': 'tv_domestic', '欧美剧': 'tv_american',
    '日剧': 'tv_japanese', '韩剧': 'tv_korean', '动画': 'tv_animation', '纪录片': 'tv_documentary'
};

// 综艺地区：显示名 → type 代码（网页版写的是「国内 / 国外」，不是「华语」）
var SHOW_CODE = {
    '': 'show', '综合': 'show', '全部': 'show',
    '国内': 'show_domestic', '华语': 'show_domestic', '国外': 'show_foreign'
};

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
        // 第 1 行：三个 tab（网页版有「冷门佳片」，按需求不要）
        // 第 2 行：网页版 explore 的五个地区
        'hot_movie': [
            {
                'key': 'sort', 'name': '排序', 'value': [
                    {'n': '热门电影', 'v': 'recommend'},
                    {'n': '最新电影', 'v': 'time'},
                    {'n': '豆瓣高分', 'v': 'rank'}
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
        // 剧集：网页版只有「最近热门剧集」，地区维度是剧种
        'hot_tv': [
            {
                'key': 'cat', 'name': '类型', 'value': [
                    {'n': '综合', 'v': ''},
                    {'n': '国产剧', 'v': '国产剧'},
                    {'n': '欧美剧', 'v': '欧美剧'},
                    {'n': '日剧', 'v': '日剧'},
                    {'n': '韩剧', 'v': '韩剧'},
                    {'n': '动画', 'v': '动画'},
                    {'n': '纪录片', 'v': '纪录片'}
                ]
            }
        ],
        // 综艺：网页版「最近热门综艺」的地区是 国内 / 国外
        'hot_show': [
            {
                'key': 'area', 'name': '地区', 'value': [
                    {'n': '全部', 'v': ''},
                    {'n': '国内', 'v': '国内'},
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

/* ---------------------------------------------------------- category */

// 热播电影：4 个 tab × 5 个地区 = 20 组，全部与网页版 explore 同源同序。
function hotMovie(extend, pg) {
    var start = (pg - 1) * PAGE;
    var cat = normMovieCat(extend.sort);
    var type = MOVIE_AREA.hasOwnProperty(extend.area) ? MOVIE_AREA[extend.area] : '全部';
    var r = recentHot('movie', cat, type, start);
    return pack(r.list, pg, r.total);
}

// 热播剧集：category=tv，type 是剧种代码
function hotTv(extend, pg) {
    var start = (pg - 1) * PAGE;
    var cat = extend.cat || '';
    var type = TV_CODE.hasOwnProperty(cat) ? TV_CODE[cat] : 'tv';
    var r = recentHot('tv', 'tv', type, start);
    return pack(r.list, pg, r.total);
}

// 热播综艺：category=show，type 是 国内/国外 代码
function hotShow(extend, pg) {
    var start = (pg - 1) * PAGE;
    var area = extend.area || '';
    var type = SHOW_CODE.hasOwnProperty(area) ? SHOW_CODE[area] : 'show';
    var r = recentHot('tv', 'show', type, start);
    return pack(r.list, pg, r.total);
}

// 电影筛选 / 电视筛选：组合条件（类型+地区+年代+平台）只有 rexxar recommend 能做，
// 与网页版「选电影」页（explore-all）同源。
// 注意：这里**不能**退化成 recent_hot —— 它的 category 只有四档，表达不了
//      「类型 + 年代 + 平台」的任意组合；也不能退化成 j/search（不同池子）。
function filterList(extend, pg, isTv) {
    var start = (pg - 1) * PAGE;
    var sort = extend.sort || 'U';
    var genre = extend.genre || '';
    var sgenre = extend.sgenre || '';
    var area = extend.area || '';
    var year = extend.year || '';
    var platform = extend.platform || '';

    var tags = [];
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

    // 「综艺」在 rexxar 里既是类型又是大类，必须保留，否则「综艺+真人秀」
    // 会退化成 tags=真人秀，把真人秀类的剧集也捞进来。
    var rxTags = (isTv && base === '综艺') ? ['综艺'].concat(tags).join(',') : tags.join(',');
    // sort=T 在没有 tags 时服务端只回 8 条 ⇒ 强制退回 U
    var effSort = (!rxTags && sort === 'T') ? 'U' : sort;

    var r = rxList(isTv ? 'tv' : 'movie', rxTags, effSort, start);
    return pack(r.list, pg, r.total);
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
        'vod_remarks': rateText(rate),
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
