package api

// 来源库门面：本地爬虫规则与 ani-subs / Kazumi / TVBox 三个内置库共用一处入口。
//
// 为什么要有这一层：四个库的执行器完全不同（规则引擎、订阅抓站、Kazumi 规则运行时、
// 苹果 CMS 协议），但「有哪些库、配了什么、现在能不能用」这件事对界面是一样的。
// 所以这里只做三件不改变各自行为的事：
//   1. 列出四个库的状态、条目与配置（一次请求拿全）；
//   2. 读写三个内置库的配置（仍落在 system_settings.dataSourceConfig，不搬家、不迁移）；
//   3. 让 /api/crawler/search 能按 library 分派——界面只认一个搜索入口。
//
// 播放解析**不在**这里统一：三个库的解析产物与参数形态不同（番剧要选集、CMS 走
// vod_play_url 分组），点片仍复用各自前端组件与端点。等 P5 真把规则层合并时再说。
//
// 接口刻意挂在 /api/crawler/ 下：桌面控制台的桥接只放行这个前缀，挂在 /api/admin
// 下网页端能看见、桌面端看不见。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/httpx"
)

var (
	errCrawlerLibraryTooManyURLs = errors.New("最多 30 个地址")
	errCrawlerLibraryURLTooLong  = errors.New("地址过长（上限 500 字符）")
	errCrawlerLibraryURLScheme   = errors.New("地址必须以 http:// 或 https:// 开头")
	errCrawlerLibraryUnknown     = errors.New("未知的来源库")
)

const (
	crawlerLibraryLocal   = "local"
	crawlerLibraryAniSubs = "anisubs"
	crawlerLibraryKazumi  = "kazumi"
	crawlerLibraryCMS     = "cms"
)

// crawlerLibraryConfigKeys 是「库 → dataSourceConfig 里的键」。
//
// 键名必须与各服务自己解析的 json tag 逐字一致（internal/anisubs|kazumi|cms 的
// dataSourceConfig 结构体），否则界面写进去、服务读不到。
var crawlerLibraryConfigKeys = map[string]string{
	crawlerLibraryAniSubs: "aniSubsSubscriptions",
	crawlerLibraryKazumi:  "kazumiRules",
	crawlerLibraryCMS:     "cmsSources",
}

// crawlerLibraryListTimeout 是列源时的预算：三个库都要读远端配置，
// 一个慢站点不该把整个页面拖住，超时就报「读取超时」，界面仍能改配置。
const crawlerLibraryListTimeout = 12 * time.Second

// crawlerLibraryView 是界面要的一条库信息。
type crawlerLibraryView struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Kind        string           `json:"kind"`
	Description string           `json:"description"`
	Available   bool             `json:"available"`
	Error       string           `json:"error,omitempty"`
	Count       int              `json:"count"`
	ConfigKey   string           `json:"configKey,omitempty"`
	Editable    bool             `json:"editable"`
	URLs        []string         `json:"urls,omitempty"`
	Sources     []map[string]any `json:"sources,omitempty"`
	Note        string           `json:"note,omitempty"`
}

func (s *Server) registerCrawlerLibraryRoutes(mux *http.ServeMux) {
	admin := s.Auth.RequireDesktopOrAdmin
	mux.HandleFunc("GET /api/crawler/libraries", admin(s.handleCrawlerLibraries))
	mux.HandleFunc("GET /api/crawler/libraries/{id}/config", admin(s.handleCrawlerLibraryConfigGet))
	mux.HandleFunc("PUT /api/crawler/libraries/{id}/config", admin(s.handleCrawlerLibraryConfigPut))
}

// handleCrawlerLibraries 一次返回四个库的状态。
//
// 单个库读取失败（远端规则地址挂了、超时）只记在该库的 error 上，不影响其它库：
// 界面要能显示「这个库现在不可用」，而不是整页报错。
func (s *Server) handleCrawlerLibraries(w http.ResponseWriter, r *http.Request) {
	urls := s.crawlerLibraryConfigURLs(r.Context())
	libraries := []map[string]any{}

	if bundle := localBundle(); bundle != nil {
		rules := bundle.Store.List(true)
		libraries = append(libraries, map[string]any{
			"id": crawlerLibraryLocal, "name": "本地规则", "kind": "rule",
			"description": "Agent 生成的站点规则，也就是「站点规则」里的那批。",
			"available":   true, "count": len(rules), "editable": false,
			"note": "增删改在「站点规则」里，导入导出也在那边。",
		})
	} else {
		libraries = append(libraries, map[string]any{
			"id": crawlerLibraryLocal, "name": "本地规则", "kind": "rule",
			"description": "Agent 生成的站点规则，也就是「站点规则」里的那批。",
			"available":   false, "error": "引擎未初始化", "count": 0, "editable": false,
		})
	}

	// 三个内置库：并发读，各自超时，互不拖累。
	builtins := []crawlerLibraryView{
		{
			ID: crawlerLibraryAniSubs, Name: "AniSubs 番剧源", Kind: "subscription",
			Description: "ani-subs 订阅源（web-selector 抓站 / RSS）。",
			ConfigKey:   crawlerLibraryConfigKeys[crawlerLibraryAniSubs],
			Editable:    true,
			Note:        "留空使用内置订阅；每行一个订阅地址。",
			URLs:        urls[crawlerLibraryAniSubs],
		},
		{
			ID: crawlerLibraryKazumi, Name: "Kazumi 番剧源", Kind: "rule-pack",
			Description: "Kazumi 规则包（JSONPath + @var 模板）。",
			ConfigKey:   crawlerLibraryConfigKeys[crawlerLibraryKazumi],
			Editable:    true,
			Note:        "每行一个规则或索引地址。",
			URLs:        urls[crawlerLibraryKazumi],
		},
		{
			ID: crawlerLibraryCMS, Name: "TVBox 采集源", Kind: "protocol",
			Description: "TVBox / OK影视配置里的苹果 CMS 采集站。",
			ConfigKey:   crawlerLibraryConfigKeys[crawlerLibraryCMS],
			Editable:    true,
			Note:        "每行一个 TVBox 配置地址。",
			URLs:        urls[crawlerLibraryCMS],
		},
	}

	var wg sync.WaitGroup
	results := make([]crawlerLibraryView, len(builtins))
	for index, library := range builtins {
		wg.Add(1)
		go func(index int, library crawlerLibraryView) {
			defer wg.Done()
			results[index] = s.crawlerLibraryState(r.Context(), library)
		}(index, library)
	}
	wg.Wait()
	for _, result := range results {
		libraries = append(libraries, map[string]any{
			"id": result.ID, "name": result.Name, "kind": result.Kind,
			"description": result.Description, "available": result.Available,
			"error": result.Error, "count": result.Count,
			"configKey": result.ConfigKey, "editable": result.Editable,
			"urls": result.URLs, "sources": result.Sources, "note": result.Note,
		})
	}

	httpx.OK(w, map[string]any{"success": true, "libraries": libraries})
}

// crawlerLibraryState 读一个内置库的源列表。
func (s *Server) crawlerLibraryState(parent context.Context, library crawlerLibraryView) crawlerLibraryView {
	ctx, cancel := context.WithTimeout(parent, crawlerLibraryListTimeout)
	defer cancel()

	switch library.ID {
	case crawlerLibraryAniSubs:
		sources := s.AniSubs.List(ctx)
		library.Count = len(sources)
		library.Sources = make([]map[string]any, 0, len(sources))
		for _, source := range sources {
			library.Sources = append(library.Sources, map[string]any{"id": source.ID, "name": source.Name})
		}
		library.Available = len(sources) > 0
		if !library.Available {
			library.Error = "没有可用的订阅源"
		}
	case crawlerLibraryKazumi:
		sources, err := s.Kazumi.List(ctx)
		if err != nil {
			library.Error = err.Error()
			return library
		}
		library.Count = len(sources)
		library.Sources = make([]map[string]any, 0, len(sources))
		for _, source := range sources {
			library.Sources = append(library.Sources, map[string]any{"id": source.ID, "name": source.Name})
		}
		library.Available = len(sources) > 0
		if !library.Available {
			library.Error = "没有可用的规则包"
		}
	case crawlerLibraryCMS:
		sources, err := s.CMS.Sources(ctx)
		if err != nil {
			library.Error = err.Error()
			return library
		}
		library.Count = len(sources)
		library.Sources = make([]map[string]any, 0, len(sources))
		for _, source := range sources {
			library.Sources = append(library.Sources, map[string]any{"id": source.ID, "name": source.Name})
		}
		library.Available = len(sources) > 0
		if !library.Available {
			library.Error = "没有可用的采集站"
		}
	default:
		library.Error = "未知的来源库"
	}
	return library
}

// crawlerLibraryConfigURLs 读出三个内置库当前的地址列表。
//
// 读失败一律返回空表：这是展示用信息，配置本身在 GET /config 里还会再取一次，
// 不值得让整个列表接口 500。
func (s *Server) crawlerLibraryConfigURLs(ctx context.Context) map[string][]string {
	out := map[string][]string{}
	settings, err := s.Settings.Get(ctx)
	if err != nil || settings == nil {
		return out
	}
	config := map[string]any{}
	if len(settings.DataSourceConfig) > 0 {
		_ = json.Unmarshal(settings.DataSourceConfig, &config)
	}
	for library, key := range crawlerLibraryConfigKeys {
		raw, _ := config[key].([]any)
		urls := make([]string, 0, len(raw))
		for _, item := range raw {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				urls = append(urls, text)
			}
		}
		out[library] = urls
	}
	return out
}

func (s *Server) handleCrawlerLibraryConfigGet(w http.ResponseWriter, r *http.Request) {
	library := strings.TrimSpace(r.PathValue("id"))
	key, ok := crawlerLibraryConfigKeys[library]
	if !ok {
		httpx.Fail(w, http.StatusBadRequest, "该来源库没有可配置项")
		return
	}
	httpx.OK(w, map[string]any{
		"success": true, "library": library, "configKey": key,
		"urls": s.crawlerLibraryConfigURLs(r.Context())[library],
	})
}

// crawlerLibraryURLsBody 是 PUT 的请求体。地址列表为空表示「恢复默认」。
type crawlerLibraryURLsBody struct {
	URLs []string `json:"urls"`
}

// handleCrawlerLibraryConfigPut 写回一个内置库的地址列表。
//
// 只替换 dataSourceConfig 里的这一个键，其余键（动漫 RSS、第三方源等）原样保留——
// 界面只负责这一块，不能顺手把别人的配置抹掉。
func (s *Server) handleCrawlerLibraryConfigPut(w http.ResponseWriter, r *http.Request) {
	library := strings.TrimSpace(r.PathValue("id"))
	key, ok := crawlerLibraryConfigKeys[library]
	if !ok {
		httpx.Fail(w, http.StatusBadRequest, "该来源库没有可配置项")
		return
	}
	var body crawlerLibraryURLsBody
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	urls, err := normalizeCrawlerLibraryURLs(body.URLs)
	if err != nil {
		httpx.BadRequest(w, err.Error())
		return
	}

	settings, err := s.Settings.GetOrCreate(r.Context())
	if err != nil {
		httpx.InternalError(w, "PUT /api/crawler/libraries/{id}/config", err)
		return
	}
	config := map[string]any{}
	if len(settings.DataSourceConfig) > 0 {
		if unmarshalErr := json.Unmarshal(settings.DataSourceConfig, &config); unmarshalErr != nil {
			httpx.Fail(w, http.StatusInternalServerError, "现有数据源配置不是合法 JSON，已放弃写入")
			return
		}
	}
	items := make([]any, 0, len(urls))
	for _, url := range urls {
		items = append(items, url)
	}
	config[key] = items
	encoded, err := json.Marshal(config)
	if err != nil {
		httpx.InternalError(w, "PUT /api/crawler/libraries/{id}/config", err)
		return
	}
	settings.DataSourceConfig = encoded
	if err := s.Settings.Save(r.Context(), settings); err != nil {
		httpx.InternalError(w, "PUT /api/crawler/libraries/{id}/config", err)
		return
	}
	httpx.OK(w, map[string]any{
		"success": true, "library": library, "configKey": key, "urls": urls,
	})
}

// normalizeCrawlerLibraryURLs 清洗地址列表：去空白、去重、限长、只收 http(s)。
func normalizeCrawlerLibraryURLs(raw []string) ([]string, error) {
	if len(raw) > 30 {
		return nil, errCrawlerLibraryTooManyURLs
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		url := strings.TrimSpace(item)
		if url == "" {
			continue
		}
		if len(url) > 500 {
			return nil, errCrawlerLibraryURLTooLong
		}
		if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
			return nil, errCrawlerLibraryURLScheme
		}
		if seen[url] {
			continue
		}
		seen[url] = true
		out = append(out, url)
	}
	return out, nil
}

// ---------------------------------------------------------------- 统一搜索

// crawlerLibrarySearch 按库分派搜索，返回统一形状的行。
//
// 结果只带「能渲染一张卡片」的字段：library / source / sourceName / id / title /
// cover / description。选集、播放参数仍由各库自己的端点提供——这里不做跨库抽象。
func (s *Server) crawlerLibrarySearch(ctx context.Context, library, keyword string, limit int) ([]map[string]any, error) {
	switch library {
	case crawlerLibraryAniSubs:
		items, err := s.AniSubs.SearchAllCoalesced(ctx, keyword)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(items))
		for _, item := range items {
			out = append(out, map[string]any{
				"library": library, "source": item.Source, "sourceName": item.SourceName,
				"id": item.ID, "title": item.Title,
				"cover": optionalString(item.Cover), "description": optionalString(item.Description),
			})
		}
		return crawlerLimitItems(out, limit), nil
	case crawlerLibraryKazumi:
		return s.kazumiLibrarySearch(ctx, keyword, limit)
	case crawlerLibraryCMS:
		items, err := s.CMS.SearchAllCoalesced(ctx, keyword)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(items))
		for _, item := range items {
			out = append(out, map[string]any{
				"library": library, "source": item.Source, "sourceName": item.SiteName,
				"id": item.ID, "title": item.Title,
				"cover": item.Cover, "description": item.Description,
			})
		}
		return crawlerLimitItems(out, limit), nil
	default:
		return nil, errCrawlerLibraryUnknown
	}
}

// kazumiLibrarySearch 并发问所有 Kazumi 规则包（上限 6 路），单包失败只丢那一包。
func (s *Server) kazumiLibrarySearch(ctx context.Context, keyword string, limit int) ([]map[string]any, error) {
	sources, err := s.Kazumi.List(ctx)
	if err != nil {
		return nil, err
	}
	type kazumiHit struct {
		sourceID string
		source   string
		results  []map[string]any
	}
	hits := make([]kazumiHit, len(sources))
	semaphore := make(chan struct{}, 6)
	var wg sync.WaitGroup
	for index, source := range sources {
		wg.Add(1)
		go func(index int, id, name string) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			provider, getErr := s.Kazumi.Get(ctx, id)
			if getErr != nil || provider == nil {
				return
			}
			results, searchErr := provider.Search(ctx, keyword)
			if searchErr != nil {
				return
			}
			rows := make([]map[string]any, 0, len(results))
			for _, item := range results {
				rows = append(rows, map[string]any{
					"library": crawlerLibraryKazumi, "source": item.Source, "sourceName": name,
					"id": item.ID, "title": item.Title, "cover": optionalString(item.Cover),
				})
			}
			hits[index] = kazumiHit{sourceID: id, source: name, results: rows}
		}(index, source.ID, source.Name)
	}
	wg.Wait()

	out := []map[string]any{}
	for _, hit := range hits {
		out = append(out, hit.results...)
	}
	return crawlerLimitItems(out, limit), nil
}

// crawlerLimitItems 截断结果条数（limit<=0 表示不截断）。
func crawlerLimitItems(items []map[string]any, limit int) []map[string]any {
	if limit > 0 && len(items) > limit {
		return items[:limit]
	}
	if items == nil {
		return []map[string]any{}
	}
	return items
}

// optionalString 把可空字符串原样转成 JSON（nil 时整键消失）。
func optionalString(value *string) any {
	if value == nil || *value == "" {
		return nil
	}
	return *value
}
