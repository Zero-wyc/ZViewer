package openlist

import "testing"

// TestNormalizeServerURL 锁死 /dav 补全与协议补全规则。
//
// 这两条不是洁癖：挂载表里存的是规范化后的地址，匹配不上就永远取不到凭证，
// 表现为「NAS 密码明明是对的，影片流却提示认证失败」。
func TestNormalizeServerURL(t *testing.T) {
	cases := map[string]string{
		"192.168.1.5:5244":            "http://192.168.1.5:5244/dav",
		"  http://nas.local:5244/  ":  "http://nas.local:5244/dav",
		"https://pan.example.com/dav": "https://pan.example.com/dav",
		"https://pan.example.com/":    "https://pan.example.com/dav",
		"http://host:5244/dav/":       "http://host:5244/dav",
		"":                            "",
	}
	for in, want := range cases {
		if got := NormalizeServerURL(in); got != want {
			t.Errorf("NormalizeServerURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestToAPIBaseURL(t *testing.T) {
	cases := map[string]string{
		"http://host:5244/dav":  "http://host:5244",
		"http://host:5244/dav/": "http://host:5244",
		"http://host:5244/":     "http://host:5244",
		"http://host:5244":      "http://host:5244",
	}
	for in, want := range cases {
		if got := ToAPIBaseURL(in); got != want {
			t.Errorf("ToAPIBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestHashPasswordMatchesNode 与 Node 的 hashAlistPassword 对拍。
//
// 黄金值由 backend/src/services/openlist-client.ts 在
// ALIST_PASSWORD_SALT 下生成。哈希值会**落库**（新版挂载存的就是它），
// salt 或编码变了会让所有已保存的挂载密码立刻失效。
func TestHashPasswordMatchesNode(t *testing.T) {
	cases := map[string]string{
		"admin":    "6fcb57cd10b2c11d765dcf16148d99130afd895082af83725ee8bb181b1d2b0f",
		"p@ssw0rd": "bcf93b9caec179ac77979ab42337160fa88233c515bba05cf2b3a1a6ecf17a04",
		"":         "263d6a3a1bc3780769ef456641d81a41ea52b66dd25fe02b5959967fd852127d",
	}
	for plain, want := range cases {
		if got := HashPassword(plain); got != want {
			t.Errorf("HashPassword(%q) = %q, want %q", plain, got, want)
		}
	}
}

func TestIsHashedPassword(t *testing.T) {
	if !IsHashedPassword(HashPassword("admin")) {
		t.Error("哈希值应被识别")
	}
	if IsHashedPassword("admin") {
		t.Error("明文不应被识别为哈希")
	}
	if IsHashedPassword("") {
		t.Error("空串不应被识别为哈希")
	}
	if IsHashedPassword("6fcb57cd10b2c11d765dcf16148d99130afd895082af83725ee8bb181b1d2b0") {
		t.Error("63 位 hex 不应被识别")
	}
}

func TestCodeOf(t *testing.T) {
	if got := CodeOf(newError(CodeAuthFailed, "x")); got != CodeAuthFailed {
		t.Errorf("got %q", got)
	}
	if got := CodeOf(errTest{}); got != CodeUnreachable {
		t.Errorf("未知错误应归为 UNREACHABLE，实际 %q", got)
	}
}

type errTest struct{}

func (errTest) Error() string { return "boom" }
