package serverfiles

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testRoots(t *testing.T) []RootInfo {
	t.Helper()
	uploads := t.TempDir()
	readonly := t.TempDir()
	return []RootInfo{
		{Key: UploadsRootKey, Name: "默认空间", AbsPath: uploads},
		{Key: "custom:3", Name: "只读盘", AbsPath: readonly, Readonly: true},
	}
}

func TestParsePrefixedPath(t *testing.T) {
	cases := []struct {
		input   string
		rootKey string
		relPath string
	}{
		{"uploads:/movies/a.mp4", "uploads", "/movies/a.mp4"},
		{"custom:3:/videos/b.mp4", "custom:3", "/videos/b.mp4"},
		{"/movies/a.mp4", "uploads", "/movies/a.mp4"},
		{"", "uploads", ""},
		{"uploads:", "uploads", "/"},
		// 非前缀写法不能被当成自定义根（避免 `custom:` 后接非数字也能进）
		{"custom:x:/a", "uploads", "custom:x:/a"},
	}
	for _, c := range cases {
		key, rel := ParsePrefixedPath(c.input)
		if key != c.rootKey || rel != c.relPath {
			t.Fatalf("ParsePrefixedPath(%q) = (%q, %q)，期望 (%q, %q)",
				c.input, key, rel, c.rootKey, c.relPath)
		}
	}
}

func TestResolveSafePathKeepsInsideRoot(t *testing.T) {
	roots := testRoots(t)
	uploads := roots[0].AbsPath

	abs, root, err := ResolveSafePath("uploads:/a/b.mp4", roots)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if root.Key != UploadsRootKey {
		t.Fatalf("根 key = %q，期望 uploads", root.Key)
	}
	if want := filepath.Join(uploads, "a", "b.mp4"); abs != want {
		t.Fatalf("abs = %q，期望 %q", abs, want)
	}

	// 越权：`..` 必须被拦住。这是整个模块的安全底线——
	// 放过去等于 root 用户能删服务器任意文件。
	for _, bad := range []string{
		"uploads:../../etc/passwd",
		"uploads:/a/../../outside.txt",
		"custom:3:../sibling",
	} {
		if _, _, err := ResolveSafePath(bad, roots); err == nil {
			t.Fatalf("%q 应当被判定为路径越权", bad)
		}
	}

	// 反斜杠也要按分隔符处理（Windows 客户端可能这么传）
	abs, _, err = ResolveSafePath(`uploads:\a\b.mp4`, roots)
	if err != nil {
		t.Fatalf("反斜杠路径解析失败: %v", err)
	}
	if want := filepath.Join(uploads, "a", "b.mp4"); abs != want {
		t.Fatalf("反斜杠 abs = %q，期望 %q", abs, want)
	}

	if _, _, err := ResolveSafePath("custom:9:/a", roots); err != ErrUnknownRoot {
		t.Fatalf("未注册根应当报 ErrUnknownRoot，得到 %v", err)
	}
}

func TestToPrefixedPath(t *testing.T) {
	roots := testRoots(t)
	root := roots[0]
	if got := ToPrefixedPath(root, root.AbsPath); got != "uploads:/" {
		t.Fatalf("根路径 = %q，期望 uploads:/", got)
	}
	got := ToPrefixedPath(root, filepath.Join(root.AbsPath, "a", "b.mp4"))
	if got != "uploads:/a/b.mp4" {
		t.Fatalf("子路径 = %q，期望 uploads:/a/b.mp4", got)
	}
}

// buildUpload 构造一个 multipart 请求体（字段顺序与前端一致：targetDir 在前）。
func buildUpload(t *testing.T, targetDir string, files map[string]string) io.Reader {
	t.Helper()
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	if targetDir != "" {
		if err := w.WriteField("targetDir", targetDir); err != nil {
			t.Fatalf("写字段失败: %v", err)
		}
	}
	for name, content := range files {
		part, err := w.CreateFormFile("files", name)
		if err != nil {
			t.Fatalf("建 part 失败: %v", err)
		}
		if _, err := part.Write([]byte(content)); err != nil {
			t.Fatalf("写 part 失败: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("关闭 writer 失败: %v", err)
	}
	// 把 boundary 塞回去：调用方需要 Reader，这里用 Content-Type 无法传递，
	// 因此返回一个带 boundary 的 reader 由调用方构造。
	return &boundaryReader{Reader: buf, boundary: w.Boundary()}
}

// boundaryReader 把 boundary 一起带出去（测试辅助，不用改函数签名）。
type boundaryReader struct {
	io.Reader
	boundary string
}

func newMultipartReader(t *testing.T, r io.Reader) *multipart.Reader {
	t.Helper()
	br, ok := r.(*boundaryReader)
	if !ok {
		t.Fatal("需要 boundaryReader")
	}
	return multipart.NewReader(br.Reader, br.boundary)
}

// newTestRegistry 造一个不连库的注册表：直接预热缓存，避免测试依赖 server_folder 表。
func newTestRegistry(roots []RootInfo) *Registry {
	reg := NewRegistry(nil, roots[0].AbsPath)
	reg.cache = roots
	reg.at = time.Now()
	reg.valid = true
	return reg
}

func TestReceiveUploadsWritesFileAndPrefixesPath(t *testing.T) {
	roots := testRoots(t)
	reg := newTestRegistry(roots)

	body := buildUpload(t, "uploads:/movies", map[string]string{"a.mp4": "hello"})
	files, err := reg.ReceiveUploads(context.Background(), newMultipartReader(t, body))
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("文件数 = %d，期望 1", len(files))
	}
	if files[0].Path != "uploads:/movies/a.mp4" {
		t.Fatalf("path = %q，期望 uploads:/movies/a.mp4", files[0].Path)
	}
	if files[0].Size != 5 {
		t.Fatalf("size = %d，期望 5", files[0].Size)
	}
	content, err := os.ReadFile(filepath.Join(roots[0].AbsPath, "movies", "a.mp4"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("落盘内容 = %q, %v", content, err)
	}
}

func TestReceiveUploadsCreatesDirAndRenamesDuplicate(t *testing.T) {
	roots := testRoots(t)
	reg := newTestRegistry(roots)

	// 目标目录不存在：必须递归创建（前端不承诺先建目录）
	body := buildUpload(t, "uploads:/new/deep", map[string]string{"a.mp4": "one"})
	if _, err := reg.ReceiveUploads(context.Background(), newMultipartReader(t, body)); err != nil {
		t.Fatalf("首次上传失败: %v", err)
	}
	// 同名再传一次：追加序号，绝不覆盖
	body = buildUpload(t, "uploads:/new/deep", map[string]string{"a.mp4": "two"})
	files, err := reg.ReceiveUploads(context.Background(), newMultipartReader(t, body))
	if err != nil {
		t.Fatalf("二次上传失败: %v", err)
	}
	if files[0].Name != "a (1).mp4" {
		t.Fatalf("重名文件 = %q，期望 a (1).mp4", files[0].Name)
	}
	first, _ := os.ReadFile(filepath.Join(roots[0].AbsPath, "new", "deep", "a.mp4"))
	if string(first) != "one" {
		t.Fatalf("原文件被覆盖了: %q", first)
	}
}

func TestReceiveUploadsRejectsReadonlyRoot(t *testing.T) {
	roots := testRoots(t)
	reg := newTestRegistry(roots)

	body := buildUpload(t, "custom:3:/x", map[string]string{"a.mp4": "hello"})
	_, err := reg.ReceiveUploads(context.Background(), newMultipartReader(t, body))
	if err != ErrRootReadonly {
		t.Fatalf("只读根应当拒绝，得到 %v", err)
	}
	// 拒绝后不能在只读目录里留下任何残片
	if _, statErr := os.Stat(filepath.Join(roots[1].AbsPath, "x")); statErr == nil {
		t.Fatal("只读根被写入了内容")
	}
}

func TestUniqueFilenameFallsBackWhenExhausted(t *testing.T) {
	dir := t.TempDir()
	if got := UniqueFilename(dir, "a.mp4"); got != "a.mp4" {
		t.Fatalf("空目录应原样返回，得到 %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.mp4"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := UniqueFilename(dir, "a.mp4"); got != "a (1).mp4" {
		t.Fatalf("重名应追加序号，得到 %q", got)
	}
}

func TestRepairFilenameStripsPath(t *testing.T) {
	if got := RepairFilename(`C:\Users\a\视频.mp4`); got != "视频.mp4" {
		t.Fatalf("应剥掉客户端路径，得到 %q", got)
	}
	if got := RepairFilename(""); got != "unnamed" {
		t.Fatalf("空文件名应给兜底名，得到 %q", got)
	}
	if got := RepairFilename("正常.mkv"); got != "正常.mkv" {
		t.Fatalf("合法 UTF-8 不应被改写，得到 %q", got)
	}
}

// CompareNames 必须给出拼音序而不是码点序：两者的顺序差别对中文目录名很明显。
func TestCompareNamesChinese(t *testing.T) {
	// 拼音 a < b，码点上「阿」(U+963F) > 「波」(U+6CE2)。
	// 也就是说码点序会把「波西米亚」排在「阿凡达」前面，拼音序相反。
	if CompareNames("阿凡达", "波西米亚") >= 0 {
		t.Fatal("按拼音排序时 阿(a) 应排在 波(b) 之前")
	}
	if CompareNames("banana", "zebra") >= 0 {
		t.Fatal("ASCII 名称仍应按字母序")
	}
	if CompareNames("阿凡达", "阿凡达") != 0 {
		t.Fatal("同一字符串比较结果必须为 0")
	}
}
