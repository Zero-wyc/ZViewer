package subtitle

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/serverfiles"
	"zviewer/backend/internal/store"
)

const testServerFolderDDL = `
CREATE TABLE "server_folder" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" varchar NOT NULL, "absPath" varchar NOT NULL, "readonly" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
`

// newTestService 构造一个只接了 server-files 源的字幕服务。
//
// Stream 留空：server-files 分支不解析挂载凭证，走不到它。
func newTestService(t *testing.T, uploadsDir string) *Service {
	t.Helper()
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetMaxOpenConns(1)
	if _, err := conn.Exec(testServerFolderDDL); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	registry := serverfiles.NewRegistry(store.NewServerFolders(conn), uploadsDir)
	return NewService(nil, registry)
}

// writeFile 建目录并写文件（相对 uploads 根）。
func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

func ptr[T any](v T) *T { return &v }

func TestPathHelpers(t *testing.T) {
	cases := []struct {
		name     string
		path     string
		base     string
		dir      string
		stripExt string
	}{
		{"普通路径", "/anime/EP01/a.mkv", "a.mkv", "/anime/EP01", "a"},
		{"反斜杠也当分隔符", `\anime\EP01\a.mkv`, "a.mkv", "/anime/EP01", "a"},
		{"根目录文件", "/a.mkv", "a.mkv", "", "a"},
		{"没有斜杠", "a.mkv", "a.mkv", "/", "a"},
		{"无扩展名", "/d/EP01", "EP01", "/d", "EP01"},
		// 隐藏文件 `.srt` 的点在首位，stripExt 不剥（与 Node 的 dot > 0 一致）
		{"隐藏文件不剥扩展名", "/d/.srt", ".srt", "/d", ".srt"},
		{"多点文件名只剥最后一个", "/d/a.b.mkv", "a.b.mkv", "/d", "a.b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := BaseName(c.path); got != c.base {
				t.Fatalf("BaseName(%q)=%q，期望 %q", c.path, got, c.base)
			}
			if got := Dirname(c.path); got != c.dir {
				t.Fatalf("Dirname(%q)=%q，期望 %q", c.path, got, c.dir)
			}
			if got := StripExt(c.base); got != c.stripExt {
				t.Fatalf("StripExt(%q)=%q，期望 %q", c.base, got, c.stripExt)
			}
		})
	}
}

func TestExt(t *testing.T) {
	for in, want := range map[string]string{
		"a.SRT": ".srt",
		"a.ass": ".ass",
		"a":     "",
		"a.tar": ".tar",
	} {
		if got := Ext(in); got != want {
			t.Fatalf("Ext(%q)=%q，期望 %q", in, got, want)
		}
	}
}

func TestIsFileSource(t *testing.T) {
	for _, s := range []string{"webdav", "openlist", "ftp", "server-files"} {
		if !IsFileSource(s) {
			t.Fatalf("%q 应被视为文件源", s)
		}
	}
	for _, s := range []string{"", "bilibili", "emby", "jellyfin", "anime"} {
		if IsFileSource(s) {
			t.Fatalf("%q 不应被视为文件源", s)
		}
	}
}

func TestMapEmbySubtitleFormat(t *testing.T) {
	cases := map[string][2]string{
		"ass":    {"ass", "ass"},
		"ssa":    {"ass", "ass"},
		"webvtt": {"vtt", "vtt"},
		"srt":    {"srt", "srt"},
		// subrip 是 srt 的别名；未知 codec 也要退化成 srt，
		// 否则前端拿不到能解析的格式。
		"subrip":  {"srt", "srt"},
		"unknown": {"srt", "srt"},
		"":        {"srt", "srt"},
	}
	for codec, want := range cases {
		ext, format := MapEmbySubtitleFormat(codec)
		if ext != want[0] || format != want[1] {
			t.Fatalf("MapEmbySubtitleFormat(%q)=(%q,%q)，期望 (%q,%q)",
				codec, ext, format, want[0], want[1])
		}
	}
}

// TestSearchServerFiles 覆盖同名匹配、扩展名白名单与目录不存在。
func TestSearchServerFiles(t *testing.T) {
	uploads := t.TempDir()
	writeFile(t, uploads, "anime/EP01.mkv", "video")
	writeFile(t, uploads, "anime/EP01.chs.srt", "chs")
	writeFile(t, uploads, "anime/EP01.ass", "ass")
	writeFile(t, uploads, "anime/EP02.srt", "other-episode") // 不同集，不该命中
	writeFile(t, uploads, "anime/EP01.txt", "not-subtitle")  // 非字幕扩展名
	writeFile(t, uploads, "anime/EP01.mp4", "another-video") // 同前缀但不是字幕

	svc := newTestService(t, uploads)
	movie := &store.Movie{
		ID:     1,
		RoomID: "R1",
		Source: ptr("server-files"),
		Path:   ptr("uploads:/anime/EP01.mkv"),
	}

	results, err := svc.SearchSubtitlesInMovieDir(context.Background(), movie)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("应命中 2 条字幕，得到 %d: %+v", len(results), results)
	}
	byName := map[string]SearchResult{}
	for _, r := range results {
		byName[r.Filename] = r
	}
	if r, ok := byName["EP01.chs.srt"]; !ok || r.Content != "chs" || r.Format != "srt" {
		t.Fatalf("EP01.chs.srt 结果不正确: %+v", r)
	}
	if r, ok := byName["EP01.ass"]; !ok || r.Format != "ass" {
		t.Fatalf("EP01.ass 结果不正确: %+v", r)
	}
}

func TestSearchServerFilesMissingDir(t *testing.T) {
	uploads := t.TempDir()
	svc := newTestService(t, uploads)
	movie := &store.Movie{
		ID: 1, RoomID: "R1",
		Source: ptr("server-files"),
		Path:   ptr("uploads:/nope/a.mkv"),
	}
	results, err := svc.SearchSubtitlesInMovieDir(context.Background(), movie)
	if err != nil {
		t.Fatalf("目录不存在不该报错: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("目录不存在应返回空列表，得到 %+v", results)
	}
}

// TestSearchSkipsNonFileSource 非文件源（bilibili）直接空列表。
func TestSearchSkipsNonFileSource(t *testing.T) {
	svc := newTestService(t, t.TempDir())
	movie := &store.Movie{ID: 1, RoomID: "R1", Source: ptr("bilibili"), Path: ptr("uploads:/a.mkv")}
	results, err := svc.SearchSubtitlesInMovieDir(context.Background(), movie)
	if err != nil || len(results) != 0 {
		t.Fatalf("非文件源应返回空列表，得到 %+v / %v", results, err)
	}
	// Source 为 nil 时同样按非文件源处理（Node 里 (movie.source || '') 是空串）。
	movie.Source = nil
	if results, err := svc.SearchSubtitlesInMovieDir(context.Background(), movie); err != nil || len(results) != 0 {
		t.Fatalf("Source 为空应返回空列表，得到 %+v / %v", results, err)
	}
}

// TestBrowseServerFiles 覆盖隐藏文件过滤、目录无 size 键、拼音排序。
func TestBrowseServerFiles(t *testing.T) {
	uploads := t.TempDir()
	writeFile(t, uploads, "anime/阿凡达.srt", "a")
	writeFile(t, uploads, "anime/波西米亚.srt", "b")
	writeFile(t, uploads, "anime/sub/inside.mkv", "v")
	writeFile(t, uploads, "anime/.hidden", "h")
	writeFile(t, uploads, "anime/a.mkv", "12345")

	svc := newTestService(t, uploads)
	movie := &store.Movie{
		ID: 1, RoomID: "R1",
		Source: ptr("server-files"),
		Path:   ptr("uploads:/anime/a.mkv"),
	}

	result, err := svc.BrowseMovieDirectory(context.Background(), movie, "uploads:/anime")
	if err != nil {
		t.Fatalf("浏览失败: %v", err)
	}
	if result.CurrentPath != "uploads:/anime" {
		t.Fatalf("currentPath=%q", result.CurrentPath)
	}
	if result.ParentPath != "uploads:" {
		t.Fatalf("parentPath=%v，期望 uploads:", result.ParentPath)
	}

	// 目录在前：sub 必须排第一；隐藏文件必须被剔除。
	if len(result.Entries) != 4 {
		t.Fatalf("应有 4 项（sub + 3 个文件），得到 %d: %+v", len(result.Entries), result.Entries)
	}
	if result.Entries[0].Name != "sub" || result.Entries[0].Type != "directory" {
		t.Fatalf("首项应是目录 sub，得到 %+v", result.Entries[0])
	}
	if result.Entries[0].Size != nil {
		t.Fatalf("目录不应带 size 键（Node 里是 undefined），得到 %v", *result.Entries[0].Size)
	}

	// 简体中文排序（CLDR zh 语义）：汉字整体排在拉丁字母之前，
	// 汉字之间按拼音（「阿」在「波」之前，码点序相反）。
	names := []string{result.Entries[1].Name, result.Entries[2].Name, result.Entries[3].Name}
	wantOrder := []string{"阿凡达.srt", "波西米亚.srt", "a.mkv"}
	if strings.Join(names, ",") != strings.Join(wantOrder, ",") {
		t.Fatalf("文件排序为 %v，期望 %v", names, wantOrder)
	}

	// isSubtitle 只对字幕扩展名为 true。
	for _, e := range result.Entries {
		if e.Name == "a.mkv" {
			if e.IsSubtitle {
				t.Fatal("a.mkv 不该被标成字幕")
			}
			if e.Size == nil || *e.Size != 5 {
				t.Fatalf("a.mkv 的 size 应为 5，得到 %v", e.Size)
			}
		}
		if e.Name == "阿凡达.srt" && !e.IsSubtitle {
			t.Fatal("阿凡达.srt 应被标成字幕")
		}
	}
}

func TestBrowseServerFilesMissingDir(t *testing.T) {
	svc := newTestService(t, t.TempDir())
	movie := &store.Movie{ID: 1, RoomID: "R1", Source: ptr("server-files")}
	result, err := svc.BrowseMovieDirectory(context.Background(), movie, "uploads:/nope")
	if err != nil {
		t.Fatalf("目录不存在不该报错: %v", err)
	}
	if result.ParentPath != nil {
		t.Fatalf("目录不存在时 parentPath 应为 null，得到 %v", result.ParentPath)
	}
	if result.Entries == nil || len(result.Entries) != 0 {
		t.Fatalf("目录不存在应返回空列表，得到 %+v", result.Entries)
	}
}

// TestLoadServerFiles 覆盖正常读取、文件不存在（404）与目录（404）。
func TestLoadServerFiles(t *testing.T) {
	uploads := t.TempDir()
	writeFile(t, uploads, "anime/a.chs.srt", "1\n00:00:01,000 --> 00:00:02,000\n你好\n")

	svc := newTestService(t, uploads)
	movie := &store.Movie{ID: 1, RoomID: "R1", Source: ptr("server-files")}
	ctx := context.Background()

	got, err := svc.LoadSubtitleFile(ctx, movie, "uploads:/anime/a.chs.srt")
	if err != nil {
		t.Fatalf("加载字幕失败: %v", err)
	}
	if got.Filename != "a.chs.srt" || got.Format != "srt" {
		t.Fatalf("返回元信息不正确: %+v", got)
	}
	if !strings.Contains(got.Content, "你好") {
		t.Fatalf("内容不正确: %q", got.Content)
	}

	_, err = svc.LoadSubtitleFile(ctx, movie, "uploads:/anime/nope.srt")
	var se *ServiceError
	if !errorsAs(err, &se) || se.Status != 404 || se.Message != "字幕文件不存在" {
		t.Fatalf("文件不存在应返回 404「字幕文件不存在」，得到 %v", err)
	}

	_, err = svc.LoadSubtitleFile(ctx, movie, "uploads:/anime")
	if !errorsAs(err, &se) || se.Status != 400 {
		t.Fatalf("非字幕应返回 400，得到 %v", err)
	}
}

// errorsAs 是 errors.As 的薄封装（避免测试文件重复 import errors 名字冲突）。
func errorsAs(err error, target **ServiceError) bool {
	if err == nil {
		return false
	}
	se, ok := err.(*ServiceError)
	if !ok {
		return false
	}
	*target = se
	return true
}

// TestServerURLEmptyGuards 覆盖缺 serverUrl 时各源的 400 文案。
func TestServerURLEmptyGuards(t *testing.T) {
	svc := newTestService(t, t.TempDir())
	ctx := context.Background()

	cases := map[string]string{
		"ftp":      "FTP 服务器地址缺失",
		"openlist": "OpenList 服务器地址缺失",
		"webdav":   "WebDAV 服务器地址缺失",
	}
	for source, want := range cases {
		movie := &store.Movie{ID: 1, RoomID: "R1", Source: ptr(source)}
		_, err := svc.BrowseMovieDirectory(ctx, movie, "/d")
		var se *ServiceError
		if !errorsAs(err, &se) {
			t.Fatalf("%s: 应返回 ServiceError，得到 %v", source, err)
		}
		if se.Status != 400 || se.Message != want {
			t.Fatalf("%s: 期望 400 %q，得到 %d %q", source, want, se.Status, se.Message)
		}
	}
}

func TestNullIfEmpty(t *testing.T) {
	if v := nullIfEmpty(""); v != nil {
		t.Fatalf("空串应转成 nil，得到 %#v", v)
	}
	if v := nullIfEmpty("zh"); v != "zh" {
		t.Fatalf("非空串应原样返回，得到 %#v", v)
	}
}
