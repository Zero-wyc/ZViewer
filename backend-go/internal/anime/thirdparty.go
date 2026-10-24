package anime

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// 第三方 HTTP 番剧源，对应 services/anime/providers/thirdParty.ts。
//
// 协议完全由配置里的 URL 模板决定：
//
//	searchUrl   默认 {baseUrl}/search        含 {keyword} 时插值，否则拼 ?keyword=
//	episodesUrl 默认 {baseUrl}/episodes/{id} 含 {id} 时插值，否则拼 ?id=
//	resolveUrl  默认 {baseUrl}/resolve/{id}  同上
//
// 返回体统一兼容「裸数组」与「{ data: [...] }」两种形态。

// ThirdPartyEndpoints 是一个第三方源的端点配置。
type ThirdPartyEndpoints struct {
	SearchURL   string            `json:"searchUrl"`
	EpisodesURL string            `json:"episodesUrl"`
	ResolveURL  string            `json:"resolveUrl"`
	Headers     map[string]string `json:"headers"`
	AuthToken   string            `json:"authToken"`
}

// ThirdPartyConfig 是第三方源配置。
type ThirdPartyConfig struct {
	BaseURL   string
	Endpoints ThirdPartyEndpoints
}

// placeholderPattern 匹配 URL 模板里的 {name} 占位。
var placeholderPattern = regexp.MustCompile(`\{([\w]+)\}`)

// encodeURIComponent 对齐 JS 的 encodeURIComponent。
//
// Go 的 url.QueryEscape 会把空格编成 `+`（表单语义），放进路径段会变成字面量
// 加号；JS 编码器只吐 %20，所以这里把 `+` 换回来。
func encodeURIComponent(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

// interpolateURL 把 {name} 换成 encodeURIComponent 后的值，缺失时换空串。
func interpolateURL(template string, params map[string]string) string {
	return placeholderPattern.ReplaceAllStringFunc(template, func(placeholder string) string {
		key := placeholder[1 : len(placeholder)-1]
		value, ok := params[key]
		if !ok {
			return ""
		}
		return encodeURIComponent(value)
	})
}

// thirdPartyProvider 是配置出来的第三方源。
type thirdPartyProvider struct {
	sourceID  string
	name      string
	baseURL   string
	endpoints ThirdPartyEndpoints
}

func newThirdPartyProvider(sourceID, displayName string, config ThirdPartyConfig) *thirdPartyProvider {
	return &thirdPartyProvider{
		sourceID:  sourceID,
		name:      displayName,
		baseURL:   config.BaseURL,
		endpoints: config.Endpoints,
	}
}

// Name 返回展示名。
func (p *thirdPartyProvider) Name() string { return p.name }

// fetchJSON 拉取 JSON（带配置里的头与 Bearer 令牌）。
func (p *thirdPartyProvider) fetchJSON(ctx context.Context, target string) (any, error) {
	headers := map[string]string{
		"User-Agent": defaultUserAgent,
		"Accept":     "application/json",
	}
	// 配置里的 headers 覆盖默认头（Node 是对象展开，后写优先）。
	for key, value := range p.endpoints.Headers {
		headers[key] = value
	}
	if p.endpoints.AuthToken != "" {
		headers["Authorization"] = "Bearer " + p.endpoints.AuthToken
	}

	resp, err := httpGet(ctx, target, headers)
	if err != nil {
		return nil, err
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return nil, fmt.Errorf("第三方数据源请求失败 [%d]: %s", resp.Status, target)
	}
	var payload any
	if err := json.Unmarshal(resp.Body, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// buildURL 拼端点地址：模板含占位就插值，否则拼查询串。
func (p *thirdPartyProvider) buildURL(template, fallback, placeholder, queryKey, value string) string {
	if template == "" {
		template = fallback
	}
	if strings.Contains(template, placeholder) {
		return interpolateURL(template, map[string]string{queryKey: value})
	}
	return template + "?" + queryKey + "=" + encodeURIComponent(value)
}

// unwrapList 兼容「裸数组」与「{ data: [...] }」。
func unwrapList(payload any) any {
	if object, ok := payload.(map[string]any); ok {
		if list, ok := object["data"].([]any); ok {
			return list
		}
	}
	return payload
}

// Search 搜索第三方源。
func (p *thirdPartyProvider) Search(ctx context.Context, keyword string) ([]SearchResult, error) {
	target := p.buildURL(p.endpoints.SearchURL, p.baseURL+"/search", "{keyword}", "keyword", keyword)
	payload, err := p.fetchJSON(ctx, target)
	if err != nil {
		return nil, err
	}
	return normalizeSearchResults(unwrapList(payload), p.sourceID), nil
}

// Episodes 取第三方源的分集。
func (p *thirdPartyProvider) Episodes(ctx context.Context, identifier string) ([]Episode, error) {
	target := p.buildURL(p.endpoints.EpisodesURL, p.baseURL+"/episodes/{id}", "{id}", "id", identifier)
	payload, err := p.fetchJSON(ctx, target)
	if err != nil {
		return nil, err
	}
	return normalizeEpisodes(unwrapList(payload)), nil
}

// PlaybackURL 解析第三方源的播放地址。
func (p *thirdPartyProvider) PlaybackURL(ctx context.Context, episode Episode) (*PlaybackURL, error) {
	target := p.buildURL(p.endpoints.ResolveURL, p.baseURL+"/resolve/{id}", "{id}", "id", episode.ID)
	payload, err := p.fetchJSON(ctx, target)
	if err != nil {
		return nil, err
	}
	object, ok := payload.(map[string]any)
	if !ok {
		return nil, nil
	}
	rawURL, ok := lookup(object, "url", "playUrl", "videoUrl")
	if !ok {
		return nil, nil
	}
	value, ok := rawURL.(string)
	if !ok || value == "" {
		return nil, nil
	}
	result := &PlaybackURL{URL: value}
	if headers, ok := object["headers"].(map[string]any); ok {
		converted := make(map[string]string, len(headers))
		for key, item := range headers {
			if text, ok := item.(string); ok {
				converted[key] = text
			}
		}
		result.Headers = converted
	}
	return result, nil
}

// lookup 复刻 `a ?? b ?? c`：跳过缺失与 null，命中第一个后立即返回。
func lookup(object map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		value, present := object[key]
		if present && value != nil {
			return value, true
		}
	}
	return nil, false
}

// normalizeSearchResults 归一化搜索结果（兼容 id/animeId/seasonId 三种 id）。
func normalizeSearchResults(payload any, source string) []SearchResult {
	list, ok := payload.([]any)
	if !ok {
		return []SearchResult{}
	}
	results := make([]SearchResult, 0, len(list))
	for _, entry := range list {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		var id string
		if value, ok := lookup(object, "id", "animeId", "seasonId"); ok {
			id = JSString(value)
		}
		var title string
		if value, ok := lookup(object, "title", "name"); ok {
			title = JSString(value)
		}
		if id == "" || title == "" {
			continue
		}
		result := SearchResult{ID: id, Title: title, Source: source}
		if value, ok := object["cover"]; ok && truthy(value) {
			result.Cover = strPtr(JSString(value))
		}
		if value, ok := object["description"]; ok && truthy(value) {
			result.Description = strPtr(JSString(value))
		}
		if value, ok := object["extra"].(map[string]any); ok {
			result.Extra = value
		}
		results = append(results, result)
	}
	return results
}

// normalizeEpisodes 归一化分集。
func normalizeEpisodes(payload any) []Episode {
	list, ok := payload.([]any)
	if !ok {
		return []Episode{}
	}
	episodes := make([]Episode, 0, len(list))
	for idx, entry := range list {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		// `typeof episodeNumber === 'number' ? episodeNumber : Number(...) || idx + 1`：
		// 数字形态（含 0）原样用，字符串/其他才走 Number 的「0 即假」语义。
		episodeNumber := idx + 1
		if raw, ok := object["episodeNumber"]; ok {
			if number, ok := raw.(float64); ok {
				episodeNumber = int(number)
			} else if number, ok := ToFloat(raw); ok && number != 0 {
				episodeNumber = int(number)
			}
		}

		id := strconv.Itoa(idx + 1)
		if value, ok := object["id"]; ok && value != nil {
			id = JSString(value)
		}
		title := fmt.Sprintf("第 %d 集", episodeNumber)
		if value, ok := object["title"]; ok && value != nil {
			title = JSString(value)
		}
		params := map[string]any{}
		if value, ok := object["playbackParams"].(map[string]any); ok {
			params = value
		}
		if id == "" || title == "" {
			continue
		}
		episodes = append(episodes, Episode{
			ID:             id,
			Title:          title,
			EpisodeNumber:  episodeNumber,
			PlaybackParams: params,
		})
	}
	return episodes
}

// truthy 复刻 JS 的真值判断（0/""/null/false 为假）。
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && !math.IsNaN(v)
	case []any:
		return true
	case map[string]any:
		return true
	}
	return true
}

// JSString 复刻 String(x) 的常见分支。
func JSString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		if v == math.Trunc(v) && math.Abs(v) < 1e15 {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	}
	return fmt.Sprint(value)
}
