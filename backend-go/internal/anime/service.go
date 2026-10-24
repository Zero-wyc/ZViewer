package anime

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/store"
)

// 动漫源注册表，对应 services/anime/index.ts。
//
// 内置源只有 B站番剧；RSS 与第三方源来自
// system_settings.dataSourceConfig（rssSources / thirdPartySources）。
// 配置一变（JSON 内容不同）就整表重建——Node 侧用 JSON.stringify 做指纹，
// 这里直接用原始 JSON 字节，语义等价且不用先反序列化再序列化。

// SourceInfo 是 /sources 下发的一条。
type SourceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Service 是动漫源注册表。
type Service struct {
	settings *store.Settings
	bilibili *bilibili.Service

	mu        sync.Mutex
	providers map[string]Provider
	order     []string
	hash      string
}

// NewService 构造服务。
func NewService(settings *store.Settings, bili *bilibili.Service) *Service {
	return &Service{
		settings:  settings,
		bilibili:  bili,
		providers: make(map[string]Provider, 8),
	}
}

// rssSourceEntry 是配置里的一个 RSS 源。
type rssSourceEntry struct {
	ID   any    `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

// thirdPartySourceEntry 是配置里的一个第三方源。
type thirdPartySourceEntry struct {
	ID        any                  `json:"id"`
	Name      string               `json:"name"`
	BaseURL   string               `json:"baseUrl"`
	Endpoints *ThirdPartyEndpoints `json:"endpoints"`
}

// dataSourceConfig 是 settings 里与动漫源相关的那部分。
type dataSourceConfig struct {
	RSSSources        []rssSourceEntry        `json:"rssSources"`
	ThirdPartySources []thirdPartySourceEntry `json:"thirdPartySources"`
}

// load 读取配置并按需重建注册表。
func (s *Service) load(ctx context.Context) (map[string]Provider, []string) {
	settings, err := s.settings.Get(ctx)
	if err != nil {
		log.Printf("[anime] 读取系统设置失败: %v", err)
	}
	raw := json.RawMessage(nil)
	if settings != nil {
		raw = settings.DataSourceConfig
	}
	hash := string(raw)

	s.mu.Lock()
	if s.providers != nil && len(s.order) > 0 && s.hash == hash {
		providers, order := s.providers, s.order
		s.mu.Unlock()
		return providers, order
	}
	s.mu.Unlock()

	var config dataSourceConfig
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &config); err != nil {
			log.Printf("[anime] dataSourceConfig 解析失败: %v", err)
			config = dataSourceConfig{}
		}
	}

	providers := make(map[string]Provider, len(config.RSSSources)+len(config.ThirdPartySources)+1)
	order := make([]string, 0, len(config.RSSSources)+len(config.ThirdPartySources)+1)

	// 内置源永远排第一，其余按配置顺序。
	providers[BilibiliSourceID] = newBilibiliProvider(s.bilibili)
	order = append(order, BilibiliSourceID)

	for _, source := range config.RSSSources {
		id := JSString(source.ID)
		if id == "" || source.URL == "" {
			continue
		}
		name := source.Name
		if name == "" {
			name = "RSS: " + id
		}
		key := "rss_" + id
		providers[key] = newRSSProvider(key, name, source.URL)
		order = append(order, key)
	}

	for _, source := range config.ThirdPartySources {
		id := JSString(source.ID)
		if id == "" {
			continue
		}
		name := source.Name
		if name == "" {
			name = "第三方: " + id
		}
		endpoints := ThirdPartyEndpoints{}
		if source.Endpoints != nil {
			endpoints = *source.Endpoints
		}
		key := "third_party_" + id
		providers[key] = newThirdPartyProvider(key, name, ThirdPartyConfig{
			BaseURL:   source.BaseURL,
			Endpoints: endpoints,
		})
		order = append(order, key)
	}

	s.mu.Lock()
	s.providers = providers
	s.order = order
	s.hash = hash
	s.mu.Unlock()
	return providers, order
}

// List 列出所有数据源（顺序即配置顺序）。
func (s *Service) List(ctx context.Context) ([]SourceInfo, error) {
	providers, order := s.load(ctx)
	sources := make([]SourceInfo, 0, len(order))
	for _, key := range order {
		sources = append(sources, SourceInfo{ID: key, Name: providers[key].Name()})
	}
	return sources, nil
}

// Get 按 id 取数据源；未知 id 返回 nil（路由层回 400「未知的番剧数据源」）。
func (s *Service) Get(ctx context.Context, id string) Provider {
	providers, _ := s.load(ctx)
	return providers[id]
}
