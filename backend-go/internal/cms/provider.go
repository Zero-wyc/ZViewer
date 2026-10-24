package cms

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// CMS provider：苹果 CMS V10 JSON 采集接口（api.php/provide/vod）。
//
// 对应 services/cms/cmsProvider.ts。播放地址永远实时从源站读（采集站直链
// 漂移很快，落库等于制造 404），所以 provider 只做「拼 URL + 解析」这一件事。

const (
	// vodTimeout 与 Node 的 REQUEST_TIMEOUT_MS 一致。
	vodTimeout = 15 * time.Second
	// maxSearchResults 是单站搜索结果上限（Node 里的 .slice(0, 30)）。
	maxSearchResults = 30
)

// Provider 是单个 CMS 采集站的客户端。
type Provider struct {
	Site   Site
	origin string
}

// NewProvider 构造 provider。
func NewProvider(site Site) *Provider {
	origin := ""
	if parsed, err := url.Parse(site.API); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		origin = parsed.Scheme + "://" + parsed.Host + "/"
	}
	return &Provider{Site: site, origin: origin}
}

// buildAPIURL 在采集接口地址上追加参数（保留 api 自带的 query）。
func buildAPIURL(api string, params map[string]string) string {
	parsed, err := url.Parse(api)
	if err != nil {
		return api
	}
	query := parsed.Query()
	for key, value := range params {
		query.Set(key, value)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// requestVodList 请求采集接口并取 list 数组。
//
// 苹果 CMS 标准是 ac=videolist，部分老站只认 ac=detail，所以第一次拿不到
// 非空列表就换一个再试。网络/解析失败一律当空列表（搜索返回「没有结果」
// 比整页 502 更符合用户预期）。
func (p *Provider) requestVodList(ctx context.Context, params map[string]string) []map[string]any {
	requestOnce := func(ac string) []map[string]any {
		merged := make(map[string]string, len(params)+1)
		for key, value := range params {
			merged[key] = value
		}
		merged["ac"] = ac

		result := fetchText(ctx, buildAPIURL(p.Site.API, merged), map[string]string{
			"User-Agent": DefaultUserAgent,
			"Accept":     "application/json",
		}, vodTimeout)
		if !result.OK {
			return nil
		}
		var payload struct {
			List []map[string]any `json:"list"`
		}
		if err := json.Unmarshal([]byte(result.Body), &payload); err != nil {
			return nil
		}
		return payload.List
	}

	list := requestOnce("videolist")
	if len(list) == 0 {
		list = requestOnce("detail")
	}
	return list
}

// parsePlayGroups 把 vod_play_url / vod_play_from 解析成播放组。
//
// vod_play_url 结构：'组1集1$链接#集2$链接$$$组2集1$链接'，
// 组名对应 vod_play_from 的 $$$ 分组下标。返回值与 $$$ 原始下标一一对应
// （resolve 直接用原始串取地址，两边必须共用同一套分组语义）。
func parsePlayGroups(rawURL, rawFrom, vodID string) []PlayGroup {
	groupNames := strings.Split(rawFrom, "$$$")
	groupURLs := strings.Split(rawURL, "$$$")

	groups := make([]PlayGroup, 0, len(groupURLs))
	for index, group := range groupURLs {
		rawEpisodes := make([]string, 0, 8)
		for _, episode := range strings.Split(group, "#") {
			if trimmed := strings.TrimSpace(episode); trimmed != "" {
				rawEpisodes = append(rawEpisodes, trimmed)
			}
		}
		if len(rawEpisodes) == 0 {
			continue
		}

		episodes := make([]Episode, 0, len(rawEpisodes))
		for _, raw := range rawEpisodes {
			sep := strings.Index(raw, "$")
			title := raw
			link := ""
			if sep >= 0 {
				title = strings.TrimSpace(raw[:sep])
				link = strings.TrimSpace(raw[sep+1:])
			}
			if link == "" {
				continue
			}
			if title == "" {
				title = fmt.Sprintf("第%d集", len(episodes)+1)
			}
			episodes = append(episodes, Episode{
				Index: len(episodes),
				Title: title,
				PlaybackParams: PlaybackParams{
					VodID:         vodID,
					PlayFromIndex: index,
					EpisodeIndex:  len(episodes),
				},
			})
		}
		if len(episodes) == 0 {
			continue
		}

		name := ""
		if index < len(groupNames) {
			name = strings.TrimSpace(groupNames[index])
		}
		if name == "" {
			name = fmt.Sprintf("播放源%d", index+1)
		}
		groups = append(groups, PlayGroup{Name: name, Episodes: episodes})
	}
	return groups
}

// parseVodDetail 从采集接口条目解析影片详情。
func parseVodDetail(item map[string]any, site Site) *VodDetail {
	vodID := asString(item["vod_id"])
	return &VodDetail{
		ID:          vodID,
		Title:       asString(item["vod_name"]),
		Cover:       asString(item["vod_pic"]),
		Description: asString(item["vod_content"]),
		Year:        asString(item["vod_year"]),
		Area:        asString(item["vod_area"]),
		TypeName:    asString(item["type_name"]),
		Remark:      asString(item["vod_remarks"]),
		PlayGroups: parsePlayGroups(
			asString(item["vod_play_url"]),
			asString(item["vod_play_from"]),
			vodID,
		),
		Source: site.Key,
	}
}

// DetectMediaFormat 嗅探媒体格式。
//
// Node 用的是带前瞻的正则 `\.m3u8(?=[?#]|$)`；Go 的 RE2 不支持 lookahead，
// 这里先砍掉 ?/# 之后的部分再判后缀，语义等价。
func DetectMediaFormat(raw string) MediaFormat {
	lower := strings.ToLower(raw)
	if index := strings.IndexAny(lower, "?#"); index >= 0 {
		lower = lower[:index]
	}
	switch {
	case strings.HasSuffix(lower, ".m3u8"):
		return FormatHLS
	case strings.HasSuffix(lower, ".flv"):
		return FormatFLV
	case strings.HasSuffix(lower, ".mp4"), strings.HasSuffix(lower, ".mkv"):
		return FormatMP4
	}
	return FormatUnknown
}

// Search 站点内搜索影片。
func (p *Provider) Search(ctx context.Context, keyword string) ([]SearchResult, error) {
	list := p.requestVodList(ctx, map[string]string{"wd": keyword})
	results := make([]SearchResult, 0, len(list))
	for _, item := range list {
		result := SearchResult{
			ID:          asString(item["vod_id"]),
			Title:       asString(item["vod_name"]),
			Cover:       asString(item["vod_pic"]),
			Description: asString(item["vod_content"]),
			Remark:      asString(item["vod_remarks"]),
			Source:      p.Site.Key,
		}
		if result.ID == "" || result.Title == "" {
			continue
		}
		results = append(results, result)
	}
	if len(results) > maxSearchResults {
		results = results[:maxSearchResults]
	}
	return results, nil
}

// Detail 取影片详情与剧集列表。
func (p *Provider) Detail(ctx context.Context, vodID string) (*VodDetail, error) {
	list := p.requestVodList(ctx, map[string]string{"ids": vodID})
	if len(list) == 0 {
		return nil, fmt.Errorf("影片不存在或源站接口无响应")
	}
	detail := parseVodDetail(list[0], p.Site)
	if len(detail.PlayGroups) == 0 {
		return nil, fmt.Errorf("影片没有可播放的剧集")
	}
	return detail, nil
}

// PlaybackURL 解析某一集的播放地址。
//
// 直接从原始 vod_play_url 串按组/集序号取地址，不经过 parsePlayGroups 的
// 中间对象——保证拿到的永远是最新鲜的直链。
func (p *Provider) PlaybackURL(ctx context.Context, params PlaybackParams) (*PlaybackURL, error) {
	list := p.requestVodList(ctx, map[string]string{"ids": params.VodID})
	if len(list) == 0 {
		return nil, nil
	}

	rawGroups := make([][]string, 0, 4)
	for _, group := range strings.Split(asString(list[0]["vod_play_url"]), "$$$") {
		episodes := make([]string, 0, 8)
		for _, episode := range strings.Split(group, "#") {
			trimmed := strings.TrimSpace(episode)
			sep := strings.Index(trimmed, "$")
			if sep < 0 || strings.TrimSpace(trimmed[sep+1:]) == "" {
				continue
			}
			episodes = append(episodes, trimmed)
		}
		rawGroups = append(rawGroups, episodes)
	}

	groupIndex := -1
	if params.PlayFromIndex >= 0 && params.PlayFromIndex < len(rawGroups) {
		groupIndex = params.PlayFromIndex
	} else {
		for index, group := range rawGroups {
			if len(group) > 0 {
				groupIndex = index
				break
			}
		}
	}
	if groupIndex < 0 {
		return nil, nil
	}

	group := rawGroups[groupIndex]
	if params.EpisodeIndex < 0 || params.EpisodeIndex >= len(group) {
		return nil, nil
	}
	raw := group[params.EpisodeIndex]
	link := strings.TrimSpace(raw[strings.Index(raw, "$")+1:])
	if link == "" || !isHTTPURL(link) {
		return nil, nil
	}

	headers := map[string]string{"User-Agent": DefaultUserAgent}
	if p.origin != "" {
		headers["Referer"] = p.origin
	}
	return &PlaybackURL{URL: link, Headers: headers, Format: DetectMediaFormat(link)}, nil
}

// isHTTPURL 判断是否 http(s) 绝对地址（大小写不敏感）。
func isHTTPURL(raw string) bool {
	lower := strings.ToLower(raw)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}
