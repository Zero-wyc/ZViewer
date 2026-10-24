package anime

import "context"

// 动漫（番剧）聚合源，对应 services/anime/*。
//
// 一个 Provider 就是「一个可搜索的番剧源」：搜索 → 取分集 → 解析播放地址。
// 内置源只有 B站番剧；RSS 与第三方 HTTP 源由 system_settings.dataSourceConfig
// 配置出来（见 service.go）。

// SearchResult 是一条搜索结果。
//
// cover / description 用指针：Node 侧「字段不存在」与「空串」在 JSON 里
// 是两种形态（前者整键消失），只有指针能如实还原。
type SearchResult struct {
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Cover       *string        `json:"cover,omitempty"`
	Description *string        `json:"description,omitempty"`
	Source      string         `json:"source"`
	Extra       map[string]any `json:"extra,omitempty"`
}

// Episode 是一集。
type Episode struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	EpisodeNumber  int            `json:"episodeNumber"`
	PlaybackParams map[string]any `json:"playbackParams"`
}

// PlaybackURL 是解析出来的播放地址。
//
// 只有 url 必填；其余字段随源而异，缺省时整键消失（前端按 URL 后缀兜底）。
type PlaybackURL struct {
	URL        string            `json:"url"`
	Headers    map[string]string `json:"headers,omitempty"`
	Format     string            `json:"format,omitempty"`
	AudioURL   string            `json:"audioUrl,omitempty"`
	VideoCodec string            `json:"videoCodec,omitempty"`
	AudioCodec string            `json:"audioCodec,omitempty"`
	Duration   *float64          `json:"duration,omitempty"`
}

// Provider 是一个番剧数据源。
type Provider interface {
	// Name 是展示名（/sources 直接透出）。
	Name() string
	Search(ctx context.Context, keyword string) ([]SearchResult, error)
	Episodes(ctx context.Context, identifier string) ([]Episode, error)
	PlaybackURL(ctx context.Context, episode Episode) (*PlaybackURL, error)
}

// strPtr 返回字符串指针（用于「字段存在但可能为空串」的场景）。
func strPtr(value string) *string { return &value }
