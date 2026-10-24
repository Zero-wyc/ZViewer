package bilibili

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// BangumiEpisodes 取指定番剧的集数列表。
func (s *Service) BangumiEpisodes(ctx context.Context, cookie, seasonID string) ([]BangumiEpisode, error) {
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/pgc/view/web/season?season_id="+encodeComponent(seasonID),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}

	// pgc 的载荷在**顶层 result**；旧实现兼容的 data.result 也一并认。
	raw := env.Result
	if len(raw) == 0 || string(raw) == "null" {
		var wrapped struct {
			Result json.RawMessage `json:"result"`
		}
		if _, err := DecodeDataInto(env, &wrapped); err == nil {
			raw = wrapped.Result
		}
	}

	type rawEpisode struct {
		Bvid        string          `json:"bvid"`
		Cid         int64           `json:"cid"`
		Title       string          `json:"title"`
		LongTitle   string          `json:"long_title"`
		TitleFormat string          `json:"title_format"`
		Index       json.RawMessage `json:"index"`
	}
	var season struct {
		Episodes    []rawEpisode `json:"episodes"`
		MainSection *struct {
			Episodes []rawEpisode `json:"episodes"`
		} `json:"main_section"`
		Section []struct {
			Episodes []rawEpisode `json:"episodes"`
		} `json:"section"`
	}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &season); err != nil {
			return nil, err
		}
	}

	// `result.episodes || result.main_section?.episodes || []`：
	// episodes 存在但为空数组时不再回退（JS 里空数组是 truthy）。
	episodes := season.Episodes
	if episodes == nil && season.MainSection != nil {
		episodes = season.MainSection.Episodes
	}
	if len(episodes) == 0 && season.Episodes == nil {
		for _, section := range season.Section {
			episodes = append(episodes, section.Episodes...)
		}
	}

	items := make([]BangumiEpisode, 0, len(episodes))
	for idx, ep := range episodes {
		titleParts := make([]string, 0, 2)
		if ep.TitleFormat != "" {
			titleParts = append(titleParts, ep.TitleFormat)
		}
		if ep.LongTitle != "" {
			titleParts = append(titleParts, ep.LongTitle)
		}
		title := strings.Join(titleParts, " ")
		if title == "" {
			title = ep.LongTitle
		}
		if title == "" {
			title = ep.Title
		}

		var index any = idx + 1
		if ep.Title != "" {
			index = ep.Title
		} else if len(ep.Index) > 0 && string(ep.Index) != "null" {
			var decoded any
			if err := json.Unmarshal(ep.Index, &decoded); err == nil {
				index = decoded
			}
		}
		items = append(items, BangumiEpisode{
			Bvid:  ep.Bvid,
			Cid:   ep.Cid,
			Title: title,
			Index: index,
		})
	}
	return items, nil
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
