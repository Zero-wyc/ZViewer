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
	"time"
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
		"kind":        importBundleKind,
		"exported_at": NowISO(),
		"count":       len(rules),
		"rules":       rules,
	}
}

// ImportOptions 描述「从别处搬来的规则包」该怎么落地。
//
// 规则包里有两类引用换机器后必然失真，调用方必须显式选择怎么处理：
//   - search.account_id / play.account_id 指向源机器的 accounts.json（Cookie 资产），
//     目标机没有同名账号时，规则一搜就报「账号不存在」；
//   - allowed_rooms 是源服务器的房间 ID，目标机对不上就等于对所有人都隐身。
//
// ClearAccounts / ClearRooms 为真时在落库前清空对应引用。注意清空房间列表的
// 语义是「对所有房间开放」，是放大可见范围，调用方应二次确认。
type ImportOptions struct {
	Mode          string
	DryRun        bool
	ClearAccounts bool
	ClearRooms    bool
	// HasAccount 判断目标机有没有这个账号；nil 表示无从检查（不产生警告）。
	HasAccount func(accountID string) bool
}

// ImportBundle 是 ImportOptions 的简写：merge/replace + 是否 dry-run。
func (s *RuleStore) ImportBundle(payload any, mode string, dryRun bool) (map[string]any, error) {
	return s.ImportBundleWithOptions(payload, ImportOptions{Mode: mode, DryRun: dryRun})
}

// ImportBundleWithOptions 导入规则包。merge 按 id 或「名称+站点」匹配已有规则并更新，
// replace 先清空再导入；dryRun 只做校验不落盘。
//
// 报告里除了 imported/updated/failed，还带两样东西：
//   - warnings：包级问题（kind/format 不匹配、声明条数与实际不符）；
//   - items[].warnings / items[].notes：单条规则的「换机后可能搜不出来」提示，
//     以及按选项实际清空了哪些引用。前端与 CLI 共用这份报告，不用各拼一套话。
func (s *RuleStore) ImportBundleWithOptions(payload any, opts ImportOptions) (map[string]any, error) {
	incoming, bundleWarnings, err := decodeImportBundle(payload)
	if err != nil {
		return nil, err
	}
	mode := strings.ToLower(strings.TrimSpace(opts.Mode))
	if mode == "" {
		mode = "merge"
	}
	if mode != "merge" && mode != "replace" {
		return nil, RuleError("导入模式只能是 merge 或 replace", nil)
	}

	// replace 是不可逆的：先整包备份到 <root>/backup-<时间>.json，再清空。
	// 备份失败就中止——宁可导不进去，也不能把用户现有的规则抹掉。
	backupFile := ""
	if mode == "replace" && !opts.DryRun {
		backupFile, err = s.backupBeforeReplace()
		if err != nil {
			return nil, err
		}
		for _, rule := range s.List(true) {
			_, _ = s.Delete(rule.ID)
		}
	}

	items := make([]map[string]any, 0, len(incoming))
	imported, updated, skipped, failed, warningCount := 0, 0, 0, 0, len(bundleWarnings)

	for index, rawItem := range incoming {
		object, ok := rawItem.(map[string]any)
		if !ok {
			failed++
			items = append(items, map[string]any{
				"name": "", "action": "failed", "error": "规则必须是 JSON 对象",
			})
			continue
		}
		encoded, encodeErr := json.Marshal(object)
		if encodeErr != nil {
			failed++
			items = append(items, map[string]any{"name": "", "action": "failed", "error": encodeErr.Error()})
			continue
		}
		var candidate Rule
		decodeErr := json.Unmarshal(encoded, &candidate)
		label := firstNonEmpty(candidate.Name, candidate.ID, "第 "+itoa(index+1)+" 条")
		if decodeErr != nil {
			failed++
			items = append(items, map[string]any{"name": label, "action": "failed", "error": decodeErr.Error()})
			continue
		}

		// 清洗必须早于校验：Validate 校验的是「真正要落库的那一份」。
		notes := applyImportCleanup(&candidate, opts)
		itemWarnings := importWarnings(&candidate, opts)

		item := map[string]any{"name": label}
		if len(itemWarnings) > 0 {
			item["warnings"] = itemWarnings
			warningCount += len(itemWarnings)
		}
		if len(notes) > 0 {
			item["notes"] = notes
		}

		if opts.DryRun {
			if _, validateErr := Validate(&candidate); validateErr != nil {
				failed++
				item["action"] = "failed"
				item["error"] = validateErr.Error()
				items = append(items, item)
				continue
			}
			if existing := s.findExistingForImport(&candidate); existing != nil {
				updated++
				item["action"] = "update"
				item["ruleId"] = existing.ID
			} else {
				imported++
				item["action"] = "create"
				item["ruleId"] = nil
			}
			items = append(items, item)
			continue
		}

		targetID := ""
		action := "create"
		if existing := s.findExistingForImport(&candidate); existing != nil {
			targetID = existing.ID
			action = "update"
		}
		saved, saveErr := s.Save(&candidate, targetID)
		if saveErr != nil {
			failed++
			item["action"] = "failed"
			item["error"] = saveErr.Error()
			items = append(items, item)
			continue
		}
		if action == "update" {
			updated++
		} else {
			imported++
		}
		item["action"] = action
		item["ruleId"] = saved.ID
		items = append(items, item)
	}

	report := map[string]any{
		"success":      failed == 0,
		"mode":         mode,
		"dryRun":       opts.DryRun,
		"total":        len(incoming),
		"imported":     imported,
		"updated":      updated,
		"skipped":      skipped,
		"failed":       failed,
		"warnings":     bundleWarnings,
		"warningCount": warningCount,
		"items":        items,
	}
	if backupFile != "" {
		report["backupFile"] = backupFile
	}
	return report, nil
}

// backupBeforeReplace 把当前全部规则写进 <root>/backup-<时间>.json 并返回路径。
// 空库不备份（没什么可丢的，留一堆空文件反而碍事）。
func (s *RuleStore) backupBeforeReplace() (string, error) {
	existing := s.List(true)
	if len(existing) == 0 {
		return "", nil
	}
	bundle := s.ExportBundle(nil)
	raw, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return "", RuleErrorf("replace 前备份失败，已中止（没有改动任何规则）：%v", err)
	}
	// 文件名不能带冒号（Windows），所以不用 NowISO 的格式。
	name := "backup-" + time.Now().Format("20060102-150405") + ".json"
	path := filepath.Join(filepath.Dir(filepath.Dir(s.dir)), name)
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return "", RuleErrorf("replace 前备份失败，已中止（没有改动任何规则）：%v", err)
	}
	return path, nil
}

// importBundleKind 是规则包的 kind 标识；导出与导入共用一份，改名就两边一起改。
const importBundleKind = "zviewer-crawler-rules"

// decodeImportBundle 接受三种形态：bundle（含 kind/format）、{"rules":[...]}、裸规则数组。
// 包级元信息不匹配只警告不拒绝：宁可导进来让用户看到，也比一句「格式不对」强。
func decodeImportBundle(payload any) ([]any, []string, error) {
	switch typed := payload.(type) {
	case map[string]any:
		list, ok := typed["rules"].([]any)
		if !ok {
			return nil, nil, RuleError("导入内容必须包含 rules 数组", nil)
		}
		warnings := make([]string, 0, 3)
		if kind, _ := typed["kind"].(string); kind != "" && kind != importBundleKind {
			warnings = append(warnings,
				"规则包类型是 "+strconv.Quote(kind)+"，不是 "+strconv.Quote(importBundleKind)+"；仍按 rules 数组导入")
		}
		if version := anyInt(typed["format"]); version > 0 && version != RuleFormat {
			warnings = append(warnings,
				"规则包格式版本 "+itoa(version)+" 与当前 "+itoa(RuleFormat)+" 不一致，未知字段会被丢弃")
		}
		if declared := anyInt(typed["count"]); declared > 0 && declared != len(list) {
			warnings = append(warnings,
				"规则包声明 "+itoa(declared)+" 条，实际 "+itoa(len(list))+" 条")
		}
		return list, warnings, nil
	case []any:
		return typed, nil, nil
	default:
		return nil, nil, RuleError("导入内容必须包含 rules 数组", nil)
	}
}

// applyImportCleanup 按选项抹掉跨机引用，返回「实际做了什么」给报告用。
func applyImportCleanup(rule *Rule, opts ImportOptions) []string {
	var notes []string
	if opts.ClearAccounts {
		if id := strings.TrimSpace(rule.Search.AccountID); id != "" {
			rule.Search.AccountID = ""
			notes = append(notes, "已清空 search.account_id（"+id+"）")
		}
		if rule.Play != nil {
			if id := strings.TrimSpace(rule.Play.AccountID); id != "" {
				rule.Play.AccountID = ""
				notes = append(notes, "已清空 play.account_id（"+id+"）")
			}
		}
	}
	if opts.ClearRooms && len(rule.AllowedRooms) > 0 {
		notes = append(notes, "已清空 allowed_rooms（清空后对所有房间开放）")
		rule.AllowedRooms = nil
	}
	return notes
}

// importWarnings 指出「这条规则导进来以后大概搜不出来」的原因。
// 只在真的能判断时才说：没有账号库（HasAccount=nil）就不猜。
func importWarnings(rule *Rule, opts ImportOptions) []string {
	var warnings []string
	if !opts.ClearAccounts && opts.HasAccount != nil {
		check := func(field, id string) {
			if strings.TrimSpace(id) == "" || opts.HasAccount(id) {
				return
			}
			warnings = append(warnings, "账号 "+id+" 在本机不存在（"+field+"），该规则会搜索失败；可勾选「清空账号绑定」")
		}
		check("search.account_id", rule.Search.AccountID)
		if rule.Play != nil {
			check("play.account_id", rule.Play.AccountID)
		}
	}
	if !opts.ClearRooms && len(rule.AllowedRooms) > 0 {
		warnings = append(warnings, "allowed_rooms 是源服务器的房间 ID，本机对不上时该规则只有管理员可见；可勾选「清空房间限制」")
	}
	if rule.Visibility == "root" {
		warnings = append(warnings, "visibility=root：导入后仅管理员可见")
	}
	return warnings
}

// anyInt 读 JSON 解码后的数字（float64/json.Number）或数字字符串。
func anyInt(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	default:
		return 0
	}
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
