// Package mcp 实现 MCP（Model Context Protocol）的 stdio 传输层。
//
// 只做协议，不含业务：工具从 Registry 里拿（crawler.ToolRegistry 直接满足），
// 所以这一层可以被单测完整覆盖，也不会把爬虫引擎的内部结构绑进协议代码。
//
// 报文格式按规范：stdin/stdout 上每行一个 JSON-RPC 2.0 对象，
// stdout 只允许出现协议报文——任何诊断信息都必须走 stderr。
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// 支持的协议版本。客户端报的版本在列表里就原样回，否则回最新的那个
// （规范允许服务端选一个自己支持的版本，客户端不接受会自己断开）。
var SupportedVersions = []string{"2024-11-05", "2025-03-26", "2025-06-18"}

// LatestVersion 是默认协商结果。
const LatestVersion = "2025-06-18"

// ServerName 出现在 initialize 的 serverInfo 里；客户端会拿它当工具名前缀或显示名。
const ServerName = "zviewer-crawler"

// DefaultInstructions 是 initialize 返回给模型的一段说明。
const DefaultInstructions = "ZViewer 爬虫引擎：生成、测试、管理影视站点的搜索规则。工具返回的 " +
	"success=false 表示这次调用失败，code 与 error 说明原因。"

// Registry 是工具集的最小契约，*crawler.ToolRegistry 直接满足。
type Registry interface {
	MCPTools() []map[string]any
	Call(ctx context.Context, name string, args map[string]any) map[string]any
}

// Handler 把一条请求变成一条响应。无状态，可并发调用。
type Handler struct {
	registry Registry
	version  string
	logf     func(format string, args ...any)
}

// NewHandler 构造处理器。version 是服务端版本号（出现在 serverInfo 里）。
func NewHandler(registry Registry, version string, logf func(string, ...any)) *Handler {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Handler{registry: registry, version: version, logf: logf}
}

// jsonrpcRequest 是唯一需要解析的入站结构。
type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Handle 处理一个已经解析好的请求；第二个返回值表示是否需要回包
// （通知没有 id，按规范不回）。
func (h *Handler) Handle(ctx context.Context, raw json.RawMessage) (map[string]any, bool) {
	var request jsonrpcRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return errorResponse(nil, -32600, "Invalid Request"), true
	}
	if request.Method == "" {
		return errorResponse(request.ID, -32600, "Invalid Request"), true
	}
	notification := len(request.ID) == 0

	switch request.Method {
	case "initialize":
		return h.result(request.ID, h.initialize(request.Params)), true
	case "notifications/initialized", "notifications/cancelled":
		return nil, false
	case "ping":
		return h.result(request.ID, map[string]any{}), true
	case "tools/list":
		return h.result(request.ID, map[string]any{"tools": h.registry.MCPTools()}), true
	case "tools/call":
		return h.result(request.ID, h.callTool(ctx, request.Params)), true
	case "resources/list", "prompts/list":
		key := strings.SplitN(request.Method, "/", 2)[0]
		return h.result(request.ID, map[string]any{key: []any{}}), true
	case "logging/setLevel":
		// 没有分级日志要调，收下不回嘴。
		return h.result(request.ID, map[string]any{}), true
	}
	if notification {
		return nil, false
	}
	return errorResponse(request.ID, -32601, "Method not found: "+request.Method), true
}

func (h *Handler) initialize(params json.RawMessage) map[string]any {
	var payload struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(params, &payload)
	version := LatestVersion
	for _, supported := range SupportedVersions {
		if strings.TrimSpace(payload.ProtocolVersion) == supported {
			version = supported
			break
		}
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities": map[string]any{
			"tools": map[string]any{"listChanged": false},
		},
		"serverInfo":   map[string]any{"name": ServerName, "version": h.version},
		"instructions": DefaultInstructions,
	}
}

// callTool 执行工具。工具自己把错误编码进返回值（success:false），
// 这里只负责包成 MCP 的 content 结构，让模型能直接读到。
func (h *Handler) callTool(ctx context.Context, params json.RawMessage) map[string]any {
	var payload struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &payload); err != nil {
		return toolError("参数解析失败：" + err.Error())
	}
	if strings.TrimSpace(payload.Name) == "" {
		return toolError("缺少工具名 name")
	}
	result := h.registry.Call(ctx, payload.Name, payload.Arguments)
	if result == nil {
		result = map[string]any{"success": false, "error": "工具没有返回结果"}
	}
	isError := false
	if success, ok := result["success"].(bool); ok && !success {
		isError = true
	}
	if ok, exists := result["ok"].(bool); exists && !ok {
		isError = true
	}
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": toText(result)}},
		"isError": isError,
	}
}

// toText 序列化工具结果。SetEscapeHTML(false) 是必要的：规则里的正则、选择器
// 常带 < > &，转义成 \u003c 之后模型读起来像乱码。
func toText(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Sprintf("%v", value)
	}
	return strings.TrimRight(buffer.String(), "\n")
}

func toolError(message string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": message}},
		"isError": true,
	}
}

func (h *Handler) result(id json.RawMessage, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": idOrNull(id), "result": result}
}

func errorResponse(id json.RawMessage, code int, message string) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      idOrNull(id),
		"error":   map[string]any{"code": code, "message": message},
	}
}

// idOrNull 让 id 原样回显（数字/字符串都行），缺失时给 null。
func idOrNull(id json.RawMessage) any {
	if len(id) == 0 {
		return nil
	}
	return id
}

// MaxMessageBytes 是一行的上限。fetch_page / browser_html 的返回可能有几 MB，
// bufio.Scanner 默认 64KB 会直接报 token too long。
const MaxMessageBytes = 8 << 20

// Serve 在 in/out 上跑 stdio 事件循环，直到 EOF。
//
// 返回 error 只用于「读失败」这类真异常；单条报文的问题一律变成 JSON-RPC 错误响包，
// 不能让客户端因为一次坏输入就断开。
func Serve(ctx context.Context, in io.Reader, out io.Writer, handler *Handler) error {
	reader := bufio.NewReaderSize(in, 64<<10)
	writer := bufio.NewWriterSize(out, 64<<10)
	for {
		line, readErr := readLine(reader)
		if len(line) > 0 {
			if err := writeLine(writer, handler.handleLine(ctx, line)); err != nil {
				return err
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

// readLine 读一行（不含换行）。超长时返回错误而不是静默截断。
func readLine(reader *bufio.Reader) ([]byte, error) {
	var buffer []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(buffer)+len(chunk) > MaxMessageBytes {
			return nil, fmt.Errorf("单条报文超过 %d 字节", MaxMessageBytes)
		}
		buffer = append(buffer, chunk...)
		if err == nil {
			return bytes.TrimRight(buffer, "\r\n"), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimRight(buffer, "\r\n"), err
	}
}

// handleLine 把一行原文变成一行响应（可能为空 = 通知）。
func (h *Handler) handleLine(ctx context.Context, line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return nil
	}
	var raw json.RawMessage
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		// 连 JSON 都不是：按规范回 -32700，id 只能是 null。
		return encode(errorResponse(nil, -32700, "Parse error: "+err.Error()))
	}
	// 批量请求（数组）在 2025-06-18 之后被移除，这里明确回错，别让客户端等到超时。
	if len(trimmed) > 0 && trimmed[0] == '[' {
		return encode(errorResponse(nil, -32600, "批量请求已不被支持，请逐条发送"))
	}
	response, ok := h.Handle(ctx, raw)
	if !ok {
		return nil
	}
	return encode(response)
}

func writeLine(writer *bufio.Writer, line []byte) error {
	if len(line) == 0 {
		return nil
	}
	if _, err := writer.Write(append(line, '\n')); err != nil {
		return err
	}
	return writer.Flush()
}

// encode 序列化响应；失败时给一条兜底的内部错误（正常不会走到）。
func encode(response map[string]any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(response); err != nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"encode failed"}}`)
	}
	return bytes.TrimRight(buffer.Bytes(), "\n")
}
