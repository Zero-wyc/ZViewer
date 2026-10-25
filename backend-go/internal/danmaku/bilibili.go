package danmaku

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"zviewer/backend/internal/bilibili"
)

// B站 的两个弹幕源，对应 providers/bilibiliVideo.ts 与 providers/bilibiliBangumi.ts。

// maxStatFetch 是补充统计信息时最多并发查几个视频。
//
// 搜索接口不返回 like/coin，只能逐个调 view；并发太多会撞风控，Node 侧
// 就卡在 10，超出的部分沿用搜索接口自带的四项统计。
const maxStatFetch = 10

var (
	// bvidPattern 从关键词里抠 BV 号。
	bvidPattern = regexp.MustCompile(`BV[0-9A-Za-z]{10}`)
	// aidPattern 抠 av 号（只取数字部分）。
	aidPattern = regexp.MustCompile(`(?i)av(\d+)`)
	// seasonIDPattern 抠 ss 号。
	seasonIDPattern = regexp.MustCompile(`(?i)ss(\d+)`)
	// mediaIDPattern 抠 md 号。
	mediaIDPattern = regexp.MustCompile(`(?i)md(\d+)`)
)

// extractBvid 从输入里抠视频号；没有则返回空串。
//
// av 号只取数字部分直接交给 view 接口——Node 侧同样如此（注定失败），
// 这里保持一致而不是「顺手修好」。
func extractBvid(input string) string {
	if match := bvidPattern.FindString(input); match != "" {
		return match
	}
	if match := aidPattern.FindStringSubmatch(input); len(match) == 2 {
		return match[1]
	}
	return ""
}

// extractSeasonID 从输入里抠番剧 seasonId（ss123 / md456 / 纯数字）。
func extractSeasonID(input string) string {
	if match := seasonIDPattern.FindStringSubmatch(input); len(match) == 2 {
		return match[1]
	}
	if match := mediaIDPattern.FindStringSubmatch(input); len(match) == 2 {
		return match[1]
	}
	trimmed := strings.TrimSpace(input)
	if trimmed != "" && isDigits(trimmed) {
		return trimmed
	}
	return ""
}

func isDigits(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

func strPtr(value string) *string { return &value }

// ---------------------------------------------------------------------------
// bilibili-video
// ---------------------------------------------------------------------------

type biliVideoProvider struct {
	bili *bilibili.Service
}

func (p *biliVideoProvider) Name() string { return "哔哩哔哩视频" }

func (p *biliVideoProvider) Search(ctx context.Context, keyword string, pc Context) ([]SearchResult, error) {
	if bvid := extractBvid(keyword); bvid != "" {
		info, err := p.bili.GetVideoInfo(ctx, bvid, pc.Cookie)
		if err != nil || info == nil {
			return []SearchResult{}, nil
		}
		result := SearchResult{
			ID:     info.Bvid,
			Title:  info.Title,
			Cover:  strPtr(info.Pic),
			Source: "bilibili-video",
			Extra:  map[string]any{"bvid": info.Bvid, "aid": info.Aid},
		}
		if info.Stat != nil {
			result.Stats = &SearchStats{
				Play:      info.Stat.View,
				Danmaku:   info.Stat.Danmaku,
				Favorites: info.Stat.Favorite,
				Like:      info.Stat.Like,
				Coin:      info.Stat.Coin,
				Reply:     info.Stat.Reply,
			}
		}
		return []SearchResult{result}, nil
	}

	items, _, err := p.bili.Search(ctx, keyword, pc.Cookie, 1, bilibili.SearchByKeyword)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return []SearchResult{}, nil
	}

	// 并发补统计（allSettled 语义：失败就沿用搜索接口的数据）。
	type statResult struct {
		info *bilibili.VideoInfo
	}
	limit := maxStatFetch
	if len(items) < limit {
		limit = len(items)
	}
	stats := make([]statResult, limit)
	var wg sync.WaitGroup
	for index := 0; index < limit; index++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			info, err := p.bili.GetVideoInfo(ctx, items[slot].Bvid, pc.Cookie)
			if err == nil {
				stats[slot].info = info
			}
		}(index)
	}
	wg.Wait()

	results := make([]SearchResult, 0, len(items))
	for index, item := range items {
		result := SearchResult{
			ID:          item.Bvid,
			Title:       item.Title,
			Cover:       strPtr(item.Pic),
			Description: strPtr(item.UpName),
			Source:      "bilibili-video",
			Stats: &SearchStats{
				Play:      item.View,
				Danmaku:   item.Danmaku,
				Favorites: item.Favorites,
				Reply:     item.Review,
			},
			Extra: map[string]any{"bvid": item.Bvid, "aid": item.Aid},
		}
		if index < limit && stats[index].info != nil && stats[index].info.Stat != nil {
			stat := stats[index].info.Stat
			result.Stats = &SearchStats{
				Play:      stat.View,
				Danmaku:   stat.Danmaku,
				Favorites: stat.Favorite,
				Like:      stat.Like,
				Coin:      stat.Coin,
				Reply:     stat.Reply,
			}
		}
		results = append(results, result)
	}
	return results, nil
}

func (p *biliVideoProvider) Episodes(ctx context.Context, identifier string, pc Context) ([]Episode, error) {
	bvid := extractBvid(identifier)
	if bvid == "" {
		return nil, errors.New("无法解析 BV 号")
	}
	info, err := p.bili.GetVideoInfo(ctx, bvid, pc.Cookie)
	if err != nil || info == nil {
		return nil, errors.New("获取视频信息失败")
	}

	if len(info.Pages) <= 1 {
		return []Episode{{
			ID:             info.Bvid + "-" + strconv.FormatInt(info.Cid, 10),
			Title:          info.Title,
			EpisodeNumber:  1,
			PlaybackParams: map[string]any{"bvid": info.Bvid, "cid": info.Cid},
		}}, nil
	}

	episodes := make([]Episode, 0, len(info.Pages))
	for _, page := range info.Pages {
		title := info.Title
		if page.Part != "" {
			title = info.Title + " - " + page.Part
		}
		episodes = append(episodes, Episode{
			ID:             info.Bvid + "-" + strconv.FormatInt(page.Cid, 10),
			Title:          title,
			EpisodeNumber:  float64(page.Page),
			PlaybackParams: map[string]any{"bvid": info.Bvid, "cid": page.Cid},
		})
	}
	return episodes, nil
}

func (p *biliVideoProvider) Danmaku(ctx context.Context, episode Episode, _ Context) ([]Item, error) {
	cid, ok := episodeCID(episode)
	if !ok {
		return nil, errors.New("缺少 cid 参数")
	}
	return biliDanmakuItems(ctx, p.bili, cid)
}

// episodeCID 取 playbackParams.cid，且必须是数字（对应 Node 的 typeof === 'number'）。
func episodeCID(episode Episode) (int64, bool) {
	value, present := episode.PlaybackParams["cid"]
	if !present {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	}
	return 0, false
}

// ---------------------------------------------------------------------------
// bilibili-bangumi
// ---------------------------------------------------------------------------

type biliBangumiProvider struct {
	bili *bilibili.Service
}

func (p *biliBangumiProvider) Name() string { return "哔哩哔哩番剧" }

func (p *biliBangumiProvider) Search(ctx context.Context, keyword string, pc Context) ([]SearchResult, error) {
	if seasonID := extractSeasonID(keyword); seasonID != "" {
		info, err := p.bili.BangumiSeason(ctx, pc.Cookie, seasonID)
		if err != nil || info == nil || info.SeasonID == 0 {
			return []SearchResult{}, nil
		}
		// description 在 Node 的 getBangumiEpisodes 里**不存在**，所以这里
		// 不设 Description（整键消失），别顺手补上。
		return []SearchResult{{
			ID:     strconv.FormatInt(info.SeasonID, 10),
			Title:  info.Title,
			Cover:  strPtr(info.Cover),
			Source: "bilibili-bangumi",
			Extra:  map[string]any{"seasonId": info.SeasonID},
		}}, nil
	}

	items, err := p.bili.SearchBangumi(ctx, keyword, pc.Cookie)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return []SearchResult{}, nil
	}

	results := make([]SearchResult, 0, len(items))
	for _, item := range items {
		result := SearchResult{
			ID:     strconv.FormatInt(item.SeasonID, 10),
			Title:  item.Title,
			Cover:  strPtr(item.Cover),
			Source: "bilibili-bangumi",
			Extra:  map[string]any{"seasonId": item.SeasonID, "link": item.Link},
		}
		if item.Description != nil {
			result.Description = item.Description
		}
		results = append(results, result)
	}
	return results, nil
}

func (p *biliBangumiProvider) Episodes(ctx context.Context, identifier string, pc Context) ([]Episode, error) {
	seasonID := extractSeasonID(identifier)
	if seasonID == "" {
		return nil, errors.New("无法解析 season_id")
	}
	info, err := p.bili.BangumiSeason(ctx, pc.Cookie, seasonID)
	if err != nil || info == nil || len(info.Episodes) == 0 {
		return nil, errors.New("该番剧暂无可用集数")
	}

	episodes := make([]Episode, 0, len(info.Episodes))
	for index, ep := range info.Episodes {
		title := ep.Title
		if title == "" {
			title = "第 " + formatNumber(ep.Index) + " 集"
		}
		params := map[string]any{"bvid": ep.Bvid, "cid": ep.Cid}
		if ep.Aid != nil {
			params["aid"] = *ep.Aid
		}
		episodes = append(episodes, Episode{
			ID:             ep.Bvid + "-" + strconv.FormatInt(ep.Cid, 10),
			Title:          title,
			EpisodeNumber:  float64(index + 1),
			PlaybackParams: params,
		})
	}
	return episodes, nil
}

func (p *biliBangumiProvider) Danmaku(ctx context.Context, episode Episode, _ Context) ([]Item, error) {
	cid, ok := episodeCID(episode)
	if !ok {
		return nil, errors.New("缺少 cid 参数")
	}
	return biliDanmakuItems(ctx, p.bili, cid)
}

// biliDanmakuItems 拉取并映射 B站 弹幕（两个 B站 源共用）。
func biliDanmakuItems(ctx context.Context, bili *bilibili.Service, cid int64) ([]Item, error) {
	items, err := bili.GetDanmaku(ctx, cid)
	if err != nil {
		return nil, err
	}
	out := make([]Item, 0, len(items))
	for _, item := range items {
		out = append(out, Item{
			ID:      item.ID,
			Content: item.Content,
			Time:    item.Time,
			Mode:    item.Mode,
			Color:   item.Color,
			Size:    item.Size,
		})
	}
	return out, nil
}

// formatNumber 复刻 String(x)：整数值的 float64 不带小数点。
func formatNumber(value any) string {
	switch typed := value.(type) {
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case string:
		return typed
	}
	return ""
}
