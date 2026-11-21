package crawler

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// 站点账号库（crawler/data/accounts.json，权限 0600）。
//
// 对应 Python 版 accounts.py。只有 root/管理员工具能读到明文；列表视图掩码。
// 规则通过 search.account_id / play.account_id 引用账号，解析时把 Cookie 与
// 请求头合进抓取请求（见 withAccount）。

// SensitiveHeaders 在掩码视图里要打码的请求头名（小写）。
var SensitiveHeaders = map[string]bool{
	"cookie":        true,
	"authorization": true,
	"x-csrf-token":  true,
	"token":         true,
}

// MaskSecret 把密钥掩码成「前 4 + ... + 后 4」，太短的只说「已设置」。
func MaskSecret(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 8 {
		return "已设置"
	}
	return value[:4] + "..." + value[len(value)-4:]
}

// AccountStore 读写 accounts.json。
type AccountStore struct {
	path string
	mu   sync.Mutex
}

// NewAccountStore 构造账号库（目录不存在时自动建）。
func NewAccountStore(path string) (*AccountStore, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, ConfigError("账号库路径不可用: " + err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, ConfigError("无法创建账号库目录: " + err.Error())
	}
	return &AccountStore{path: abs}, nil
}

func (s *AccountStore) read() ([]map[string]any, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return []map[string]any{}, nil
		}
		return nil, RuleError("账号文件读取失败: "+err.Error(), nil)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, RuleError("账号文件损坏: "+err.Error(), nil)
	}
	// 兼容 {"accounts": [...]} 与裸数组两种写法。
	items, ok := decoded.([]any)
	if !ok {
		if object, isObject := decoded.(map[string]any); isObject {
			if inner, exists := object["accounts"].([]any); exists {
				items = inner
			}
		}
	}
	accounts := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if account, isObject := item.(map[string]any); isObject {
			accounts = append(accounts, account)
		}
	}
	return accounts, nil
}

func (s *AccountStore) write(accounts []map[string]any) error {
	encoded, err := json.MarshalIndent(map[string]any{"accounts": accounts}, "", "  ")
	if err != nil {
		return RuleError("账号序列化失败: "+err.Error(), nil)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), 0o600); err != nil {
		return RuleError("账号文件写入失败: "+err.Error(), nil)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return RuleError("账号文件写入失败: "+err.Error(), nil)
	}
	// Windows 上 chmod 基本无效，忽略错误（与 Python 一致）。
	_ = os.Chmod(s.path, 0o600)
	return nil
}

// PublicAccountView 返回脱敏（mask=true）或带明文的视图。
func PublicAccountView(account map[string]any, mask bool) map[string]any {
	headers := map[string]any{}
	if raw, ok := account["headers"].(map[string]any); ok {
		for key, value := range raw {
			headers[key] = value
		}
	}
	headerKeys := make([]string, 0, len(headers))
	for key := range headers {
		headerKeys = append(headerKeys, key)
	}
	sort.Strings(headerKeys)
	view := map[string]any{
		"id":          account["id"],
		"name":        firstNonEmpty(stringOf(account["name"]), stringOf(account["id"])),
		"site":        stringOf(account["site"]),
		"username":    stringOf(account["username"]),
		"notes":       stringOf(account["notes"]),
		"hasCookies":  stringOf(account["cookies"]) != "",
		"hasPassword": stringOf(account["password"]) != "",
		"headerKeys":  headerKeys,
		"createdAt":   account["created_at"],
		"updatedAt":   account["updated_at"],
	}
	if !mask {
		view["cookies"] = stringOf(account["cookies"])
		view["password"] = stringOf(account["password"])
		view["headers"] = headers
		return view
	}
	view["cookies"] = MaskSecret(stringOf(account["cookies"]))
	masked := make(map[string]any, len(headers))
	for key, value := range headers {
		text := stringOf(value)
		if SensitiveHeaders[strings.ToLower(key)] {
			masked[key] = MaskSecret(text)
		} else {
			masked[key] = text
		}
	}
	view["headers"] = masked
	return view
}

// List 返回全部账号（默认掩码）。
func (s *AccountStore) List(mask bool) []map[string]any {
	s.mu.Lock()
	accounts, err := s.read()
	s.mu.Unlock()
	if err != nil {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(accounts))
	for _, account := range accounts {
		out = append(out, PublicAccountView(account, mask))
	}
	return out
}

// Get 按 id 取原始账号（含明文）。
func (s *AccountStore) Get(accountID string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	accounts, err := s.read()
	if err != nil {
		return nil
	}
	for _, account := range accounts {
		if stringOf(account["id"]) == accountID {
			return account
		}
	}
	return nil
}

// Require 按 id 取账号，不存在时报错。
func (s *AccountStore) Require(accountID string) (map[string]any, error) {
	account := s.Get(accountID)
	if account == nil {
		return nil, RuleError("账号不存在: "+accountID, nil)
	}
	return account, nil
}

// Save 保存或更新账号（同 id 覆盖；未提供字段沿用旧值）。
func (s *AccountStore) Save(raw map[string]any) (map[string]any, error) {
	if raw == nil {
		return nil, RuleError("账号必须是 JSON 对象", nil)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	accounts, err := s.read()
	if err != nil {
		return nil, err
	}
	accountID := accountSlug(firstNonEmpty(stringOf(raw["id"]), stringOf(raw["name"]), stringOf(raw["site"]), "account"))
	var existing map[string]any
	index := -1
	for i, item := range accounts {
		if stringOf(item["id"]) == accountID {
			existing = item
			index = i
			break
		}
	}
	previous := func(key, fallback string) string {
		if value, ok := raw[key]; ok && value != nil {
			return stringOf(value)
		}
		if existing != nil {
			return firstNonEmpty(stringOf(existing[key]), fallback)
		}
		return fallback
	}
	headers := map[string]any{}
	switch typed := raw["headers"].(type) {
	case nil:
		if existing != nil {
			if old, ok := existing["headers"].(map[string]any); ok {
				headers = old
			}
		}
	case map[string]any:
		headers = typed
	default:
		return nil, RuleError("账号 headers 必须是对象", nil)
	}
	normalizedHeaders := make(map[string]any, len(headers))
	for key, value := range headers {
		normalizedHeaders[key] = stringOf(value)
	}
	createdAt := NowISO()
	if existing != nil {
		if previous := stringOf(existing["created_at"]); previous != "" {
			createdAt = previous
		}
	}
	account := map[string]any{
		"id":         accountID,
		"name":       strings.TrimSpace(previous("name", accountID)),
		"site":       strings.ToLower(strings.TrimSpace(previous("site", ""))),
		"username":   strings.TrimSpace(previous("username", "")),
		"password":   previous("password", ""),
		"cookies":    previous("cookies", ""),
		"headers":    normalizedHeaders,
		"notes":      strings.TrimSpace(previous("notes", "")),
		"created_at": createdAt,
		"updated_at": NowISO(),
	}
	if index >= 0 {
		accounts[index] = account
	} else {
		accounts = append(accounts, account)
	}
	if err := s.write(accounts); err != nil {
		return nil, err
	}
	return account, nil
}

// Delete 删除账号，返回是否真的删掉了。
func (s *AccountStore) Delete(accountID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	accounts, err := s.read()
	if err != nil {
		return false
	}
	remaining := make([]map[string]any, 0, len(accounts))
	for _, account := range accounts {
		if stringOf(account["id"]) != accountID {
			remaining = append(remaining, account)
		}
	}
	if len(remaining) == len(accounts) {
		return false
	}
	return s.write(remaining) == nil
}

// Resolve 实现 AccountResolver：给抓取器用的账号视图（含 Cookie 明文）。
func (s *AccountStore) Resolve(accountID string) (map[string]any, error) {
	if strings.TrimSpace(accountID) == "" {
		return map[string]any{}, nil
	}
	account, err := s.Require(accountID)
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	if raw, ok := account["headers"].(map[string]any); ok {
		for key, value := range raw {
			headers[key] = stringOf(value)
		}
	}
	return map[string]any{
		"id":       stringOf(account["id"]),
		"username": stringOf(account["username"]),
		"password": stringOf(account["password"]),
		"cookies":  stringOf(account["cookies"]),
		"headers":  headers,
	}, nil
}

// accountSlug 生成账号 id：小写字母数字加连字符，最多 40 字符。
func accountSlug(value string) string {
	var builder strings.Builder
	lastDash := false
	for _, char := range strings.ToLower(strings.TrimSpace(value)) {
		switch {
		case (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9'):
			builder.WriteRune(char)
			lastDash = false
		default:
			if !lastDash {
				builder.WriteByte('-')
				lastDash = true
			}
		}
	}
	slug := strings.Trim(builder.String(), "-")
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	if slug == "" {
		return "account"
	}
	return slug
}
