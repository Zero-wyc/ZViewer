package crawler

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newTestRule(name, site string) *Rule {
	return &Rule{
		Name:    name,
		Site:    site,
		Enabled: true,
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{Method: "GET", URL: "https://" + site + "/s?q={keyword}"},
		},
		Parse: Parse{
			Type:      "html",
			Container: ".item",
			Fields: map[string]Field{
				"title": {Selector: ".t"},
				"url":   {Selector: "a", Attr: "href"},
			},
		},
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"示例站 Example": "example",
		"  A B  ":     "a-b",
		"a/b\\c":      "a-b-c",
		"":            "",
	}
	for input, want := range cases {
		if got := Slugify(input); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestStoreSaveAndVersion(t *testing.T) {
	store, err := NewRuleStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	saved, err := store.Save(newTestRule("例子站", "example.com"), "")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if saved.ID != "site" {
		// name 是纯中文，slugify 后为空 → 回退成 "site"（Python 同款）。
		t.Errorf("id = %q", saved.ID)
	}
	if saved.Version != 1 {
		t.Errorf("version = %d", saved.Version)
	}
	createdAt := saved.CreatedAt

	saved.Search.Request.URL = "https://example.com/search?q={keyword}"
	updated, err := store.Save(saved, saved.ID)
	if err != nil {
		t.Fatalf("resave: %v", err)
	}
	if updated.Version != 2 {
		t.Errorf("version after update = %d", updated.Version)
	}
	if updated.CreatedAt != createdAt {
		t.Errorf("created_at changed: %q -> %q", createdAt, updated.CreatedAt)
	}

	// 同名第二个规则要有独立 id。
	second, err := store.Save(newTestRule("例子站", "other.com"), "")
	if err != nil {
		t.Fatalf("save second: %v", err)
	}
	if second.ID != "site-2" {
		t.Errorf("second id = %q", second.ID)
	}
	if list := store.List(true); len(list) != 2 {
		t.Errorf("list len = %d", len(list))
	}
}

func TestStoreUpdateMergesSections(t *testing.T) {
	store, err := NewRuleStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	saved, err := store.Save(newTestRule("demo", "example.com"), "")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	patch := map[string]json.RawMessage{
		"parse": json.RawMessage(`{"limit":5}`),
		"name":  json.RawMessage(`"改名了"`),
		"id":    json.RawMessage(`"hacked"`),
	}
	updated, err := store.Update(saved.ID, patch)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.ID != saved.ID {
		t.Errorf("id should not be patchable, got %q", updated.ID)
	}
	if updated.Name != "改名了" {
		t.Errorf("name = %q", updated.Name)
	}
	if updated.Parse.Limit != 5 {
		t.Errorf("limit = %d", updated.Parse.Limit)
	}
	// 浅合并：patch 没提的 container 要保留。
	if updated.Parse.Container != ".item" {
		t.Errorf("container lost: %q", updated.Parse.Container)
	}
}

func TestStoreListAndVisibility(t *testing.T) {
	store, err := NewRuleStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	alpha, _ := store.Save(newTestRule("alpha", "a.com"), "")
	beta, _ := store.Save(newTestRule("beta", "b.com"), "")
	beta.Enabled = false
	if _, err := store.Save(beta, beta.ID); err != nil {
		t.Fatalf("disable beta: %v", err)
	}

	all := store.List(true)
	if len(all) != 2 {
		t.Fatalf("list(true) = %d", len(all))
	}
	enabled := store.List(false)
	if len(enabled) != 1 || enabled[0].ID != alpha.ID {
		t.Fatalf("list(false) = %+v", enabled)
	}

	alpha.Visibility = "root"
	alpha.AllowedRooms = []string{"room1"}
	alpha, _ = store.Save(alpha, alpha.ID)
	if !RuleVisibleTo(alpha, "room1", "root") {
		t.Error("root should see root-only rule")
	}
	if RuleVisibleTo(alpha, "room1", "guest") {
		t.Error("guest must not see root-only rule")
	}
	alpha.Visibility = "public"
	if !RuleVisibleTo(alpha, "room1", "guest") {
		t.Error("guest should see public rule in allowed room")
	}
	if RuleVisibleTo(alpha, "room2", "guest") {
		t.Error("guest outside allowed room must not see rule")
	}
}

func TestStoreFindBySite(t *testing.T) {
	store, _ := NewRuleStore(t.TempDir())
	general, _ := store.Save(newTestRule("通用", "example.com"), "")
	specific := newTestRule("子站", "sub.example.com")
	specific.Aliases = []string{"cdn.sub.example.com"}
	if _, err := store.Save(specific, ""); err != nil {
		t.Fatalf("save specific: %v", err)
	}

	if found := store.FindBySite("sub.example.com"); found == nil || found.Name != "子站" {
		t.Errorf("exact match should win, got %+v", found)
	}
	if found := store.FindBySite("www.example.com"); found == nil || found.ID != general.ID {
		t.Errorf("parent domain should fall back to general rule, got %+v", found)
	}
	if found := store.FindBySite("nope.com"); found != nil {
		t.Errorf("unexpected match: %+v", found)
	}
}

func TestStoreRecordSearch(t *testing.T) {
	store, _ := NewRuleStore(t.TempDir())
	saved, _ := store.Save(newTestRule("demo", "example.com"), "")
	store.RecordSearch(saved.ID, true, "")
	store.RecordSearch(saved.ID, false, "HTTP 403")

	reloaded, err := store.Get(saved.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if reloaded.Stats.Searches != 2 || reloaded.Stats.Successes != 1 || reloaded.Stats.Failures != 1 {
		t.Errorf("stats = %+v", reloaded.Stats)
	}
	if reloaded.Stats.LastError == nil || *reloaded.Stats.LastError != "HTTP 403" {
		t.Errorf("last_error = %v", reloaded.Stats.LastError)
	}
	if reloaded.Stats.LastUsedAt == nil {
		t.Error("last_used_at should be set")
	}
}

func TestStoreExportImport(t *testing.T) {
	dir := t.TempDir()
	source, _ := NewRuleStore(filepath.Join(dir, "source"))
	if _, err := source.Save(newTestRule("alpha", "a.com"), ""); err != nil {
		t.Fatalf("save alpha: %v", err)
	}
	if _, err := source.Save(newTestRule("beta", "b.com"), ""); err != nil {
		t.Fatalf("save beta: %v", err)
	}
	bundle := source.ExportBundle(nil)
	if bundle["count"].(int) != 2 {
		t.Fatalf("export count = %v", bundle["count"])
	}

	target, _ := NewRuleStore(filepath.Join(dir, "target"))
	decoded, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	var payload any
	if err := json.Unmarshal(decoded, &payload); err != nil {
		t.Fatalf("unmarshal bundle: %v", err)
	}

	report, err := target.ImportBundle(payload, "merge", true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if report["imported"].(int) != 2 || report["dryRun"].(bool) != true {
		t.Errorf("dry run report = %+v", report)
	}
	if len(target.List(true)) != 0 {
		t.Error("dry run must not write files")
	}

	report, err = target.ImportBundle(payload, "merge", false)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if report["imported"].(int) != 2 || report["success"].(bool) != true {
		t.Errorf("import report = %+v", report)
	}
	if len(target.List(true)) != 2 {
		t.Errorf("imported = %d", len(target.List(true)))
	}

	// 再导一次应当是更新而不是新增。
	report, err = target.ImportBundle(payload, "merge", false)
	if err != nil {
		t.Fatalf("reimport: %v", err)
	}
	if report["updated"].(int) != 2 || report["imported"].(int) != 0 {
		t.Errorf("reimport report = %+v", report)
	}
}

// decodeBundle 把导出结果过一遍 JSON，模拟「从文件读回来的规则包」。
//
// 直接把 ExportBundle 的 map 喂给导入器是不对的：那里的 rules 是 []*Rule，
// 而导入器只认 JSON 解码后的 []any——跳过这一步会得到「必须包含 rules 数组」。
func decodeBundle(t *testing.T, bundle map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("unmarshal bundle: %v", err)
	}
	return payload
}

// 跨机引用必须逐个说清楚：账号、房间白名单、root 可见性在目标机都会"变味"，
// 报告不说，用户只会看到「导入成功」然后搜不出东西。
func TestImportBundlePortabilityWarnings(t *testing.T) {
	dir := t.TempDir()
	source, _ := NewRuleStore(filepath.Join(dir, "source"))
	rule := newTestRule("带账号", "a.com")
	rule.Search.AccountID = "acc-1"
	rule.AllowedRooms = []string{"room-1"}
	rule.Visibility = "root"
	if _, err := source.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}

	target, _ := NewRuleStore(filepath.Join(dir, "target"))
	report, err := target.ImportBundleWithOptions(decodeBundle(t, source.ExportBundle(nil)), ImportOptions{
		DryRun:     true,
		HasAccount: func(string) bool { return false },
	})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	items := report["items"].([]map[string]any)
	warnings, _ := items[0]["warnings"].([]string)
	if len(warnings) != 3 {
		t.Fatalf("warnings = %v, want 账号/房间/可见性 三条", warnings)
	}
	if report["warningCount"].(int) != 3 {
		t.Errorf("warningCount = %v", report["warningCount"])
	}
}

// 勾选清空后：规则不再引用源机的账号与房间，报告用 notes 记下实际改了什么。
func TestImportBundleClearsCrossMachineRefs(t *testing.T) {
	dir := t.TempDir()
	source, _ := NewRuleStore(filepath.Join(dir, "source"))
	rule := newTestRule("带账号", "a.com")
	rule.Search.AccountID = "acc-1"
	rule.AllowedRooms = []string{"room-1"}
	if _, err := source.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}

	target, _ := NewRuleStore(filepath.Join(dir, "target"))
	report, err := target.ImportBundleWithOptions(decodeBundle(t, source.ExportBundle(nil)), ImportOptions{
		ClearAccounts: true,
		ClearRooms:    true,
		HasAccount:    func(string) bool { return false },
	})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if report["imported"].(int) != 1 {
		t.Fatalf("report = %+v", report)
	}
	saved := target.List(true)
	if len(saved) != 1 {
		t.Fatalf("saved = %d", len(saved))
	}
	if saved[0].Search.AccountID != "" {
		t.Errorf("account_id 未清空: %q", saved[0].Search.AccountID)
	}
	if len(saved[0].AllowedRooms) != 0 {
		t.Errorf("allowed_rooms 未清空: %v", saved[0].AllowedRooms)
	}
	items := report["items"].([]map[string]any)
	notes, _ := items[0]["notes"].([]string)
	if len(notes) != 2 {
		t.Fatalf("notes = %v, want 账号与房间各一条", notes)
	}
	if _, ok := items[0]["warnings"]; ok {
		t.Errorf("清空后不该再有缺账号/房间的警告: %v", items[0]["warnings"])
	}
}

// 包级元信息不匹配只警告不拒绝：宁可导进来让人看见，也别一句「格式不对」挡死。
func TestImportBundleWarnsOnBundleMetadata(t *testing.T) {
	dir := t.TempDir()
	source, _ := NewRuleStore(filepath.Join(dir, "source"))
	if _, err := source.Save(newTestRule("alpha", "a.com"), ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	payload := decodeBundle(t, source.ExportBundle(nil))
	payload["kind"] = "other-tool-export"
	payload["format"] = float64(9)
	payload["count"] = float64(9)

	target, _ := NewRuleStore(filepath.Join(dir, "target"))
	report, err := target.ImportBundle(payload, "merge", true)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	warnings := report["warnings"].([]string)
	if len(warnings) != 3 {
		t.Fatalf("warnings = %v, want kind/format/count 三条", warnings)
	}
	if report["failed"].(int) != 0 {
		t.Errorf("元信息不匹配不应导致失败: %+v", report)
	}
}

// replace 是「先清空再导入」：源包少了某条规则时，目标机也要跟着消失。
func TestImportBundleReplaceDropsMissingRules(t *testing.T) {
	dir := t.TempDir()
	source, _ := NewRuleStore(filepath.Join(dir, "source"))
	if _, err := source.Save(newTestRule("alpha", "a.com"), ""); err != nil {
		t.Fatalf("save alpha: %v", err)
	}
	target, _ := NewRuleStore(filepath.Join(dir, "target"))
	if _, err := target.Save(newTestRule("stale", "old.com"), ""); err != nil {
		t.Fatalf("save stale: %v", err)
	}
	report, err := target.ImportBundle(decodeBundle(t, source.ExportBundle(nil)), "replace", false)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if report["imported"].(int) != 1 {
		t.Fatalf("report = %+v", report)
	}
	rules := target.List(true)
	if len(rules) != 1 || rules[0].Name != "alpha" {
		t.Fatalf("replace 后应只剩 alpha，得到 %d 条", len(rules))
	}
}

func TestStoreCorruptFileSkipped(t *testing.T) {
	dir := t.TempDir()
	store, _ := NewRuleStore(dir)
	if _, err := store.Save(newTestRule("alpha", "a.com"), ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatalf("write broken: %v", err)
	}
	if list := store.List(true); len(list) != 1 {
		t.Errorf("corrupt file should be skipped, list = %d", len(list))
	}
}
