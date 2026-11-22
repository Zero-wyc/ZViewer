package crawler

import (
	"strings"
)

// 搜索结果里的「分组剧集」。
//
// 苹果 CMS 系（TVBox type=1 采集站）把线路与集数压在一个字段里：
//
//	vod_play_from: "ffm3u8$$$ldm3u8"
//	vod_play_url:  "第01集$https://a/1.m3u8#第02集$https://a/2.m3u8$$$第01集$https://b/1.m3u8"
//
// 番剧站常见单组形态，只是没有 $$$ 分组。规则里加一段 groups 就能把这两种
// 形态都描述成数据，搜索结果因此带 groups，点片界面直接出线路与选集，
// 不需要为 CMS 单独写执行器。

// PlayGroup 是一条线路（分组）。
type PlayGroup struct {
	Name     string        `json:"name"`
	Episodes []PlayEpisode `json:"episodes"`
}

// PlayEpisode 是一集。URL 可能是媒体直链，也可能是需要二次解析的播放页。
type PlayEpisode struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// defaultGroupSeparators 是 CMS/TVBox 的默认分隔符。
const (
	defaultGroupSep   = "$$$"
	defaultEpisodeSep = "#"
	defaultNameSep    = "$"
)

// GroupSpec 描述「怎么把一个字段拆成线路与集数」。
type GroupSpec struct {
	// Field 是已抽取的字段名（parse.fields 里那一条），值是拼好的集数串。
	Field string `json:"field"`
	// NamesField 是与 Field 同分隔的线路名列表字段（CMS 的 vod_play_from）。
	NamesField string `json:"names_field,omitempty"`
	GroupSep   string `json:"group_sep,omitempty"`
	EpisodeSep string `json:"episode_sep,omitempty"`
	// NameSep 是「集名 + 链接」之间的分隔符；置空串表示整段就是链接。
	NameSep string `json:"name_sep,omitempty"`
	// URLTemplate 非空时用它包装集链接（{url} 替换成原链接）。
	URLTemplate string `json:"url_template,omitempty"`
}

// normalizeGroupSpec 填默认分隔符，去掉空白字段。
func normalizeGroupSpec(spec *GroupSpec) *GroupSpec {
	if spec == nil {
		return nil
	}
	spec.Field = strings.TrimSpace(spec.Field)
	if spec.Field == "" {
		return nil
	}
	spec.NamesField = strings.TrimSpace(spec.NamesField)
	spec.URLTemplate = strings.TrimSpace(spec.URLTemplate)
	// 分隔符为空一律按 CMS 默认值补齐：规则里写空串没有别的语义，
	// 真要「不分组」就不写 groups 段。
	if spec.GroupSep == "" {
		spec.GroupSep = defaultGroupSep
	}
	if spec.EpisodeSep == "" {
		spec.EpisodeSep = defaultEpisodeSep
	}
	if spec.NameSep == "" {
		spec.NameSep = defaultNameSep
	}
	return spec
}

// BuildGroups 按 spec 把字段值拆成线路与集数。解析不出任何一集时返回 nil。
func BuildGroups(spec *GroupSpec, item map[string]string) []PlayGroup {
	if spec == nil || item == nil {
		return nil
	}
	raw := strings.TrimSpace(item[spec.Field])
	if raw == "" {
		return nil
	}
	names := []string(nil)
	if spec.NamesField != "" {
		if value := strings.TrimSpace(item[spec.NamesField]); value != "" {
			names = strings.Split(value, spec.GroupSep)
		}
	}
	segments := strings.Split(raw, spec.GroupSep)
	groups := make([]PlayGroup, 0, len(segments))
	for index, segment := range segments {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}
		name := ""
		if index < len(names) {
			name = strings.TrimSpace(names[index])
		}
		if name == "" {
			name = "线路 " + itoa(index+1)
		}
		episodes := parseGroupEpisodes(segment, spec)
		if len(episodes) == 0 {
			continue
		}
		groups = append(groups, PlayGroup{Name: name, Episodes: episodes})
	}
	if len(groups) == 0 {
		return nil
	}
	return groups
}

// parseGroupEpisodes 拆一组里的集数。
func parseGroupEpisodes(segment string, spec *GroupSpec) []PlayEpisode {
	parts := strings.Split(segment, spec.EpisodeSep)
	episodes := make([]PlayEpisode, 0, len(parts))
	for index, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, link := "", part
		if spec.NameSep != "" {
			if at := strings.Index(part, spec.NameSep); at >= 0 {
				name = strings.TrimSpace(part[:at])
				link = strings.TrimSpace(part[at+len(spec.NameSep):])
			}
		}
		if link == "" {
			continue
		}
		if spec.URLTemplate != "" {
			link = strings.ReplaceAll(spec.URLTemplate, "{url}", link)
		}
		if name == "" {
			name = "第 " + itoa(index+1) + " 集"
		}
		episodes = append(episodes, PlayEpisode{Name: name, URL: link})
		if len(episodes) >= maxEpisodes {
			break
		}
	}
	return episodes
}

// attachGroups 给搜索结果条目补上 groups（没有匹配字段的条目原样跳过）。
func attachGroups(items []map[string]any, spec *GroupSpec) {
	if spec == nil || len(items) == 0 {
		return
	}
	for _, item := range items {
		if item == nil {
			continue
		}
		flat := make(map[string]string, len(item))
		for key, value := range item {
			if text, ok := value.(string); ok {
				flat[key] = text
			}
		}
		if groups := BuildGroups(spec, flat); len(groups) > 0 {
			item["groups"] = groups
		}
		// 原始字段（vod_play_url 之类）可以很长，且前端只用 groups，去掉避免整包变大。
		delete(item, spec.Field)
		if spec.NamesField != "" {
			delete(item, spec.NamesField)
		}
	}
}
