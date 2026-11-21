package crawler

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAccountStoreSaveAndMask(t *testing.T) {
	store, err := NewAccountStore(filepath.Join(t.TempDir(), "accounts.json"))
	if err != nil {
		t.Fatalf("NewAccountStore: %v", err)
	}
	saved, err := store.Save(map[string]any{
		"name":     "站长账号",
		"site":     "Example.COM",
		"username": "admin",
		"password": "supersecretpassword",
		"cookies":  "sid=abcdefghijklmnop",
		"headers":  map[string]any{"Referer": "https://example.com/", "Cookie": "sid=secret-cookie"},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if saved["id"] != "站长账号" && saved["id"] == "" {
		t.Fatalf("id empty: %+v", saved)
	}
	if saved["site"] != "example.com" {
		t.Errorf("site = %v (must lowercase)", saved["site"])
	}

	masked := PublicAccountView(saved, true)
	cookies := masked["cookies"].(string)
	if cookies == "sid=abcdefghijklmnop" {
		t.Error("cookies not masked")
	}
	headers := masked["headers"].(map[string]any)
	if headers["Cookie"] == "sid=secret-cookie" {
		t.Error("sensitive header not masked")
	}
	if headers["Referer"] != "https://example.com/" {
		t.Errorf("non-sensitive header should stay: %v", headers["Referer"])
	}

	// Resolve 给抓取器的是明文。
	resolved, err := store.Resolve(saved["id"].(string))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if resolved["cookies"] != "sid=abcdefghijklmnop" {
		t.Errorf("resolved cookies = %v", resolved["cookies"])
	}
	if resolved["headers"].(map[string]string)["Cookie"] != "sid=secret-cookie" {
		t.Errorf("resolved headers = %v", resolved["headers"])
	}

	// 空 id 也要能取到空账号（规则没绑账号）。
	empty, err := store.Resolve("")
	if err != nil || len(empty) != 0 {
		t.Errorf("empty resolve = %v %v", empty, err)
	}
	if _, err := store.Resolve("missing"); err == nil {
		t.Error("missing account must error")
	}
}

func TestAccountStoreUpdatePreservesCreatedAt(t *testing.T) {
	store, err := NewAccountStore(filepath.Join(t.TempDir(), "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Save(map[string]any{"id": "demo", "name": "演示", "cookies": "a=1"})
	if err != nil {
		t.Fatal(err)
	}
	createdAt := first["created_at"]
	// 只改 notes：其余字段（cookies/password）必须沿用旧值。
	second, err := store.Save(map[string]any{"id": "demo", "notes": "改了说明"})
	if err != nil {
		t.Fatal(err)
	}
	if second["created_at"] != createdAt {
		t.Errorf("created_at changed: %v -> %v", createdAt, second["created_at"])
	}
	if second["cookies"] != "a=1" {
		t.Errorf("cookies lost on update: %v", second["cookies"])
	}
	if second["notes"] != "改了说明" {
		t.Errorf("notes = %v", second["notes"])
	}
	if len(store.List(true)) != 1 {
		t.Errorf("list = %d", len(store.List(true)))
	}
	if !store.Delete("demo") {
		t.Error("delete failed")
	}
	if store.Delete("demo") {
		t.Error("second delete should be false")
	}
}

func TestAccountSlugAndMask(t *testing.T) {
	cases := map[string]string{
		"Example Site!": "example-site",
		"  ":            "account",
		"中文站点":          "account",
	}
	for input, want := range cases {
		if got := accountSlug(input); got != want {
			t.Errorf("accountSlug(%q) = %q, want %q", input, got, want)
		}
	}
	if MaskSecret("") != "" {
		t.Error("empty mask must be empty")
	}
	if MaskSecret("short") != "已设置" {
		t.Errorf("short mask = %q", MaskSecret("short"))
	}
	if MaskSecret("abcdefghijklmnop") != "abcd...mnop" {
		t.Errorf("long mask = %q", MaskSecret("abcdefghijklmnop"))
	}
}

// accounts.json 用 {"accounts": [...]} 包装，且兼容裸数组。
func TestAccountStoreReadsBothShapes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "accounts.json")
	if err := os.WriteFile(path, []byte(`[{"id":"raw","name":"裸数组"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewAccountStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if accounts := store.List(true); len(accounts) != 1 || accounts[0]["id"] != "raw" {
		t.Fatalf("raw array not read: %+v", accounts)
	}
	// 写回统一成包装格式。
	if _, err := store.Save(map[string]any{"id": "wrapped"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !containsJSONKey(raw) {
		t.Errorf("file not wrapped: %s", string(raw))
	}
}

func containsJSONKey(raw []byte) bool {
	return strings.Contains(string(raw), "\"accounts\"")
}
