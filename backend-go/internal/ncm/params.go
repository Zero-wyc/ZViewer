package ncm

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
)

// params 是接口参数视图：query 与 body 合并后的字符串表。
//
// 全部转成字符串是有意的——网易云的参数最终都要进 JSON 或 form，而前端传的
// 数字/布尔到了 Go 这里只剩「字面量」这一个有用信息，各路由再用 I/B 转回去。
type params map[string]string

// paramsFromQuery 构造参数视图（body 由 mergeBody 补充）。
func paramsFromQuery(query url.Values) params {
	out := make(params, len(query))
	for key := range query {
		out[key] = query.Get(key)
	}
	return out
}

// parseQueryPath 把 "/song/url/v1?id=1&level=2" 拆成路径与参数。
func parseQueryPath(path string) (string, params) {
	index := strings.IndexByte(path, '?')
	if index < 0 {
		return path, params{}
	}
	parsed, err := url.ParseQuery(path[index+1:])
	if err != nil {
		return path[:index], params{}
	}
	return path[:index], paramsFromQuery(parsed)
}

// mergeBody 把 JSON/form body 里的键填进参数表（不覆盖已有的 query 值）。
//
// 与 Node 版一致：query 优先。写操作（收藏、创建歌单）用 body 传参，读接口
// 用 query，两者同时出现时以 query 为准。
func (p params) mergeBody(body map[string]any) {
	for key, value := range body {
		if _, exists := p[key]; exists {
			continue
		}
		p[key] = plainValue(value)
	}
}

// bodyParams 解析请求体里的键值（JSON object 或 form-urlencoded）。
//
// 非对象 JSON（数组/标量）返回 nil：那些接口的参数都在 query 上，body 只是
// 原始载荷，而上游要的是加密后的 params，本来就带不过去。
func bodyParams(contentType string, raw []byte) map[string]any {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if strings.Contains(contentType, "application/x-www-form-urlencoded") {
		form, err := url.ParseQuery(string(raw))
		if err != nil {
			return nil
		}
		out := make(map[string]any, len(form))
		for key := range form {
			out[key] = form.Get(key)
		}
		return out
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	// 客户端不允许自报登录态：cookie 由服务端按凭证注入，否则任何人都能
	// 用 body 里的 cookie 冒充别人。
	delete(parsed, "cookie")
	delete(parsed, "noCookie")
	return parsed
}

// S 取字符串参数（缺失或空串时用兜底值）。
func (p params) S(key string, fallback ...string) string {
	if value := p[key]; value != "" {
		return value
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}

// Has 判断参数是否存在且非空。
func (p params) Has(key string) bool { return p[key] != "" }

// I 取整数参数（解析失败时用兜底值）。
func (p params) I(key string, fallback int) int {
	value := p[key]
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}

// B 取布尔参数（"false"/"0"/"no" 视为假，其余非空串视为真）。
func (p params) B(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(p[key]))
	if value == "" {
		return fallback
	}
	switch value {
	case "false", "0", "no":
		return false
	default:
		return true
	}
}

// resourceTypeMap 是评论资源的 threadId 前缀表（与 Node util/config.json 一致）。
//
// 前端传的是数字类型（0 歌曲 / 1 MV / 2 歌单 / 3 专辑 / 4 电台 / 5 视频 /
// 6 动态 / 7 节目），上游要的是前缀字符串。
var resourceTypeMap = map[string]string{
	"0": "R_SO_4_",
	"1": "R_MV_5_",
	"2": "A_PL_0_",
	"3": "R_AL_3_",
	"4": "A_DJ_1_",
	"5": "R_VI_62_",
	"6": "A_EV_2_",
	"7": "A_DR_14_",
}

// threadID 拼评论线程 id（缺省按歌曲处理）。
func threadID(p params) string {
	prefix, ok := resourceTypeMap[p.S("type", "0")]
	if !ok {
		prefix = resourceTypeMap["0"]
	}
	return prefix + p.S("id")
}

// songDetailC 拼 /api/v3/song/detail 的 c 参数（形如 [{"id":1},{"id":2}]）。
//
// ids 支持逗号/空白分隔；上限 1000 首（上游硬限制，超了会截断）。
func songDetailC(ids string) string {
	parts := strings.FieldsFunc(ids, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	if len(parts) > 1000 {
		parts = parts[:1000]
	}
	builder := strings.Builder{}
	builder.WriteByte('[')
	for index, part := range parts {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(`{"id":`)
		builder.WriteString(strings.TrimSpace(part))
		builder.WriteByte('}')
	}
	builder.WriteByte(']')
	return builder.String()
}

// qrClientType 是扫码登录的固定类型（3 = 网页扫码）。
const qrClientType = 3
