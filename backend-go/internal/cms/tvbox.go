package cms

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TVBox 配置加载，对应 services/cms/tvboxConfigLoader.ts。
//
// 管理员在后台填的是 TVBox/OK影视 的「接口」地址（如 https://xxx/jsm.json），
// 里面 sites 数组混着各种 type；这里只挑 type === 1 且 api 形如苹果 CMS 的站点。

const (
	// configTimeout 与 Node 的 CONFIG_TIMEOUT_MS 一致。
	configTimeout = 20 * time.Second
	// configCacheTTL 是配置缓存时长（TVBox 配置一天漂移一两次，10 分钟足够）。
	configCacheTTL = 10 * time.Minute
	// maxRedirectDepth 是「跳转配置」的最大递归深度。
	maxRedirectDepth = 2
	// githubCDNBase 是 GitHub 加速前缀（与 utils/githubCdn.ts 一致）。
	githubCDNBase = "https://gh-proxy.com"
)

var (
	// cmsAPIHostPattern 判断 api 是否为 http(s) 地址。
	cmsAPIHostPattern = regexp.MustCompile(`(?i)^https?://`)
	// cmsAPIPathPattern 判断 api 是否像苹果 CMS 采集接口。
	//
	// 常见形态：.../api.php/provide/vod、.../provide/vod/at/json、
	// .../api.php/provide/vod/from/dbm3u8/
	cmsAPIPathPattern = regexp.MustCompile(`(?i)provide[./]vod|api\.php`)
)

// ProxyGitHubURL 把 GitHub 地址改写成 CDN 前缀（非 GitHub 原样返回）。
func ProxyGitHubURL(raw string) string {
	if raw == "" {
		return raw
	}
	for _, prefix := range []string{
		"https://github.com/",
		"https://raw.githubusercontent.com/",
		"https://api.github.com/",
	} {
		if strings.HasPrefix(raw, prefix) {
			return githubCDNBase + "/" + raw
		}
	}
	return raw
}

// IsCMSAPI 判断 api 是否为苹果 CMS JSON 采集接口形态。
func IsCMSAPI(api string) bool {
	if !cmsAPIHostPattern.MatchString(api) {
		return false
	}
	return cmsAPIPathPattern.MatchString(api)
}

// ExtractSite 从 TVBox sites 条目提取 CMS 站点；不匹配返回 (Site{}, false)。
func ExtractSite(entry map[string]any) (Site, bool) {
	// type 必须是数字 1：字符串 "1" 在 JS 里 `!== 1` 成立，同样会被过滤掉。
	if number, ok := entry["type"].(float64); !ok || number != 1 {
		return Site{}, false
	}
	api := asString(entry["api"])
	name := asString(entry["name"])
	key := asString(entry["key"])
	if api == "" || !IsCMSAPI(api) || name == "" || key == "" {
		return Site{}, false
	}
	// searchable !== 0：缺省视为可搜索（TVBox 的默认值就是 1）。
	searchable := true
	if raw, ok := entry["searchable"]; ok {
		if number, ok := raw.(float64); ok && number == 0 {
			searchable = false
		}
	}
	return Site{Key: key, Name: name, API: api, Searchable: searchable}, true
}

// configLoader 是带 TTL + 单飞 + 过期兜底的配置加载器。
type configLoader struct {
	mu       sync.Mutex
	cache    map[string]configCacheEntry
	inflight map[string]*configCall
}

type configCacheEntry struct {
	sites     []Site
	fetchedAt time.Time
}

type configCall struct {
	done  chan struct{}
	sites []Site
	err   error
}

func newConfigLoader() *configLoader {
	return &configLoader{
		cache:    make(map[string]configCacheEntry, 8),
		inflight: make(map[string]*configCall, 4),
	}
}

// Load 获取配置中的 CMS 站点。
//
// 失败时若有过期缓存则回退旧数据：TVBox 配置源本身可用性波动很大，
// 拉不到就让整站「一个源都没有」是最差的降级方式。
func (l *configLoader) Load(ctx context.Context, configURL string, forceRefresh bool) ([]Site, error) {
	key := strings.TrimSpace(configURL)
	if key == "" {
		return nil, fmt.Errorf("配置地址为空")
	}

	l.mu.Lock()
	cached, hasCached := l.cache[key]
	if !forceRefresh && hasCached && time.Since(cached.fetchedAt) < configCacheTTL {
		l.mu.Unlock()
		return cached.sites, nil
	}
	if call, ok := l.inflight[key]; ok {
		l.mu.Unlock()
		<-call.done
		return call.sites, call.err
	}
	call := &configCall{done: make(chan struct{})}
	l.inflight[key] = call
	l.mu.Unlock()

	sites, err := l.loadConfigSites(ctx, key, 0)

	l.mu.Lock()
	if err != nil {
		if hasCached && len(cached.sites) > 0 {
			log.Printf("[cms] 配置拉取失败，使用过期缓存: %s (%v)", key, err)
			sites, err = cached.sites, nil
		}
	} else {
		l.cache[key] = configCacheEntry{sites: sites, fetchedAt: time.Now()}
	}
	call.sites, call.err = sites, err
	delete(l.inflight, key)
	close(call.done)
	l.mu.Unlock()

	return sites, err
}

// Clear 清空配置缓存（管理端保存 cmsSources 时触发）。
func (l *configLoader) Clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cache = make(map[string]configCacheEntry, 8)
	l.inflight = make(map[string]*configCall, 4)
}

// loadConfigSites 拉取并解析单个 TVBox 配置 URL。
func (l *configLoader) loadConfigSites(ctx context.Context, configURL string, depth int) ([]Site, error) {
	if depth > maxRedirectDepth {
		return nil, nil
	}

	result := fetchText(ctx, ProxyGitHubURL(configURL), map[string]string{
		"User-Agent": DefaultUserAgent,
		"Accept":     "application/json",
	}, configTimeout)
	if !result.OK {
		suffix := ""
		if result.Error != "" {
			suffix = " (" + result.Error + ")"
		}
		return nil, fmt.Errorf("拉取配置失败 [%d]: %s%s", result.Status, configURL, suffix)
	}

	var config map[string]any
	if err := json.Unmarshal([]byte(result.Body), &config); err != nil {
		return nil, fmt.Errorf("配置 JSON 解析失败: %s", configURL)
	}

	urls, hasURLs := config["urls"].([]any)
	_, hasSites := config["sites"].([]any)
	if hasURLs && !hasSites {
		nested := make([]string, 0, len(urls))
		for _, entry := range urls {
			item, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if raw := asString(item["url"]); raw != "" {
				nested = append(nested, raw)
			}
		}
		if len(nested) == 0 {
			return nil, fmt.Errorf("配置为空跳转（urls 无有效地址）: %s", configURL)
		}

		base, _ := url.Parse(configURL)
		resolved := make([]string, 0, len(nested))
		for _, item := range nested {
			target, err := url.Parse(item)
			if err != nil || base == nil {
				resolved = append(resolved, item)
				continue
			}
			resolved = append(resolved, base.ResolveReference(target).String())
		}

		var (
			all      []Site
			firstErr error
			wg       sync.WaitGroup
			mu       sync.Mutex
			results  = make([][]Site, len(resolved))
		)
		for index, target := range resolved {
			wg.Add(1)
			go func(i int, target string) {
				defer wg.Done()
				sites, err := l.loadConfigSites(ctx, target, depth+1)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					if firstErr == nil {
						firstErr = err
					}
					return
				}
				results[i] = sites
			}(index, target)
		}
		wg.Wait()
		for _, sites := range results {
			all = append(all, sites...)
		}
		if len(all) == 0 {
			if firstErr != nil {
				return nil, fmt.Errorf("跳转配置全部失效: %v", firstErr)
			}
			return nil, fmt.Errorf("跳转配置中没有 CMS 采集源: %s", configURL)
		}
		return all, nil
	}

	sitesRaw, ok := config["sites"].([]any)
	if !ok {
		return nil, fmt.Errorf("配置中没有 sites 字段: %s", configURL)
	}
	sites := make([]Site, 0, len(sitesRaw))
	for _, raw := range sitesRaw {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if site, ok := ExtractSite(entry); ok {
			sites = append(sites, site)
		}
	}
	return sites, nil
}

// asString 复刻 JS 的 `typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ”`。
func asString(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		// JSON 数字统一是 float64：整数值要输出 "1" 而不是 "1.000000"。
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	default:
		return ""
	}
}
