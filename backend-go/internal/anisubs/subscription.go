package anisubs

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
)

// 订阅获取与 provider 构建，对应 services/anisubs/subscription.ts。

// 内置订阅副本。
//
// 来源与 Node 侧 services/anisubs/default-*.json **逐字节相同**（含 UTF-8 BOM），
// 订阅本体挂在 Cloudflare 后面，远程拉取失败时这是最后一个可用性保障。
// 更新订阅时两边要一起换。
//
//go:embed data/default-css1.json
var defaultCSS1 []byte

//go:embed data/default-bt1.json
var defaultBT1 []byte

// defaultSubscriptions 是没配 aniSubsSubscriptions 时使用的默认订阅。
var defaultSubscriptions = []string{
	"https://sub.creamycake.org/v1/css1.json",
	"https://sub.creamycake.org/v1/bt1.json",
}

// decodeSubscription 解析订阅 JSON（容忍 UTF-8 BOM）。
//
// Node 的 JSON 加载器会吃掉 BOM，Go 的 json.Unmarshal 不会——两份内置订阅
// 都带 BOM，少了这一步会直接解析失败。
func decodeSubscription(body string) (*Subscription, error) {
	trimmed := bytes.TrimPrefix([]byte(body), []byte{0xEF, 0xBB, 0xBF})
	var subscription Subscription
	if err := json.Unmarshal(trimmed, &subscription); err != nil {
		return nil, err
	}
	return &subscription, nil
}

var (
	fallbackOnce sync.Once
	fallbackCSS1 *Subscription
	fallbackBT1  *Subscription
)

// localFallback 按 URL 取内置订阅副本（去掉 query/fragment 后比较）。
func localFallback(rawURL string) *Subscription {
	fallbackOnce.Do(func() {
		fallbackCSS1, _ = decodeSubscription(string(defaultCSS1))
		fallbackBT1, _ = decodeSubscription(string(defaultBT1))
	})
	clean := rawURL
	if idx := strings.IndexAny(clean, "?#"); idx >= 0 {
		clean = clean[:idx]
	}
	switch clean {
	case "https://sub.creamycake.org/v1/css1.json":
		return fallbackCSS1
	case "https://sub.creamycake.org/v1/bt1.json":
		return fallbackBT1
	}
	return nil
}

// unavailableDefaultSources 是默认订阅里**已知不可用**的源（审计日期 2026-10-12）。
//
// 只对默认订阅生效：自定义订阅是用户自己挑的，不做任何过滤。
var unavailableDefaultSources = map[string]struct{}{
	"稀饭动漫":          {},
	"girigiri愛動漫":   {},
	"E-ACG":         {},
	"去看吧":           {},
	"新优酷":           {},
	"hanime1_1080p": {},
	"hanime1_720p":  {},
	"风车影视":          {},
}

// DefaultSourceOverride 对默认订阅做兼容性修正，对应 defaultCompatibility.ts。
//
// 两件事：
//  1. bt1 订阅里的条目是 .torrent/magnet，浏览器播不了 → 整个订阅丢弃；
//  2. css1 里 TvTFun 的规则缺封面与分集选择器 → 补上（并改成 no-channel）。
//
// 返回 nil 表示该源要跳过。
func DefaultSourceOverride(rawURL string, source MediaSource) *MediaSource {
	clean := rawURL
	if idx := strings.IndexAny(clean, "?#"); idx >= 0 {
		clean = clean[:idx]
	}
	if clean == "https://sub.creamycake.org/v1/bt1.json" {
		return nil
	}
	if clean != "https://sub.creamycake.org/v1/css1.json" {
		return &source
	}
	if _, blocked := unavailableDefaultSources[source.Arguments.Name]; blocked {
		return nil
	}
	if source.Arguments.Name != "TvTFun" || source.Arguments.SearchConfig == nil {
		return &source
	}

	patch := *source.Arguments.SearchConfig
	jsonPath := SubjectFormatJSONPathIndexed{SelectCovers: "$.data.videos[*].pic"}
	if patch.SelectorSubjectFormatJSONPathIndexed != nil {
		jsonPath = *patch.SelectorSubjectFormatJSONPathIndexed
		jsonPath.SelectCovers = "$.data.videos[*].pic"
	}
	patch.SelectorSubjectFormatJSONPathIndexed = &jsonPath
	patch.ChannelFormatID = "no-channel"
	patch.SelectorChannelFormatNoChannel = &ChannelFormatNoChannel{
		SelectEpisodes:           `a[href*="/play?source="]`,
		MatchEpisodeSortFromName: `第\s*(?<ep>\d+)\s*集`,
	}

	patched := source
	patched.Arguments.SearchConfig = &patch
	return &patched
}

// builtProvider 是一个构建好的数据源。
type builtProvider struct {
	ID       string
	Provider Provider
}

// buildProviderFromMediaSource 从单个媒体源构建 provider；不支持的 factory 返回 nil。
func buildProviderFromMediaSource(source *MediaSource, index int) *builtProvider {
	name := source.Arguments.Name
	// id 里带下标：订阅允许重名，名称只负责显示。
	id := "ani_subs_" + source.FactoryID + "_" + strconv.Itoa(index)

	config := source.Arguments.SearchConfig
	if config == nil {
		return nil
	}
	if source.FactoryID == "rss" {
		if config.SearchURL == "" {
			return nil
		}
		return &builtProvider{ID: id, Provider: NewRSSProvider(id, name, config.SearchURL)}
	}
	if source.FactoryID == "web-selector" {
		return &builtProvider{ID: id, Provider: NewWebSelectorProvider(id, name, config)}
	}
	return nil
}

// BuildProvidersFromSubscription 把一个订阅展开成 provider 列表（保持订阅内顺序）。
func BuildProvidersFromSubscription(subscription *Subscription, transform func(string, MediaSource) *MediaSource, sourceURL string) []builtProvider {
	providers := make([]builtProvider, 0, 16)
	if subscription == nil || subscription.ExportedMediaSourceDataList == nil {
		return providers
	}
	for index, source := range subscription.ExportedMediaSourceDataList.MediaSources {
		normalized := &source
		if transform != nil {
			normalized = transform(sourceURL, source)
		}
		if normalized == nil {
			continue
		}
		if built := buildProviderFromMediaSource(normalized, index); built != nil {
			providers = append(providers, *built)
		}
	}
	return providers
}

// buildProviders 拉取所有订阅并构建注册表。
//
// 单个订阅失败只跳过它：一个订阅挂掉不该让整个 /sources 变空。
func buildProviders(ctx context.Context, urls []string) []builtProvider {
	providers := make([]builtProvider, 0, 32)
	seen := make(map[string]struct{}, 32)
	for _, rawURL := range urls {
		if strings.TrimSpace(rawURL) == "" {
			continue
		}
		subscription, err := FetchSubscription(ctx, rawURL)
		if err != nil {
			continue
		}
		for _, built := range BuildProvidersFromSubscription(subscription, DefaultSourceOverride, rawURL) {
			// 后者覆盖前者（与 Node 的 Object.assign 一致），但保留首次出现的位置。
			if _, exists := seen[built.ID]; exists {
				for i := range providers {
					if providers[i].ID == built.ID {
						providers[i] = built
						break
					}
				}
				continue
			}
			seen[built.ID] = struct{}{}
			providers = append(providers, built)
		}
	}
	return providers
}
