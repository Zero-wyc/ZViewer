// 网易云四套加密通道。
//
// 对外路径与参数名沿用 NeteaseCloudMusicApi 的方言（前端 44 处调用依赖它），
// 这里负责把参数表变成真实上游能接受的密文：weapi 双层 AES-CBC + RSA，
// eapi AES-ECB + 摘要（默认通道），linuxapi 与明文 api 兜底。
//
// 密钥与 RSA 公钥都是客户端侧的固定值，随网易云客户端版本变化——失效时的
// 表现是所有接口一起 400/403，改这里的常量即可，与业务代码无关。
package ncm

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"sort"
	"strings"
)

// 网易云固化的加密常量。这些值从 2015 年沿用至今，随客户端版本更新时才可能
// 变动；一旦上游改密钥，weapi/eapi 会整体失效（表现为响应 code=400 或解密
// 失败），此处与 Node 版 util/crypto.js 保持一致，便于对拍。
const (
	weapiIV        = "0102030405060708"
	weapiPresetKey = "0CoJUm6Qyw8W8jud"
	linuxapiKey    = "rFgB&h#%2?^eDg:Q"
	eapiKey        = "e82ckenh8dichen8"
	eapiSeparator  = "-36cd479b6b5-"

	// weapiRSAKey 是网易 weapi 的 RSA 公钥（只有模数与指数，用于无填充加密）。
	weapiRSAKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`

	// keyCharset 是 weapi 第二层 AES 密钥的字符集（必须是 62 个可见字符）。
	keyCharset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
)

// crypto 是加密方式，取值为 NeteaseCloudMusicApi 的 crypto 选项。
type crypto string

const (
	// cryptoAPI 是明文通道：POST /api/xxx，form 表单直投 interface 域名。
	cryptoAPI crypto = "api"
	// cryptoWeapi 是网页版通道：双层 AES-CBC + RSA，打 music.163.com。
	cryptoWeapi crypto = "weapi"
	// cryptoEapi 是客户端通道：AES-ECB + md5 摘要 + header 内嵌 cookie。
	cryptoEapi crypto = "eapi"
	// cryptoLinuxapi 是 Linux 客户端通道，只有个别老接口在用（/song/url）。
	cryptoLinuxapi crypto = "linuxapi"
)

// payload 是一次加密的结果：要 POST 的表单字段。
type payload map[string]string

// encrypt 按 crypto 把业务参数编成上游要的表单字段。
//
// apiURL 是真实上游路径（形如 /api/song/detail），eapi 的摘要需要它原文。
// csrf 是 cookie 里的 __csrf，weapi 要求把它塞进参数。
func encrypt(mode crypto, apiURL string, data map[string]any, csrf string) (payload, error) {
	switch mode {
	case cryptoWeapi:
		withCSRF := cloneData(data)
		withCSRF["csrf_token"] = csrf
		return weapiEncrypt(withCSRF)
	case cryptoEapi:
		return eapiEncrypt(apiURL, data)
	case cryptoLinuxapi:
		return linuxapiEncrypt(map[string]any{
			"method": "POST",
			"url":    apiURL,
			"params": data,
		})
	case cryptoAPI, "":
		return plainPayload(data), nil
	}
	return nil, fmt.Errorf("未知的加密方式: %s", mode)
}

// weapiEncrypt 复刻 Node 版 weapi：
//
//	params   = base64(AES-CBC(base64(AES-CBC(json, presetKey, iv)), secretKey, iv))
//	encSecKey= hex(RSA-NOPADDING(reverse(secretKey), 公钥))
//
// 注意两级 AES 的密钥不同：第一级固定，第二级随机；RSA 加密的是随机密钥的
// **反转串**（Node 侧秘密在 split(”).reverse().join(”) 那一步）。
func weapiEncrypt(data map[string]any) (payload, error) {
	text, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	secretKey, err := randomKey(16)
	if err != nil {
		return nil, err
	}
	first, err := aesCBCBase64(text, weapiPresetKey, weapiIV)
	if err != nil {
		return nil, err
	}
	second, err := aesCBCBase64([]byte(first), secretKey, weapiIV)
	if err != nil {
		return nil, err
	}
	encSecKey, err := rsaNoPaddingHex([]byte(reverse(secretKey)))
	if err != nil {
		return nil, err
	}
	return payload{"params": second, "encSecKey": encSecKey}, nil
}

// eapiEncrypt 复刻客户端通道：
//
//	digest = md5("nobody" + url + "use" + json + "md5forencrypt")
//	params = HEX(AES-ECB(url + sep + json + sep + digest))
//
// 与 weapi 的关键差别：摘要里带业务参数，所以参数一改摘要必须重算。
func eapiEncrypt(apiURL string, data map[string]any) (payload, error) {
	text, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	message := "nobody" + apiURL + "use" + string(text) + "md5forencrypt"
	sum := md5.Sum([]byte(message))
	joined := apiURL + eapiSeparator + string(text) + eapiSeparator + hex.EncodeToString(sum[:])
	encrypted, err := aesECBHex([]byte(joined), eapiKey)
	if err != nil {
		return nil, err
	}
	return payload{"params": encrypted}, nil
}

// linuxapiEncrypt 复刻 Linux 客户端通道（AES-ECB + 大写 HEX）。
func linuxapiEncrypt(data map[string]any) (payload, error) {
	text, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	encrypted, err := aesECBHex(text, linuxapiKey)
	if err != nil {
		return nil, err
	}
	return payload{"eparams": encrypted}, nil
}

// plainPayload 把参数压成 form 表单。
//
// 与 Node 的 new URLSearchParams(data) 等价：布尔写 true/false，数字取十进制，
// 数组/对象用逗号连接（只有 songIds 这类字段会走到，它们本来就期望 JSON，
// 由调用方自己 marshal 成字符串传进来）。
func plainPayload(data map[string]any) payload {
	out := make(payload, len(data))
	for key, value := range data {
		out[key] = plainValue(value)
	}
	return out
}

// plainValue 是 URLSearchParams 对单个值的字符串化规则。
func plainValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return formatNumber(typed)
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, plainValue(item))
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(typed, ",")
	case map[string]any:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(encoded)
	default:
		return fmt.Sprint(typed)
	}
}

// formatNumber 避免把整数输出成 1.000000e+06。
func formatNumber(value float64) string {
	if value == float64(int64(value)) {
		return fmt.Sprintf("%d", int64(value))
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", value), "0"), ".")
}

// encodeForm 把 payload 编成 application/x-www-form-urlencoded。
//
// 用 url.Values.Encode 会按键排序；网易不关心顺序，但排序让请求可复现，
// 排障时能直接对比。
func encodeForm(form payload) string {
	keys := make([]string, 0, len(form))
	for key := range form {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	values := make(url.Values, len(form))
	for _, key := range keys {
		values.Set(key, form[key])
	}
	return values.Encode()
}

// aesCBCBase64 做 AES-CBC/PKCS7 并输出标准 base64。
func aesCBCBase64(plain []byte, key, iv string) (string, error) {
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		return "", err
	}
	padded := pkcs7Pad(plain, block.BlockSize())
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, []byte(iv)).CryptBlocks(out, padded)
	return base64.StdEncoding.EncodeToString(out), nil
}

// aesECBHex 做 AES-ECB/PKCS7 并输出大写 HEX（eapi/linuxapi 要求大写）。
func aesECBHex(plain []byte, key string) (string, error) {
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		return "", err
	}
	padded := pkcs7Pad(plain, block.BlockSize())
	out := make([]byte, len(padded))
	for offset := 0; offset < len(padded); offset += block.BlockSize() {
		block.Encrypt(out[offset:offset+block.BlockSize()], padded[offset:offset+block.BlockSize()])
	}
	return strings.ToUpper(hex.EncodeToString(out)), nil
}

// pkcs7Pad 补位到块大小整数倍。
func pkcs7Pad(plain []byte, blockSize int) []byte {
	padding := blockSize - len(plain)%blockSize
	out := make([]byte, len(plain)+padding)
	copy(out, plain)
	for index := len(plain); index < len(out); index++ {
		out[index] = byte(padding)
	}
	return out
}

// rsaNoPaddingHex 用网易公钥做**无填充** RSA，输出定长 HEX。
//
// 网易用的是教科书式 RSA（不是 PKCS#1 v1.5）：明文左补零到模长 128 字节，
// 再做一次模幂。补零到定长很重要——少了前导零服务端解出的密钥会短几位。
func rsaNoPaddingHex(plain []byte) (string, error) {
	block, _ := pem.Decode([]byte(weapiRSAKey))
	if block == nil {
		return "", errors.New("weapi 公钥解析失败")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", err
	}
	publicKey, ok := parsed.(*rsa.PublicKey)
	if !ok || publicKey == nil {
		return "", errors.New("weapi 公钥类型异常")
	}
	size := (publicKey.N.BitLen() + 7) / 8
	if len(plain) > size {
		return "", errors.New("weapi 密钥过长")
	}
	buffer := make([]byte, size)
	copy(buffer[size-len(plain):], plain)
	message := new(big.Int).SetBytes(buffer)
	ciphertext := new(big.Int).Exp(message, big.NewInt(int64(publicKey.E)), publicKey.N)
	// ciphertext.Bytes() 会丢掉前导零，必须手动补齐到模长，否则 hex 长度不足。
	return fmt.Sprintf("%0*x", size*2, ciphertext.Bytes()), nil
}

// randomKey 生成 n 个字符的随机密钥（base62）。
func randomKey(n int) (string, error) {
	buffer := make([]byte, n)
	for index := range buffer {
		value, err := rand.Int(rand.Reader, big.NewInt(int64(len(keyCharset))))
		if err != nil {
			return "", err
		}
		buffer[index] = keyCharset[value.Int64()]
	}
	return string(buffer), nil
}

// reverse 反转字符串（weapi 的 RSA 明文是密钥反转串）。
func reverse(value string) string {
	runes := []rune(value)
	for left, right := 0, len(runes)-1; left < right; left, right = left+1, right-1 {
		runes[left], runes[right] = runes[right], runes[left]
	}
	return string(runes)
}

// cloneData 浅拷贝参数表（避免加密时把 csrf_token 写回调用方的 map）。
func cloneData(data map[string]any) map[string]any {
	out := make(map[string]any, len(data)+1)
	for key, value := range data {
		out[key] = value
	}
	return out
}
