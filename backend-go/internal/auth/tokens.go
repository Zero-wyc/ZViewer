// Package auth 实现与 Node 版完全互通的鉴权：
// 同一份密钥文件、同一种 JWT 载荷、同一套 cookie 语义。
//
// 互通是硬要求：迁移期两端可能交替接管同一批用户，
// Node 签发的 token 必须能被 Go 验证，反之亦然，
// 否则每次切换端口都要所有人重新登录一次。
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// 角色与状态取值，与 entities/User.ts 保持一致。
const (
	RoleRoot  = "root"
	RoleAdmin = "admin"
	RoleUser  = "user"
	RoleGuest = "guest"

	StatusActive  = "active"
	StatusPending = "pending"
)

// Claims 复刻 Node 侧 JwtPayload 的字段名。
//
// 注意 `json` tag 必须逐字一致——Node 用 userId / issuedAtMs / guestId，
// 大小写不匹配会让对方读到零值，表现为"token 有效但身份变成 0 号用户"。
type Claims struct {
	UserID     int64  `json:"userId"`
	Role       string `json:"role"`
	Username   string `json:"username,omitempty"`
	IssuedAtMs int64  `json:"issuedAtMs"`
	GuestID    string `json:"guestId,omitempty"`
	jwt.RegisteredClaims
}

// Tokens 是一次签发得到的令牌对。
type Tokens struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

// 校验失败的分类，供 HTTP 层映射 401 / 403。
var (
	ErrTokenExpired  = errors.New("令牌已过期")
	ErrTokenInvalid  = errors.New("令牌无效")
	ErrTokenInactive = errors.New("令牌已失效，请重新登录")
)

// Manager 负责签发与校验令牌。
type Manager struct {
	accessSecret  []byte
	refreshSecret []byte

	accessTTL       time.Duration
	refreshTTL      time.Duration
	guestAccessTTL  time.Duration
	guestRefreshTTL time.Duration
}

// NewManager 加载（或生成）密钥并确定有效期。
func NewManager(configDir string) (*Manager, error) {
	secretsFile := filepath.Join(configDir, "jwt-secrets.json")

	access, err := loadOrCreateSecret("JWT_ACCESS_SECRET", "access", secretsFile)
	if err != nil {
		return nil, err
	}
	refresh, err := loadOrCreateSecret("JWT_REFRESH_SECRET", "refresh", secretsFile)
	if err != nil {
		return nil, err
	}

	return &Manager{
		accessSecret:    []byte(access),
		refreshSecret:   []byte(refresh),
		accessTTL:       parseTTL(os.Getenv("JWT_ACCESS_EXPIRES_IN"), time.Hour),
		refreshTTL:      parseTTL(os.Getenv("JWT_REFRESH_EXPIRES_IN"), 30*24*time.Hour),
		guestAccessTTL:  time.Hour,
		guestRefreshTTL: 7 * 24 * time.Hour,
	}, nil
}

// Generate 签发给正式用户。
func (m *Manager) Generate(userID int64, role, username string) (Tokens, error) {
	return m.sign(userID, role, username, "", false)
}

// GenerateGuest 签发给游客：userId=0、role=guest，refresh 只有 7 天。
func (m *Manager) GenerateGuest(guestID string) (Tokens, error) {
	if guestID == "" {
		guestID = newUUIDv4()
	}
	return m.sign(0, RoleGuest, RoleGuest, guestID, true)
}

// GenerateGuestAccess 只续签游客的 access token（refresh 不轮换）。
func (m *Manager) GenerateGuestAccess(guestID string) (string, error) {
	tokens, err := m.sign(0, RoleGuest, RoleGuest, guestID, true)
	if err != nil {
		return "", err
	}
	return tokens.AccessToken, nil
}

// GenerateAccess 只续签正式用户的 access token。
func (m *Manager) GenerateAccess(userID int64, role, username string) (string, error) {
	tokens, err := m.sign(userID, role, username, "", false)
	if err != nil {
		return "", err
	}
	return tokens.AccessToken, nil
}

func (m *Manager) sign(userID int64, role, username, guestID string, guest bool) (Tokens, error) {
	now := time.Now()
	claims := Claims{
		UserID:     userID,
		Role:       role,
		Username:   username,
		IssuedAtMs: now.UnixMilli(),
		GuestID:    guestID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(now),
		},
	}

	accessTTL, refreshTTL := m.accessTTL, m.refreshTTL
	if guest {
		accessTTL, refreshTTL = m.guestAccessTTL, m.guestRefreshTTL
	}

	accessClaims := claims
	accessClaims.ExpiresAt = jwt.NewNumericDate(now.Add(accessTTL))
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims).SignedString(m.accessSecret)
	if err != nil {
		return Tokens{}, fmt.Errorf("签发 access token 失败: %w", err)
	}

	refreshClaims := claims
	refreshClaims.ExpiresAt = jwt.NewNumericDate(now.Add(refreshTTL))
	refreshToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims).SignedString(m.refreshSecret)
	if err != nil {
		return Tokens{}, fmt.Errorf("签发 refresh token 失败: %w", err)
	}

	return Tokens{AccessToken: accessToken, RefreshToken: refreshToken}, nil
}

// VerifyAccess 校验 access token。
func (m *Manager) VerifyAccess(token string) (*Claims, error) {
	return verify(token, m.accessSecret)
}

// VerifyRefresh 校验 refresh token。
func (m *Manager) VerifyRefresh(token string) (*Claims, error) {
	return verify(token, m.refreshSecret)
}

func verify(token string, secret []byte) (*Claims, error) {
	claims := &Claims{}
	// 显式限定 HS256：防止 alg 混淆攻击，也避免与 Node 的签发算法不一致
	_, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		return secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrTokenExpired
		}
		return nil, ErrTokenInvalid
	}
	return claims, nil
}

// IsGuest 判断是否为游客身份。
func (c *Claims) IsGuest() bool {
	return c.UserID == 0 && c.Role == RoleGuest
}

// IssuedAtTime 返回签发时刻（优先毫秒字段，回退标准 iat）。
func (c *Claims) IssuedAtTime() time.Time {
	if c.IssuedAtMs > 0 {
		return time.UnixMilli(c.IssuedAtMs).UTC()
	}
	if c.IssuedAt != nil {
		return c.IssuedAt.Time.UTC()
	}
	return time.Time{}
}

// loadOrCreateSecret 复刻 middleware/auth.ts#loadOrCreateSecret：
// 环境变量 > config/jwt-secrets.json 的指定键 > 自动生成并合并写回。
func loadOrCreateSecret(envKey, fileKey, secretsFile string) (string, error) {
	if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
		return v, nil
	}

	store := readSecrets(secretsFile)
	if v, ok := store[fileKey].(string); ok && len(v) >= 32 {
		return v, nil
	}

	generated, err := randomHex(32)
	if err != nil {
		return "", fmt.Errorf("生成 %s 失败: %w", envKey, err)
	}

	// 合并写回：只覆盖自己那个键，其余键（可能是另一把密钥）原样保留
	store[fileKey] = generated
	if err := writeSecrets(secretsFile, store); err != nil {
		// 与 Node 版一致：写盘失败不阻断启动，代价是重启后旧 token 全部失效
		fmt.Fprintf(os.Stderr, "[auth] %s 无法持久化（本次使用进程内临时密钥）: %v\n", envKey, err)
		return generated, nil
	}
	fmt.Printf("[auth] %s 未设置：已生成随机密钥并保存到 %s\n", envKey, secretsFile)
	return generated, nil
}

func readSecrets(path string) map[string]any {
	store := map[string]any{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return store
	}
	if err := json.Unmarshal(raw, &store); err != nil {
		// 文件损坏时覆盖重建，与 Node 版行为一致
		return map[string]any{}
	}
	return store
}

func writeSecrets(path string, store map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// newUUIDv4 生成 RFC 4122 v4 UUID，与 Node 的 crypto.randomUUID 输出同格式。
func newUUIDv4() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// 随机源不可用属于极端环境错误，用时间戳兜底也要让游客可用
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

// parseTTL 解析 Node jsonwebtoken 风格的有效期表达式：
// "1h" / "30d" / "7d" / "3600"（纯数字按秒）/ "3600s"。
// time.ParseDuration 不认 "d"，必须自己补。
func parseTTL(raw string, fallback time.Duration) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	unit := raw[len(raw)-1]
	value, err := strconv.Atoi(raw[:len(raw)-1])
	if err != nil || value <= 0 {
		return fallback
	}
	switch unit {
	case 's':
		return time.Duration(value) * time.Second
	case 'm':
		return time.Duration(value) * time.Minute
	case 'h':
		return time.Duration(value) * time.Hour
	case 'd':
		return time.Duration(value) * 24 * time.Hour
	case 'w':
		return time.Duration(value) * 7 * 24 * time.Hour
	default:
		return fallback
	}
}
