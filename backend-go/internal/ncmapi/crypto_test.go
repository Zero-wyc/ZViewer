package ncmapi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

// decryptECB 是测试用 AES-ECB 解密（去 PKCS7）。
func decryptECB(t *testing.T, cipherHex, key string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(strings.ToLower(cipherHex))
	if err != nil {
		t.Fatalf("密文不是合法 HEX: %v", err)
	}
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		t.Fatalf("构造 cipher 失败: %v", err)
	}
	if len(raw)%block.BlockSize() != 0 || len(raw) == 0 {
		t.Fatalf("密文长度不是块大小整数倍: %d", len(raw))
	}
	out := make([]byte, len(raw))
	for offset := 0; offset < len(raw); offset += block.BlockSize() {
		block.Decrypt(out[offset:offset+block.BlockSize()], raw[offset:offset+block.BlockSize()])
	}
	return unpadPKCS7(t, out)
}

// unpadPKCS7 去掉补位并校验。
func unpadPKCS7(t *testing.T, padded []byte) []byte {
	t.Helper()
	if len(padded) == 0 {
		t.Fatalf("空明文")
	}
	padding := int(padded[len(padded)-1])
	if padding == 0 || padding > len(padded) {
		t.Fatalf("非法补位: %d", padding)
	}
	return padded[:len(padded)-padding]
}

// TestEapiEncryptRoundTrip 验证 eapi 的拼装格式与摘要。
//
// 这个断言必须精确：eapi 的 params 是「路径 + 分隔符 + 参数 JSON + 分隔符 +
// md5」，任何一段错位都会让上游返回「参数错误」，而错误码和风控失败长得一样。
func TestEapiEncryptRoundTrip(t *testing.T) {
	data := map[string]any{"ids": "[1]", "level": "lossless"}
	form, err := eapiEncrypt("/api/song/enhance/player/url/v1", data)
	if err != nil {
		t.Fatalf("eapi 加密失败: %v", err)
	}
	if len(form) != 1 || form["params"] == "" {
		t.Fatalf("eapi 应当只产出 params 字段: %#v", form)
	}
	plain := string(decryptECB(t, form["params"], eapiKey))

	parts := strings.Split(plain, eapiSeparator)
	if len(parts) != 3 {
		t.Fatalf("eapi 明文应当被分隔成三段，实际 %d 段: %s", len(parts), plain)
	}
	if parts[0] != "/api/song/enhance/player/url/v1" {
		t.Fatalf("路径段错误: %s", parts[0])
	}
	message := "nobody" + parts[0] + "use" + parts[1] + "md5forencrypt"
	sum := md5.Sum([]byte(message))
	if parts[2] != hex.EncodeToString(sum[:]) {
		t.Fatalf("摘要段错误: %s != %s", parts[2], hex.EncodeToString(sum[:]))
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(parts[1]), &decoded); err != nil {
		t.Fatalf("参数段不是合法 JSON: %v", err)
	}
	if decoded["level"] != "lossless" {
		t.Fatalf("参数段丢字段: %#v", decoded)
	}
}

// TestLinuxapiEncryptRoundTrip 验证 linuxapi 的外层结构。
func TestLinuxapiEncryptRoundTrip(t *testing.T) {
	form, err := linuxapiEncrypt(map[string]any{"method": "POST", "url": "https://music.163.com/api/x", "params": map[string]any{"ids": "[1]"}})
	if err != nil {
		t.Fatalf("linuxapi 加密失败: %v", err)
	}
	plain := decryptECB(t, form["eparams"], linuxapiKey)
	var decoded map[string]any
	if err := json.Unmarshal(plain, &decoded); err != nil {
		t.Fatalf("eparams 不是合法 JSON: %v", err)
	}
	if decoded["method"] != "POST" {
		t.Fatalf("method 丢失: %#v", decoded)
	}
	if !strings.Contains(string(plain), "/api/x") {
		t.Fatalf("url 丢失: %s", plain)
	}
}

// TestWeapiEncryptShape 验证 weapi 的形状约束。
//
// 无法在本地解开第二层（密钥随机且不在密文里），所以这里只钉死格式约束；
// 真正的算法正确性由 tests/e2e 打真实接口验证。
func TestWeapiEncryptShape(t *testing.T) {
	form, err := weapiEncrypt(map[string]any{"a": "1"})
	if err != nil {
		t.Fatalf("weapi 加密失败: %v", err)
	}
	if len(form["params"]) == 0 || len(form["encSecKey"]) == 0 {
		t.Fatalf("缺少 params/encSecKey: %#v", form)
	}
	if len(form["encSecKey"]) != 256 {
		t.Fatalf("encSecKey 必须是定长 256 HEX，实际 %d", len(form["encSecKey"]))
	}
	raw, err := base64.StdEncoding.DecodeString(form["params"])
	if err != nil {
		t.Fatalf("params 不是合法 base64: %v", err)
	}
	if len(raw)%aes.BlockSize != 0 || len(raw) == 0 {
		t.Fatalf("params 明文长度异常: %d", len(raw))
	}

	second, err := weapiEncrypt(map[string]any{"a": "1"})
	if err != nil {
		t.Fatalf("weapi 二次加密失败: %v", err)
	}
	if second["params"] == form["params"] {
		t.Fatal("weapi 每次必须使用新的随机密钥")
	}
}

// TestRSANoPaddingFixedLength 验证 RSA 输出定长（前导零不能丢）。
func TestRSANoPaddingFixedLength(t *testing.T) {
	for _, plain := range []string{"a", "0123456789abcdef", "Zz9"} {
		encoded, err := rsaNoPaddingHex([]byte(plain))
		if err != nil {
			t.Fatalf("RSA 加密失败: %v", err)
		}
		if len(encoded) != 256 {
			t.Fatalf("RSA 输出必须定长 256 HEX，输入 %q 得到 %d", plain, len(encoded))
		}
	}
}

// TestPlainValue 验证表单字符串化与 URLSearchParams 一致。
func TestPlainValue(t *testing.T) {
	cases := []struct {
		input any
		want  string
	}{
		{true, "true"},
		{false, "false"},
		{30, "30"},
		{int64(8), "8"},
		{100000.0, "100000"},
		{1.5, "1.5"},
		{"ALL", "ALL"},
		{nil, ""},
		{[]any{"1", "2"}, "1,2"},
	}
	for _, item := range cases {
		if got := plainValue(item.input); got != item.want {
			t.Fatalf("plainValue(%#v) = %q，期望 %q", item.input, got, item.want)
		}
	}
}

// TestEncryptRejectsUnknownMode 未知加密方式必须报错而不是静默降级成明文。
func TestEncryptRejectsUnknownMode(t *testing.T) {
	if _, err := encrypt(crypto("xeapi"), "/api/x", map[string]any{}, ""); err == nil {
		t.Fatal("未知加密方式应当报错")
	}
}

// 确保测试辅助里的 cipher 包被使用（goimports 友好）。
var _ cipher.Block
