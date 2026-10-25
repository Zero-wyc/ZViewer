package danmaku

import "context"

// 多源弹幕的数据结构与 provider 接口，对应 services/danmaku/types.ts。

// SearchStats 是搜索结果里的统计数据。
//
// 全部用**值**而不是指针 + omitempty：Node 侧这些字段来自 `x ?? 0`，
// 0 也要原样下发（`play: 0` 与「没有 play」对前端是两回事）。
type SearchStats struct {
	Play      int64 `json:"play"`
	Danmaku   int64 `json:"danmaku"`
	Favorites int64 `json:"favorites"`
	Like      int64 `json:"like"`
	Coin      int64 `json:"coin"`
	Reply     int64 `json:"reply"`
}

// SearchResult 是一条弹幕源搜索结果。
//
// Cover / Description 用指针：Node 侧「字段不存在」与「空串」在 JSON 里
// 是两种形态（前者整键消失），`string` + omitempty 会把两者混为一谈。
type SearchResult struct {
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Cover       *string        `json:"cover,omitempty"`
	Description *string        `json:"description,omitempty"`
	Source      string         `json:"source"`
	Stats       *SearchStats   `json:"stats,omitempty"`
	Extra       map[string]any `json:"extra,omitempty"`
}

// Episode 是一集。
type Episode struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	EpisodeNumber  float64        `json:"episodeNumber"`
	PlaybackParams map[string]any `json:"playbackParams"`
}

// Item 是一条弹幕（统一格式）。
type Item struct {
	ID      string  `json:"id"`
	Content string  `json:"content"`
	Time    float64 `json:"time"`
	Mode    int     `json:"mode"`
	Color   int     `json:"color"`
	Size    int     `json:"size"`
}

// Context 是 provider 的调用上下文，由路由层注入。
//
// 只有 B站 用得上（搜索与 WBI 签名需要登录态），其余源忽略。
type Context struct {
	Cookie string
}

// Provider 是一个弹幕源。
type Provider interface {
	Name() string
	Search(ctx context.Context, keyword string, pc Context) ([]SearchResult, error)
	Episodes(ctx context.Context, identifier string, pc Context) ([]Episode, error)
	Danmaku(ctx context.Context, episode Episode, pc Context) ([]Item, error)
}

// Source 是一个可选弹幕源。
type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
