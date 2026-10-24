package bilibili

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
)

// ErrNoCredential 表示该用户尚未绑定 B站 账号。
var ErrNoCredential = errors.New("未找到 B站 凭证")

// Credential 是用户已保存的 B站 登录信息。
type Credential struct {
	Cookie       string
	RefreshToken string
}

// CredentialStore 读写 "bilibili_credential" 表。
//
// 加密方式沿用 Node 版：base64。这不是安全措施，只是避免明文直接可见；
// 是否升级到真正的加密由后续单独决定，此处保持字节级兼容——
// 若改成 DPAPI/AES，Node 版读回时就会解不开。
type CredentialStore struct {
	conn *sql.DB
}

// NewCredentialStore 构造凭证仓库。
func NewCredentialStore(conn *sql.DB) *CredentialStore {
	return &CredentialStore{conn: conn}
}

// Get 读取用户凭证，未绑定时返回 ErrNoCredential。
func (s *CredentialStore) Get(ctx context.Context, userID string) (*Credential, error) {
	var cookie string
	var refreshToken sql.NullString
	err := s.conn.QueryRowContext(ctx,
		`SELECT "cookie", "refreshToken" FROM "bilibili_credential" WHERE "userId" = ? LIMIT 1`,
		userID,
	).Scan(&cookie, &refreshToken)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoCredential
	}
	if err != nil {
		return nil, fmt.Errorf("读取 B站 凭证失败: %w", err)
	}
	cred := &Credential{Cookie: decodeBase64(cookie)}
	if refreshToken.Valid && refreshToken.String != "" {
		cred.RefreshToken = decodeBase64(refreshToken.String)
	}
	return cred, nil
}

// GetCookie 是 Get 的便捷封装：未绑定或读取失败都返回空串。
//
// 与 Node 版 getUserCookie 一致：解析流程把「没 Cookie」当成匿名态处理，
// 不该因为读库失败而整体解析失败。
func (s *CredentialStore) GetCookie(ctx context.Context, userID string) string {
	if userID == "" {
		return ""
	}
	cred, err := s.Get(ctx, userID)
	if err != nil || cred == nil {
		return ""
	}
	return cred.Cookie
}

func decodeBase64(s string) string {
	decoded, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return s
	}
	return string(decoded)
}
