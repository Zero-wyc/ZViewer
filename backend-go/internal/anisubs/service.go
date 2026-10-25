package anisubs

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"zviewer/backend/internal/store"
)

// provider 注册表，对应 services/anisubs/index.ts。

// SourceInfo 是 /sources 下发的一条。
type SourceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Service 是 ani-subs 数据源注册表。
type Service struct {
	settings *store.Settings

	mu        sync.Mutex
	providers []builtProvider
	hash      string
	// loaded 区分「还没构建过」与「构建出来是空的」——空注册表不缓存，
	// 下次请求要重试（订阅源恢复后不该等重启）。
	loaded bool
}

// NewService 构造服务。
func NewService(settings *store.Settings) *Service {
	return &Service{settings: settings}
}

// dataSourceConfig 是 settings 里与 anisubs 相关的那部分。
type dataSourceConfig struct {
	AniSubsSubscriptions []string `json:"aniSubsSubscriptions"`
}

// subscriptions 读取订阅 URL 列表：配置为空时回落内置默认订阅。
//
// 注意「配置了空数组」= 用默认订阅（Node 的 `Array.isArray && length > 0`
// 就是这么写的）。想一个源都不要的用户没有对应语义，这是既有行为。
func subscriptions(raw json.RawMessage) []string {
	if len(raw) > 0 && string(raw) != "null" {
		var config dataSourceConfig
		if err := json.Unmarshal(raw, &config); err == nil && len(config.AniSubsSubscriptions) > 0 {
			return config.AniSubsSubscriptions
		}
	}
	return defaultSubscriptions
}

// load 读取配置并按需重建注册表。
func (s *Service) load(ctx context.Context) []builtProvider {
	raw := json.RawMessage(nil)
	if settings, err := s.settings.Get(ctx); err != nil {
		log.Printf("[anisubs] 读取系统设置失败: %v", err)
	} else if settings != nil {
		raw = settings.DataSourceConfig
	}
	hash := string(raw)

	s.mu.Lock()
	if s.loaded && len(s.providers) > 0 && s.hash == hash {
		providers := s.providers
		s.mu.Unlock()
		return providers
	}
	s.mu.Unlock()

	built := buildProviders(ctx, subscriptions(raw))

	s.mu.Lock()
	s.providers = built
	s.hash = hash
	s.loaded = true
	s.mu.Unlock()
	return built
}

// List 列出所有数据源（顺序即订阅内顺序）。
func (s *Service) List(ctx context.Context) []SourceInfo {
	providers := s.load(ctx)
	sources := make([]SourceInfo, 0, len(providers))
	for _, provider := range providers {
		sources = append(sources, SourceInfo{ID: provider.ID, Name: provider.Provider.Name()})
	}
	return sources
}

// Get 按 id 取数据源；未知 id 返回 nil（路由层回 400「未知的数据源」）。
func (s *Service) Get(ctx context.Context, id string) Provider {
	for _, provider := range s.load(ctx) {
		if provider.ID == id {
			return provider.Provider
		}
	}
	return nil
}
