// Package crawler 是「全网搜片」爬虫引擎的 Go 实现。
//
// 它是 crawler/engine（Python 版）的等价迁移：规则 schema、抽取语义、
// 错误码与 HTTP 形状必须与 Python 版保持一致，前端与桌面壳只认这些契约。
// 各文件对应关系见 DEVELOPMENT 或本包 doc 注释中的模块表。
package crawler

import "fmt"

// EngineError 是引擎抛出的结构化错误，形状与 Python 的 EngineError 一致：
// 序列化后是 {"success": false, "code": ..., "error": ..., "details": {...}}。
type EngineError struct {
	Code    string         `json:"code"`
	Message string         `json:"error"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *EngineError) Error() string { return e.Message }

// ToMap 返回 API 层直接写回前端的对象。
func (e *EngineError) ToMap() map[string]any {
	out := map[string]any{"success": false, "code": e.Code, "error": e.Message}
	if len(e.Details) > 0 {
		out["details"] = e.Details
	}
	return out
}

// ErrorCode 取出任意 error 的 code；非 EngineError 统一按内部错误处理。
func ErrorCode(err error) string {
	if e, ok := err.(*EngineError); ok && e.Code != "" {
		return e.Code
	}
	return "internal_error"
}

func newError(code, message string, details map[string]any) *EngineError {
	return &EngineError{Code: code, Message: message, Details: details}
}

// ConfigError 构造配置类错误（缺 API Key、路径不可写等）。
func ConfigError(message string) *EngineError {
	return newError("config_error", message, nil)
}

// RuleError 构造规则类错误。
func RuleError(message string, details map[string]any) *EngineError {
	return newError("rule_error", message, details)
}

// RuleErrorf 便于拼文案。
func RuleErrorf(format string, args ...any) *EngineError {
	return newError("rule_error", fmt.Sprintf(format, args...), nil)
}

// RuleNotFound 构造「规则不存在」错误。
func RuleNotFound(ruleID string) *EngineError {
	return newError("rule_not_found", "规则不存在: "+ruleID, map[string]any{"ruleId": ruleID})
}

// FetchError 构造抓取类错误，status 与 url 进 details（前端据此判断验证页）。
func FetchError(message string, status int, url string, details map[string]any) *EngineError {
	payload := map[string]any{"status": status, "url": url}
	for key, value := range details {
		payload[key] = value
	}
	return newError("fetch_error", message, payload)
}

// SearchError 构造搜索类错误（code 由调用方决定，例如 site_disabled）。
func SearchError(code, message string, details map[string]any) *EngineError {
	return newError(code, message, details)
}

// ChallengeError 表示站点返回了人机验证页而不是结果。
type ChallengeError = EngineError

// NewChallengeError 按 Python 的格式拼「需要人工验证」错误。
func NewChallengeError(details map[string]any) *EngineError {
	copied := make(map[string]any, len(details)+1)
	for key, value := range details {
		copied[key] = value
	}
	name, _ := copied["name"].(string)
	if name == "" {
		name, _ = copied["site"].(string)
	}
	if name == "" {
		name = "站点"
	}
	reason, _ := copied["reason"].(string)
	if reason == "" {
		reason = "unknown"
		copied["reason"] = reason
	}
	return newError("challenge_required", fmt.Sprintf("%s 需要人工验证后才能搜索（%s）", name, reason), copied)
}

// LLMError 构造大模型调用错误。
func LLMError(message string, details map[string]any) *EngineError {
	return newError("llm_error", message, details)
}
