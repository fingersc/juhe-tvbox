/*
 * 豆瓣影视库 —— 独立版 JS Spider（替代 jar 内的 csp_DouDouGuard）
 * 目标：不依赖任何 jar，配置里 api 直接指向本文件即可。
 *
 * 数据源（全部实测可用，2026-10 验证）：
 *   - 热播电影        m.douban.com/rexxar/api/v2/subject_collection/movie_hot_gaia
 *   - 热播剧集/综艺    movie.douban.com/j/search_subjects、j/new_search_subjects
 *   - 筛选            j/new_search_subjects（genres / countries / tags）
 *   - 榜单            rexxar subject_collection/{movie_showing, movie_weekly_best, movie_top250, ...}
 *
 * 网络说明：req() 底层走宿主 OkGoHelper.getDefaultClient()，与播放器同一套
 *           DNS 决议 / 连接池 / 双栈优选，不额外开连接。
 *
 * 版本：v1  改动请同步 bump 配置里的 ?v=N（否则客户端 7 天缓存不更新）
 */

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var HDR = {'User-Agent': UA, 'Referer': 'https://movie.douban.com/'};
var SITE = 'https://movie.douban.com';
var RX = 'https://m.douban.com/rexxar/api/v2';
var PAGE = 20;
var TTL = 8000;

/* ------------------------------------------------------------------ 基础 */

function enc(s) {
    try {
        return encodeURIComponent(String(s == null ? '' : s));
    } catch (e) {
        return '';
    }
}

// 豆瓣对同一 IP 有速率限制：连续几十次请求后开始返回空 data。
// 这里做 60 秒的 URL 级缓存，翻页/切筛选时重复的请求直接命中，
// 既省流量也避开限流（尤其是「国外综艺」这种要合并多次请求的分类）。
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

/* ------------------------------------------------------- 三种列表源解析 */

// rexxar subject_collection
// 注意：movie_* 系列用 cover.url，tv_*/show_* 系列用的是 pic.large，两种都要认。
function fromCollection(j) {
    var out = [];
    if (!j) return out;
    var arr = j.subject_collection_items || [];
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        var cover = '';
        if (it.cover && it.cover.url) cover = it.cover.url;
        else if (it.pic && it.pic.large) cover = it.pic.large;
        else if (it.pic && it.pic.normal) cover = it.pic.normal;
        else if (it.cover_url) cover = it.cover_url;
        var rate = (it.rating && it.rating.value) ? it.rating.value : 0;
        out.push(card(it.id, it.title, cover, rate));
    }
    return out;
}

// j/search_subjects
function fromSearch(j) {
    var out = [];
    if (!j) return out;
    var arr = j.subjects || [];
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        out.push(card(it.id, it.title, it.cover, it.rate));
    }
    return out;
}

// j/new_search_subjects
function fromNewSearch(j) {
    var out = [];
    if (!j) return out;
    var arr = j.data || [];
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
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

// 年代：豆瓣 j/new_search_subjects 只认「具体年份」这种 tag，
// 「2010年代 / 90年代」这类区间没有任何可用参数（year、year_range 都被服务端忽略，
// tags 里写区间直接返回 0 条），所以这里只给年份，不做区间。
function yearOpts() {
    var out = [{'n': '全部年代', 'v': ''}];
    var y = new Date().getFullYear();
    for (var i = 0; i < 16; i++) out.push({'n': String(y - i), 'v': String(y - i)});
    return out;
}

function sortOpts(first) {
    return [
        {'n': first, 'v': 'U'},
        {'n': '首播时间', 'v': 'T'},
        {'n': '高分优先', 'v': 'S'}
    ];
}

var CLASSES = [
    {'type_id': 'hot_movie', 'type_name': '热播电影'},
    {'type_id': 'hot_tv', 'type_name': '热播剧集'},
    {'type_id': 'hot_show', 'type_name': '热播综艺'},
    {'type_id': 'filter_movie', 'type_name': '电影筛选'},
    {'type_id': 'filter_tv', 'type_name': '电视筛选'},
    {'type_id': 'rank_movie', 'type_name': '电影榜单'},
    {'type_id': 'rank_tv', 'type_name': '电视剧榜单'}
];

function buildFilters() {
    return {
        'hot_movie': [
            {
                'key': 'sort', 'name': '排序', 'value': [
                    {'n': '热度', 'v': 'recommend'},
                    {'n': '最新', 'v': 'time'},
                    {'n': '评分', 'v': 'rank'}
                ]
            },
            {'key': 'area', 'name': '地区', 'value': opts(AREAS.slice(0, 10), '全部')}
        ],
        'hot_tv': [
            {
                'key': 'cat', 'name': '分类', 'value': [
                    {'n': '综合', 'v': ''},
                    {'n': '国产剧', 'v': '国产剧'},
                    {'n': '欧美剧', 'v': '欧美剧'},
                    {'n': '日剧', 'v': '日剧'},
                    {'n': '韩剧', 'v': '韩剧'},
                    {'n': '动画', 'v': '动画'}
                ]
            }
        ],
        'hot_show': [
            {
                'key': 'cat', 'name': '分类', 'value': [
                    {'n': '综合', 'v': ''},
                    {'n': '国内', 'v': '国内'},
                    {'n': '国外', 'v': '国外'}
                ]
            }
        ],
        'filter_movie': [
            {'key': 'genre', 'name': '类型', 'value': opts(MOVIE_GENRES, '全部类型')},
            {'key': 'area', 'name': '地区', 'value': opts(AREAS, '全部地区')},
            {'key': 'sort', 'name': '排序', 'value': sortOpts('近期热度')},
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
            {'key': 'sort', 'name': '排序', 'value': sortOpts('近期热度')},
            {'key': 'year', 'name': '年代', 'value': yearOpts()},
            {'key': 'platform', 'name': '平台', 'value': opts(PLATFORMS, '全部')}
        ],
        'rank_movie': [
            {
                'key': 'rank', 'name': '榜单', 'value': [
                    {'n': '实时热门电影', 'v': 'realtime'},
                    {'n': '一周口碑电影榜', 'v': 'weekly'},
                    {'n': '豆瓣电影Top250', 'v': 'top250'}
                ]
            }
        ],
        'rank_tv': [
            {
                'key': 'rank', 'name': '榜单', 'value': [
                    {'n': '实时热门电视', 'v': 'hot'},
                    {'n': '华语口碑剧集榜', 'v': 'cndrama'},
                    {'n': '全球口碑剧集榜', 'v': 'globaldrama'},
                    {'n': '国内口碑综艺榜', 'v': 'cnshow'},
                    {'n': '国外口碑综艺榜', 'v': 'globalshow'}
                ]
            }
        ]
    };
}

/* ------------------------------------------------------------ 榜单映射 */

var COLLECTION = {
    // ★ 实测校正（已用用户截图逐条比对）：
    //   「一周口碑电影榜」= movie_weekly_best，10/10 命中
    //     （生日快乐/登峰传奇/害群之马/杯雪/逃出布迪秀/生化危机/一个夜晚…/野兽之心/万人之上/眩晕）
    //   「实时热门电影」= 用户截图里的那份榜单（生日快乐/空枪/泥面人/黑球/生化危机/你能看到一切/…）
    //     在豆瓣公开接口上找不到对应集合：movie_hot_gaia / movie_hot / movie_showing /
    //     movie_soon / j/search_subjects 各排序组合全部对不上，疑似客户端私有混排。
    //     退用 movie_showing（影院热映）—— 与同页第 1 条重名最多、语义最接近，
    //     且与 weekly_best 是两份不同数据（原先两者指向同一集合，两个 chip 内容一样）。
    'realtime': 'movie_showing',
    'weekly': 'movie_weekly_best',
    'top250': 'movie_top250',
    'hot': 'tv_hot',
    'cndrama': 'tv_chinese_best_weekly',
    'globaldrama': 'tv_global_best_weekly',
    'cnshow': 'show_chinese_best_weekly',
    'globalshow': 'show_global_best_weekly'
};

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

// 热播电影：未筛选时走 movie_hot_gaia（与原版逐条一致，303 条可翻页）；
// 一旦选了地区或换了排序，改用 search_subjects（它才支持 sort / tag）。
function hotMovie(extend, pg) {
    var sort = extend.sort || 'recommend';
    var area = extend.area || '';
    var start = (pg - 1) * PAGE;
    if (!area && sort === 'recommend') {
        var j = httpJson(RX + '/subject_collection/movie_hot_gaia/items?start=' + start + '&count=' + PAGE);
        return pack(fromCollection(j), pg, j && j.total ? j.total : 0);
    }
    var url = SITE + '/j/search_subjects?type=movie&tag=' + enc(area || '热门') +
        '&sort=' + enc(sort) + '&page_limit=' + PAGE + '&page_start=' + start;
    return pack(fromSearch(httpJson(url)), pg, 0);
}

function hotTv(extend, pg) {
    var cat = extend.cat || '热门';
    var start = (pg - 1) * PAGE;
    var url = SITE + '/j/search_subjects?type=tv&tag=' + enc(cat) +
        '&sort=recommend&page_limit=' + PAGE + '&page_start=' + start;
    return pack(fromSearch(httpJson(url)), pg, 0);
}

// 热播综艺：new_search_subjects 里 tags=综艺 单独用会被当默认列表，
// 必须带一个具体标签（年份或地区）才生效，这里按「今年」兜住。
function hotShow(extend, pg) {
    var cat = extend.cat || '';
    var start = (pg - 1) * PAGE;
    var year = new Date().getFullYear();
    var tags, list = [];
    if (cat === '国内') {
        tags = '综艺,中国大陆';
        var j = httpJson(SITE + '/j/new_search_subjects?sort=U&range=0,10&tags=' + enc(tags) +
            '&start=' + start);
        list = fromNewSearch(j);
    } else if (cat === '国外') {
        // 豆瓣没有「国外综艺」聚合标签，只能按地区逐个取再合并
        var areas = ['美国', '英国', '日本', '韩国'];
        for (var i = 0; i < areas.length; i++) {
            var jj = httpJson(SITE + '/j/new_search_subjects?sort=U&range=0,10&tags=' +
                enc('综艺,' + areas[i]) + '&start=' + start);
            var part = fromNewSearch(jj);
            for (var k = 0; k < part.length && k < 5; k++) list.push(part[k]);
        }
    } else {
        tags = '综艺,' + year;
        var j0 = httpJson(SITE + '/j/new_search_subjects?sort=U&range=0,10&tags=' + enc(tags) +
            '&start=' + start);
        list = fromNewSearch(j0);
    }
    return pack(list, pg, 0);
}

// 电影筛选 / 电视筛选：genres + countries + tags 组合
function filterList(extend, pg, isTv) {
    var start = (pg - 1) * PAGE;
    var sort = extend.sort || 'U';
    var tags = [];
    var genre = extend.genre || '';
    var sgenre = extend.sgenre || '';
    var area = extend.area || '';
    var year = extend.year || '';
    var platform = extend.platform || '';

    var base;
    if (isTv) {
        var t = extend.type || '电视剧';
        base = t;
        // 综艺和电视剧的「形式」是两套标签，选哪个用哪个
        if (t === '综艺') {
            // 实测：tags 只写「综艺」豆瓣会退化成默认列表（返回美剧），
            // 必须再带一个具体标签才认，这里用「今年」兜住，跨年自动跟随。
            tags.push(String(new Date().getFullYear()));
            if (sgenre) tags.push(sgenre);
        } else {
            if (genre) tags.push(genre);
        }
        if (platform) tags.push(platform);
    } else {
        base = '电影';
        if (genre) tags.push(genre);
    }

    var tagStr = base + (tags.length ? ',' + tags.join(',') : '');
    // 年份只能作为 tags 的一项（实测 tags=电影,喜剧,2025 有效），
    // 独立的 year / year_range 参数会被豆瓣直接忽略。
    if (year && /^\d{4}$/.test(year)) tagStr = tagStr + ',' + year;
    var url = SITE + '/j/new_search_subjects?sort=' + enc(sort) + '&range=0,10&tags=' + enc(tagStr) +
        '&start=' + start;
    // countries 是豆瓣选片页的独立参数，地区用它比塞进 tags 更准
    if (area) url += '&countries=' + enc(area);

    var list = fromNewSearch(httpJson(url));

    // 兜底：组合条件太窄返回空时，退一步只按大类取，保证不白屏
    if (!list.length && (tags.length || area)) {
        var url2 = SITE + '/j/new_search_subjects?sort=' + enc(sort) + '&range=0,10&tags=' +
            enc(base) + '&start=' + start;
        list = fromNewSearch(httpJson(url2));
    }
    return pack(list, pg, 0);
}

function rankList(extend, pg, isTv) {
    var key = extend.rank || (isTv ? 'hot' : 'realtime');
    var col = COLLECTION[key] || (isTv ? 'tv_hot' : 'movie_showing');
    var start = (pg - 1) * PAGE;
    var j = httpJson(RX + '/subject_collection/' + col + '/items?start=' + start + '&count=' + PAGE);
    return pack(fromCollection(j), pg, j && j.total ? j.total : 0);
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
        if (tid === 'rank_movie') return rankList(extend, p, false);
        if (tid === 'rank_tv') return rankList(extend, p, true);
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
