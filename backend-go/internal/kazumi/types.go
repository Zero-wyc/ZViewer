package kazumi

import (
	"context"

	"zviewer/backend/internal/anisubs"
)

// Kazumi 规则源的数据结构，对应 services/kazumi/types.ts。
//
// 规则来自社区仓库（Predidit/KazumiRules），字段写法很松：类型标错的、
// 该有却没有的都有。所以模式字段（searchMode / chapterMode）用 any 承载，
// 由 normalizeRuleMode 统一判成 xpath/api——Node 侧同样是 unknown。

// MediaFormat 是媒体容器格式。
//
// 直接复用 anisubs 的定义（`mp4` / `hls` / `flv` / `unknown`）：
// 两侧的 detectMediaFormat 逐字相同，分成两套枚举只会在 DTO 处来回转换。
type MediaFormat = anisubs.MediaFormat

// SearchResult 是一条搜索结果。
//
// Cover 用指针：Node 侧 `cover: readPoster(url)` 取不到时值是 undefined，
// JSON 序列化后**整个键消失**；`string` + omitempty 无法区分「键不存在」与
// 「空串」。description 在 Kazumi 里从不赋值，所以干脆不声明。
type SearchResult struct {
	ID     string  `json:"id"`
	Title  string  `json:"title"`
	Cover  *string `json:"cover,omitempty"`
	Source string  `json:"source"`
}

// Episode 是一集。
//
// EpisodeNumber 用 float64：规则允许 `第 1.5 话`，Node 侧就是 number，
// 而且 id 里拼的就是这个值的字符串形式（取整会让 id 与前端记录对不上）。
type Episode struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	EpisodeNumber  float64        `json:"episodeNumber"`
	PlaybackParams map[string]any `json:"playbackParams"`
}

// PlaybackURL 是解析出来的播放地址。
type PlaybackURL struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Format  string            `json:"format,omitempty"`
}

// Provider 是一个 Kazumi 数据源。
type Provider interface {
	Name() string
	Search(ctx context.Context, keyword string) ([]SearchResult, error)
	Episodes(ctx context.Context, identifier string) ([]Episode, error)
	PlaybackURL(ctx context.Context, episode Episode) (*PlaybackURL, error)
}

// Rule 是 Kazumi 规则 JSON。
//
// 只声明实际用到的字段：规则里有 adBlocker / useWebview / antiCrawlerConfig
// 这类给客户端 App 用的开关，后端不参与，读进来也是噪音。
type Rule struct {
	API             string `json:"api"`
	Type            string `json:"type"`
	Name            string `json:"name"`
	Version         string `json:"version"`
	MuliSources     bool   `json:"muliSources"`
	UseWebview      bool   `json:"useWebview"`
	UseNativePlayer bool   `json:"useNativePlayer"`
	UsePost         bool   `json:"usePost"`
	UseLegacyParser bool   `json:"useLegacyParser"`
	AdBlocker       bool   `json:"adBlocker"`
	UserAgent       string `json:"userAgent"`
	Referer         string `json:"referer"`
	BaseURL         string `json:"baseURL"`
	SearchURL       string `json:"searchURL"`
	SearchList      string `json:"searchList"`
	SearchName      string `json:"searchName"`
	SearchResult    string `json:"searchResult"`
	ChapterRoads    string `json:"chapterRoads"`
	ChapterResult   string `json:"chapterResult"`
	// SearchMode / ChapterMode 是 `xpath` 或 `api`，缺省按 xpath。
	SearchMode       any               `json:"searchMode"`
	ChapterMode      any               `json:"chapterMode"`
	SearchAPIConfig  *APISearchConfig  `json:"searchApiConfig"`
	ChapterAPIConfig *APIChapterConfig `json:"chapterApiConfig"`
}

// APISearchConfig 对齐上游 ApiSearchConfig（apiLevel 9 的 JSON 搜索）。
type APISearchConfig struct {
	Request    *APIRequest `json:"request"`
	ListPath   any         `json:"listPath"`
	NamePath   any         `json:"namePath"`
	SourcePath any         `json:"sourcePath"`
	// SourceTemplate 是详情页模板，@source 换成来源值（URL 编码）；空=原样保留。
	SourceTemplate any `json:"sourceTemplate"`
}

// APIEpisodePageConfig 是播放页地址模板。
type APIEpisodePageConfig struct {
	URL   any            `json:"url"`
	Query map[string]any `json:"query"`
}

// APIChapterConfig 对齐上游 ApiChapterConfig。
type APIChapterConfig struct {
	Request *APIRequest `json:"request"`
	// Format 是 `nested`（JSONPath 结构化）或 `delimited`（苹果 CMS 分隔串）。
	Format           any `json:"format"`
	RoadsPath        any `json:"roadsPath"`
	RoadNamePath     any `json:"roadNamePath"`
	EpisodesPath     any `json:"episodesPath"`
	EpisodeNamePath  any `json:"episodeNamePath"`
	EpisodeURLPath   any `json:"episodeUrlPath"`
	RoadNamesPath    any `json:"roadNamesPath"`
	RoadEpisodesPath any `json:"roadEpisodesPath"`
	RoadSeparator    any `json:"roadSeparator"`
	EpisodeSeparator any `json:"episodeSeparator"`
	FieldSeparator   any `json:"fieldSeparator"`
	// Variables 是命名捕获：变量名 → 章节响应上的 JSONPath。
	Variables   map[string]any        `json:"variables"`
	EpisodePage *APIEpisodePageConfig `json:"episodePage"`
}

// APIRequest 是 API 规则请求模板。
type APIRequest struct {
	Method  any            `json:"method"`
	URL     any            `json:"url"`
	Headers map[string]any `json:"headers"`
	Query   map[string]any `json:"query"`
	// BodyType 是 `none` / `json` / `form`，默认 none（仅 POST 生效）。
	BodyType any `json:"bodyType"`
	Body     any `json:"body"`
}

// Road 是一条播放线路（选集结果）。
type Road struct {
	Name   string
	URLs   []string
	Titles []string
}

// SearchItem 是一条 API 搜索结果（src 可能还是裸 id，由 provider 归一化）。
type SearchItem struct {
	Name string
	Src  string
}
