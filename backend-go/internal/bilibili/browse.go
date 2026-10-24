package bilibili

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 内容浏览域：分区榜、相关推荐、搜索、评论、合集/系列、收藏夹、追番。
//
// 对应 routes/stream/bilibili-{videos,comments,lists,favorites,bangumi}.routes.ts
// 的服务层部分。这一批全部是「转发 + 归一化」，没有解析状态，
// 因此只共享 Client / WBI / Browse 缓存三件东西。

// bvidPattern 与前端 `/^BV[0-9A-Za-z]{10}$/` 一致。
var bvidPattern = regexp.MustCompile(`^BV[0-9A-Za-z]{10}$`)

// htmlTagPattern 用于清理搜索标题里的 <em class="keyword"> 高亮。
var htmlTagPattern = regexp.MustCompile(`<[^>]+>`)

// 缓存 TTL，与各路由文件里的常量一一对应。
const (
	regionRankingTTL    = 5 * time.Minute
	searchResultTTL     = 2 * time.Minute
	commentAidTTL       = 10 * time.Minute
	customListTTL       = 5 * time.Minute
	tagChainCooldown    = 60 * time.Second
	searchPagesPerShard = 50
)

// searchOrderShards 是 B站 搜索的排序分片（空串 = 综合排序）。
//
// 单一排序最多翻 50 页（numResults 封顶 1000、numPages 封顶 50，接口硬限制），
// 超过 50 页后按排序维度分片继续。pubdate 刻意不参与——时间线跳变太突兀。
var searchOrderShards = []string{"", "click", "dm", "stow"}

// SearchMaxPages 是可翻的虚拟页上限（4 × 50）。
const SearchMaxPages = searchPagesPerShard * 4

// ErrVideoNotFound 表示视频不存在（路由层映射成 404）。
var ErrVideoNotFound = errors.New("视频不存在")

// RegionItem 是分区榜单条目（一起听「哔哩哔哩」页）。
type RegionItem struct {
	Bvid     string `json:"bvid"`
	Title    string `json:"title"`
	Pic      string `json:"pic"`
	Duration int    `json:"duration"`
	UpName   string `json:"upName"`
	Cid      int64  `json:"cid"`
	View     int64  `json:"view"`
	Danmaku  int64  `json:"danmaku"`
	Date     int64  `json:"date"`
}

// RelatedItem 是相关推荐条目（自动连播用，含 cid 可直接插播）。
type RelatedItem struct {
	Bvid     string `json:"bvid"`
	Cid      int64  `json:"cid"`
	Title    string `json:"title"`
	Pic      string `json:"pic"`
	UpName   string `json:"upName"`
	View     int64  `json:"view"`
	Danmaku  int64  `json:"danmaku"`
	Duration int    `json:"duration"`
}

// SearchItem 是搜索结果 / 标签结果条目（两者同构）。
type SearchItem struct {
	Bvid     string `json:"bvid"`
	Title    string `json:"title"`
	Pic      string `json:"pic"`
	UpName   string `json:"upName"`
	View     int64  `json:"view"`
	Danmaku  int64  `json:"danmaku"`
	Duration int    `json:"duration"`
	Tag      string `json:"tag"`
}

// ListItem 是合集 / 系列 / 收藏夹条目的统一载荷。
//
// 与 SearchItem 的差别只有最后一个字段：这里是收藏/发布时间（date），
// 搜索那边是标签（tag）。前端把它们都当 BilibiliVideoItem 的可选字段读。
type ListItem struct {
	Bvid     string `json:"bvid"`
	Title    string `json:"title"`
	Pic      string `json:"pic"`
	UpName   string `json:"upName"`
	View     int64  `json:"view"`
	Danmaku  int64  `json:"danmaku"`
	Duration int    `json:"duration"`
	Date     int64  `json:"date"`
}

// CommentItem 是主楼评论 / 楼中楼回复的归一化结构。
type CommentItem struct {
	Rpid       int64             `json:"rpid"`
	Mid        int64             `json:"mid"`
	Name       string            `json:"name"`
	Avatar     string            `json:"avatar"`
	Content    string            `json:"content"`
	Time       int64             `json:"time"`
	Like       int64             `json:"like"`
	ReplyCount int64             `json:"replyCount"`
	Emote      map[string]string `json:"emote"`
	Location   string            `json:"location"`
}

// BrowseCaches 是内容浏览域的短 TTL 缓存集合。
type BrowseCaches struct {
	region     *ttlCache[[]RegionItem]
	search     *ttlCache[searchCacheEntry]
	aid        *ttlCache[aidInfo]
	favList    *ttlCache[listCacheEntry]
	collection *ttlCache[listCacheEntry]

	// buvid 是评论接口的风控 Cookie（finger/spi 取一次，进程内复用）。
	buvidMu sync.Mutex
	buvid   string

	// tagChainBlockedUntil 是标签链路的冷却截止时间（毫秒时间戳）。
	tagChainMu           sync.Mutex
	tagChainBlockedUntil int64
}

type searchCacheEntry struct {
	Items []SearchItem
	Total *int64
}

type aidInfo struct {
	Aid   int64
	Reply int64
}

type listCacheEntry struct {
	Items []ListItem
	Total *int64
}

// NewBrowseCaches 构造浏览域缓存。
func NewBrowseCaches() *BrowseCaches {
	region := newTTLCache[[]RegionItem](regionRankingTTL)
	// 榜单最多 16 个分区（Node 侧 maxSize 16）。
	region.maxSize = 16
	return &BrowseCaches{
		region:     region,
		search:     newTTLCache[searchCacheEntry](searchResultTTL),
		aid:        newTTLCache[aidInfo](commentAidTTL),
		favList:    newTTLCache[listCacheEntry](customListTTL),
		collection: newTTLCache[listCacheEntry](customListTTL),
	}
}

// ---------------------------------------------------------------------------
// 分区榜单 / 相关推荐
// ---------------------------------------------------------------------------

// RegionRanking 取分区排行榜（rid=3 是音乐）。
//
// 旧接口 x/web-interface/dynamic/region 已被下线（-404），改用 ranking/v2；
// 它返回全量榜单，分页在本地切。缓存 5 分钟：同一分区短时间内内容不变，
// 切换分区与翻页都能即时返回。
func (s *Service) RegionRanking(ctx context.Context, rid int, cookie string) ([]RegionItem, error) {
	key := "rank:" + strconv.Itoa(rid)
	if cached, ok := s.Browse.region.Get(key); ok {
		return cached, nil
	}

	target := fmt.Sprintf("https://api.bilibili.com/x/web-interface/ranking/v2?rid=%d&type=all", rid)
	env, err := s.Client.Fetch(ctx, target, FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var payload struct {
		List []struct {
			Bvid     string `json:"bvid"`
			Title    string `json:"title"`
			Pic      string `json:"pic"`
			Duration int    `json:"duration"`
			Pubdate  int64  `json:"pubdate"`
			Cid      int64  `json:"cid"`
			Owner    struct {
				Name string `json:"name"`
			} `json:"owner"`
			Stat struct {
				View    int64 `json:"view"`
				Danmaku int64 `json:"danmaku"`
			} `json:"stat"`
		} `json:"list"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, err
	}

	items := make([]RegionItem, 0, len(payload.List))
	for _, a := range payload.List {
		items = append(items, RegionItem{
			Bvid:     a.Bvid,
			Title:    a.Title,
			Pic:      NormalizeImageURL(a.Pic),
			Duration: a.Duration,
			UpName:   a.Owner.Name,
			Cid:      a.Cid,
			View:     a.Stat.View,
			Danmaku:  a.Stat.Danmaku,
			Date:     a.Pubdate,
		})
	}
	// 空结果不缓存：多半是风控抖动，缓存住会让整页空 5 分钟。
	if len(items) > 0 {
		s.Browse.region.Set(key, items)
	}
	return items, nil
}

// RelatedVideos 取相关推荐（先 view 拿 aid，再打 archive/related）。
func (s *Service) RelatedVideos(ctx context.Context, bvid, cookie string) ([]RelatedItem, error) {
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/view?bvid="+encodeComponent(bvid),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var view struct {
		Aid int64 `json:"aid"`
	}
	if _, err := DecodeDataInto(env, &view); err != nil {
		return nil, err
	}
	if view.Aid == 0 {
		return nil, ErrVideoNotFound
	}

	relEnv, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/web-interface/archive/related?aid=%d", view.Aid),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	// related 的 data 是数组；DecodeDataInto 对数组同样适用。
	var raw []struct {
		Bvid     string `json:"bvid"`
		Cid      int64  `json:"cid"`
		Title    string `json:"title"`
		Pic      string `json:"pic"`
		Duration int    `json:"duration"`
		Owner    struct {
			Name string `json:"name"`
		} `json:"owner"`
		Stat struct {
			View    int64 `json:"view"`
			Danmaku int64 `json:"danmaku"`
		} `json:"stat"`
	}
	ok, err := DecodeDataInto(relEnv, &raw)
	if err != nil {
		return nil, err
	}
	items := make([]RelatedItem, 0, len(raw))
	if ok {
		for _, v := range raw {
			items = append(items, RelatedItem{
				Bvid:     v.Bvid,
				Cid:      v.Cid,
				Title:    v.Title,
				Pic:      NormalizeImageURL(v.Pic),
				UpName:   v.Owner.Name,
				View:     v.Stat.View,
				Danmaku:  v.Stat.Danmaku,
				Duration: v.Duration,
			})
		}
	}
	return items, nil
}

// ---------------------------------------------------------------------------
// 搜索（关键词 / 标签 / 混合）
// ---------------------------------------------------------------------------

// SearchMode 是搜索数据源模式。
type SearchMode string

const (
	// SearchByKeyword 是默认的关键词搜索。
	SearchByKeyword SearchMode = "search"
	// SearchByTag 是 B站 标签检索。
	SearchByTag SearchMode = "tag"
	// SearchByMixed 是关键词 + 标签合并去重。
	SearchByMixed SearchMode = "mixed"
)

// ParseSearchMode 复刻路由层的枚举兜底：非法值一律按 search。
func ParseSearchMode(raw string) SearchMode {
	switch SearchMode(raw) {
	case SearchByTag:
		return SearchByTag
	case SearchByMixed:
		return SearchByMixed
	}
	return SearchByKeyword
}

// Search 执行一次搜索，返回条目与总数（总数可能为 nil）。
//
// 三层降级与 Node 一致：标签链路失败 → 冷却 60s；tag 模式无标签结果 →
// 回退关键词搜索；mixed 模式把标签结果追加在搜索结果之后（按 bvid 去重）。
func (s *Service) Search(ctx context.Context, keyword, cookie string, page int, mode SearchMode) ([]SearchItem, *int64, error) {
	if mode == "" {
		mode = SearchByKeyword
	}
	cacheKey := fmt.Sprintf("%s|%s|%d", mode, keyword, page)
	if cached, ok := s.Browse.search.Get(cacheKey); ok {
		return cached.Items, cached.Total, nil
	}

	var tagItems []SearchItem
	if mode == SearchByTag || mode == SearchByMixed {
		if s.tagChainAvailable() {
			tagID, err := s.SearchTagID(ctx, keyword, cookie)
			if err == nil && tagID > 0 {
				tagItems, _, err = s.TagVideosPaged(ctx, tagID, cookie, page)
			}
			if err != nil {
				s.blockTagChain()
				log.Printf("[bilibili] tag 链路失败，回退关键词搜索: %v", err)
				tagItems = nil
			}
		}
	}

	if mode == SearchByTag {
		if len(tagItems) > 0 {
			// 标签接口不返回总数：前端按「页满即有下一页」估算。
			s.Browse.search.Set(cacheKey, searchCacheEntry{Items: tagItems})
			return tagItems, nil, nil
		}
		items, total, err := s.searchVideosPaged(ctx, keyword, cookie, page)
		if err != nil {
			return nil, nil, err
		}
		if len(items) > 0 {
			s.Browse.search.Set(cacheKey, searchCacheEntry{Items: items, Total: total})
		}
		return items, total, nil
	}

	items, total, err := s.searchVideosPaged(ctx, keyword, cookie, page)
	if err != nil {
		return nil, nil, err
	}

	if mode == SearchByMixed {
		seen := make(map[string]struct{}, len(items)+len(tagItems))
		merged := make([]SearchItem, 0, len(items)+len(tagItems))
		for _, v := range append(append([]SearchItem{}, items...), tagItems...) {
			if _, ok := seen[v.Bvid]; ok {
				continue
			}
			seen[v.Bvid] = struct{}{}
			merged = append(merged, v)
		}
		if len(merged) > 0 {
			s.Browse.search.Set(cacheKey, searchCacheEntry{Items: merged, Total: total})
		}
		return merged, total, nil
	}

	if len(items) > 0 {
		s.Browse.search.Set(cacheKey, searchCacheEntry{Items: items, Total: total})
	}
	return items, total, nil
}

func (s *Service) tagChainAvailable() bool {
	s.Browse.tagChainMu.Lock()
	defer s.Browse.tagChainMu.Unlock()
	return time.Now().UnixMilli() >= s.Browse.tagChainBlockedUntil
}

func (s *Service) blockTagChain() {
	s.Browse.tagChainMu.Lock()
	s.Browse.tagChainBlockedUntil = time.Now().Add(tagChainCooldown).UnixMilli()
	s.Browse.tagChainMu.Unlock()
}

// resolveSearchPage 把虚拟页映射成 (排序 order, 真实页码)。
func resolveSearchPage(page int) (string, int) {
	if page < 1 {
		page = 1
	}
	shardIdx := (page - 1) / searchPagesPerShard
	if shardIdx >= len(searchOrderShards) {
		shardIdx = len(searchOrderShards) - 1
	}
	realPage := page - shardIdx*searchPagesPerShard
	if realPage > searchPagesPerShard {
		realPage = searchPagesPerShard
	}
	if realPage < 1 {
		realPage = 1
	}
	return searchOrderShards[shardIdx], realPage
}

// searchVideosPaged 走 WBI 签名的 search/type 接口。
func (s *Service) searchVideosPaged(ctx context.Context, keyword, cookie string, page int) ([]SearchItem, *int64, error) {
	imgKey, subKey, err := s.WBI.Keys(ctx, cookie)
	if err != nil {
		return nil, nil, err
	}
	order, realPage := resolveSearchPage(page)
	params := NewParams().
		Set("keyword", keyword).
		Set("search_type", "video").
		Set("page", strconv.Itoa(realPage)).
		Set("page_size", "20")
	if order != "" {
		params.Set("order", order)
	}
	signed := SignParams(params, imgKey, subKey)

	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/wbi/search/type?"+signed.Encode(),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, nil, err
	}

	var payload struct {
		Result []struct {
			Bvid        string          `json:"bvid"`
			Title       string          `json:"title"`
			Pic         string          `json:"pic"`
			Play        int64           `json:"play"`
			VideoReview int64           `json:"video_review"`
			Duration    json.RawMessage `json:"duration"`
			Author      string          `json:"author"`
			Tag         string          `json:"tag"`
		} `json:"result"`
		NumResults *int64 `json:"numResults"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, nil, err
	}

	items := make([]SearchItem, 0, len(payload.Result))
	for _, item := range payload.Result {
		items = append(items, SearchItem{
			Bvid:     item.Bvid,
			Title:    cleanTitle(item.Title),
			Pic:      normalizeSearchPic(item.Pic),
			UpName:   item.Author,
			View:     item.Play,
			Danmaku:  item.VideoReview,
			Duration: parseSearchDuration(item.Duration),
			Tag:      item.Tag,
		})
	}
	return items, payload.NumResults, nil
}

// SearchTagID 按关键词找 B站 标签 id。
//
// 注意这条用的是**未签名**的 search/type（Node 侧就如此）；签名只加在
// 后面的 tag/videos 上。
func (s *Service) SearchTagID(ctx context.Context, keyword, cookie string) (int64, error) {
	imgKey, subKey, err := s.WBI.Keys(ctx, cookie)
	if err != nil {
		return 0, err
	}
	signed := SignParams(NewParams().
		Set("keyword", keyword).
		Set("search_type", "tag").
		Set("page", "1").
		Set("page_size", "20"), imgKey, subKey)
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/search/type?"+signed.Encode(),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return 0, err
	}
	var payload struct {
		Result []struct {
			TagID   json.RawMessage `json:"tag_id"`
			TagName string          `json:"tag_name"`
		} `json:"result"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return 0, err
	}

	var best int64
	for _, candidate := range payload.Result {
		id := rawNumber(candidate.TagID)
		if id <= 0 {
			continue
		}
		if candidate.TagName == keyword {
			return id, nil
		}
		if best == 0 {
			best = id
		}
	}
	if best == 0 {
		return 0, nil
	}
	return best, nil
}

// TagVideosPaged 拉标签下的视频（响应结构做过 vlist/videos/list 兼容）。
func (s *Service) TagVideosPaged(ctx context.Context, tagID int64, cookie string, page int) ([]SearchItem, *int64, error) {
	imgKey, subKey, err := s.WBI.Keys(ctx, cookie)
	if err != nil {
		return nil, nil, err
	}
	signed := SignParams(NewParams().
		Set("tag_id", strconv.FormatInt(tagID, 10)).
		Set("pn", strconv.Itoa(page)).
		Set("ps", "20"), imgKey, subKey)
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/tag/videos?"+signed.Encode(),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, nil, err
	}

	type rawTagVideo struct {
		Bvid   string `json:"bvid"`
		Title  string `json:"title"`
		Pic    string `json:"pic"`
		Author string `json:"author"`
		Owner  struct {
			Name string `json:"name"`
		} `json:"owner"`
		Duration    json.RawMessage `json:"duration"`
		Length      string          `json:"length"`
		Play        int64           `json:"play"`
		Danmaku     int64           `json:"danmaku"`
		VideoReview int64           `json:"video_review"`
		Stat        struct {
			View    int64 `json:"view"`
			Danmaku int64 `json:"danmaku"`
		} `json:"stat"`
	}
	var payload struct {
		Vlist  []rawTagVideo `json:"vlist"`
		Videos []rawTagVideo `json:"videos"`
		List   []rawTagVideo `json:"list"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, nil, err
	}

	raw := payload.Vlist
	if len(raw) == 0 {
		raw = payload.Videos
	}
	if len(raw) == 0 {
		raw = payload.List
	}

	items := make([]SearchItem, 0, len(raw))
	for _, v := range raw {
		if v.Bvid == "" {
			continue
		}
		duration := int(rawNumber(v.Duration))
		if duration == 0 && v.Length != "" {
			duration = parseDurationString(v.Length)
		}
		upName := v.Author
		if upName == "" {
			upName = v.Owner.Name
		}
		danmaku := v.VideoReview
		if danmaku == 0 {
			danmaku = v.Danmaku
		}
		if danmaku == 0 {
			danmaku = v.Stat.Danmaku
		}
		view := v.Play
		if view == 0 {
			view = v.Stat.View
		}
		items = append(items, SearchItem{
			Bvid:     v.Bvid,
			Title:    cleanTitle(v.Title),
			Pic:      normalizeSearchPic(v.Pic),
			UpName:   upName,
			View:     view,
			Danmaku:  danmaku,
			Duration: duration,
		})
	}
	// 标签接口不返回总数。
	return items, nil, nil
}

// cleanTitle 去掉搜索结果标题里的高亮标签。
func cleanTitle(title string) string {
	return htmlTagPattern.ReplaceAllString(title, "")
}

// normalizeSearchPic 只补协议相对地址；搜索接口给的就是完整 URL，
// 这里不能像 NormalizeImageURL 那样给裸路径补 https://（会把相对路径拼坏）。
func normalizeSearchPic(raw string) string {
	if strings.HasPrefix(raw, "//") {
		return "https:" + raw
	}
	return raw
}

// parseDurationString 把 "mm:ss" / "hh:mm:ss" 转秒。
func parseDurationString(raw string) int {
	parts := strings.Split(raw, ":")
	values := make([]int, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil {
			return 0
		}
		values = append(values, n)
	}
	switch len(values) {
	case 3:
		return values[0]*3600 + values[1]*60 + values[2]
	case 2:
		return values[0]*60 + values[1]
	}
	return 0
}

// parseSearchDuration 处理 "mm:ss" 字符串与「数字秒」两种形态。
func parseSearchDuration(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return 0
		}
		return parseDurationString(s)
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0
	}
	return int(n)
}

// rawNumber 把「数字或数字字符串」统一成 int64（字段形态随 B站 版本变化）。
func rawNumber(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return 0
		}
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return 0
		}
		return n
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0
	}
	return int64(n)
}

// ViewSummary 是「添加视频」弹窗用的视频摘要。
type ViewSummary struct {
	Bvid     string     `json:"bvid"`
	Title    string     `json:"title"`
	Pic      string     `json:"pic"`
	Duration int        `json:"duration"`
	UpName   string     `json:"upName"`
	Cid      int64      `json:"cid"`
	Pages    []ViewPage `json:"pages"`
}

// ViewPage 是摘要里的分集条目。
//
// 刻意不复用 VideoPage：那个结构带 duration，而 Node 的 /bilibili/view
// 只下发 page/part/cid——多出来的键会让前端的分集下拉显示冗余信息，
// 也会让两端的响应骨架对不上。
type ViewPage struct {
	Page int    `json:"page"`
	Part string `json:"part"`
	Cid  int64  `json:"cid"`
}

// VideoSummary 按 BV 号取视频摘要（添加视频弹窗「搜索」）。
//
// 这里刻意用**未签名**的 view 接口：它不受 WBI 密钥过期影响，
// 而且不需要 aid/stat 之外的字段。解析链仍然走 GetVideoInfo（WBI 优先）。
func (s *Service) VideoSummary(ctx context.Context, bvid, cookie string) (*ViewSummary, error) {
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/view?bvid="+encodeComponent(bvid),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var raw struct {
		Title    string `json:"title"`
		Pic      string `json:"pic"`
		Cid      int64  `json:"cid"`
		Duration int    `json:"duration"`
		Owner    struct {
			Name string `json:"name"`
		} `json:"owner"`
		Pages []struct {
			Page int    `json:"page"`
			Part string `json:"part"`
			Cid  int64  `json:"cid"`
		} `json:"pages"`
	}
	if _, err := DecodeDataInto(env, &raw); err != nil {
		return nil, err
	}
	summary := &ViewSummary{
		Bvid:     bvid,
		Title:    raw.Title,
		Pic:      NormalizeImageURL(raw.Pic),
		Duration: raw.Duration,
		UpName:   raw.Owner.Name,
		Cid:      raw.Cid,
		Pages:    make([]ViewPage, 0, len(raw.Pages)),
	}
	for _, p := range raw.Pages {
		summary.Pages = append(summary.Pages, ViewPage{Page: p.Page, Part: p.Part, Cid: p.Cid})
	}
	return summary, nil
}

// IsValidBvid 判断是否形如 BV 号（前端同款正则）。
func IsValidBvid(raw string) bool {
	return bvidPattern.MatchString(raw)
}
