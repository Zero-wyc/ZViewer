package cms

// CMS 采集源的数据模型。
//
// 对应 services/cms/types.ts。JSON 标签必须与 Node 侧逐字一致：
// `cover`/`description`/`remark` 这类可选字段在 Node 里是 `undefined`（整键消失），
// 所以这里全部 omitempty——写成空串会让前端把「没有封面」渲染成一张空图。

// MediaFormat 是媒体容器格式。
type MediaFormat string

const (
	// FormatMP4 是 mp4/mkv（浏览器可直放）。
	FormatMP4 MediaFormat = "mp4"
	// FormatHLS 是 m3u8 播放列表。
	FormatHLS MediaFormat = "hls"
	// FormatFLV 是 FLV 容器。
	FormatFLV MediaFormat = "flv"
	// FormatUnknown 交给前端按 URL 后缀猜。
	FormatUnknown MediaFormat = "unknown"
)

// Site 是 TVBox 配置里的一个 CMS 采集站。
type Site struct {
	// Key 是注册表唯一键（cms{配置序号}_{站点 key}）。
	Key string
	// Name 是显示名。
	Name string
	// API 是苹果 CMS JSON 采集接口根地址。
	API string
	// Searchable 对应 TVBox 的 searchable !== 0。
	Searchable bool
}

// Source 是 /sources 的响应条目。
type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SearchResult 是搜索结果条目。
type SearchResult struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Cover       string `json:"cover,omitempty"`
	Description string `json:"description,omitempty"`
	Remark      string `json:"remark,omitempty"`
	Source      string `json:"source"`
}

// PlaybackParams 是定位一集所需的参数（透传到 resolve）。
type PlaybackParams struct {
	VodID         string `json:"vodId"`
	PlayFromIndex int    `json:"playFromIndex"`
	EpisodeIndex  int    `json:"episodeIndex"`
}

// Episode 是播放组内的一集。
type Episode struct {
	Index          int            `json:"index"`
	Title          string         `json:"title"`
	PlaybackParams PlaybackParams `json:"playbackParams"`
}

// PlayGroup 对应 vod_play_from / vod_play_url 的 $$$ 分组。
type PlayGroup struct {
	Name     string    `json:"name"`
	Episodes []Episode `json:"episodes"`
}

// VodDetail 是影片详情。
type VodDetail struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Cover       string      `json:"cover,omitempty"`
	Description string      `json:"description,omitempty"`
	Year        string      `json:"year,omitempty"`
	Area        string      `json:"area,omitempty"`
	TypeName    string      `json:"typeName,omitempty"`
	Remark      string      `json:"remark,omitempty"`
	PlayGroups  []PlayGroup `json:"playGroups"`
	Source      string      `json:"source"`
}

// PlaybackURL 是解析出来的播放地址。
type PlaybackURL struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Format  MediaFormat       `json:"format"`
}

// AggregateResult 是聚合搜索条目。
type AggregateResult struct {
	// ID 是复合 id：`${source}::${vodId}`。
	ID          string `json:"id"`
	Source      string `json:"source"`
	SiteName    string `json:"siteName"`
	VodID       string `json:"vodId"`
	Title       string `json:"title"`
	Cover       string `json:"cover,omitempty"`
	Description string `json:"description,omitempty"`
	Remark      string `json:"remark,omitempty"`
}
