package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// NcmCredential 对应 "ncm_credential" 表：一个 ZViewer 用户持久化的网易云登录态。
//
// `userId` 上有 UNIQUE 约束（`UQ_8784f26ab8cf90c9c2b82f9f7b6`），
// 所以「游客共用一份 cookie」在结构上就不可能——游客 userId=0 也照样会被
// 这一行挡住，因此业务层一律不落库游客凭证。
type NcmCredential struct {
	ID      int64
	UserID  int64
	Cookies string
	// Nickname / AvatarURL / VIPType / VIPStatus 是登录态缓存。
	// 扫码登录（`/login/qr/check` 803）只回 code，不含资料，
	// 这些字段靠后续 `/login/status` 与转发响应顺手补全。
	Nickname  *string
	AvatarURL *string
	VIPType   *int64
	VIPStatus *int64
	UpdatedAt time.Time
}

// NcmCredentials 提供网易云凭证读写。
type NcmCredentials struct {
	conn *sql.DB
}

// NewNcmCredentials 构造凭证仓库。
func NewNcmCredentials(conn *sql.DB) *NcmCredentials { return &NcmCredentials{conn: conn} }

const ncmCredentialColumns = `"id", "userId", "cookies", "nickname", "avatarUrl",
	"vipType", "vipStatus", "updatedAt"`

// FindByUserID 读取用户凭证；没有时返回 (nil, nil)。
//
// 与 Node 的 `repo.findOneBy({ userId })` 一致：查不到不是错误。
func (n *NcmCredentials) FindByUserID(ctx context.Context, userID int64) (*NcmCredential, error) {
	if userID <= 0 {
		return nil, nil
	}
	row := n.conn.QueryRowContext(ctx,
		`SELECT `+ncmCredentialColumns+` FROM "ncm_credential" WHERE "userId" = ?`, userID)

	var (
		cred      NcmCredential
		nickname  sql.NullString
		avatarURL sql.NullString
		vipType   sql.NullInt64
		vipStatus sql.NullInt64
		updatedAt string
	)
	err := row.Scan(&cred.ID, &cred.UserID, &cred.Cookies, &nickname, &avatarURL,
		&vipType, &vipStatus, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取网易云凭证失败: %w", err)
	}
	if nickname.Valid {
		value := nickname.String
		cred.Nickname = &value
	}
	if avatarURL.Valid {
		value := avatarURL.String
		cred.AvatarURL = &value
	}
	if vipType.Valid {
		value := vipType.Int64
		cred.VIPType = &value
	}
	if vipStatus.Valid {
		value := vipStatus.Int64
		cred.VIPStatus = &value
	}
	if parsed, ok := parseSQLiteTime(updatedAt); ok {
		cred.UpdatedAt = parsed
	}
	return &cred, nil
}

// NcmProfilePatch 是要写入的账号资料缓存。
//
// 每个字段用指针区分「不改」（nil）与「改成 0 / 空串」——
// Node 侧是 `if (profile?.vipType != null) existing.vipType = profile.vipType`，
// 把 0 也当成有效值写进去，用值类型会把 0 当成「不写」。
type NcmProfilePatch struct {
	Nickname  *string
	AvatarURL *string
	VIPType   *int64
	VIPStatus *int64
}

// Save 写入（或更新）用户凭证并同步资料缓存。
//
// 更新分支的语义与 Node 的 persistCookies 逐条对应：
// cookies 一律覆盖；nickname / avatarUrl / vipType / vipStatus **只在传入非 nil
// 时覆盖**（`COALESCE(excluded.x, 旧值)`），否则保留库里的旧值。
func (n *NcmCredentials) Save(ctx context.Context, userID int64, cookies string, patch NcmProfilePatch) error {
	if userID <= 0 {
		return errors.New("游客不持久化网易云凭证")
	}
	_, err := n.conn.ExecContext(ctx, `
		INSERT INTO "ncm_credential"
			("userId", "cookies", "nickname", "avatarUrl", "vipType", "vipStatus", "updatedAt")
		VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT("userId") DO UPDATE SET
			"cookies"   = excluded."cookies",
			"nickname"  = COALESCE(excluded."nickname", "ncm_credential"."nickname"),
			"avatarUrl" = COALESCE(excluded."avatarUrl", "ncm_credential"."avatarUrl"),
			"vipType"   = COALESCE(excluded."vipType", "ncm_credential"."vipType"),
			"vipStatus" = COALESCE(excluded."vipStatus", "ncm_credential"."vipStatus"),
			"updatedAt" = datetime('now')
	`, userID, cookies,
		nullableStringPtr(patch.Nickname),
		nullableStringPtr(patch.AvatarURL),
		nullableInt64Ptr(patch.VIPType),
		nullableInt64Ptr(patch.VIPStatus),
	)
	if err != nil {
		return fmt.Errorf("保存网易云凭证失败: %w", err)
	}
	return nil
}

// DeleteByUserID 删除用户凭证（退出登录）。
func (n *NcmCredentials) DeleteByUserID(ctx context.Context, userID int64) error {
	if userID <= 0 {
		return nil
	}
	if _, err := n.conn.ExecContext(ctx,
		`DELETE FROM "ncm_credential" WHERE "userId" = ?`, userID); err != nil {
		return fmt.Errorf("删除网易云凭证失败: %w", err)
	}
	return nil
}

func nullableInt64Ptr(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}
