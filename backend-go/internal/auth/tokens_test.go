package auth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// bcryptjsHash 由 Node 的 bcryptjs@3 以 cost=10 生成，明文为 "zviewer-test"。
//
// 这条断言的意义：现有库里所有密码哈希都是 bcryptjs 产出的 $2b$ 前缀，
// 如果 Go 的 x/crypto/bcrypt 读不懂，全站用户都将无法登录。
const bcryptjsHash = "$2b$10$cZJ7sOpwAUf7cNLn4AwwouFRNDa4ytmn2ANPKL1ZDtFACiN9RqS/u"

func TestBcryptAcceptsBcryptjsHash(t *testing.T) {
	if err := bcrypt.CompareHashAndPassword([]byte(bcryptjsHash), []byte("zviewer-test")); err != nil {
		t.Fatalf("Go bcrypt 无法校验 bcryptjs 的 $2b$ 哈希: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(bcryptjsHash), []byte("wrong")); err == nil {
		t.Fatal("错误密码不应通过校验")
	}
}

func newTestManager(t *testing.T) *Manager {
	t.Helper()
	dir := t.TempDir()
	manager, err := NewManager(dir)
	if err != nil {
		t.Fatalf("构造 Manager 失败: %v", err)
	}
	// 确认密钥确实落盘，否则重启后所有 token 会失效
	if _, err := os.Stat(filepath.Join(dir, "jwt-secrets.json")); err != nil {
		t.Fatalf("密钥文件未生成: %v", err)
	}
	return manager
}

func TestTokenRoundTrip(t *testing.T) {
	manager := newTestManager(t)

	tokens, err := manager.Generate(42, RoleAdmin, "alice")
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}

	claims, err := manager.VerifyAccess(tokens.AccessToken)
	if err != nil {
		t.Fatalf("校验 access 失败: %v", err)
	}
	if claims.UserID != 42 || claims.Role != RoleAdmin || claims.Username != "alice" {
		t.Fatalf("载荷不符: %+v", claims)
	}

	// access 与 refresh 使用不同密钥，交叉校验必须失败
	if _, err := manager.VerifyRefresh(tokens.AccessToken); err == nil {
		t.Fatal("access token 不应能通过 refresh 密钥校验")
	}
	if _, err := manager.VerifyAccess(tokens.RefreshToken); err == nil {
		t.Fatal("refresh token 不应能通过 access 密钥校验")
	}
}

// TestClaimsJSONFieldNames 锁死字段名。
//
// 这些 key 是与 Node 互通的契约，改任何一个都会让对面的 token 静默解析成零值。
func TestClaimsJSONFieldNames(t *testing.T) {
	manager := newTestManager(t)
	tokens, err := manager.Generate(7, RoleUser, "bob")
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}

	claims, err := manager.VerifyAccess(tokens.AccessToken)
	if err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	raw, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	for _, key := range []string{"userId", "role", "username", "issuedAtMs", "exp", "iat"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("载荷缺少字段 %q（Node 侧依赖该字段名）: %s", key, raw)
		}
	}
}

func TestGuestTokenCarriesGuestID(t *testing.T) {
	manager := newTestManager(t)

	tokens, err := manager.GenerateGuest("")
	if err != nil {
		t.Fatalf("签发游客令牌失败: %v", err)
	}
	claims, err := manager.VerifyAccess(tokens.AccessToken)
	if err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	if !claims.IsGuest() {
		t.Fatalf("应识别为游客: %+v", claims)
	}
	if claims.GuestID == "" {
		t.Fatal("游客令牌必须携带 guestId，否则 assertTokenActive 会判定失效")
	}
	if len(claims.GuestID) != 36 {
		t.Fatalf("guestId 应为 UUIDv4 (36 字符)，实际 %q", claims.GuestID)
	}
}

func TestExpiredTokenRejected(t *testing.T) {
	manager := newTestManager(t)
	// 直接构造一个已过期的 claims，验证 verify 会归入 ErrTokenExpired
	claims := Claims{UserID: 1, Role: RoleUser}
	claims.IssuedAt = jwt.NewNumericDate(time.Now().Add(-2 * time.Hour))
	claims.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Hour))

	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(manager.accessSecret)
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	if _, err := manager.VerifyAccess(token); err != ErrTokenExpired {
		t.Fatalf("期望 ErrTokenExpired，实际 %v", err)
	}
}

func TestParseTTL(t *testing.T) {
	cases := map[string]time.Duration{
		"":        time.Hour,
		"3600":    time.Hour,
		"3600s":   time.Hour,
		"60m":     time.Hour,
		"1h":      time.Hour,
		"1d":      24 * time.Hour,
		"30d":     30 * 24 * time.Hour,
		"1w":      7 * 24 * time.Hour,
		"garbage": time.Hour,
		"-5":      time.Hour,
	}
	for raw, want := range cases {
		if got := parseTTL(raw, time.Hour); got != want {
			t.Errorf("parseTTL(%q) = %v, 期望 %v", raw, got, want)
		}
	}
}
