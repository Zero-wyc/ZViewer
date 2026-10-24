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

// encodeBase64 与 Node 的 Buffer.from(text,'utf8').toString('base64') 一致。
//
// 这不是加密，只是避免明文直接出现在库里；换成任何"更强的"算法都会让
// Node 版读回来是乱码（回滚保障就断了）。
func encodeBase64(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

// Save 写入或更新用户凭证（对应 credential.ts#saveCredential）。
//
// userId 是 varchar 列，Node 侧存的是 String(userId)；这里同样用字符串，
// 让 "1" 与 1 在 SQLite 的隐式转换里走同一条索引。
func (s *CredentialStore) Save(ctx context.Context, userID, cookie, refreshToken string) error {
	encodedCookie := encodeBase64(cookie)
	var encodedRefresh any
	if refreshToken != "" {
		encodedRefresh = encodeBase64(refreshToken)
	}

	res, err := s.conn.ExecContext(ctx,
		`UPDATE "bilibili_credential"
		    SET "cookie" = ?, "refreshToken" = ?, "updatedAt" = datetime('now')
		  WHERE "userId" = ?`,
		encodedCookie, encodedRefresh, userID,
	)
	if err != nil {
		return fmt.Errorf("更新 B站 凭证失败: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("更新 B站 凭证失败: %w", err)
	}
	if affected > 0 {
		return nil
	}

	_, err = s.conn.ExecContext(ctx,
		`INSERT INTO "bilibili_credential" ("userId", "cookie", "refreshToken", "createdAt", "updatedAt")
		 VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
		userID, encodedCookie, encodedRefresh,
	)
	if err != nil {
		return fmt.Errorf("写入 B站 凭证失败: %w", err)
	}
	return nil
}

// Clear 删除用户凭证（对应 credential.ts#clearCredential）。
func (s *CredentialStore) Clear(ctx context.Context, userID string) error {
	if _, err := s.conn.ExecContext(ctx,
		`DELETE FROM "bilibili_credential" WHERE "userId" = ?`, userID,
	); err != nil {
		return fmt.Errorf("清除 B站 凭证失败: %w", err)
	}
	return nil
}
