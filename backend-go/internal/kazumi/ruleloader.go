package kazumi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/webfetch"
)

// 规则获取与 provider 构建，对应 services/kazumi/ruleLoader.ts。

// defaultRules 是没有配置时用的官方规则列表。
var defaultRules = []string{
	"https://raw.githubusercontent.com/Predidit/KazumiRules/main/DM84.json",
	"https://raw.githubusercontent.com/Predidit/KazumiRules/main/MXdm.json",
	"https://raw.githubusercontent.com/Predidit/KazumiRules/main/xfdmneo.json",
}

// officialRepositorySources 把「仓库地址」展开成具体规则文件。
//
// 用户在配置里填的是仓库主页（复制地址栏那种），后端要认出来并换成规则文件；
// 认不出来时当作普通 URL 直接取 JSON。
var officialRepositorySources = map[string][]string{
	"https://github.com/Predidit/Kazumi": {
		"https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/DM84.json",
		"https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/7sefun.json",
	},
	"https://github.com/Predidit/KazumiRules": {
		"https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json",
	},
}

// ruleFetchTimeout 与 Node 的 fetchText 默认值一致（20s）。
const ruleFetchTimeout = 20 * time.Second

// errInvalidRule 表示规则 JSON 缺字段（路由层回 502）。
var errInvalidRule = errors.New("规则格式不正确（缺少 name/baseURL，且无 searchURL 或 api 搜索配置）")

// normalizeRepositoryURL 去掉 `.git` 后缀与结尾斜杠。
func normalizeRepositoryURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasSuffix(trimmed, ".git/") {
		trimmed = strings.TrimSuffix(trimmed, ".git/")
	} else if strings.HasSuffix(trimmed, ".git") {
		trimmed = strings.TrimSuffix(trimmed, ".git")
	}
	return strings.TrimSuffix(trimmed, "/")
}

// fetchRuleDocument 取一份规则 JSON（数组=索引，对象=规则）。
func fetchRuleDocument(ctx context.Context, rawURL string) (any, error) {
	proxied := webfetch.ProxyGitHubURL(rawURL)
	result := webfetch.Fetch(ctx, proxied, webfetch.Options{
		Headers: map[string]string{
			"User-Agent": defaultUserAgent,
			"Accept":     "application/json",
		},
		Timeout: ruleFetchTimeout,
	})
	if !result.OK {
		return nil, fmt.Errorf("获取规则失败 [%d]: %s%s", result.Status, proxied, requestErrorSuffix(result))
	}
	var document any
	if err := json.Unmarshal([]byte(result.Body), &document); err != nil {
		return nil, errors.New("规则 JSON 解析失败")
	}
	return document, nil
}

// fetchRule 取一份规则并校验必填字段。
func fetchRule(ctx context.Context, rawURL string) (*Rule, error) {
	document, err := fetchRuleDocument(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	raw, ok := document.(map[string]any)
	if !ok {
		return nil, errInvalidRule
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, errInvalidRule
	}
	rule := &Rule{}
	if err := json.Unmarshal(encoded, rule); err != nil {
		return nil, errInvalidRule
	}
	// apiLevel 9 的规则允许 searchURL 为空（searchMode=api 时走 searchApiConfig）。
	if rule.Name == "" || rule.BaseURL == "" || (rule.SearchURL == "" && !usesAPISearch(rule)) {
		return nil, errInvalidRule
	}
	return rule, nil
}

// isRuleName 判断索引里的 name 能否当文件名用。
func isRuleName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		char := name[i]
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z',
			char >= '0' && char <= '9', char == '_', char == '.', char == '-':
		default:
			return false
		}
	}
	return true
}

// buildIndexedRuleURL 把索引地址换成「同目录下的 <name>.json」。
func buildIndexedRuleURL(indexURL, name string) string {
	encoded := anisubs.EncodeURIComponent(name)
	lower := strings.ToLower(indexURL)
	const marker = "index.json"

	// 对应 `/\/index\.json(?:[?#].*)?$/i` + 「替换紧跟 ?/#/结尾的那个」。
	position := -1
	for offset := 0; offset < len(lower); {
		found := strings.Index(lower[offset:], marker)
		if found < 0 {
			break
		}
		at := offset + found
		after := at + len(marker)
		precededBySlash := at > 0 && indexURL[at-1] == '/'
		atBoundary := after == len(indexURL) || indexURL[after] == '?' || indexURL[after] == '#'
		if precededBySlash && atBoundary {
			position = at
		}
		offset = after
	}
	if position >= 0 {
		return indexURL[:position] + encoded + ".json" + indexURL[position+len(marker):]
	}

	base, err := url.Parse(indexURL)
	if err != nil {
		return indexURL
	}
	reference, err := url.Parse(encoded + ".json")
	if err != nil {
		return indexURL
	}
	return serializeURL(base.ResolveReference(reference))
}

// expandRuleSource 把「规则源」展开成一组具体规则地址。
//
// 规则源可能是：仓库主页（展开成固定文件）、索引 JSON（数组，每项一个 name）、
// 或者规则文件本身（原样返回）。
func expandRuleSource(ctx context.Context, rawURL string) ([]string, error) {
	if sources, ok := officialRepositorySources[normalizeRepositoryURL(rawURL)]; ok {
		expanded := make([]string, 0, len(sources))
		for _, source := range sources {
			nested, err := expandRuleSource(ctx, source)
			if err != nil {
				return nil, err
			}
			expanded = append(expanded, nested...)
		}
		return expanded, nil
	}

	document, err := fetchRuleDocument(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	entries, ok := document.([]any)
	if !ok {
		return []string{rawURL}, nil
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name, ok := object["name"].(string)
		if !ok || !isRuleName(name) {
			continue
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil, errors.New("规则索引中没有可用的规则名称")
	}
	urls := make([]string, 0, len(names))
	for _, name := range names {
		urls = append(urls, buildIndexedRuleURL(rawURL, name))
	}
	return urls, nil
}

// registry 是「id → provider」的有序表。
type registry struct {
	providers map[string]Provider
	order     []string
}

// buildProvidersFromRules 从规则地址列表构建 provider。
//
// id 用**展开后的下标**（`kazumi_0`、`kazumi_1`…），名称只用于显示：
// 社区规则会重名，用名字当 id 会互相覆盖。下标在失败时也照常推进，
// 保证同一个规则文件在不同次构建里拿到同一个 id（前端记住的是它）。
func buildProvidersFromRules(ctx context.Context, ruleURLs []string) *registry {
	expanded := make([]string, 0, len(ruleURLs))
	for _, sourceURL := range ruleURLs {
		trimmed := strings.TrimSpace(sourceURL)
		if trimmed == "" {
			continue
		}
		urls, err := expandRuleSource(ctx, trimmed)
		if err != nil {
			log.Printf("[kazumi] 展开规则源失败: %s (%v)", trimmed, err)
			continue
		}
		expanded = append(expanded, urls...)
	}

	seen := make(map[string]bool, len(expanded))
	unique := make([]string, 0, len(expanded))
	for _, item := range expanded {
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		unique = append(unique, item)
	}

	result := &registry{
		providers: make(map[string]Provider, len(unique)),
		order:     make([]string, 0, len(unique)),
	}
	for index, ruleURL := range unique {
		rule, err := fetchRule(ctx, ruleURL)
		if err != nil {
			log.Printf("[kazumi] 加载规则失败: %s (%v)", ruleURL, err)
			continue
		}
		id := fmt.Sprintf("kazumi_%d", index)
		result.providers[id] = newProvider(id, rule)
		result.order = append(result.order, id)
		log.Printf("[kazumi] 加载规则成功: %s → %s", rule.Name, id)
	}
	return result
}
