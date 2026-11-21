package crawler

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
)

// 限量搜索日志：给 agent 诊断空结果 / 验证码 / 选择器漂移用。
// 只记短预览，不落 Cookie 与响应头。

// DefaultSearchLogLimit 是环形日志的默认容量。
const DefaultSearchLogLimit = 200

// SearchLogStore 是最多 N 条、最新的在最前的 JSON 日志。
type SearchLogStore struct {
	path string
	// 不用 limit 作字段名，避免和 http 包之类的同名概念混淆。
	capacity int
	mu       sync.Mutex
	entries  []map[string]any
}

// NewSearchLogStore 打开日志文件（不存在则视为空）。
func NewSearchLogStore(path string, capacity int) (*SearchLogStore, error) {
	if capacity <= 0 {
		capacity = DefaultSearchLogLimit
	}
	if capacity < 10 {
		capacity = 10
	}
	store := &SearchLogStore{path: path, capacity: capacity}
	store.entries = store.load()
	return store, nil
}

func (s *SearchLogStore) load() []map[string]any {
	payload, err := os.ReadFile(s.path)
	if err != nil {
		return []map[string]any{}
	}
	var raw []map[string]any
	if err := json.Unmarshal(payload, &raw); err != nil {
		return []map[string]any{}
	}
	if len(raw) > s.capacity {
		raw = raw[:s.capacity]
	}
	if raw == nil {
		return []map[string]any{}
	}
	return raw
}

func (s *SearchLogStore) save() {
	payload, err := json.MarshalIndent(s.entries, "", " ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}

// Append 压入一条记录（带 ts），返回落库后的副本。
func (s *SearchLogStore) Append(record map[string]any) map[string]any {
	entry := make(map[string]any, len(record)+1)
	for key, value := range record {
		entry[key] = value
	}
	entry["ts"] = NowISO()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = append([]map[string]any{entry}, s.entries...)
	if len(s.entries) > s.capacity {
		s.entries = s.entries[:s.capacity]
	}
	s.save()
	return entry
}

// List 按站点/来源/失败筛选，最新的在最前。
func (s *SearchLogStore) List(limit int, site string, failuresOnly bool, source string) []map[string]any {
	size := limit
	if size <= 0 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	needle := lowerTrim(site)
	out := make([]map[string]any, 0, size)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.entries {
		if needle != "" {
			if !containsAnyFold(needle, entry["site"], entry["siteId"], entry["siteName"]) {
				continue
			}
		}
		if failuresOnly && boolValue(entry["ok"]) {
			continue
		}
		if source != "" {
			if value, _ := entry["source"].(string); value != source {
				continue
			}
		}
		copied := make(map[string]any, len(entry))
		for key, value := range entry {
			copied[key] = value
		}
		out = append(out, copied)
		if len(out) >= size {
			break
		}
	}
	return out
}

// Clear 清空日志并返回被清掉的条数。
func (s *SearchLogStore) Clear() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := len(s.entries)
	s.entries = []map[string]any{}
	s.save()
	return count
}

// Count 返回当前条数。
func (s *SearchLogStore) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// BuildSearchRecord 组装一条日志记录（不落盘）。
func BuildSearchRecord(rule *Rule, keyword, roomID, role string, page *Page, count, skipped int, errMsg string, tookMs int, source string, repair map[string]any) map[string]any {
	if page == nil {
		page = &Page{}
	}
	if source == "" {
		source = "search"
	}
	request := page.Request
	if request == nil {
		request = map[string]string{}
	}
	record := map[string]any{
		"source":      source,
		"ok":          errMsg == "",
		"siteId":      rule.ID,
		"site":        rule.Site,
		"siteName":    rule.Name,
		"keyword":     keyword,
		"roomId":      roomID,
		"role":        firstNonEmpty(role, "guest"),
		"mode":        rule.Search.Mode,
		"parseType":   rule.Parse.Type,
		"container":   rule.Parse.Container,
		"count":       count,
		"skipped":     skipped,
		"tookMs":      tookMs,
		"pageUrl":     page.PageURL,
		"status":      page.Status,
		"request":     map[string]any{"method": request["method"], "url": request["url"]},
		"bytes":       len([]byte(page.Text)),
		"bodyPreview": previewText(page.Text, 400),
	}
	if errMsg != "" {
		record["error"] = truncateRunes(errMsg, 500)
	}
	if repair != nil {
		attempted := boolValue(repair["attempted"])
		success := boolValue(repair["success"])
		errorText, _ := repair["error"].(string)
		record["repair"] = map[string]any{
			"attempted": attempted,
			"success":   success,
			"error":     truncateRunes(errorText, 300),
		}
	}
	return record
}

func previewText(text string, size int) string {
	return truncateRunes(CollapseSpace(text), size)
}

func lowerTrim(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func containsAnyFold(needle string, values ...any) bool {
	for _, value := range values {
		text, _ := value.(string)
		if text != "" && strings.Contains(strings.ToLower(text), needle) {
			return true
		}
	}
	return false
}
