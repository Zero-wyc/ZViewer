package api

import "zviewer/backend/internal/anime"

// 动漫类端点共用的 episode DTO 解析。
//
// anime 与 anisubs 两个模块的 /resolve 都接收
// `{ source, episode: { id, title, episodeNumber, playbackParams } }`，
// 归一化规则逐字相同（Node 侧是两份 normalizeEpisode 拷贝，字段语义一致）。
// 放在一处，免得改一边忘另一边。

// normalizeEpisodeFields 拆出 episode 的公共字段。
//
//   - id/title：`String(x ?? ”)`，缺失或 null 当空串；
//   - 集号：`Number(x) || 1`（0/NaN 都算「没给」）；
//   - playbackParams：必须是对象，否则给空对象。
func normalizeEpisodeFields(raw map[string]any) (id, title string, episodeNumber float64, params map[string]any) {
	if value, present := raw["id"]; present && value != nil {
		id = anime.JSString(value)
	}
	if value, present := raw["title"]; present && value != nil {
		title = anime.JSString(value)
	}
	episodeNumber = 1
	if value, present := raw["episodeNumber"]; present {
		if number, ok := anime.ToFloat(value); ok && number != 0 {
			episodeNumber = number
		}
	}
	params = map[string]any{}
	if value, ok := raw["playbackParams"].(map[string]any); ok {
		params = value
	}
	return id, title, episodeNumber, params
}
