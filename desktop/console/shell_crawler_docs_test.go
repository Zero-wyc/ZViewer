package console

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCrawlerDocsFallsBackToEmbedded(t *testing.T) {
	b := &crawlerBridge{root: t.TempDir()}
	doc, err := b.docs()
	if err != nil {
		t.Fatalf("docs() error: %v", err)
	}
	if !strings.Contains(doc["content"].(string), "爬虫") {
		t.Fatalf("embedded doc looks empty")
	}
	if !strings.Contains(doc["path"].(string), "内置") {
		t.Fatalf("expected embedded path marker, got %v", doc["path"])
	}
}

func TestCrawlerDocsReadsFileWhenPresent(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "docs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "engine.md"), []byte("# 规则文档测试"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := &crawlerBridge{root: root}
	doc, err := b.docs()
	if err != nil {
		t.Fatalf("docs() error: %v", err)
	}
	if doc["content"] != "# 规则文档测试" || doc["path"] != "crawler/docs/engine.md" {
		t.Fatalf("unexpected doc: %#v", doc)
	}
}
