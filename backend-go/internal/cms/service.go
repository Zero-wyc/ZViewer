package cms

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"zviewer/backend/internal/store"
)

// CMS 采集源注册表，对应 services/cms/index.ts。
//
// 源站列表来自 SystemSettings.dataSourceConfig.cmsSources（TVBox 配置 URL 数组），
// 不内置任何默认源——「默认源」这种东西一旦写死，源站换了就得发版。

// resolveCacheTTLMs 是解析结果缓存时长（6 分钟）。
//
// 采集站解析（详情 API + 播放页抓取）较慢，拉长窗口让多人同集共享一次解析；
// 采集直链普遍只有几分钟时效，6 分钟窗口内复用一般安全。
const resolveCacheTTLMs = 6 * 60 * 1000

// resolveCacheSize 是解析缓存容量上限。
const resolveCacheSize = 500

// aggregatePerSourceLimit 是聚合搜索里单站取几条。
const aggregatePerSourceLimit = 15

// Service 是 CMS 数据源注册表。
type Service struct {
	settings *store.Settings
	loader   *configLoader
	resolve  *resolveCache[*PlaybackURL]

	mu        sync.Mutex
	providers map[string]*Provider
	order     []string
	hash      string

	inflightMu     sync.Mutex
	searchInflight map[string]*searchCall
}

// searchCall 是一次聚合搜索的在飞请求。
type searchCall struct {
	done    chan struct{}
	results []AggregateResult
	err     error
}

// NewService 构造服务。
func NewService(settings *store.Settings) *Service {
	return &Service{
		settings:       settings,
		loader:         newConfigLoader(),
		resolve:        newResolveCache[*PlaybackURL](resolveCacheTTLMs, resolveCacheSize),
		providers:      make(map[string]*Provider, 16),
		searchInflight: make(map[string]*searchCall, 4),
	}
}

// dataSourceConfig 是 settings 里与 CMS 相关的那部分。
type dataSourceConfig struct {
	CMSources []string `json:"cmsSources"`
}

// configURLs 读取并清洗配置 URL 列表（去空白、丢空串）。
func configURLs(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var config dataSourceConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil
	}
	urls := make([]string, 0, len(config.CMSources))
	for _, item := range config.CMSources {
		trimmed := strings.TrimSpace(item)
		if trimmed != "" {
			urls = append(urls, trimmed)
		}
	}
	return urls
}

// Providers 返回 provider 有序列表（顺序即配置顺序，聚合搜索依赖它稳定）。
func (s *Service) Providers(ctx context.Context) ([]*Provider, error) {
	settings, err := s.settings.Get(ctx)
	if err != nil {
		return nil, err
	}
	urls := configURLs(settings.DataSourceConfig)

	encoded, _ := json.Marshal(urls)
	hash := string(encoded)

	s.mu.Lock()
	if len(s.providers) > 0 && s.hash == hash {
		providers := make([]*Provider, 0, len(s.order))
		for _, key := range s.order {
			providers = append(providers, s.providers[key])
		}
		s.mu.Unlock()
		return providers, nil
	}
	s.mu.Unlock()

	// 空表不缓存（Node 侧同样的取舍：配置刚补上时下一次请求要能立刻生效）。
	built := make(map[string]*Provider, 16)
	builtOrder := make([]string, 0, 16)
	for configIndex, configURL := range urls {
		sites, err := s.loader.Load(ctx, configURL, false)
		if err != nil {
			log.Printf("[cms] 配置加载失败: %s (%v)", configURL, err)
			continue
		}
		for _, site := range sites {
			key := fmt.Sprintf("cms%d_%s", configIndex, site.Key)
			// 重复 key（同配置内/跨配置碰撞）时追加序号保证唯一。
			if _, exists := built[key]; exists {
				key = key + "_" + strconv.Itoa(len(built))
			}
			built[key] = NewProvider(Site{
				Key:        key,
				Name:       site.Name,
				API:        site.API,
				Searchable: site.Searchable,
			})
			builtOrder = append(builtOrder, key)
		}
		log.Printf("[cms] 配置加载成功: %s → %d 个 CMS 站点", configURL, len(sites))
	}

	s.mu.Lock()
	s.providers = built
	s.order = builtOrder
	s.hash = hash
	s.mu.Unlock()

	providers := make([]*Provider, 0, len(builtOrder))
	for _, key := range builtOrder {
		providers = append(providers, built[key])
	}
	return providers, nil
}

// Provider 按注册键取单个 provider。
func (s *Service) Provider(ctx context.Context, key string) (*Provider, error) {
	providers, err := s.Providers(ctx)
	if err != nil {
		return nil, err
	}
	for _, provider := range providers {
		if provider.Site.Key == key {
			return provider, nil
		}
	}
	return nil, nil
}

// Sources 列出可用数据源。
func (s *Service) Sources(ctx context.Context) ([]Source, error) {
	providers, err := s.Providers(ctx)
	if err != nil {
		return nil, err
	}
	sources := make([]Source, 0, len(providers))
	for _, provider := range providers {
		sources = append(sources, Source{ID: provider.Site.Key, Name: provider.Site.Name})
	}
	return sources, nil
}

// LoadConfigSites 直接加载某个 TVBox 配置（管理端 inspect 用）。
func (s *Service) LoadConfigSites(ctx context.Context, configURL string, forceRefresh bool) ([]Site, error) {
	return s.loader.Load(ctx, configURL, forceRefresh)
}

// ClearCache 清空注册表与配置缓存（管理端保存 cmsSources 时调用）。
func (s *Service) ClearCache() {
	s.mu.Lock()
	s.providers = make(map[string]*Provider, 16)
	s.order = nil
	s.hash = ""
	s.mu.Unlock()
	s.loader.Clear()
	s.resolve = newResolveCache[*PlaybackURL](resolveCacheTTLMs, resolveCacheSize)
}

// titleNoisePattern 是聚合去重时忽略的空白/标点/符号。
var titleNoisePattern = regexp.MustCompile(`[\s\p{P}\p{S}]+`)

// normalizeTitle 标题归一化（小写 + 去空白/标点/符号）。
func normalizeTitle(title string) string {
	return titleNoisePattern.ReplaceAllString(strings.ToLower(title), "")
}

// SearchAll 聚合搜索全部站点。
//
// 并发查询、单站失败不影响整体（allSettled 语义）；按归一化标题去重，
// 同名影片保留备注更完整的一方（「更新至第x集」这种信息更有价值）。
func (s *Service) SearchAll(ctx context.Context, keyword string) ([]AggregateResult, error) {
	providers, err := s.Providers(ctx)
	if err != nil {
		return nil, err
	}
	if len(providers) == 0 {
		return []AggregateResult{}, nil
	}

	results := make([][]SearchResult, len(providers))
	var wg sync.WaitGroup
	for index, provider := range providers {
		wg.Add(1)
		go func(i int, p *Provider) {
			defer wg.Done()
			items, err := p.Search(ctx, keyword)
			if err != nil {
				log.Printf("[cms] 聚合搜索失败 %s: %v", p.Site.Key, err)
				return
			}
			if len(items) > aggregatePerSourceLimit {
				items = items[:aggregatePerSourceLimit]
			}
			results[i] = items
		}(index, provider)
	}
	wg.Wait()

	merged := make([]AggregateResult, 0, 32)
	seen := make(map[string]int, 32)
	for index, items := range results {
		siteName := providers[index].Site.Name
		for _, item := range items {
			if item.ID == "" || item.Title == "" {
				continue
			}
			key := normalizeTitle(item.Title)
			if existingIndex, ok := seen[key]; ok {
				existing := &merged[existingIndex]
				if existing.Remark == "" && item.Remark != "" {
					existing.Remark = item.Remark
					if existing.Cover == "" {
						existing.Cover = item.Cover
					}
				}
				continue
			}
			seen[key] = len(merged)
			merged = append(merged, AggregateResult{
				ID:          item.Source + "::" + item.ID,
				Source:      item.Source,
				SiteName:    siteName,
				VodID:       item.ID,
				Title:       item.Title,
				Cover:       item.Cover,
				Description: item.Description,
				Remark:      item.Remark,
			})
		}
	}
	return merged, nil
}

// SearchAllCoalesced 合并同一关键词的并发聚合搜索（对应路由层的 inflight map）。
func (s *Service) SearchAllCoalesced(ctx context.Context, keyword string) ([]AggregateResult, error) {
	s.inflightMu.Lock()
	if call, ok := s.searchInflight[keyword]; ok {
		s.inflightMu.Unlock()
		<-call.done
		return call.results, call.err
	}
	call := &searchCall{done: make(chan struct{})}
	s.searchInflight[keyword] = call
	s.inflightMu.Unlock()

	results, err := s.SearchAll(ctx, keyword)

	s.inflightMu.Lock()
	call.results, call.err = results, err
	delete(s.searchInflight, keyword)
	close(call.done)
	s.inflightMu.Unlock()
	return results, err
}

// NormalizePlaybackParams 规范化 resolve 请求体（对应路由层的 normalizePlaybackParams）。
//
// 注意 vodId 不 trim：Node 是 `String(body?.vodId ?? ”)`，多余空白会原样
// 进采集接口——看着不合理，但它是既有行为。
func NormalizePlaybackParams(raw map[string]any) PlaybackParams {
	params := PlaybackParams{VodID: jsString(raw["vodId"])}
	if value, ok := jsNumber(raw["playFromIndex"]); ok {
		params.PlayFromIndex = int(value)
	}
	if value, ok := jsNumber(raw["episodeIndex"]); ok {
		params.EpisodeIndex = int(value)
	}
	return params
}

// Resolve 解析播放地址（6 分钟缓存 + 单飞）。
func (s *Service) Resolve(ctx context.Context, provider *Provider, params PlaybackParams) (*PlaybackURL, error) {
	key := fmt.Sprintf("%s|%s|%d|%d", provider.Site.Key, params.VodID, params.PlayFromIndex, params.EpisodeIndex)
	return s.resolve.run(key, func() (*PlaybackURL, error) {
		result, err := provider.PlaybackURL(ctx, params)
		if err != nil {
			return nil, err
		}
		if result == nil {
			// 失败不缓存：错误会传播给所有等待者，下一次请求自动重试。
			return nil, fmt.Errorf("无法解析播放地址")
		}
		return result, nil
	})
}

// jsString 复刻 `String(v ?? ”)` 在 JSON 输入上的语义。
func jsString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprint(v)
	}
}

// jsNumber 复刻 `Number(v) || 0`（NaN/0 都落回 0）。
//
// JSON 数字解出来是 float64；字符串形态（前端偶尔会传 "1"）按 Number 语义解析。
func jsNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		if v != v { // NaN
			return 0, false
		}
		return v, true
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
	case bool:
		if v {
			return 1, true
		}
		return 0, false
	}
	return 0, false
}
