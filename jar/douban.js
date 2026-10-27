/*
 * 豆瓣影视库 —— 独立版 JS Spider（替代 jar 内的 csp_DouDouGuard）
 * 目标：不依赖任何 jar，配置里 api 直接指向本文件即可。
 *
 * ============================ 数据源（v3 已修正） ============================
 * ★ v3 的关键改版：列表全部改回**网页版同源**接口，与 movie.douban.com/explore
 *   逐条一致。v2 用的 rexxar（App 端推荐流）是另一套内容池，和网页版对不上。
 *
 *   列表（网页版同源）  movie.douban.com/j/search_subjects
 *       type=movie|tv  tag=热门|华语|美剧|日本动画|综艺...  sort=recommend|time|rank
 *       —— 这正是网页版「选电影 / 选剧集」每个 tab 背后调的接口。
 *   详情（只用它）      m.douban.com/rexxar/api/v2/{movie,tv}/{id}
 *   兜底（App 端池）    m.douban.com/rexxar/api/v2/{movie,tv}/recommend
 *       只在 j/search 被风控、或该筛选组合确实没有内容时用一次。
 *
 * ============================== 参数速查（实测） ==============================
 *   j/search 的 sort 三档：recommend=热门  time=最新  rank=豆瓣高分
 *   ★ 地区 tag 可以与 sort 叠加：tag=华语&sort=rank → 华语高分（霸王别姬/无间道）
 *   ★ 剧集没有地区维度，只能按类型 tag；「动画」的真实 tag 是 **日本动画**
 *     （写「动画/动漫/番剧」全部 0 条，这是换源时最容易踩的坑）
 *   ★ 综艺：tv tag=综艺 三档都纯综艺，华语+国外混排，与网页版一致；
 *     地区（华语/国外）j/search 没有这个维度 → 只有 rexxar tags=综艺,华语|国外
 *
 * ================================ 风控（重要） ================================
 *   j/new_search_subjects（网页版的**组合筛选**接口）按出口 IP 风控，命中后固定返回
 *     {"msg":"检测到有异常请求从您的IP发出，请登录再试!","r":1}
 *   —— 加 Cookie(bid/ll)、换 Referer、加 X-Requested-With、改 UA 全部无效。
 *   所以：组合筛选（类型+地区+年代）只走 rexxar，不再碰它。
 *   j/search_subjects **不在风控名单**（60 次连续无间隔实测 60/60 成功），
 *   但为了不把 IP 打进去，这里做了三重保护：
 *     1) URL 级 60 秒缓存（翻页/来回切筛选不重复打）
 *     2) 命中风控响应 → 全局熔断 5 分钟，期间直接走 rexxar 兜底
 *     3) 单页一次请求，不做并发、不做失败重试风暴
 *
 * 网络说明：req() 底层走宿主 OkGoHelper.getDefaultClient()，与播放器同一套
 *           DNS 决议 / 连接池 / 双栈优选，不额外开连接。
 *
 * 版本：v3  改动请同步 bump 配置里的 ?v=N（否则客户端 7 天缓存不更新）
 */

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var HDR = {'User-Agent': UA, 'Referer': 'https://movie.douban.com/explore'};
var SITE = 'https://movie.douban.com';
var JSEARCH = SITE + '/j/search_subjects';
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

/* ============================================================== j/search */
// 网页版同源。返回 null = 请求失败/被风控（调用方走兜底）；
// 返回 [] = 请求成功但真的没有内容（调用方可以再兜一次或如实返回空）。

var BLOCK_UNTIL = 0;
var BLOCK_MS = 5 * 60 * 1000;

function jBlocked() {
    return nowMs() < BLOCK_UNTIL;
}

function jSearch(type, tag, sort, start) {
    if (jBlocked()) return null;
    var url = JSEARCH + '?type=' + enc(type) + '&tag=' + enc(tag || '热门') +
        '&sort=' + enc(sort || 'recommend') + '&page_limit=' + PAGE + '&page_start=' + start;
    var j = httpJson(url);
    if (!j) return null;
    // 风控响应：{"msg":"检测到有异常请求从您的IP发出，请登录再试!","r":1}
    if (j.r === 1 || j.msg) {
        BLOCK_UNTIL = nowMs() + BLOCK_MS;
        return null;
    }
    if (!j.subjects) return null;
    var out = [];
    for (var i = 0; i < j.subjects.length; i++) {
        var it = j.subjects[i];
        if (!it) continue;
        var id = String(it.id == null ? '' : it.id);
        if (!/^\d+$/.test(id)) continue;
        out.push(card(id, it.title, it.cover, it.rate));
    }
    return out;
}

/* ============================================================ rexxar 兜底 */
// rexxar 的 sort 语义（取自接口返回的 sorts 元数据，非猜测）：
//   T=综合排序  U=近期热度  R=首映时间  S=高分优先
//   注意 sort=T 在**不带任何 tags** 时服务端只回 8 条，所以默认一律用 U。

function rxUrl(kind, tags, sort, start) {
    var q = '?refresh=0&start=' + start + '&count=' + PAGE + '&uncollect=false&sort=' + sort;
    if (tags) q += '&tags=' + enc(tags);
    return RX + '/' + kind + '/recommend' + q;
}

// 坑 1：items 里会混进 type=chart 的「豆瓣榜单」条目（id 是 movie_comedy 这种
//       非数字串），点进去详情必然 404 ⇒ 一律丢弃，判据用「id 必须纯数字」。
// 坑 2：封面统一取 pic.large，cover_url 常为 null。
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

function rxList(kind, tags, sort, start) {
    var j = httpJson(rxUrl(kind, tags, sort, start));
    var t = j ? parseInt(j.total, 10) : 0;
    return {'list': fromRecommend(j), 'total': isNaN(t) ? 0 : t};
}

/* ==================================================== 语义映射 / 归一化 */

// 热播电影第一行三档 → j/search 的 sort。
// 兼容三种入参：本版的语义值、旧版的 U/R/S、以及万一传回中文名。
// （v2 就吃过一次亏：宿主缓存了旧的 filterSelect 值，一直按首映时间取，
//   界面上却看不出任何筛选生效的痕迹 —— 所以这里必须做兜底归一。）
function normMovieSort(v) {
    if (v === 'time' || v === 'R' || v === '首映时间' || v === '最新电影' || v === '最新') return 'time';
    if (v === 'rank' || v === 'S' || v === '高分优先' || v === '豆瓣高分') return 'rank';
    return 'recommend';
}

// 电影筛选里的排序档 → j/search sort
function normFilterSort(v) {
    if (v === 'R' || v === 'time') return 'time';
    if (v === 'S' || v === 'rank') return 'rank';
    return 'recommend'; // U / T / 空
}

// 同一档位在 rexxar 里的对应值
function rxSortOf(jsSort) {
    if (jsSort === 'time') return 'R';
    if (jsSort === 'rank') return 'S';
    return 'U';
}

// 热播剧集：TVBox 显示名 → j/search tag / rexxar tags
// 「欧美剧」在豆瓣：j/search 叫「美剧」，rexxar 叫「欧美」（写「欧美剧」返回 0 条）
// 「动画」在 j/search 只有「日本动画」有内容
var TV_TAG = {
    '': '热门', '综合': '热门', '国产剧': '国产剧', '欧美剧': '美剧',
    '日剧': '日剧', '韩剧': '韩剧', '动画': '日本动画', '纪录片': '纪录片'
};
var TV_RX = {
    '': '', '综合': '', '国产剧': '国产剧', '欧美剧': '欧美',
    '日剧': '日剧', '韩剧': '韩剧', '动画': '动画', '纪录片': '纪录片'
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
        // 第 1 行 3 项：热门 / 最新 / 高分    第 2 行 5 项：全部 + 4 个地区
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

/* ---------------------------------------------------------- category */

// 热播电影：行1 三档（热门/最新/高分）× 行2 地区（全部/华语/欧美/韩国/日本）
// j/search 里地区是 tag、三档是 sort，可以自由叠加 → 15 组全部与网页版同源。
function hotMovie(extend, pg) {
    var start = (pg - 1) * PAGE;
    var area = extend.area || '';
    var sort = normMovieSort(extend.sort);
    var list = jSearch('movie', area || '热门', sort, start);
    var rs = rxSortOf(sort);
    if (list === null) {
        // 风控熔断 / 网络失败 → App 池兜底，保证不白屏
        var r = rxList('movie', area, rs, start);
        return pack(r.list, pg, r.total);
    }
    if (!list.length) {
        // 真的空（例如某小地区 + 高分档）→ 再兜一次
        var r2 = rxList('movie', area, rs, start);
        if (r2.list.length) return pack(r2.list, pg, r2.total);
    }
    return pack(list, pg, 0);
}

// 热播剧集：一行 7 档，全部走 sort=recommend（网页版「最近热门剧集」）
function hotTv(extend, pg) {
    var start = (pg - 1) * PAGE;
    var cat = extend.cat || '';
    var tag = TV_TAG[cat] || '热门';
    var list = jSearch('tv', tag, 'recommend', start);
    var rxTags = TV_RX.hasOwnProperty(cat) ? TV_RX[cat] : '';
    if (list === null) {
        var r = rxList('tv', rxTags, 'U', start);
        return pack(r.list, pg, r.total);
    }
    if (!list.length) {
        var r2 = rxList('tv', rxTags, 'U', start);
        if (r2.list.length) return pack(r2.list, pg, r2.total);
    }
    return pack(list, pg, 0);
}

// 热播综艺：
//   「全部」= j/search tag=综艺（网页版同源，华语+国外天然混排，20 条纯综艺）
//   「华语 / 国外」= j/search 没有地区维度，只能 rexxar tags=综艺,华语|国外
//     （国外档用 sort=R：U 档会把《绝望写手》这种剧顶到前面，R 档全是真人秀）
function hotShow(extend, pg) {
    var start = (pg - 1) * PAGE;
    var area = extend.area || '';
    if (area === '国外') {
        var r1 = rxList('tv', '综艺,国外', 'R', start);
        if (r1.list.length) return pack(r1.list, pg, r1.total);
        return hotShowAll(start, pg);
    }
    if (area === '华语') {
        var r2 = rxList('tv', '综艺,华语', 'U', start);
        if (r2.list.length) return pack(r2.list, pg, r2.total);
        return hotShowAll(start, pg);
    }
    return hotShowAll(start, pg);
}

function hotShowAll(start, pg) {
    var list = jSearch('tv', '综艺', 'recommend', start);
    if (list === null || !list.length) {
        var r = rxList('tv', '综艺', 'U', start);
        if (r.list.length) return pack(r.list, pg, r.total);
        return pack(list || [], pg, 0);
    }
    return pack(list, pg, 0);
}

// 电影筛选 / 电视筛选：组合条件（类型+地区+年代+平台）只有 rexxar 能做
// —— 网页版的组合筛选走 j/new_search_subjects，按 IP 风控，放弃。
// 例外：电影筛选在「没选类型、没选年代」时退化成「地区 + 排序」两维，
// 这两种维度 j/search 完全支持，此时优先走 j/search，结果与网页版一致。
function filterList(extend, pg, isTv) {
    var start = (pg - 1) * PAGE;
    var sort = extend.sort || 'U';
    var genre = extend.genre || '';
    var sgenre = extend.sgenre || '';
    var area = extend.area || '';
    var year = extend.year || '';
    var platform = extend.platform || '';

    if (!isTv && !genre && !year) {
        var jsort = normFilterSort(sort);
        var list = jSearch('movie', area || '热门', jsort, start);
        if (list !== null) {
            if (list.length) return pack(list, pg, 0);
            var rr = rxList('movie', area, rxSortOf(jsort), start);
            if (rr.list.length) return pack(rr.list, pg, rr.total);
            return pack([], pg, 0);
        }
    }

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
