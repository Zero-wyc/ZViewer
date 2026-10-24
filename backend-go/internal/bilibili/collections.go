package bilibili

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// 自定义栏目：合集 / 系列 / 收藏夹链接解析与分页。
//
// 对应 bilibili-lists.routes.ts。链接形式（space.bilibili.com）：
//
//	合集    /{mid}/lists/{sid}（新版）· /{mid}/channel/collectiondetail?sid={sid}
//	系列    /{mid}/lists/{sid}（新版）· /{mid}/channel/seriesdetail?sid={sid}
//	收藏夹  /{mid}/favlist?fid={fid}
//
// /lists/{sid} 本身分不出类型：合集(season)与系列(series)是两个独立命名空间。
// 判据是 seasons_archives_list 返回的 meta.mid 与链接 mid 是否一致——
// 一致才是合集，不一致说明这个数字恰好是别的 UP 的合集 id，只能按系列查。

// LinkKind 是自定义栏目的类型。
type LinkKind string

const (
	// LinkSeason 是合集。
	LinkSeason LinkKind = "season"
	// LinkSeries 是系列。
	LinkSeries LinkKind = "series"
	// LinkFavlist 是收藏夹。
	LinkFavlist LinkKind = "favlist"
)

var (
	// ErrInvalidLink 表示短链展开失败（路由层回 400「链接无效」）。
	ErrInvalidLink = errors.New("链接无效")
	// ErrUnsupportedLink 表示链接不是合集/系列/收藏夹页面。
	ErrUnsupportedLink = errors.New("无法识别的链接")

	spaceLinkPattern = regexp.MustCompile(`^/(\d+)/(favlist|lists(?:/[^/]+)?|channel/(?:collectiondetail|seriesdetail))/?$`)
	listsSidPattern  = regexp.MustCompile(`^/\d+/lists/(\d+)`)
)

// LinkMeta 是栏目链接的元信息。
type LinkMeta struct {
	Kind   LinkKind
	Mid    int64
	ListID int64
	Title  string
	Total  *int64
}

// ParseSpaceLink 解析 B站 空间链接 → 类型 + mid + 列表 id。
func ParseSpaceLink(raw string) (*LinkMeta, bool) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, false
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "bilibili.com" && !strings.HasSuffix(host, ".bilibili.com") {
		return nil, false
	}
	m := spaceLinkPattern.FindStringSubmatch(parsed.Path)
	if len(m) != 3 {
		return nil, false
	}
	mid, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || mid <= 0 {
		return nil, false
	}

	seg := m[2]
	if seg == "favlist" {
		fid, err := strconv.ParseInt(strings.TrimSpace(parsed.Query().Get("fid")), 10, 64)
		if err != nil || fid <= 0 {
			return nil, false
		}
		return &LinkMeta{Kind: LinkFavlist, Mid: mid, ListID: fid}, true
	}

	rawSid := parsed.Query().Get("sid")
	if rawSid == "" {
		if sm := listsSidPattern.FindStringSubmatch(parsed.Path); len(sm) == 2 {
			rawSid = sm[1]
		}
	}
	sid, err := strconv.ParseInt(strings.TrimSpace(rawSid), 10, 64)
	if err != nil || sid <= 0 {
		return nil, false
	}
	switch {
	case strings.HasPrefix(seg, "channel/collectiondetail"):
		return &LinkMeta{Kind: LinkSeason, Mid: mid, ListID: sid}, true
	case strings.HasPrefix(seg, "channel/seriesdetail"):
		return &LinkMeta{Kind: LinkSeries, Mid: mid, ListID: sid}, true
	}
	// /lists/{sid}：类型未知，先按合集试，失败再按系列（见 LinkMetaOf）。
	return &LinkMeta{Kind: LinkSeason, Mid: mid, ListID: sid}, true
}

// ExpandShortLink 展开 b23.tv 短链；非短链原样返回。
func (s *Service) ExpandShortLink(ctx context.Context, raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", ErrInvalidLink
	}
	// Node 的 `new URL(raw)` 对相对串/空串直接抛错 → 400「链接无效」。
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", ErrInvalidLink
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "b23.tv" && !strings.HasSuffix(host, ".b23.tv") {
		return raw, nil
	}

	resp, _, err := s.rawGet(ctx, raw, "")
	if err != nil {
		return "", err
	}
	final := resp.Request.URL.String()
	finalParsed, err := url.Parse(final)
	if err != nil {
		return "", ErrInvalidLink
	}
	finalHost := strings.ToLower(finalParsed.Hostname())
	if finalHost == "b23.tv" || strings.HasSuffix(finalHost, ".b23.tv") {
		return "", ErrInvalidLink
	}
	return final, nil
}

// LinkMetaOf 解析栏目链接，必要时向 B站 校验类型与标题。
func (s *Service) LinkMetaOf(ctx context.Context, raw, cookie string) (*LinkMeta, error) {
	expanded, err := s.ExpandShortLink(ctx, raw)
	if err != nil {
		return nil, ErrInvalidLink
	}
	meta, ok := ParseSpaceLink(expanded)
	if !ok {
		return nil, ErrUnsupportedLink
	}

	if meta.Kind == LinkFavlist {
		env, fetchErr := s.Client.Fetch(ctx,
			fmt.Sprintf("https://api.bilibili.com/x/v3/fav/resource/list?media_id=%d&pn=1&ps=1&keyword=&type=0&tid=0&platform=web", meta.ListID),
			FetchOptions{Cookie: cookie})
		if fetchErr != nil {
			return nil, fetchErr
		}
		var payload struct {
			Info *struct {
				Title      string `json:"title"`
				Total      *int64 `json:"total"`
				MediaCount *int64 `json:"media_count"`
			} `json:"info"`
		}
		if _, decodeErr := DecodeDataInto(env, &payload); decodeErr != nil {
			return nil, decodeErr
		}
		if payload.Info != nil {
			meta.Title = payload.Info.Title
			meta.Total = firstInt(payload.Info.Total, payload.Info.MediaCount)
		}
		return meta, nil
	}

	// 合集优先：meta.mid 与链接 mid 不一致就按系列再查。
	seasonEnv, seasonErr := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=%d&season_id=%d&page_num=1&page_size=1", meta.Mid, meta.ListID),
		FetchOptions{Cookie: cookie})
	if seasonErr == nil {
		var season struct {
			Meta *struct {
				Mid   int64  `json:"mid"`
				Name  string `json:"name"`
				Title string `json:"title"`
				Total *int64 `json:"total"`
			} `json:"meta"`
			Page *struct {
				Total *int64 `json:"total"`
			} `json:"page"`
		}
		if _, decodeErr := DecodeDataInto(seasonEnv, &season); decodeErr == nil && season.Meta != nil && season.Meta.Mid == meta.Mid {
			meta.Kind = LinkSeason
			meta.Title = season.Meta.Name
			if meta.Title == "" {
				meta.Title = season.Meta.Title
			}
			var pageTotal *int64
			if season.Page != nil {
				pageTotal = season.Page.Total
			}
			meta.Total = firstInt(season.Meta.Total, pageTotal)
			return meta, nil
		}
	}

	seriesEnv, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/series/archives?mid=%d&series_id=%d&pn=1&ps=1", meta.Mid, meta.ListID),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var series struct {
		Page *struct {
			Total *int64 `json:"total"`
		} `json:"page"`
	}
	if _, err := DecodeDataInto(seriesEnv, &series); err != nil {
		return nil, err
	}
	meta.Kind = LinkSeries
	if series.Page != nil {
		meta.Total = series.Page.Total
	}

	// 系列标题在另一个接口；取不到不阻塞添加（Node 侧同样 catch 掉）。
	if titleEnv, titleErr := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/series/series?series_id=%d", meta.ListID),
		FetchOptions{Cookie: cookie}); titleErr == nil {
		var titlePayload struct {
			Meta *struct {
				Name string `json:"name"`
			} `json:"meta"`
		}
		if _, decodeErr := DecodeDataInto(titleEnv, &titlePayload); decodeErr == nil && titlePayload.Meta != nil {
			meta.Title = titlePayload.Meta.Name
		}
	}
	return meta, nil
}

// CollectionVideos 取合集/系列的分页视频（5 分钟缓存）。
func (s *Service) CollectionVideos(ctx context.Context, cookie string, mid, sid int64, kind LinkKind, pn, ps int) ([]ListItem, *int64, error) {
	cacheKey := fmt.Sprintf("%s|%d|%d|%d|%d", kind, mid, sid, pn, ps)
	if cached, ok := s.Browse.collection.Get(cacheKey); ok {
		return cached.Items, cached.Total, nil
	}

	var target string
	if kind == LinkSeries {
		target = fmt.Sprintf("https://api.bilibili.com/x/series/archives?mid=%d&series_id=%d&pn=%d&ps=%d", mid, sid, pn, ps)
	} else {
		target = fmt.Sprintf("https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=%d&season_id=%d&page_num=%d&page_size=%d", mid, sid, pn, ps)
	}

	env, err := s.Client.Fetch(ctx, target, FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, nil, err
	}
	var payload struct {
		Archives []struct {
			Bvid     string `json:"bvid"`
			Title    string `json:"title"`
			Pic      string `json:"pic"`
			Duration int    `json:"duration"`
			Pubdate  int64  `json:"pubdate"`
			Stat     struct {
				View    int64 `json:"view"`
				Danmaku int64 `json:"danmaku"`
			} `json:"stat"`
		} `json:"archives"`
		Page *struct {
			Total *int64 `json:"total"`
		} `json:"page"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, nil, err
	}

	items := make([]ListItem, 0, len(payload.Archives))
	for _, a := range payload.Archives {
		if a.Bvid == "" {
			continue
		}
		// 合集/系列接口不给 UP 名字（upName 恒为空串）。
		items = append(items, ListItem{
			Bvid:     a.Bvid,
			Title:    a.Title,
			Pic:      NormalizeImageURL(a.Pic),
			View:     a.Stat.View,
			Danmaku:  a.Stat.Danmaku,
			Duration: a.Duration,
			Date:     a.Pubdate,
		})
	}
	var total *int64
	if payload.Page != nil {
		total = payload.Page.Total
	}
	if len(items) > 0 {
		s.Browse.collection.Set(cacheKey, listCacheEntry{Items: items, Total: total})
	}
	return items, total, nil
}

// firstInt 返回第一个非 nil 的指针（对应 JS 的 `a ?? b`）。
func firstInt(values ...*int64) *int64 {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
