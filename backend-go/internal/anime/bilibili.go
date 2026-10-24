package anime

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"zviewer/backend/internal/bilibili"
)

// 哔哩哔哩番剧源，对应 services/anime/providers/bilibiliBangumi.ts。

var (
	ssIDPattern     = regexp.MustCompile(`(?i)ss(\d+)`)
	epIDPattern     = regexp.MustCompile(`(?i)ep(\d+)`)
	anyIDPattern    = regexp.MustCompile(`\d+`)
	digitsOnlyCheck = regexp.MustCompile(`^\d+$`)
)

// BilibiliSourceID 是 B站番剧源的 id。
const BilibiliSourceID = "bilibili_bangumi"

// bilibiliProvider 用 B站 pgc 接口搜番、取分集。
type bilibiliProvider struct {
	service *bilibili.Service
}

func newBilibiliProvider(service *bilibili.Service) *bilibiliProvider {
	return &bilibiliProvider{service: service}
}

// Name 返回展示名。
func (p *bilibiliProvider) Name() string { return "哔哩哔哩番剧" }

// extractSeasonID 从关键词/标识里抠 seasonId。
//
// 顺序与 Node 一致：ss(\d+) → ep(\d+) → 第一段数字。
func extractSeasonID(input string) string {
	if m := ssIDPattern.FindStringSubmatch(input); len(m) == 2 {
		return m[1]
	}
	if m := epIDPattern.FindStringSubmatch(input); len(m) == 2 {
		return m[1]
	}
	return anyIDPattern.FindString(input)
}

// Search 搜索番剧。
//
// 先试「关键词本身就是 seasonId」（用户直接粘 ss1234 或番剧链接），
// 解析不出来再走关键词搜索。
func (p *bilibiliProvider) Search(ctx context.Context, keyword string) ([]SearchResult, error) {
	direct := extractSeasonID(keyword)
	if direct != "" && digitsOnlyCheck.MatchString(direct) {
		if season, err := p.service.BangumiSeason(ctx, "", direct); err == nil && season.SeasonID != 0 {
			seasonID := float64(season.SeasonID)
			return []SearchResult{{
				ID:     strconv.FormatInt(season.SeasonID, 10),
				Title:  season.Title,
				Cover:  strPtr(season.Cover),
				Source: BilibiliSourceID,
				Extra:  map[string]any{"seasonId": seasonID},
			}}, nil
		} else if err != nil {
			log.Printf("[anime:bilibiliBangumi] 直接解析 seasonId 失败: %v", err)
		}
	}

	raw, err := p.service.SearchBangumi(ctx, keyword, "")
	if err != nil {
		return nil, err
	}
	results := make([]SearchResult, 0, len(raw))
	for _, item := range raw {
		if item.SeasonID == 0 {
			continue
		}
		results = append(results, SearchResult{
			ID:          strconv.FormatInt(item.SeasonID, 10),
			Title:       item.Title,
			Cover:       strPtr(item.Cover),
			Description: item.Description,
			Source:      BilibiliSourceID,
			Extra:       map[string]any{"seasonId": float64(item.SeasonID)},
		})
	}
	return results, nil
}

// Episodes 取番剧分集。
func (p *bilibiliProvider) Episodes(ctx context.Context, identifier string) ([]Episode, error) {
	seasonID := extractSeasonID(identifier)
	if seasonID == "" {
		return nil, fmt.Errorf("无法解析番剧 ID")
	}

	season, err := p.service.BangumiSeason(ctx, "", seasonID)
	if err != nil {
		return nil, err
	}
	seasonIDValue := float64(season.SeasonID)

	// 没有分集时给一条「整季」占位，前端仍能点播。
	if len(season.Episodes) == 0 {
		return []Episode{{
			ID:             fmt.Sprintf("%d-1", season.SeasonID),
			Title:          season.Title,
			EpisodeNumber:  1,
			PlaybackParams: map[string]any{"seasonId": seasonIDValue},
		}}, nil
	}

	episodes := make([]Episode, 0, len(season.Episodes))
	for idx, ep := range season.Episodes {
		cidPart := ep.Cid
		if cidPart == 0 {
			cidPart = int64(idx + 1)
		}
		params := map[string]any{
			"seasonId": seasonIDValue,
			"bvid":     ep.Bvid,
			"cid":      float64(ep.Cid),
		}
		if ep.Aid != nil {
			params["aid"] = float64(*ep.Aid)
		}
		episodes = append(episodes, Episode{
			ID:             fmt.Sprintf("%d-%d", season.SeasonID, cidPart),
			Title:          joinNonEmpty(" - ", season.Title, ep.Title),
			EpisodeNumber:  episodeNumber(ep.Index, idx),
			PlaybackParams: params,
		})
	}
	return episodes, nil
}

// PlaybackURL 把 B站 页面地址交给 /api/stream/resolve-bilibili 走常规解析链。
func (p *bilibiliProvider) PlaybackURL(_ context.Context, episode Episode) (*PlaybackURL, error) {
	bvid, _ := episode.PlaybackParams["bvid"].(string)
	cid, _ := ToFloat(episode.PlaybackParams["cid"])
	if bvid == "" || cid <= 0 {
		return nil, fmt.Errorf("缺少有效的 B站 BV/CID 参数")
	}
	target := "https://www.bilibili.com/video/" + bvid
	return &PlaybackURL{
		URL:     "/api/stream/resolve-bilibili?url=" + url.QueryEscape(target),
		Headers: map[string]string{"Referer": "https://www.bilibili.com"},
	}, nil
}

// episodeNumber 复刻 `typeof index === 'number' ? index : Number(index) || idx + 1`。
func episodeNumber(index any, idx int) int {
	if number, ok := ToFloat(index); ok {
		return int(number)
	}
	return idx + 1
}

// joinNonEmpty 复刻 `[a, b].filter(Boolean).join(sep)`。
func joinNonEmpty(sep string, values ...string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			parts = append(parts, value)
		}
	}
	return strings.Join(parts, sep)
}

// ToFloat 把 JSON 解出来的数值/数值字符串转成 float64。
func ToFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	return 0, false
}
