package crawler

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// 规则持久化：一个站点一个 JSON 文件，落在 <crawler>/data/rules/<id>.json。
// 目录布局与文件内容必须和 Python 版互相兼容——用户可能在两边轮流开。

var (
	slugUnsafeRe = regexp.MustCompile(`[^a-z0-9]+`)
	slugMaxLen   = 48
)

// Slugify 把任意字符串变成可做文件名的 id。
func Slugify(value string) string {
	lowered := strings.ToLower(strings.TrimSpace(value))
	slug := slugUnsafeRe.ReplaceAllString(lowered, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > slugMaxLen {
		slug = slug[:slugMaxLen]
	}
	return strings.Trim(slug, "-")
}

// RuleVisibleTo 是引擎、HTTP API 与 MCP 共用的可见性模型：
// 停用的规则对所有人都不可见；visibility=root 只给 root；
// allowed_rooms 为空表示所有房间，否则房间必须在列表里。
func RuleVisibleTo(rule *Rule, roomID, role string) bool {
	if rule == nil || !rule.Enabled {
		return false
	}
	if strings.ToLower(strings.TrimSpace(role)) == "root" {
		return true
	}
	if rule.Visibility == "root" {
		return false
	}
	if len(rule.AllowedRooms) > 0 {
		if roomID == "" || !containsString(rule.AllowedRooms, roomID) {
			return false
		}
	}
	return true
}

// RuleStore 是规则仓库。所有读写走同一把锁，写文件用 tmp+rename。
type RuleStore struct {
	dir string
	mu  sync.Mutex
}

// NewRuleStore 打开（或创建）规则目录。
func NewRuleStore(dir string) (*RuleStore, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	return &RuleStore{dir: abs}, nil
}

// Dir 返回规则目录的绝对路径。
func (s *RuleStore) Dir() string { return s.dir }

func (s *RuleStore) path(ruleID string) string {
	return filepath.Join(s.dir, ruleID+".json")
}

// readFile 读一个规则文件。损坏时返回错误，由调用方决定是跳过还是上抛。
func (s *RuleStore) readFile(path string) (*Rule, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, RuleErrorf("规则文件损坏 %s: %v", filepath.Base(path), err)
	}
	var rule Rule
	if err := json.Unmarshal(payload, &rule); err != nil {
		return nil, RuleErrorf("规则文件必须是 JSON 对象: %s", filepath.Base(path))
	}
	if rule.ID == "" {
		rule.ID = strings.TrimSuffix(filepath.Base(path), ".json")
	}
	// 读入不校验（旧文件可能缺新字段），只补默认值，让列表页不因一条坏规则整体失败。
	Normalize(&rule)
	return &rule, nil
}

// List 返回全部规则，按名称排序。损坏的文件会被跳过（与 Python 一致）。
func (s *RuleStore) List(includeDisabled bool) []*Rule {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	rules := make([]*Rule, 0, len(names))
	for _, name := range names {
		rule, err := s.readFile(filepath.Join(s.dir, name))
		if err != nil {
			continue
		}
		if !includeDisabled && !rule.Enabled {
			continue
		}
		rules = append(rules, rule)
	}
	sort.SliceStable(rules, func(i, j int) bool {
		left := strings.ToLower(firstNonEmpty(rules[i].Name, rules[i].ID))
		right := strings.ToLower(firstNonEmpty(rules[j].Name, rules[j].ID))
		return left < right
	})
	return rules
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// Get 按 id 取一条规则。
func (s *RuleStore) Get(ruleID string) (*Rule, error) {
	id := strings.TrimSpace(ruleID)
	if id == "" || strings.ContainsAny(id, `/\`) {
		return nil, RuleNotFound(ruleID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.path(id)
	if _, err := os.Stat(path); err != nil {
		return nil, RuleNotFound(ruleID)
	}
	return s.readFile(path)
}

// FindBySite 按域名找一条已启用规则，精确匹配优先。
func (s *RuleStore) FindBySite(site string) *Rule {
	host := HostOf(site)
	if host == "" {
		return nil
	}
	var candidates []*Rule
	for _, rule := range s.List(false) {
		if RuleMatchesHost(rule, host) {
			candidates = append(candidates, rule)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return HostOf(candidates[i].Site) == host && HostOf(candidates[j].Site) != host
	})
	return candidates[0]
}

func (s *RuleStore) uniqueID(base string) string {
	slug := Slugify(base)
	if slug == "" {
		slug = "site"
	}
	candidate := slug
	for index := 2; ; index++ {
		if _, err := os.Stat(s.path(candidate)); os.IsNotExist(err) {
			return candidate
		}
		candidate = slug + "-" + itoa(index)
	}
}

func itoa(value int) string { return strconv.Itoa(value) }

// Save 校验并写入规则。ruleID 非空表示「更新这一条」：
// 沿用 created_at / created_by / stats，version 自增。
func (s *RuleStore) Save(raw *Rule, ruleID string) (*Rule, error) {
	rule, err := Validate(raw)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	var existing *Rule
	if trimmed := Slugify(ruleID); trimmed != "" {
		if _, statErr := os.Stat(s.path(trimmed)); statErr == nil {
			existing, _ = s.readFile(s.path(trimmed))
		}
	} else if trimmed := Slugify(rule.ID); trimmed != "" {
		if _, statErr := os.Stat(s.path(trimmed)); statErr == nil {
			existing, _ = s.readFile(s.path(trimmed))
		}
	}

	if existing != nil {
		rule.ID = existing.ID
		if existing.CreatedAt != "" {
			rule.CreatedAt = existing.CreatedAt
		}
		if existing.CreatedBy != "" {
			rule.CreatedBy = existing.CreatedBy
		}
		version := existing.Version
		if version <= 0 {
			version = 1
		}
		rule.Version = version + 1
		rule.Stats = existing.Stats
	} else {
		base := firstNonEmpty(rule.ID, rule.Name, rule.Site, "site")
		rule.ID = s.uniqueID(base)
		rule.Version = 1
		rule.Stats = RuleStats{}
	}
	rule.UpdatedAt = NowISO()
	if err := s.write(rule); err != nil {
		return nil, err
	}
	return rule, nil
}

// Update 用补丁更新规则：search / parse 是浅合并，其余键整体替换；
// id / created_at / created_by / stats 不接受补丁。
func (s *RuleStore) Update(ruleID string, patch map[string]json.RawMessage) (*Rule, error) {
	current, err := s.Get(ruleID)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(current)
	if err != nil {
		return nil, RuleErrorf("规则序列化失败: %v", err)
	}
	base, err := toRawObject(encoded)
	if err != nil {
		return nil, RuleErrorf("规则序列化失败: %v", err)
	}
	for key, value := range patch {
		switch key {
		case "id", "created_at", "created_by", "stats":
			continue
		case "search", "parse":
			incoming, incomingErr := toRawObject(value)
			if incomingErr != nil {
				base[key] = value
				continue
			}
			section := base.object(key)
			if section == nil {
				section = rawObject{}
			}
			for sectionKey, sectionValue := range incoming {
				section[sectionKey] = sectionValue
			}
			merged, mergeErr := json.Marshal(section)
			if mergeErr != nil {
				return nil, RuleErrorf("规则合并失败: %v", mergeErr)
			}
			base[key] = merged
		default:
			base[key] = value
		}
	}
	mergedBytes, err := json.Marshal(base)
	if err != nil {
		return nil, RuleErrorf("规则合并失败: %v", err)
	}
	var merged Rule
	if err := json.Unmarshal(mergedBytes, &merged); err != nil {
		return nil, RuleErrorf("规则不是合法 JSON: %v", err)
	}
	return s.Save(&merged, current.ID)
}

// Delete 删除一条规则，返回是否真的删掉了。
func (s *RuleStore) Delete(ruleID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.path(strings.TrimSpace(ruleID))
	if _, err := os.Stat(path); err != nil {
		return false, nil
	}
	if err := os.Remove(path); err != nil {
		return false, RuleErrorf("删除规则失败: %v", err)
	}
	return true, nil
}

// RecordSearch 记录一次搜索的成败。写失败静默丢弃（统计不该影响主流程）。
func (s *RuleStore) RecordSearch(ruleID string, ok bool, errorMessage string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.path(ruleID)
	if _, err := os.Stat(path); err != nil {
		return
	}
	rule, err := s.readFile(path)
	if err != nil {
		return
	}
	stats := rule.Stats
	stats.Searches++
	if ok {
		stats.Successes++
		stats.LastError = nil
	} else {
		stats.Failures++
		message := errorMessage
		if len([]rune(message)) > 500 {
			message = string([]rune(message)[:500])
		}
		if message == "" {
			message = "unknown"
		}
		stats.LastError = &message
	}
	now := NowISO()
	stats.LastUsedAt = &now
	rule.Stats = stats
	_ = s.write(rule)
}

// ExportBundle 导出一份可移植的规则包。
func (s *RuleStore) ExportBundle(ruleIDs []string) map[string]any {
	wanted := map[string]struct{}{}
	for _, id := range ruleIDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			wanted[trimmed] = struct{}{}
		}
	}
	rules := make([]*Rule, 0, len(wanted))
	for _, rule := range s.List(true) {
		if len(wanted) > 0 {
			if _, ok := wanted[rule.ID]; !ok {
				continue
			}
		}
		rules = append(rules, rule)
	}
	return map[string]any{
		"format":      1,
		"kind":        "zviewer-crawler-rules",
		"exported_at": NowISO(),
		"count":       len(rules),
		"rules":       rules,
	}
}

// ImportBundle 导入规则包。merge 按 id 或「名称+站点」匹配已有规则并更新，
// replace 先清空再导入；dry_run 只做校验不落盘。
func (s *RuleStore) ImportBundle(payload any, mode string, dryRun bool) (map[string]any, error) {
	var incoming []any
	switch typed := payload.(type) {
	case map[string]any:
		list, ok := typed["rules"].([]any)
		if !ok {
			return nil, RuleError("导入内容必须包含 rules 数组", nil)
		}
		incoming = list
	case []any:
		incoming = typed
	default:
		return nil, RuleError("导入内容必须包含 rules 数组", nil)
	}
	normalizedMode := strings.ToLower(strings.TrimSpace(mode))
	if normalizedMode == "" {
		normalizedMode = "merge"
	}
	if normalizedMode != "merge" && normalizedMode != "replace" {
		return nil, RuleError("导入模式只能是 merge 或 replace", nil)
	}

	if normalizedMode == "replace" && !dryRun {
		for _, rule := range s.List(true) {
			_, _ = s.Delete(rule.ID)
		}
	}

	report := map[string]any{
		"success":  true,
		"mode":     normalizedMode,
		"dryRun":   dryRun,
		"total":    len(incoming),
		"imported": 0,
		"updated":  0,
		"skipped":  0,
		"failed":   0,
		"items":    []map[string]any{},
	}
	items := make([]map[string]any, 0, len(incoming))

	for index, rawItem := range incoming {
		label := ""
		object, ok := rawItem.(map[string]any)
		if !ok {
			report["failed"] = report["failed"].(int) + 1
			items = append(items, map[string]any{
				"name": "", "action": "failed", "error": "规则必须是 JSON 对象",
			})
			continue
		}
		encoded, err := json.Marshal(object)
		if err != nil {
			report["failed"] = report["failed"].(int) + 1
			items = append(items, map[string]any{"name": "", "action": "failed", "error": err.Error()})
			continue
		}
		var candidate Rule
		decodeErr := json.Unmarshal(encoded, &candidate)
		label = firstNonEmpty(candidate.Name, candidate.ID, "第 "+itoa(index+1)+" 条")
		if decodeErr != nil {
			report["failed"] = report["failed"].(int) + 1
			items = append(items, map[string]any{"name": label, "action": "failed", "error": decodeErr.Error()})
			continue
		}

		existing := s.findExistingForImport(&candidate)
		if dryRun {
			if _, validateErr := Validate(&candidate); validateErr != nil {
				report["failed"] = report["failed"].(int) + 1
				items = append(items, map[string]any{"name": label, "action": "failed", "error": validateErr.Error()})
				continue
			}
			if existing != nil {
				report["updated"] = report["updated"].(int) + 1
				items = append(items, map[string]any{"name": label, "action": "update", "ruleId": existing.ID})
			} else {
				report["imported"] = report["imported"].(int) + 1
				items = append(items, map[string]any{"name": label, "action": "create", "ruleId": nil})
			}
			continue
		}
		if existing != nil {
			saved, saveErr := s.Save(&candidate, existing.ID)
			if saveErr != nil {
				report["failed"] = report["failed"].(int) + 1
				items = append(items, map[string]any{"name": label, "action": "failed", "error": saveErr.Error()})
				continue
			}
			report["updated"] = report["updated"].(int) + 1
			items = append(items, map[string]any{"name": label, "action": "update", "ruleId": saved.ID})
			continue
		}
		saved, saveErr := s.Save(&candidate, "")
		if saveErr != nil {
			report["failed"] = report["failed"].(int) + 1
			items = append(items, map[string]any{"name": label, "action": "failed", "error": saveErr.Error()})
			continue
		}
		report["imported"] = report["imported"].(int) + 1
		items = append(items, map[string]any{"name": label, "action": "create", "ruleId": saved.ID})
	}

	if report["failed"].(int) > 0 {
		report["success"] = false
	}
	report["items"] = items
	return report, nil
}

// findExistingForImport 先按 id 找，再按「名称 + 站点」找。
func (s *RuleStore) findExistingForImport(candidate *Rule) *Rule {
	if slug := Slugify(candidate.ID); slug != "" {
		if _, err := os.Stat(s.path(slug)); err == nil {
			if found, readErr := s.readFile(s.path(slug)); readErr == nil {
				return found
			}
		}
	}
	if candidate.Name == "" {
		return nil
	}
	host := HostOf(candidate.Site)
	for _, rule := range s.List(true) {
		if rule.Name == candidate.Name && HostOf(rule.Site) == host {
			return rule
		}
	}
	return nil
}

// write 原子写入：先写 .json.tmp 再 rename，避免半截文件。
func (s *RuleStore) write(rule *Rule) error {
	path := s.path(rule.ID)
	payload, err := json.MarshalIndent(rule, "", "  ")
	if err != nil {
		return RuleErrorf("规则序列化失败: %v", err)
	}
	payload = append(payload, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		return RuleErrorf("写入规则失败: %v", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return RuleErrorf("写入规则失败: %v", err)
	}
	return nil
}
