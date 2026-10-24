package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"
)

// defaultMovieSecretKey 与 entities/Movie.ts 的兜底值一致。
const defaultMovieSecretKey = "zcontrol-movie-secret-key-32b"

// movieSecretKey 返回 AES-256 密钥，复刻 Node 的 padEnd(32,'0').slice(0,32)。
//
// Node 的 padEnd/slice 按 UTF-16 code unit 计数——这里用 rune 计数等价
// （BMP 内两者一致；emoji 这类代理对字符 Node 会算 2、Go 算 1，但密钥都是
// 手输的普通字符串，不存在该情形）。补位后再取 UTF-8 字节，长度不是 16/24/32
// 时返回错误，与 Node 抛 "Invalid key length" 的行为一致。
func movieSecretKey() ([]byte, error) {
	raw := os.Getenv("MOVIE_SECRET_KEY")
	if raw == "" {
		raw = defaultMovieSecretKey
	}
	runes := []rune(raw)
	for len(runes) < 32 {
		runes = append(runes, '0')
	}
	if len(runes) > 32 {
		runes = runes[:32]
	}
	key := []byte(string(runes))
	switch len(key) {
	case 16, 24, 32:
		return key, nil
	default:
		return nil, fmt.Errorf("MOVIE_SECRET_KEY 长度无效（%d 字节），需 16/24/32 字节", len(key))
	}
}

// EncryptMovieField 加密影片凭证字段，产出 `ivHex:dataHex` 格式。
//
// 与 Node 的 encryptMovieField 逐字节兼容：AES-256-CBC + 随机 16 字节 IV +
// PKCS#7 填充，密文取 hex。既有库里所有 password 列都是这个格式，
// Go 版必须能读；反过来 Go 写入的也必须能被 Node 读。
func EncryptMovieField(plain string) (string, error) {
	key, err := movieSecretKey()
	if err != nil {
		return "", err
	}
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return "", fmt.Errorf("生成 IV 失败: %w", err)
	}
	return encryptMovieFieldWithIV(plain, key, iv)
}

// encryptMovieFieldWithIV 是带显式 IV 的加密实现，仅供测试与 Node 黄金值对拍。
// 生产路径必须走 EncryptMovieField（随机 IV）。
func encryptMovieFieldWithIV(plain string, key, iv []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("初始化 AES 失败: %w", err)
	}
	padded := pkcs7Pad([]byte(plain), block.BlockSize())
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	return hex.EncodeToString(iv) + ":" + hex.EncodeToString(out), nil
}

// DecryptMovieField 解密影片凭证字段。
//
// 与 Node 的 decryptMovieField 对齐：缺少 `:` 分隔或 hex 非法时返回空串
// （Node 的 `if (!ivHex || !dataHex) return ”`）。密文长度不是块大小整数倍
// 时同样返回空串——Node 会在 decipher.final() 抛异常，但那时整个影片列表
// 都会 500，而这里选择降级为"无密码"，避免单条坏数据毁掉整个列表。
func DecryptMovieField(encrypted string) string {
	ivHex, dataHex, ok := strings.Cut(encrypted, ":")
	if !ok || ivHex == "" || dataHex == "" {
		return ""
	}
	key, err := movieSecretKey()
	if err != nil {
		return ""
	}
	iv, err := hex.DecodeString(ivHex)
	if err != nil || len(iv) != aes.BlockSize {
		return ""
	}
	data, err := hex.DecodeString(dataHex)
	if err != nil || len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return ""
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return ""
	}
	plain := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, data)
	unpadded, err := pkcs7Unpad(plain, block.BlockSize())
	if err != nil {
		return ""
	}
	if !utf8.Valid(unpadded) {
		return ""
	}
	return string(unpadded)
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - len(data)%blockSize
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, errors.New("密文长度非法")
	}
	pad := int(data[len(data)-1])
	if pad == 0 || pad > blockSize || pad > len(data) {
		return nil, errors.New("填充非法")
	}
	for _, b := range data[len(data)-pad:] {
		if int(b) != pad {
			return nil, errors.New("填充字节不一致")
		}
	}
	return data[:len(data)-pad], nil
}
