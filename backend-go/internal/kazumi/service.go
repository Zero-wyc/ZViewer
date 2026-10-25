package kazumi

import (
	"context"
	"encoding/json"
	"sync"

	"zviewer/backend/internal/store"
)

// Kazumi 数据源注册表，对应 services/kazumi/index.ts。
//
// 规则地址来自 SystemSettings.dataSourceConfig.kazumiRules；配置一变就整表
// 重建。空表**不进缓存**——「配置刚补上但下一次请求还用旧表」是最难查的
// 那类问题（Node 侧同样是这个取舍）。

// Source 是一个可选数据源。
type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// dataSourceConfig 只取 kazumi 关心的字段。
type dataSourceConfig struct {
	KazumiRules []string `json:"kazumiRules"`
}

// Service 是 Kazumi 规则源注册表。
type Service struct {
	settings *store.Settings

	mu        sync.Mutex
	providers map[string]Provider
	order     []string
	hash      string
}

// NewService 构造服务。
func NewService(settings *store.Settings) *Service {
	return &Service{
		settings:  settings,
		providers: make(map[string]Provider, 16),
	}
}

// ruleURLs 读取并清洗规则地址列表。
func ruleURLs(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return defaultRules
	}
	var config dataSourceConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return defaultRules
	}
	// 数据库里可能存了空的 kazumiRules: []，此时仍用默认规则。
	if len(config.KazumiRules) == 0 {
		return defaultRules
	}
	urls := make([]string, 0, len(config.KazumiRules))
	for _, item := range config.KazumiRules {
		if item != "" {
			urls = append(urls, item)
		}
	}
	if len(urls) == 0 {
		return defaultRules
	}
	return urls
}

// snapshot 取当前注册表（必要时重建）。
func (s *Service) snapshot(ctx context.Context) (*registry, error) {
	settings, err := s.settings.Get(ctx)
	if err != nil {
		return nil, err
	}
	urls := ruleURLs(settings.DataSourceConfig)
	// Node 把整份 dataSourceConfig 序列化后哈希，任何字段变动都会重建；
	// 这里直接用原始字节，语义相同且省一次序列化。
	hash := string(settings.DataSourceConfig)

	s.mu.Lock()
	if len(s.providers) > 0 && s.hash == hash {
		cached := &registry{
			providers: s.providers,
			order:     append([]string(nil), s.order...),
		}
		s.mu.Unlock()
		return cached, nil
	}
	s.mu.Unlock()

	built := buildProvidersFromRules(ctx, urls)

	s.mu.Lock()
	s.providers = built.providers
	s.order = built.order
	s.hash = hash
	s.mu.Unlock()
	return built, nil
}

// List 列出可用数据源（顺序即规则展开顺序）。
func (s *Service) List(ctx context.Context) ([]Source, error) {
	snapshot, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	sources := make([]Source, 0, len(snapshot.order))
	for _, id := range snapshot.order {
		provider := snapshot.providers[id]
		if provider == nil {
			continue
		}
		sources = append(sources, Source{ID: id, Name: provider.Name()})
	}
	return sources, nil
}

// Get 按 id 取 provider；不存在返回 nil。
func (s *Service) Get(ctx context.Context, id string) (Provider, error) {
	snapshot, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	return snapshot.providers[id], nil
}

// ClearCache 清空注册表（管理端保存 kazumiRules 时调用）。
func (s *Service) ClearCache() {
	s.mu.Lock()
	s.providers = make(map[string]Provider, 16)
	s.order = nil
	s.hash = ""
	s.mu.Unlock()
}
