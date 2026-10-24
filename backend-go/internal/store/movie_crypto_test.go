package store

import (
	"encoding/hex"
	"testing"
)

// TestEncryptMovieFieldMatchesNode 用固定 IV 与 Node 侧黄金值逐字节对拍。
//
// 黄金值由 `backend/src/entities/Movie.ts#encryptMovieField` 在默认密钥
// （未设 MOVIE_SECRET_KEY，即 `zcontrol-movie-secret-key-32b`）下生成：
//
//	const iv = Buffer.from('000102...0f', 'hex');
//	createCipheriv('aes-256-cbc', key, iv).update(plain) + .final()
//
// 这条测试锁死「AES-256-CBC + PKCS#7 + hex(iv):hex(data)」这套格式。
// 一旦有人把填充块大小、密钥补位或分隔符改掉，既有库里所有影片的
// 挂载密码会立刻解不出来，表现为「NAS 明明能登录，影片流却 401」。
func TestEncryptMovieFieldMatchesNode(t *testing.T) {
	key, err := movieSecretKey()
	if err != nil {
		t.Fatalf("取密钥失败: %v", err)
	}
	// 默认串只有 29 字符，padEnd(32,'0') 补 3 个 0 —— 黄金值是在补位后的
	// 密钥上生成的，断言必须带上这 3 个 0，否则密文永远对不上。
	if string(key) != "zcontrol-movie-secret-key-32b000" {
		t.Fatalf("默认密钥不符: %q (%d 字节)", string(key), len(key))
	}
	iv, err := hex.DecodeString("000102030405060708090a0b0c0d0e0f")
	if err != nil {
		t.Fatalf("IV 解析失败: %v", err)
	}

	cases := []struct {
		plain string
		want  string
	}{
		{"p@ssw0rd", "000102030405060708090a0b0c0d0e0f:14e668b06391d679ac4603d19abe2240"},
		{"p@ssw0rd!中文", "000102030405060708090a0b0c0d0e0f:dfbf0e41a2aa797df43ce39cdfce770e"},
		{
			"长长长长长长长长长长长长长长长长长长长长", // 20 个汉字 = 60 字节，跨 4 个块
			"000102030405060708090a0b0c0d0e0f:5b78f3cf26d85d3e6911719433b74b62dc661d19d2a379c4ec2e3c1265f5e349427e0ea2b15efcb6058efb15d99688dd0d31b04fc89026d5008bb6788cfff0df",
		},
	}
	for _, c := range cases {
		got, err := encryptMovieFieldWithIV(c.plain, key, iv)
		if err != nil {
			t.Fatalf("加密 %q 失败: %v", c.plain, err)
		}
		if got != c.want {
			t.Errorf("密文不符\n plain=%q\n got =%s\n want=%s", c.plain, got, c.want)
		}
		if back := DecryptMovieField(c.want); back != c.plain {
			t.Errorf("回解不符: got %q want %q", back, c.plain)
		}
	}
}

// TestEncryptMovieFieldRoundTrip 验证随机 IV 路径的往返。
func TestEncryptMovieFieldRoundTrip(t *testing.T) {
	for _, plain := range []string{"a", "1234567890123456", "密码 with space", ""} {
		enc, err := EncryptMovieField(plain)
		if err != nil {
			t.Fatalf("加密 %q 失败: %v", plain, err)
		}
		if plain != "" && enc == plain {
			t.Fatalf("未加密: %q", enc)
		}
		if got := DecryptMovieField(enc); got != plain {
			t.Errorf("往返失败: got %q want %q", got, plain)
		}
	}
	// 同一明文两次加密的 IV 必须不同（随机化）。
	a, _ := EncryptMovieField("same")
	b, _ := EncryptMovieField("same")
	if a == b {
		t.Error("两次加密结果相同，IV 未随机化")
	}
}

// TestDecryptMovieFieldRejectsGarbage 验证坏数据降级为空串而不是 panic/报错。
//
// 单条坏数据不能毁掉整个影片列表：Node 的 decipher.final() 会抛异常让
// 列表 500，这里选择降级为「无密码」，让用户至少还能看到影片。
func TestDecryptMovieFieldRejectsGarbage(t *testing.T) {
	cases := []string{
		"",
		"无分隔符",
		"abc:",      // iv 非法 hex
		":abc",      // data 非法 hex
		"0001:abcd", // data 长度非块大小整数倍
		"000102030405060708090a0b0c0d0e0f:zzzz",
	}
	for _, c := range cases {
		if got := DecryptMovieField(c); got != "" {
			t.Errorf("输入 %q 期望空串，实际 %q", c, got)
		}
	}
}

// TestMovieSecretKeyPadAndSlice 验证 padEnd(32,'0').slice(0,32) 的补位与截断。
func TestMovieSecretKeyPadAndSlice(t *testing.T) {
	t.Setenv("MOVIE_SECRET_KEY", "short")
	key, err := movieSecretKey()
	if err != nil {
		t.Fatalf("取密钥失败: %v", err)
	}
	if string(key) != "short000000000000000000000000000" || len(key) != 32 {
		t.Fatalf("补位不符: %q (%d 字节)", string(key), len(key))
	}

	t.Setenv("MOVIE_SECRET_KEY", "0123456789abcdef0123456789abcdefEXTRA")
	key, err = movieSecretKey()
	if err != nil {
		t.Fatalf("取密钥失败: %v", err)
	}
	if string(key) != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("截断不符: %q", string(key))
	}

	// 16 字节密钥也能用于 CBC（AES-128），Node 同样接受。
	t.Setenv("MOVIE_SECRET_KEY", "0123456789abcdef")
	key, err = movieSecretKey()
	if err != nil {
		t.Fatalf("16 字节密钥应可用: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("补位后长度应为 32，实际 %d", len(key))
	}
}

// TestNormalizeJSONText 验证三个 JSON 列的规范化与 Node 一致。
func TestNormalizeJSONText(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		arrayOnly bool
		want      string
		wantNil   bool
	}{
		{"缺失", ``, true, "", true},
		{"显式 null", `null`, true, "", true},
		{"数组", `[{"id":80,"label":"1080P"}]`, true, `[{"id":80,"label":"1080P"}]`, false},
		{"已序列化字符串", `"[{\"id\":80}]"`, true, `[{"id":80}]`, false},
		{"空字符串", `"   "`, true, "", true},
		{"对象给 arrayOnly", `{"a":1}`, true, "", true},
		{"空对象", `{}`, false, "", true},
		{"对象", `{"sourceId":"x","episode":{}}`, false, `{"sourceId":"x","episode":{}}`, false},
	}
	for _, c := range cases {
		var got any
		if c.raw == "" {
			got = normalizeJSONText(nil, c.arrayOnly)
		} else {
			got = normalizeJSONText([]byte(c.raw), c.arrayOnly)
		}
		if c.wantNil {
			if got != nil {
				t.Errorf("%s: 期望 nil，实际 %v", c.name, got)
			}
			continue
		}
		s, ok := got.(string)
		if !ok || s != c.want {
			t.Errorf("%s: got %v want %s", c.name, got, c.want)
		}
	}
}

// TestNormalizeOpenListServerURL 验证与挂载表的地址对齐规则。
func TestNormalizeOpenListServerURL(t *testing.T) {
	cases := map[string]string{
		"192.168.1.5:5244":            "http://192.168.1.5:5244/dav",
		"  http://nas.local:5244/  ":  "http://nas.local:5244/dav",
		"https://pan.example.com/dav": "https://pan.example.com/dav",
		"https://pan.example.com/":    "https://pan.example.com/dav",
		"":                            "",
	}
	for in, want := range cases {
		if got := NormalizeOpenListServerURL(in); got != want {
			t.Errorf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
}
