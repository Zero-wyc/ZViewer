package anisubs

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"zviewer/backend/internal/netutil"
)

// web-selector provider，对应 services/anisubs/provider.ts#createWebSelectorProvider。

// specialCharPattern 对应 `/[^\p{L}\p{N}\s]/gu`（searchRemoveSpecial）。
var specialCharPattern = regexp.MustCompile(`[^\p{L}\p{N}\s]`)

// webSelectorProvider 用 CSS 选择器规则抓站。
type webSelectorProvider struct {
	sourceID string
	name     string
	config   *SearchConfig
}

// NewWebSelectorProvider 构造 web-selector 数据源。
func NewWebSelectorProvider(sourceID, displayName string, config *SearchConfig) Provider {
	return &webSelectorProvider{sourceID: sourceID, name: displayName, config: config}
}

// Name 返回展示名。
func (p *webSelectorProvider) Name() string { return p.name }

// Search 抓搜索页并解析主体列表（同 URL 去重，最多 20 条）。
func (p *webSelectorProvider) Search(ctx context.Context, keyword string) ([]SearchResult, error) {
	term := strings.TrimSpace(keyword)
	if p.config.SearchRemoveSpecial {
		term = strings.TrimSpace(specialCharPattern.ReplaceAllString(term, " "))
	}
	if p.config.SearchUseOnlyFirstWord {
		if words := strings.Fields(term); len(words) > 0 {
			term = words[0]
		}
	}
	if term == "" {
		return []SearchResult{}, nil
	}

	searchURL := strings.ReplaceAll(p.config.SearchURL, "{keyword}", netutil.EncodeURIComponent(term))
	html, err := fetchHTML(ctx, searchURL, p.cookies())
	if err != nil {
		return nil, err
	}
	subjects, err := ParseSearchResults(html, p.config, searchURL)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]struct{}, len(subjects))
	results := make([]SearchResult, 0, len(subjects))
	for _, subject := range subjects {
		if _, exists := seen[subject.URL]; exists {
			continue
		}
		seen[subject.URL] = struct{}{}
		results = append(results, SearchResult{
			ID:     subject.URL,
			Title:  subject.Title,
			Cover:  subject.Cover,
			Source: p.sourceID,
		})
		if len(results) >= 20 {
			break
		}
	}
	return results, nil
}

// Episodes 抓详情页并解析分集。
func (p *webSelectorProvider) Episodes(ctx context.Context, identifier string) ([]Episode, error) {
	html, err := fetchHTML(ctx, identifier, p.cookies())
	if err != nil {
		return nil, err
	}
	infos, err := ParseEpisodes(html, p.config, identifier)
	if err != nil {
		return nil, err
	}
	episodes := make([]Episode, 0, len(infos))
	for _, info := range infos {
		number := info.EpisodeNumber
		if number == 0 {
			number = 1
		}
		episodes = append(episodes, Episode{
			ID:             info.ID,
			Title:          info.Title,
			EpisodeNumber:  number,
			PlaybackParams: map[string]any{"episodeUrl": info.URL},
		})
	}
	return episodes, nil
}

// PlaybackURL 抓剧集页解析真实播放地址。
func (p *webSelectorProvider) PlaybackURL(ctx context.Context, episode Episode) (*PlaybackURL, error) {
	episodeURL, _ := episode.PlaybackParams["episodeUrl"].(string)
	if episodeURL == "" {
		return nil, fmt.Errorf("缺少剧集页面地址")
	}
	if p.config.MatchVideo == nil {
		return nil, fmt.Errorf("数据源未配置视频匹配规则")
	}
	match, err := ResolveVideoURL(ctx, episodeURL, p.config.MatchVideo)
	if err != nil {
		return nil, err
	}
	if match == nil {
		return nil, nil
	}
	return &PlaybackURL{
		URL:     match.URL,
		Headers: match.Headers,
		Format:  string(match.Format),
	}, nil
}

// cookies 取 matchVideo 里配置的 Cookie。
func (p *webSelectorProvider) cookies() string {
	if p.config.MatchVideo == nil {
		return ""
	}
	return p.config.MatchVideo.Cookies
}

// encodeURIComponent 对齐 JS 的 encodeURIComponent（空格给 %20，不给 +）。
func EncodeURIComponent(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}
