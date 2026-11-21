package crawler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"zviewer/backend/internal/netproxy"
)

// OpenAI 兼容的对话客户端（DeepSeek / 通义 / 自建 vLLM 都能用）。
//
// 与 Python 版 llm.py 的差别只有传输层：那边用 urllib 逐行读，这边用
// bufio.Scanner；SSE 分片解析、tool_calls 按 index 拼接、流式失败回退非流式的
// 行为都保持一致——agent 的 function calling 依赖这些细节。

// LLMConfig 是 config.json 的 llm 段。
type LLMConfig struct {
	BaseURL         string
	APIKey          string
	Model           string
	Temperature     float64
	MaxTokens       int
	TimeoutSec      int
	ReasoningEffort string
}

// LLMClient 是一次会话复用的客户端。
type LLMClient struct {
	config LLMConfig
	client *http.Client
}

// ToolCall 是一条模型要求调用的工具。
type ToolCall struct {
	ID        string
	Name      string
	Arguments map[string]any
}

// ChatResult 是一次对话的归一化结果。
type ChatResult struct {
	Content      string
	Reasoning    string
	ToolCalls    []ToolCall
	FinishReason string
	Usage        map[string]any
}

// ChatOptions 覆盖单次请求的参数。
type ChatOptions struct {
	Tools      []map[string]any
	ToolChoice string
	// ReasoningEffort 覆盖配置里的全局推理力度（空 = 用配置值）。
	ReasoningEffort string
	Temperature     *float64
	MaxTokens       int
	ResponseFormat  map[string]any
	Model           string
	// OnDelta 在流式模式下逐段回调：kind 为 reasoning / content。
	OnDelta func(kind, text string)
	// Cancel 返回 true 时中断生成。
	Cancel func() bool
}

// NewLLMClient 构造客户端。base_url 允许已经带 /v1。
func NewLLMClient(config LLMConfig) *LLMClient {
	timeout := config.TimeoutSec
	if timeout <= 0 {
		timeout = 90
	}
	return &LLMClient{
		config: config,
		client: &http.Client{Transport: netproxy.Transport(), Timeout: time.Duration(timeout) * time.Second},
	}
}

func (c *LLMClient) apiBase() string {
	base := strings.TrimRight(strings.TrimSpace(c.config.BaseURL), "/")
	if base == "" {
		base = "https://api.deepseek.com/v1"
	}
	base = strings.TrimSuffix(base, "/chat/completions")
	return base
}

func (c *LLMClient) endpoint() string { return c.apiBase() + "/chat/completions" }

func (c *LLMClient) model(explicit string) string {
	if strings.TrimSpace(explicit) != "" {
		return explicit
	}
	if strings.TrimSpace(c.config.Model) != "" {
		return c.config.Model
	}
	return "deepseek-chat"
}

// ListModels 拉取 /models，用于 GUI 的模型下拉。
func (c *LLMClient) ListModels(ctx context.Context) ([]string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(reqCtx, http.MethodGet, c.apiBase()+"/models", nil)
	if err != nil {
		return nil, LLMError("模型列表请求构造失败: "+err.Error(), nil)
	}
	c.authorize(request)
	response, err := c.client.Do(request)
	if err != nil {
		return nil, LLMError("拉取模型列表失败: "+err.Error(), nil)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if response.StatusCode >= 400 {
		return nil, LLMError(fmt.Sprintf("拉取模型列表失败: HTTP %d", response.StatusCode), nil)
	}
	var decoded struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, LLMError("模型列表不是有效 JSON: "+err.Error(), nil)
	}
	names := make([]string, 0, len(decoded.Data))
	for _, item := range decoded.Data {
		if item.ID != "" {
			names = append(names, item.ID)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (c *LLMClient) authorize(request *http.Request) {
	request.Header.Set("Content-Type", "application/json")
	if c.config.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.config.APIKey)
	}
}

// payload 组装请求体。
func (c *LLMClient) payload(messages []map[string]any, opts ChatOptions, stream bool) map[string]any {
	temperature := c.config.Temperature
	if opts.Temperature != nil {
		temperature = *opts.Temperature
	}
	maxTokens := c.config.MaxTokens
	if opts.MaxTokens > 0 {
		maxTokens = opts.MaxTokens
	}
	if maxTokens <= 0 {
		maxTokens = 2048
	}
	body := map[string]any{
		"model":       c.model(opts.Model),
		"messages":    messages,
		"temperature": temperature,
		"max_tokens":  maxTokens,
	}
	if stream {
		body["stream"] = true
	}
	if len(opts.Tools) > 0 {
		body["tools"] = opts.Tools
		body["tool_choice"] = firstNonEmpty(opts.ToolChoice, "auto")
	}
	if opts.ResponseFormat != nil {
		body["response_format"] = opts.ResponseFormat
	}
	effort := c.config.ReasoningEffort
	if strings.TrimSpace(opts.ReasoningEffort) != "" {
		effort = strings.TrimSpace(opts.ReasoningEffort)
	}
	if strings.TrimSpace(effort) != "" && effort != "default" {
		body["reasoning_effort"] = effort
	}
	return body
}

// Chat 非流式对话。
func (c *LLMClient) Chat(ctx context.Context, messages []map[string]any, opts ChatOptions) (*ChatResult, error) {
	if strings.TrimSpace(c.config.APIKey) == "" {
		return nil, LLMError("尚未配置大模型 API Key，请在 GUI 的爬虫引擎页填写", nil)
	}
	encoded, err := json.Marshal(c.payload(messages, opts, false))
	if err != nil {
		return nil, LLMError("请求序列化失败: "+err.Error(), nil)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(), bytes.NewReader(encoded))
	if err != nil {
		return nil, LLMError("请求构造失败: "+err.Error(), nil)
	}
	c.authorize(request)
	response, err := c.client.Do(request)
	if err != nil {
		return nil, LLMError("调用大模型失败: "+err.Error(), nil)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if response.StatusCode >= 400 {
		snippet := string(payload)
		if len([]rune(snippet)) > 300 {
			snippet = string([]rune(snippet)[:300])
		}
		return nil, LLMError(fmt.Sprintf("大模型返回 HTTP %d: %s", response.StatusCode, snippet), nil)
	}
	var decoded map[string]any
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return nil, LLMError("大模型返回的不是有效 JSON: "+err.Error(), nil)
	}
	return ParseChatResponse(decoded), nil
}

// ChatStream 流式对话。服务端不支持流式（连不上/没吐任何增量）时自动回退 Chat。
func (c *LLMClient) ChatStream(ctx context.Context, messages []map[string]any, opts ChatOptions) (*ChatResult, error) {
	if strings.TrimSpace(c.config.APIKey) == "" {
		return nil, LLMError("尚未配置大模型 API Key，请在 GUI 的爬虫引擎页填写", nil)
	}
	encoded, err := json.Marshal(c.payload(messages, opts, true))
	if err != nil {
		return nil, LLMError("请求序列化失败: "+err.Error(), nil)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(), bytes.NewReader(encoded))
	if err != nil {
		return nil, LLMError("请求构造失败: "+err.Error(), nil)
	}
	c.authorize(request)
	request.Header.Set("Accept", "text/event-stream")

	response, err := c.client.Do(request)
	if err != nil {
		return c.Chat(ctx, messages, opts)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		snippet := string(payload)
		if len([]rune(snippet)) > 300 {
			snippet = string([]rune(snippet)[:300])
		}
		return nil, LLMError(fmt.Sprintf("大模型返回 HTTP %d: %s", response.StatusCode, snippet), nil)
	}

	var content, reasoning strings.Builder
	type slot struct{ id, name, arguments string }
	slots := map[int]*slot{}
	finishReason := ""
	usage := map[string]any{}
	emitted := false

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		if opts.Cancel != nil && opts.Cancel() {
			return nil, LLMError("已停止生成", map[string]any{"cancelled": true})
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		chunk := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if chunk == "[DONE]" {
			break
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(chunk), &parsed); err != nil {
			continue
		}
		if rawUsage, ok := parsed["usage"].(map[string]any); ok {
			usage = rawUsage
		}
		choices, ok := parsed["choices"].([]any)
		if !ok || len(choices) == 0 {
			continue
		}
		choice, ok := choices[0].(map[string]any)
		if !ok {
			continue
		}
		if reason, ok := choice["finish_reason"].(string); ok && reason != "" {
			finishReason = reason
		}
		delta, ok := choice["delta"].(map[string]any)
		if !ok {
			continue
		}
		if text := firstNonEmpty(stringOr(delta["reasoning_content"]), stringOr(delta["reasoning"])); text != "" {
			reasoning.WriteString(text)
			emitted = true
			if opts.OnDelta != nil {
				opts.OnDelta("reasoning", text)
			}
		}
		if text := stringOr(delta["content"]); text != "" {
			content.WriteString(text)
			emitted = true
			if opts.OnDelta != nil {
				opts.OnDelta("content", text)
			}
		}
		if calls, ok := delta["tool_calls"].([]any); ok {
			for _, item := range calls {
				object, ok := item.(map[string]any)
				if !ok {
					continue
				}
				index := int(toFloat(object["index"]))
				current, exists := slots[index]
				if !exists {
					current = &slot{}
					slots[index] = current
				}
				if id := stringOr(object["id"]); id != "" {
					current.id = id
				}
				if function, ok := object["function"].(map[string]any); ok {
					current.name += stringOr(function["name"])
					current.arguments += stringOr(function["arguments"])
				}
				emitted = true
			}
		}
	}
	if err := scanner.Err(); err != nil {
		if !emitted {
			return c.Chat(ctx, messages, opts)
		}
		return nil, LLMError("流式响应中断: "+err.Error(), nil)
	}
	if !emitted && finishReason == "" {
		// 服务端不认 stream 参数：拿不到任何增量就重来一次。
		return c.Chat(ctx, messages, opts)
	}

	toolCalls := make([]ToolCall, 0, len(slots))
	indexes := make([]int, 0, len(slots))
	for index := range slots {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	for _, index := range indexes {
		current := slots[index]
		toolCalls = append(toolCalls, ToolCall{
			ID:        current.id,
			Name:      current.name,
			Arguments: parseArguments(current.arguments),
		})
	}
	return &ChatResult{
		Content:      content.String(),
		Reasoning:    reasoning.String(),
		ToolCalls:    toolCalls,
		FinishReason: finishReason,
		Usage:        usage,
	}, nil
}

// parseArguments 把工具参数 JSON 解成对象；坏 JSON 原样塞进 __raw（agent 要回给模型）。
func parseArguments(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}
	}
	var decoded any
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return map[string]any{"__raw": trimmed}
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return map[string]any{"value": decoded}
	}
	return object
}

// ParseChatResponse 把非流式响应归一化成 ChatResult。
func ParseChatResponse(decoded map[string]any) *ChatResult {
	result := &ChatResult{Usage: map[string]any{}}
	if rawUsage, ok := decoded["usage"].(map[string]any); ok {
		result.Usage = rawUsage
	}
	choices, ok := decoded["choices"].([]any)
	if !ok || len(choices) == 0 {
		return result
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		return result
	}
	if reason, ok := choice["finish_reason"].(string); ok {
		result.FinishReason = reason
	}
	message, ok := choice["message"].(map[string]any)
	if !ok {
		return result
	}
	result.Content = stringOr(message["content"])
	result.Reasoning = firstNonEmpty(stringOr(message["reasoning_content"]), stringOr(message["reasoning"]))
	if calls, ok := message["tool_calls"].([]any); ok {
		for _, item := range calls {
			object, ok := item.(map[string]any)
			if !ok {
				continue
			}
			call := ToolCall{ID: stringOr(object["id"])}
			if function, ok := object["function"].(map[string]any); ok {
				call.Name = stringOr(function["name"])
				call.Arguments = parseArguments(stringOr(function["arguments"]))
			}
			result.ToolCalls = append(result.ToolCalls, call)
		}
	}
	return result
}

// AssistantMessage 把结果转回 messages 里的一条 assistant 消息（供下一轮携带）。
func (r *ChatResult) AssistantMessage() map[string]any {
	message := map[string]any{"role": "assistant", "content": r.Content}
	if len(r.ToolCalls) > 0 {
		calls := make([]any, 0, len(r.ToolCalls))
		for _, call := range r.ToolCalls {
			arguments, _ := json.Marshal(call.Arguments)
			calls = append(calls, map[string]any{
				"id":   call.ID,
				"type": "function",
				"function": map[string]any{
					"name":      call.Name,
					"arguments": string(arguments),
				},
			})
		}
		message["tool_calls"] = calls
	}
	return message
}
