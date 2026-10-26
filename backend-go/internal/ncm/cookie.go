// Package ncm 是「一起听」音乐模块的网易云（NCM）服务层。
//
// 本包**不实现**网易云的业务协议：所有端点都在一个「NCM API 服务」上拼
// `/song/url/v1`、`/login/qr/key` 这类路径，由它负责 weapi/eapi 加密与协议细节。
// 上游有两种来源（见 StartBundled），默认是同一进程内的 internal/ncmapi：
//
//   - 进程内实现（默认）：internal/ncmapi 直接在本进程内响应，不监听端口；
//   - 外部服务（显式 `NCM_API_BASE`）：运维自建的 NeteaseCloudMusicApi（含增强版）。
//
// 本包只负责
//
//   - 凭证读写（cookie 解析/合并/持久化）
//   - 转发（注入 cookie、绕 apicache、剥客户端传入的 cookie/noCookie）
//   - 业务编排（登录状态补全、专辑补齐、音质降级链、直链缓存、音频流转发）
//
// 上游不可达时一律 503 NCM_UNAVAILABLE（进程内实现正常时不会发生）。
package ncm

import (
	"encoding/json"
	"strconv"
	"strings"
)

// cookieName 取出 Set-Cookie 原始串里的 cookie 名（首个 = 之前的部分）。
func cookieName(setCookie string) string {
	index := strings.Index(setCookie, "=")
	if index > 0 {
		return strings.TrimSpace(setCookie[:index])
	}
	return strings.TrimSpace(setCookie)
}

// ToCookieHeader 把持久化的 cookie JSON 数组转成请求头格式。
//
// 只取 `name=value` 部分（砍掉 Path/Domain/Expires 等属性），以 "; " 连接；
// 数组非法或元素不是字符串时按空处理。
func ToCookieHeader(cookiesRaw string) string {
	var arr []any
	if err := json.Unmarshal([]byte(cookiesRaw), &arr); err != nil {
		return ""
	}
	parts := make([]string, 0, len(arr))
	for _, item := range arr {
		text, ok := item.(string)
		if !ok || text == "" {
			continue
		}
		pair := strings.TrimSpace(strings.SplitN(text, ";", 2)[0])
		if pair != "" {
			parts = append(parts, pair)
		}
	}
	return strings.Join(parts, "; ")
}

// ParseStoredCookies 解析持久化的 cookie JSON 数组（失败/非数组返回空）。
func ParseStoredCookies(cookiesRaw string) []string {
	var arr []any
	if err := json.Unmarshal([]byte(cookiesRaw), &arr); err != nil {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// MergeCookies 把新 Set-Cookie 合并进既有数组（按 cookie 名去重，新值覆盖旧值）。
//
// 去重用的是 Map 的「后写胜出」，所以返回顺序是**首次出现的顺序**——
// 与 JS 的 Map 一致（`set` 已有键不会改变它的插入位置）。
func MergeCookies(existing, incoming []string) []string {
	order := make([]string, 0, len(existing)+len(incoming))
	values := make(map[string]string, len(existing)+len(incoming))
	for _, item := range append(append([]string{}, existing...), incoming...) {
		if item == "" {
			continue
		}
		name := cookieName(item)
		if _, seen := values[name]; !seen {
			order = append(order, name)
		}
		values[name] = item
	}
	out := make([]string, 0, len(order))
	for _, name := range order {
		out = append(out, values[name])
	}
	return out
}

// Profile 是从 NCM 响应里抽出来的账号资料。
//
// 每个字段用指针，因为 Node 侧是 `typeof x === 'number' ? x : null`：
// 「字段缺失」与「值为 0」在后续判定里完全不同（vipType=0 才触发 /vip/info 兜底）。
type Profile struct {
	Nickname    *string
	AvatarURL   *string
	VIPType     *int64
	VIPStatus   *int64
	RedVIPLevel *int64
}

// ExtractProfile 从 NCM 响应体提取账号资料。
//
// 兼容 `body.profile` 与 `body.data.profile` 两种结构（不同 NCM 接口版本），
// 昵称与头像都为假值时返回 nil（对应 Node 的 `if (!nickname && !avatarUrl) return null`）。
func ExtractProfile(body any) *Profile {
	root, ok := body.(map[string]any)
	if !ok || root == nil {
		return nil
	}
	raw, isObject := root["profile"].(map[string]any)
	if !isObject {
		if data, ok := root["data"].(map[string]any); ok {
			raw, isObject = data["profile"].(map[string]any)
		}
	}
	if !isObject || raw == nil {
		return nil
	}

	profile := &Profile{
		Nickname:    stringField(raw, "nickname"),
		AvatarURL:   stringField(raw, "avatarUrl"),
		VIPType:     intField(raw, "vipType"),
		VIPStatus:   intField(raw, "vipStatus"),
		RedVIPLevel: intField(raw, "redVipLevel"),
	}
	nicknameEmpty := profile.Nickname == nil || *profile.Nickname == ""
	avatarEmpty := profile.AvatarURL == nil || *profile.AvatarURL == ""
	if nicknameEmpty && avatarEmpty {
		return nil
	}
	return profile
}

// HasLoginCookies 判断 Set-Cookie 列表是否包含登录态 cookie（MUSIC_U / __csrf）。
func HasLoginCookies(setCookies []string) bool {
	for _, item := range setCookies {
		name := strings.ToLower(cookieName(item))
		if name == "music_u" || strings.Contains(name, "csrf") {
			return true
		}
	}
	return false
}

// stringField 取字符串字段；类型不符时返回 nil。
func stringField(source map[string]any, key string) *string {
	if value, ok := source[key].(string); ok {
		return &value
	}
	return nil
}

// intField 取数字字段；类型不符时返回 nil。
func intField(source map[string]any, key string) *int64 {
	value, ok := toFloat(source[key])
	if !ok {
		return nil
	}
	result := int64(value)
	return &result
}

// toFloat 把 JSON 解出来的各种数值形态统一成 float64。
func toFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		parsed, err := v.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	return 0, false
}
