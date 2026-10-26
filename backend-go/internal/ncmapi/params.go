package ncmapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Params 是入站请求参数（query 与 body 合并后的视图）。
//
// 合并顺序与 Node 版一致：body 先铺底，query 覆盖同名键（前端绝大多数接口用
// query 传参，写操作才用 body）。
type Params map[string]string

// newParams 解析入站请求的参数。
//
// 支持三种承载方式：
//   - query string（GET，也是前端的主要用法）
//   - JSON object（POST，前端 apiPost 发的写操作）
//   - form-urlencoded（极少数调用方）
//
// 非对象 JSON（数组/标量）与解析失败都忽略，不阻断——上游会因为缺参返回
// 自己的错误码，比这里猜一个 400 更接近原行为。
func newParams(r *http.Request) Params {
	out := make(Params, len(r.URL.Query()))
	if body := decodeBody(r); body != nil {
		for key, value := range body {
			out[key] = plainValue(value)
		}
	}
	for key := range r.URL.Query() {
		out[key] = r.URL.Query().Get(key)
	}
	return out
}

// decodeBody 读出 body 里的键值（JSON object 或 form）。
func decodeBody(r *http.Request) map[string]any {
	if r.Body == nil || r.Method != http.MethodPost {
		return nil
	}
	contentType := r.Header.Get("Content-Type")
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if strings.Contains(contentType, "application/x-www-form-urlencoded") {
		form := values(string(raw))
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
	return parsed
}

// S 取字符串参数（缺失或空串时用兜底值）。
func (p Params) S(key string, fallback ...string) string {
	if value := p[key]; value != "" {
		return value
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}

// Raw 取原始值（缺失时返回空串，不做兜底）。
func (p Params) Raw(key string) string { return p[key] }

// Has 判断参数是否存在且非空。
func (p Params) Has(key string) bool { return p[key] != "" }

// I 取整数参数（解析失败时用兜底值）。
func (p Params) I(key string, fallback int) int {
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

// B 取布尔参数（"false"/"0" 视为假，其余非空串视为真）。
func (p Params) B(key string, fallback bool) bool {
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

// Or 返回第一个非空值（参数缺失时用兜底）。
func (p Params) Or(key string, fallback string) string { return p.S(key, fallback) }

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
func threadID(p Params) string {
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
