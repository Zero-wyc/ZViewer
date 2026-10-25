package danmaku

import "zviewer/backend/internal/bilibili"

// 弹幕源注册表，对应 services/danmaku/index.ts。
//
// 四个源都是内置的（不像动漫源那样来自配置），顺序即 /sources 的返回顺序。
// providerOrder 用切片而不是 map，是因为 Node 侧读的是 Object.entries 的
// 插入序，前端按这个顺序渲染下拉框。

// Service 是弹幕源注册表。
type Service struct {
	bili      *bilibili.Service
	providers map[string]Provider
	order     []string
}

// NewService 构造注册表。
func NewService(bili *bilibili.Service) *Service {
	service := &Service{
		bili:      bili,
		providers: make(map[string]Provider, 4),
		order:     make([]string, 0, 4),
	}
	for _, entry := range []struct {
		id       string
		provider Provider
	}{
		{"bilibili-video", &biliVideoProvider{bili: bili}},
		{"bilibili-bangumi", &biliBangumiProvider{bili: bili}},
		{"bahamut", &bahamutProvider{}},
		{"dandanplay", &dandanplayProvider{}},
	} {
		service.providers[entry.id] = entry.provider
		service.order = append(service.order, entry.id)
	}
	return service
}

// Get 按 id 取 provider；不存在返回 nil。
func (s *Service) Get(id string) Provider {
	return s.providers[id]
}

// List 列出全部弹幕源。
func (s *Service) List() []Source {
	sources := make([]Source, 0, len(s.order))
	for _, id := range s.order {
		sources = append(sources, Source{ID: id, Name: s.providers[id].Name()})
	}
	return sources
}

// 编译期确认四个实现都满足接口。
var (
	_ Provider = (*biliVideoProvider)(nil)
	_ Provider = (*biliBangumiProvider)(nil)
	_ Provider = (*bahamutProvider)(nil)
	_ Provider = (*dandanplayProvider)(nil)
)
