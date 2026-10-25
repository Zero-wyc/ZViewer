package anisubs

import "context"

// ani-subs 订阅 schema（ani-subs JSON 的子集），对应 services/anisubs/types.ts。
//
// 只声明真正用到的字段：订阅文件由社区维护，字段只增不减，多声明的字段
// 除了增加维护成本没有任何作用。

// MediaFormat 是媒体容器格式。
type MediaFormat string

const (
	FormatMP4     MediaFormat = "mp4"
	FormatHLS     MediaFormat = "hls"
	FormatFLV     MediaFormat = "flv"
	FormatUnknown MediaFormat = "unknown"
)

// SearchResult 是一条搜索结果。
type SearchResult struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Cover 为 nil 表示源没给封面（整键消失）。
	Cover       *string `json:"cover,omitempty"`
	Description *string `json:"description,omitempty"`
	Source      string  `json:"source"`
}

// Episode 是一集。
//
// EpisodeNumber 用 float64：ani-subs 的规则允许 `第 1.5 话` 这种集号，
// Node 侧就是 number（可以带小数），取整会改变 id 与展示。
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

// Provider 是一个 ani-subs 数据源。
//
// Node 版没有 context（fetch 用全局 AbortController）；Go 侧一路带下来，
// 客户端断开时上游抓取能立刻收尾。
type Provider interface {
	Name() string
	Search(ctx context.Context, keyword string) ([]SearchResult, error)
	Episodes(ctx context.Context, identifier string) ([]Episode, error)
	PlaybackURL(ctx context.Context, episode Episode) (*PlaybackURL, error)
}

// Subscription 是订阅 JSON 的根结构。
type Subscription struct {
	ExportedMediaSourceDataList *struct {
		MediaSources []MediaSource `json:"mediaSources"`
	} `json:"exportedMediaSourceDataList"`
}

// MediaSource 是订阅里的单个媒体源。
type MediaSource struct {
	FactoryID string `json:"factoryId"`
	Version   int    `json:"version"`
	Arguments struct {
		Name         string        `json:"name"`
		Description  string        `json:"description"`
		IconURL      string        `json:"iconUrl"`
		Tier         int           `json:"tier"`
		SearchConfig *SearchConfig `json:"searchConfig"`
	} `json:"arguments"`
}

// SearchConfig 是 web-selector 抓取配置（ani-subs JSON schema 子集）。
//
// 指针字段用于区分「没配」与「配了空串」——两者在抓取逻辑里走不同分支，
// 例如 matchVideo.referer 为空串时**不下发 Referer**，缺省时才回落页面地址。
type SearchConfig struct {
	SearchURL                  string `json:"searchUrl"`
	RawBaseURL                 string `json:"rawBaseUrl"`
	SearchUseOnlyFirstWord     bool   `json:"searchUseOnlyFirstWord"`
	SearchRemoveSpecial        bool   `json:"searchRemoveSpecial"`
	SearchUseSubjectNamesCount int    `json:"searchUseSubjectNamesCount"`
	SubjectFormatID            string `json:"subjectFormatId"`

	SelectorSubjectFormatA               *SubjectFormatA               `json:"selectorSubjectFormatA"`
	SelectorSubjectFormatIndexed         *SubjectFormatIndexed         `json:"selectorSubjectFormatIndexed"`
	SelectorSubjectFormatJSONPathIndexed *SubjectFormatJSONPathIndexed `json:"selectorSubjectFormatJsonPathIndexed"`

	ChannelFormatID                string                  `json:"channelFormatId"`
	SelectorChannelFormatFlattened *ChannelFormatFlattened `json:"selectorChannelFormatFlattened"`
	SelectorChannelFormatNoChannel *ChannelFormatNoChannel `json:"selectorChannelFormatNoChannel"`

	DefaultResolution       string `json:"defaultResolution"`
	DefaultSubtitleLanguage string `json:"defaultSubtitleLanguage"`
	FilterByEpisodeSort     bool   `json:"filterByEpisodeSort"`
	FilterBySubjectName     bool   `json:"filterBySubjectName"`

	SelectMedia *struct {
		DistinguishSubjectName bool `json:"distinguishSubjectName"`
		DistinguishChannelName bool `json:"distinguishChannelName"`
	} `json:"selectMedia"`

	MatchVideo *MatchVideo `json:"matchVideo"`
}

// SubjectFormatA 对应 `subjectFormatId: 'a'`（列表项本身就是链接）。
type SubjectFormatA struct {
	SelectLists       string `json:"selectLists"`
	PreferShorterName bool   `json:"preferShorterName"`
}

// SubjectFormatIndexed 对应 `subjectFormatId: 'indexed'`（名称与链接分列）。
type SubjectFormatIndexed struct {
	SelectNames       string `json:"selectNames"`
	SelectLinks       string `json:"selectLinks"`
	PreferShorterName bool   `json:"preferShorterName"`
}

// SubjectFormatJSONPathIndexed 对应 `subjectFormatId: 'json-path-indexed'`（接口返回 JSON）。
type SubjectFormatJSONPathIndexed struct {
	SelectNames       string `json:"selectNames"`
	SelectLinks       string `json:"selectLinks"`
	SelectCovers      string `json:"selectCovers"`
	PreferShorterName bool   `json:"preferShorterName"`
}

// ChannelFormatFlattened 对应 `channelFormatId: 'index-grouped'`（按线路分组）。
type ChannelFormatFlattened struct {
	SelectChannelNames         string `json:"selectChannelNames"`
	MatchChannelName           string `json:"matchChannelName"`
	SelectEpisodeLists         string `json:"selectEpisodeLists"`
	SelectEpisodesFromList     string `json:"selectEpisodesFromList"`
	SelectEpisodeLinksFromList string `json:"selectEpisodeLinksFromList"`
	MatchEpisodeSortFromName   string `json:"matchEpisodeSortFromName"`
}

// ChannelFormatNoChannel 对应 `channelFormatId: 'no-channel'`（不分线路）。
type ChannelFormatNoChannel struct {
	SelectEpisodes           string `json:"selectEpisodes"`
	SelectEpisodeLinks       string `json:"selectEpisodeLinks"`
	MatchEpisodeSortFromName string `json:"matchEpisodeSortFromName"`
}

// MatchVideo 是视频地址匹配规则。
type MatchVideo struct {
	EnableNestedURL   bool   `json:"enableNestedUrl"`
	MatchNestedURL    string `json:"matchNestedUrl"`
	MatchVideoURL     string `json:"matchVideoUrl"`
	Cookies           string `json:"cookies"`
	AddHeadersToVideo *struct {
		// Referer 为 nil 表示规则没写这个键 → 回落页面地址；
		// 为空串表示显式要求「不带 Referer」。
		Referer   *string `json:"referer"`
		UserAgent string  `json:"userAgent"`
		Origin    string  `json:"origin"`
	} `json:"addHeadersToVideo"`
}

// subjectLink 是搜索结果页解析出来的主体链接。
type subjectLink struct {
	Title string
	URL   string
	Cover *string
}

// episodeInfo 是详情页解析出来的一集。
type episodeInfo struct {
	ID            string
	Title         string
	EpisodeNumber float64
	URL           string
}

// videoMatch 是剧集页解析出来的播放地址。
type videoMatch struct {
	URL     string
	Headers map[string]string
	Format  MediaFormat
}

// strPtr 返回字符串指针。
func strPtr(value string) *string { return &value }
