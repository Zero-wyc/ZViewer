package bilibili

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 追番：关注列表（app 端接口）与番剧集数（pgc season）。
//
// 对应 bilibili-bangumi.routes.ts。原 web 接口 x/space/bangumi/follow/list
// 已返回 -400，只能改用 app 端 `app.bilibili.com/x/v2/space/bangumi`。

// ErrNoBiliMid 表示既没有 Cookie 里的 DedeUserID、也没能通过 nav 取到 mid。
var ErrNoBiliMid = errors.New("无法获取 B站 用户 ID")

// BangumiItem 是关注番剧条目。
type BangumiItem struct {
	SeasonID int64  `json:"seasonId"`
	Title    string `json:"title"`
	Cover    string `json:"cover"`
	Progress string `json:"progress"`
	Total    int64  `json:"total"`
}

// BangumiEpisode 是番剧的一集。
type BangumiEpisode struct {
	Bvid  string `json:"bvid"`
	Cid   int64  `json:"cid"`
	Title string `json:"title"`
	// Index 是展示用的集号，B站 有时给 "1" 有时给 1，原样透传。
	Index any `json:"index"`
}

// FollowingBangumi 取关注的番剧列表。
func (s *Service) FollowingBangumi(ctx context.Context, userID, cookie string, pn, ps int) ([]BangumiItem, error) {
	if cookie == "" {
		return nil, ErrBiliNotLoggedIn
	}

	// mid 优先取 Cookie 里的 DedeUserID；没有就查缓存、再退到 nav。
	mid := ExtractMid(cookie)
	if mid == "" {
		if cached, ok := s.Caches.GetUserInfo(userID); ok && cached.Mid > 0 {
			mid = strconv.FormatInt(cached.Mid, 10)
		} else if nav, err := s.Nav(ctx, cookie); err == nil && nav.Mid > 0 {
			mid = strconv.FormatInt(nav.Mid, 10)
			s.Caches.SetUserInfo(userID, UserInfo{
				Name:   nav.Uname,
				Avatar: NormalizeImageURL(nav.Face),
				Mid:    nav.Mid,
			})
		}
	}
	if mid == "" {
		return nil, ErrNoBiliMid
	}

	env, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://app.bilibili.com/x/v2/space/bangumi?vmid=%s&pn=%d&ps=%d", mid, pn, ps),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var payload struct {
		Count int64 `json:"count"`
		Item  []struct {
			Title         string `json:"title"`
			Cover         string `json:"cover"`
			Param         string `json:"param"`
			URI           string `json:"uri"`
			NewestEpIndex string `json:"newest_ep_index"`
			TotalCount    string `json:"total_count"`
			Index         string `json:"index"`
		} `json:"item"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, err
	}

	items := make([]BangumiItem, 0, len(payload.Item))
	for _, item := range payload.Item {
		seasonID := parseIntLoose(item.Param)
		if seasonID == 0 {
			if idx := strings.LastIndex(item.URI, "/"); idx >= 0 {
				seasonID = parseIntLoose(item.URI[idx+1:])
			} else {
				seasonID = parseIntLoose(item.URI)
			}
		}
		progress := item.NewestEpIndex
		if progress == "" {
			progress = item.Index
		}
		items = append(items, BangumiItem{
			SeasonID: seasonID,
			Title:    item.Title,
			Cover:    NormalizeImageURL(item.Cover),
			Progress: progress,
			Total:    parseIntLoose(item.TotalCount),
		})
	}
	return items, nil
}

// ErrBangumiInfo 表示 pgc season 载荷里没有 result（对应 Node 的抛错文案）。
var ErrBangumiInfo = errors.New("获取番剧信息失败")

// rawSeasonEpisode 是 pgc season 里的一集（原始字段）。
type rawSeasonEpisode struct {
	ID          int64           `json:"id"`
	Bvid        string          `json:"bvid"`
	Cid         int64           `json:"cid"`
	Aid         *int64          `json:"aid"`
	Title       string          `json:"title"`
	LongTitle   string          `json:"long_title"`
	TitleFormat string          `json:"title_format"`
	Index       json.RawMessage `json:"index"`
}

// rawSeason 是 pgc/view/web/season 的 result 载荷。
type rawSeason struct {
	SeasonID    json.RawMessage    `json:"season_id"`
	Title       string             `json:"title"`
	Cover       string             `json:"cover"`
	Episodes    []rawSeasonEpisode `json:"episodes"`
	MainSection *struct {
		Episodes []rawSeasonEpisode `json:"episodes"`
	} `json:"main_section"`
	Section []struct {
		Episodes []rawSeasonEpisode `json:"episodes"`
	} `json:"section"`
}

// fetchSeason 拉取 pgc season 载荷。
//
// pgc 的载荷在**顶层 result**；旧实现兼容的 data.result 也一并认。
// found=false 表示两处都没拿到（Node 侧是 `undefined`）。
func (s *Service) fetchSeason(ctx context.Context, cookie, seasonID string) (*rawSeason, bool, error) {
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/pgc/view/web/season?season_id="+encodeComponent(seasonID),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, false, err
	}

	raw := env.Result
	if len(raw) == 0 || string(raw) == "null" {
		var wrapped struct {
			Result json.RawMessage `json:"result"`
		}
		if _, err := DecodeDataInto(env, &wrapped); err == nil {
			raw = wrapped.Result
		}
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false, nil
	}

	var season rawSeason
	if err := json.Unmarshal(raw, &season); err != nil {
		return nil, false, err
	}
	return &season, true, nil
}

// episodeDisplayTitle 复刻
// `[title_format, long_title].filter(Boolean).join(' ') || long_title || title || ”`。
func episodeDisplayTitle(ep rawSeasonEpisode) string {
	parts := make([]string, 0, 2)
	if ep.TitleFormat != "" {
		parts = append(parts, ep.TitleFormat)
	}
	if ep.LongTitle != "" {
		parts = append(parts, ep.LongTitle)
	}
	title := strings.Join(parts, " ")
	if title == "" {
		title = ep.LongTitle
	}
	if title == "" {
		title = ep.Title
	}
	return title
}

// episodeDisplayIndex 复刻 `ep.title || ep.index || idx + 1`。
//
// JS 里 0 与空串都是 falsy，因此 index 为 0 时会继续落到序号。
func episodeDisplayIndex(ep rawSeasonEpisode, idx int) any {
	if ep.Title != "" {
		return ep.Title
	}
	if len(ep.Index) > 0 && string(ep.Index) != "null" {
		var decoded any
		if err := json.Unmarshal(ep.Index, &decoded); err == nil {
			switch value := decoded.(type) {
			case string:
				if value != "" {
					return value
				}
			case float64:
				if value != 0 {
					return value
				}
			case bool:
				if value {
					return value
				}
			}
		}
	}
	return idx + 1
}

// BangumiEpisodes 取指定番剧的集数列表（/api/stream/bilibili/bangumi-episodes 用）。
//
// 分集选取与 Node 路由一致：`result.episodes || result.main_section?.episodes || []`，
// 随后「为空再拍平 section」。**注意空数组在 JS 里是 truthy**，所以 episodes 是空数组时
// 不回落 main_section，而是直接走 section 拍平那一步。
func (s *Service) BangumiEpisodes(ctx context.Context, cookie, seasonID string) ([]BangumiEpisode, error) {
	season, found, err := s.fetchSeason(ctx, cookie, seasonID)
	if err != nil {
		return nil, err
	}
	items := make([]BangumiEpisode, 0, 8)
	if !found {
		return items, nil
	}

	episodes := season.Episodes
	if episodes == nil && season.MainSection != nil {
		episodes = season.MainSection.Episodes
	}
	if len(episodes) == 0 && season.Section != nil {
		for _, section := range season.Section {
			episodes = append(episodes, section.Episodes...)
		}
	}

	for idx, ep := range episodes {
		items = append(items, BangumiEpisode{
			Bvid:  ep.Bvid,
			Cid:   ep.Cid,
			Title: episodeDisplayTitle(ep),
			Index: episodeDisplayIndex(ep, idx),
		})
	}
	return items, nil
}

// BangumiSeasonEpisode 是动漫源用的分集（比路由 DTO 多 aid）。
type BangumiSeasonEpisode struct {
	Bvid  string
	Cid   int64
	Aid   *int64
	Title string
	Index any
}

// BangumiSeasonInfo 是 pgc season 的季信息 + 分集。
type BangumiSeasonInfo struct {
	SeasonID int64
	Title    string
	Cover    string
	Episodes []BangumiSeasonEpisode
}

// BangumiSeason 取番剧季信息（services/anime/providers/bilibiliBangumi 用）。
//
// 分集选取与 **anime provider** 一致，且和路由那版**语义不同**：
// 这里三步都要求「非空」才采用（`if (result.episodes && result.episodes.length > 0)`），
// 路由那版是 `||` 短路。两处不能合并，改一处会让另一处回归。
func (s *Service) BangumiSeason(ctx context.Context, cookie, seasonID string) (*BangumiSeasonInfo, error) {
	season, found, err := s.fetchSeason(ctx, cookie, seasonID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrBangumiInfo
	}

	var episodes []rawSeasonEpisode
	switch {
	case len(season.Episodes) > 0:
		episodes = season.Episodes
	case season.MainSection != nil && len(season.MainSection.Episodes) > 0:
		episodes = season.MainSection.Episodes
	case season.Section != nil:
		for _, section := range season.Section {
			episodes = append(episodes, section.Episodes...)
		}
	}

	info := &BangumiSeasonInfo{
		SeasonID: seasonIDNumber(season.SeasonID),
		Title:    season.Title,
		Cover:    NormalizeImageURL(season.Cover),
		Episodes: make([]BangumiSeasonEpisode, 0, len(episodes)),
	}
	for idx, ep := range episodes {
		info.Episodes = append(info.Episodes, BangumiSeasonEpisode{
			Bvid:  ep.Bvid,
			Cid:   ep.Cid,
			Aid:   ep.Aid,
			Title: episodeDisplayTitle(ep),
			Index: episodeDisplayIndex(ep, idx),
		})
	}
	return info, nil
}

// seasonIDNumber 复刻 `Number(result.season_id) || 0`。
func seasonIDNumber(raw json.RawMessage) int64 {
	if len(raw) == 0 || string(raw) == "null" {
		return 0
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		return int64(number)
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0
	}
	return parseIntLoose(text)
}

// BangumiSearchResult 是番剧搜索的一条结果（动漫源内部结构）。
type BangumiSearchResult struct {
	SeasonID int64
	Title    string
	Cover    string
	// Description 为 nil 表示上游没有这个字段（Node 侧是 undefined，整键消失）。
	Description *string
	Link        string
}

// SearchBangumi 用 WBI 签名搜索番剧（media_bangumi）。
//
// 搜索接口已强制 WBI，未签名会返回 HTML 错误页而不是 JSON，
// 因此必须走 wbi/search/type 并同步签名。
func (s *Service) SearchBangumi(ctx context.Context, keyword, cookie string) ([]BangumiSearchResult, error) {
	imgKey, subKey, err := s.WBI.Keys(ctx, cookie)
	if err != nil {
		return nil, err
	}
	signed := SignParams(NewParams().
		Set("keyword", keyword).
		Set("search_type", "media_bangumi").
		Set("page", "1").
		Set("page_size", "20"), imgKey, subKey)

	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/wbi/search/type?"+signed.Encode(),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}

	// `data.result` 是数组（不是 data.result.result）。
	var payload struct {
		Result []struct {
			SeasonID    json.RawMessage `json:"season_id"`
			MediaID     json.RawMessage `json:"media_id"`
			Title       string          `json:"title"`
			Cover       string          `json:"cover"`
			Description *string         `json:"description"`
			Link        string          `json:"link"`
		} `json:"result"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, err
	}

	limit := len(payload.Result)
	if limit > 10 {
		limit = 10
	}
	results := make([]BangumiSearchResult, 0, limit)
	htmlTagPattern := regexp.MustCompile(`<[^>]+>`)
	for _, item := range payload.Result[:limit] {
		seasonID := seasonIDNumber(item.SeasonID)
		if seasonID == 0 {
			seasonID = seasonIDNumber(item.MediaID)
		}
		results = append(results, BangumiSearchResult{
			SeasonID:    seasonID,
			Title:       htmlTagPattern.ReplaceAllString(item.Title, ""),
			Cover:       NormalizeImageURL(item.Cover),
			Description: item.Description,
			Link:        item.Link,
		})
	}
	return results, nil
}

// parseIntLoose 对应 JS 的 Number(x)：非法值一律当 0。
func parseIntLoose(raw string) int64 {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0
	}
	if n, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		return n
	}
	if f, err := strconv.ParseFloat(trimmed, 64); err == nil {
		return int64(f)
	}
	return 0
}
