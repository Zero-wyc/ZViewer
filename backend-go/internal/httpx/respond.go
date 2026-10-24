// Package httpx 提供统一的 JSON 响应与错误输出。
//
// 响应体形状必须与 Node 版一致（{success, message, ...}），
// 前端大量代码按 success 字段分支，形状变了就等于接口变了。
package httpx

import (
	"encoding/json"
	"log"
	"net/http"
)

// JSON 写出任意 JSON 响应。
func JSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		// 响应头已发出，此时只能记录；通常是客户端提前断开
		log.Printf("[http] 写出响应失败: %v", err)
	}
}

// OK 写出 200 + payload。
func OK(w http.ResponseWriter, payload any) { JSON(w, http.StatusOK, payload) }

// Fail 写出 {success:false, message} 形式的错误。
func Fail(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]any{"success": false, "message": message})
}

// FailWithCode 写出 {success:false, message, code} 形式的错误。
//
// 带 code 的场合是「前端要按错误类型分流」的接口：影片流代理要让前端区分
// AUTH_FAILED（去改挂载密码）与 NOT_FOUND（文件被挪走），只给一句文案
// 前端就只能干瞪眼。
func FailWithCode(w http.ResponseWriter, status int, message, code string) {
	JSON(w, status, map[string]any{"success": false, "message": message, "code": code})
}

// BadRequest 400。
func BadRequest(w http.ResponseWriter, message string) { Fail(w, http.StatusBadRequest, message) }

// Unauthorized 401。
func Unauthorized(w http.ResponseWriter, message string) { Fail(w, http.StatusUnauthorized, message) }

// Forbidden 403。
func Forbidden(w http.ResponseWriter, message string) { Fail(w, http.StatusForbidden, message) }

// NotFound 404。
func NotFound(w http.ResponseWriter, message string) { Fail(w, http.StatusNotFound, message) }

// InternalError 500：对外只给通用文案，细节写日志。
func InternalError(w http.ResponseWriter, scope string, err error) {
	if err != nil {
		log.Printf("[%s] %v", scope, err)
	}
	Fail(w, http.StatusInternalServerError, "服务器内部错误")
}

// DecodeJSON 解析请求体。
//
// 限制 1MB 与 Node 版 express.json({limit:'1mb'}) 对齐；
// DisallowUnknownFields 故意不开——前端有历史遗留字段，严格模式会直接 400。
func DecodeJSON(r *http.Request, dst any) error {
	limited := http.MaxBytesReader(nil, r.Body, 1<<20)
	return json.NewDecoder(limited).Decode(dst)
}
