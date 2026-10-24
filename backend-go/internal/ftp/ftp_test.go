package ftp

import (
	"strings"
	"testing"
	"time"
)

// 黄金值来自 Node 侧 basic-ftp 6.0.1 的 parseList 实际输出
// （生成命令见本节注释），逐字段对齐才算通过。
//
// 为什么用黄金值而不是「自己写一遍期望值」：FTP 的 LIST 格式没有标准，
// basic-ftp 的处理方式（贪婪/懒惰的量词、目录项 size 填 0、符号链接的
// " -> " 切分）都是历史行为，凭直觉写期望值会写出「看起来对但不兼容」
// 的测试。
//
// 生成命令：
//
//	node -e "…parseList(samples)…"   # 见 commit message
func TestParseListingMatchesBasicFTP(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []wantEntry
	}{
		{
			name: "MLSD",
			raw: strings.Join([]string{
				"type=cdir;modify=20240102030405; .",
				"type=file;size=1048576;modify=20240102030405;perm=r; a.mkv",
				"type=dir;modify=20240102030405;perm=flcdmpe; sub",
				"type=file;size=512;modify=20240102030405;perm=r; 中文 名.mp4",
				"type=OS.unix=slink:/tmp;modify=20240102030405; linkname",
				"type=file;modify=20240102030405; sizeless.bin",
			}, "\r\n"),
			want: []wantEntry{
				{"a.mkv", kindFile, 1048576, "2024-01-02T03:04:05.000Z", ""},
				{"sub", kindDirectory, 0, "2024-01-02T03:04:05.000Z", ""},
				{"中文 名.mp4", kindFile, 512, "2024-01-02T03:04:05.000Z", ""},
				{"linkname", kindSymbolicLink, 0, "2024-01-02T03:04:05.000Z", "/tmp"},
				{"sizeless.bin", kindFile, 0, "2024-01-02T03:04:05.000Z", ""},
			},
		},
		{
			name: "Unix",
			raw: strings.Join([]string{
				"total 12",
				"-rw-r--r--    1 ftp      ftp       1048576 Jan 02 03:04 a.mkv",
				"drwxr-xr-x    1 ftp      ftp             0 Jan 02 03:04 sub",
				"lrwxrwxrwx    1 ftp      ftp             8 Jan 02 03:04 link -> target",
				"-rw-r--r--    1 ftp      ftp           512 Jan 02 2024 中文 名.mp4",
			}, "\r\n"),
			// 老式 LIST 的时间不可靠，basic-ftp 一律不给 modifiedAt
			want: []wantEntry{
				{"a.mkv", kindFile, 1048576, "", ""},
				{"sub", kindDirectory, 0, "", ""},
				{"link", kindSymbolicLink, 8, "", "target"},
				{"中文 名.mp4", kindFile, 512, "", ""},
			},
		},
		{
			name: "DOS",
			raw: strings.Join([]string{
				"01-02-24  03:04AM       <DIR>          sub",
				"01-02-24  03:04AM              1048576 a.mkv",
			}, "\r\n"),
			want: []wantEntry{
				{"sub", kindDirectory, 0, "", ""},
				{"a.mkv", kindFile, 1048576, "", ""},
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			entries, err := parseListing(testCase.raw)
			if err != nil {
				t.Fatalf("解析失败: %v", err)
			}
			if len(entries) != len(testCase.want) {
				t.Fatalf("条目数=%d，期望 %d（%+v）", len(entries), len(testCase.want), entries)
			}
			for i, want := range testCase.want {
				got := entries[i]
				if got.name != want.name || got.kind != want.kind || got.size != want.size || got.link != want.link {
					t.Errorf("第 %d 项不符：got=%+v want=%+v", i, got, want)
					continue
				}
				gotModified := ""
				if !got.modified.IsZero() {
					gotModified = got.modified.Format("2006-01-02T15:04:05.000Z")
				}
				if gotModified != want.modified {
					t.Errorf("第 %d 项时间不符：got=%q want=%q", i, gotModified, want.modified)
				}
			}
		})
	}
}

type wantEntry struct {
	name     string
	kind     int
	size     int64
	modified string
	link     string
}

// 不认识的格式必须报错（否则浏览界面会显示空目录，问题被藏起来）。
func TestParseListingUnknownFormat(t *testing.T) {
	if _, err := parseListing("这不是任何已知格式的一行\r\n"); err == nil {
		t.Fatal("期望报错，实际通过")
	}
	// 空列表是合法的（空目录）
	entries, err := parseListing("\r\n")
	if err != nil || len(entries) != 0 {
		t.Fatalf("空目录应返回空列表，got=%v err=%v", entries, err)
	}
}

// displayType 复刻 Node 的 `item.type === 1 ? 'file' : 'directory'`：
// 符号链接与未知类型都算目录。
func TestDisplayType(t *testing.T) {
	cases := map[int]string{
		kindFile:         TypeFile,
		kindDirectory:    TypeDirectory,
		kindSymbolicLink: TypeDirectory,
		kindUnknown:      TypeDirectory,
	}
	for kind, want := range cases {
		if got := (rawEntry{kind: kind}).displayType(); got != want {
			t.Errorf("kind=%d got=%q want=%q", kind, got, want)
		}
	}
}

// RFC 3659 时间；毫秒在点后三位。
func TestParseMLSxDate(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"20240102030405", "2024-01-02T03:04:05.000Z"},
		{"20240102030405.014", "2024-01-02T03:04:05.014Z"},
	}
	for _, testCase := range cases {
		got, err := parseMLSxDate(testCase.raw)
		if err != nil {
			t.Fatalf("%s 解析失败: %v", testCase.raw, err)
		}
		if formatted := got.Format("2006-01-02T15:04:05.000Z"); formatted != testCase.want {
			t.Errorf("%s → %s，期望 %s", testCase.raw, formatted, testCase.want)
		}
		if _, offset := got.Zone(); offset != 0 {
			t.Errorf("时间必须是 UTC，实际偏移 %d", offset)
		}
	}
	if _, err := parseMLSxDate("2024"); err == nil {
		t.Error("长度不足应报错")
	}
}

// PASV/EPSV 报文解析。
func TestParsePassiveReplies(t *testing.T) {
	host, port, err := parsePASVAddress("227 Entering Passive Mode (192,168,1,100,10,229)")
	if err != nil {
		t.Fatalf("PASV 解析失败: %v", err)
	}
	if host != "192.168.1.100" || port != 10*256+229 {
		t.Errorf("PASV got=%s:%d", host, port)
	}

	// 部分服务器（如 OS/400）用 ! 而不是 |
	for _, reply := range []string{
		"229 Entering Extended Passive Mode (|||6446|)",
		"229 Entering Extended Passive Mode (!!!6446!)",
	} {
		got, err := parseEPSVPort(reply)
		if err != nil || got != 6446 {
			t.Errorf("EPSV 解析失败: %q → %d, %v", reply, got, err)
		}
	}
	if _, _, err := parsePASVAddress("227 nonsense"); err == nil {
		t.Error("非法 PASV 报文应报错")
	}
}

// serverUrl 的三种形态，以及一个刻意修掉的 Node 缺陷。
func TestParseServerURL(t *testing.T) {
	cases := []struct {
		raw    string
		host   string
		secure bool
	}{
		{"ftp://nas.local", "nas.local", false},
		{"ftps://nas.local/dav", "nas.local", true},
		{"nas.local", "nas.local", false},
		{"  nas.local:2121  ", "nas.local:2121", false},
		{"nas.local/一些/路径", "nas.local", false},
		// Node 侧 `replace(/^ftp/i,'')` 会把它变成 ".example.com"（DNS 解析必失败），
		// 这里按正常语义保留完整主机名。
		{"ftp.example.com", "ftp.example.com", false},
	}
	for _, testCase := range cases {
		host, secure := parseServerURL(testCase.raw)
		if host != testCase.host || secure != testCase.secure {
			t.Errorf("%q → (%q,%v)，期望 (%q,%v)", testCase.raw, host, secure, testCase.host, testCase.secure)
		}
	}
}

func TestNormalizeMountPath(t *testing.T) {
	cases := map[string]string{
		"":          "/",
		"   ":       "/",
		"/videos":   "/videos",
		"videos":    "/videos",
		"/videos/":  "/videos/",
		" /videos ": "/videos",
	}
	for raw, want := range cases {
		if got := NormalizeMountPath(raw); got != want {
			t.Errorf("%q → %q，期望 %q", raw, got, want)
		}
	}
}

// stat 缓存：命中/过期行为。
func TestStatCacheTTL(t *testing.T) {
	cache := NewStatCache()
	params := Params{ServerURL: "nas.local", Path: "/videos/a.mkv", Username: "u"}
	key := cacheKey(params)
	cache.set(key, FileInfo{Size: 42})

	if info, ok := cache.get(key); !ok || info.Size != 42 {
		t.Fatalf("刚写入的条目应命中: ok=%v info=%+v", ok, info)
	}

	// 手工把时间推到过期点之后
	cache.mu.Lock()
	item := cache.items[key]
	item.at = time.Now().Add(-31 * time.Second)
	cache.items[key] = item
	cache.mu.Unlock()

	if _, ok := cache.get(key); ok {
		t.Error("过期条目不应命中")
	}
}

// 目录缓存：LRU 淘汰最久未使用的那条。
func TestDirCacheEvictsOldest(t *testing.T) {
	cache := NewDirCache()
	// 先塞满
	for i := 0; i < dirCacheCap; i++ {
		cache.set("k"+string(rune(i)), nil)
	}
	// 触碰最后一条，让它变成「最近使用」
	cache.get("k" + string(rune(dirCacheCap-1)))
	// 再写一条，应淘汰 k0
	cache.set("extra", nil)
	if _, ok := cache.items["extra"]; !ok {
		t.Fatal("新条目应写入")
	}
	if len(cache.items) != dirCacheCap {
		t.Fatalf("容量应维持在 %d，实际 %d", dirCacheCap, len(cache.items))
	}
	if _, ok := cache.items["k"+string(rune(0))]; ok {
		t.Error("最久未使用的条目应被淘汰")
	}
}
