package crawler

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// 引擎配置（crawler/config.json）的读取。
//
// Python 版 config.py 管全量配置；Go 侧只需要与 agent 相关的三段：
// llm（模型接入）、generation（生成循环）、agent（对话循环）。文件仍由
// GUI / Python 引擎写入，Go 只读，保证两边用同一份 Key 与提示词配置。
// 未知段落原样保留在 Raw 里，后续 localized config 接口可以直接透传。

// EngineConfig 是 config.json 中 Go 引擎关心的部分。
type EngineConfig struct {
	LLM   LLMConfig
	Agent AgentConfig
	// Raw 是整个 JSON 对象（含未解析的段），保存配置时可以原样写回。
	Raw map[string]any
}

// LoadEngineConfig 读取 root/config.json；文件不存在时返回默认值。
func LoadEngineConfig(root string) (*EngineConfig, error) {
	config := &EngineConfig{Raw: map[string]any{}}
	if root == "" {
		return config, nil
	}
	raw, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return config, nil
		}
		return nil, ConfigError("读取 config.json 失败: " + err.Error())
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, ConfigError("config.json 不是有效 JSON: " + err.Error())
	}
	if decoded == nil {
		decoded = map[string]any{}
	}
	config.Raw = decoded
	config.apply(decoded)
	return config, nil
}

// Save 写回 config.json（保留未解析段落）。
func (c *EngineConfig) Save(root string) error {
	if root == "" {
		return ConfigError("没有可用的爬虫根目录")
	}
	if c.Raw == nil {
		c.Raw = map[string]any{}
	}
	c.Raw["llm"] = llmSection(c.LLM)
	c.Raw["agent"] = agentSection(c.Agent)
	encoded, err := json.MarshalIndent(c.Raw, "", "  ")
	if err != nil {
		return ConfigError("config.json 序列化失败: " + err.Error())
	}
	return os.WriteFile(filepath.Join(root, "config.json"), append(encoded, '\n'), 0o644)
}

// ApplyRaw 用一份完整配置重建结构体字段（PUT 合并后调用）。
func (c *EngineConfig) ApplyRaw(decoded map[string]any) {
	c.apply(decoded)
}

// DeepMerge 递归合并两个 JSON 对象（patch 覆盖 base；数组整体替换）。
func DeepMerge(base, patch map[string]any) map[string]any {
	merged := make(map[string]any, len(base)+len(patch))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range patch {
		existing, existingIsMap := merged[key].(map[string]any)
		incoming, incomingIsMap := value.(map[string]any)
		if existingIsMap && incomingIsMap {
			merged[key] = DeepMerge(existing, incoming)
			continue
		}
		merged[key] = value
	}
	return merged
}

func (c *EngineConfig) apply(decoded map[string]any) {
	if llm, ok := decoded["llm"].(map[string]any); ok {
		c.LLM.BaseURL = textOf(llm["base_url"], "https://api.deepseek.com/v1")
		c.LLM.APIKey = textOf(llm["api_key"], "")
		c.LLM.Model = textOf(llm["model"], "deepseek-chat")
		if value, ok := llm["temperature"].(float64); ok {
			c.LLM.Temperature = value
		} else {
			c.LLM.Temperature = 0.1
		}
		if value, ok := llm["max_tokens"].(float64); ok {
			c.LLM.MaxTokens = int(value)
		} else {
			c.LLM.MaxTokens = 2048
		}
		if value, ok := llm["timeout_sec"].(float64); ok {
			c.LLM.TimeoutSec = int(value)
		} else {
			c.LLM.TimeoutSec = 90
		}
		c.LLM.ReasoningEffort = strings.TrimSpace(textOf(llm["reasoning_effort"], ""))
	}
	if generation, ok := decoded["generation"].(map[string]any); ok {
		if value, ok := generation["max_steps"].(float64); ok {
			c.Agent.MaxSteps = int(value)
		}
		c.Agent.SampleKeyword = textOf(generation["sample_keyword"], "电影")
		c.Agent.GenerationEffort = strings.TrimSpace(textOf(generation["reasoning_effort"], ""))
	}
	if agent, ok := decoded["agent"].(map[string]any); ok {
		if value, ok := agent["max_steps"].(float64); ok {
			c.Agent.ChatMaxSteps = int(value)
		}
		if value, ok := agent["auto_continue"].(float64); ok {
			c.Agent.AutoContinue = int(value)
		}
		c.Agent.CustomPrompt = strings.TrimSpace(textOf(agent["custom_prompt"], ""))
	}
}

func llmSection(config LLMConfig) map[string]any {
	return map[string]any{
		"base_url":         config.BaseURL,
		"api_key":          config.APIKey,
		"model":            config.Model,
		"temperature":      config.Temperature,
		"max_tokens":       config.MaxTokens,
		"timeout_sec":      config.TimeoutSec,
		"reasoning_effort": config.ReasoningEffort,
	}
}

func agentSection(config AgentConfig) map[string]any {
	return map[string]any{
		"max_steps":     config.ChatMaxSteps,
		"auto_continue": config.AutoContinue,
		"custom_prompt": config.CustomPrompt,
	}
}

func textOf(value any, fallback string) string {
	if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
		return text
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fallback
}
