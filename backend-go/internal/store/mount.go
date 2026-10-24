package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ErrMountNotFound 表示挂载记录不存在。
var ErrMountNotFound = errors.New("挂载不存在")

// Mount 对应 "user_mount" 表。
//
// 凭证类字段（password / apiKey）在 Node 侧有 ValueTransformer 加密，
// Go 侧读出来时统一解密（见 DecryptMovieField）。
type Mount struct {
	ID          int64
	UserID      int64
	Type        string
	Name        string
	ServerURL   *string
	Port        *int64
	Path        *string
	Username    *string
	Password    *string // 已解密
	IndexURL    *string
	APIKey      *string // 已解密
	EmbyUserID  *string
	DirectLink  bool
	HttpsDirect *bool
}

// Mounts 提供挂载表读取。
type Mounts struct {
	conn *sql.DB
}

// NewMounts 构造挂载仓库。
func NewMounts(conn *sql.DB) *Mounts { return &Mounts{conn: conn} }

const mountColumns = `"id", "userId", "type", "name", "serverUrl", "port", "path",
	"username", "password", "indexUrl", "apiKey", "embyUserId", "directLink", "httpsDirect"`

// FindByID 按主键 + 类型读取挂载（凭证解析优先走这条：同服务器多用户
// 挂载时，锚定的 ID 才能唯一确定凭证）。
func (m *Mounts) FindByID(ctx context.Context, id int64, mountType string) (*Mount, error) {
	row := m.conn.QueryRowContext(ctx,
		`SELECT `+mountColumns+` FROM "user_mount" WHERE "id" = ? AND "type" = ? LIMIT 1`,
		id, mountType)
	return scanMount(row)
}

// FindByServerURL 按 userId + serverUrl + type 读取挂载。
//
// serverUrl 必须由调用方先规范化（openlist 需要补 /dav），因为这里的
// 比较是精确匹配——挂载表里存的是规范化后的地址。
func (m *Mounts) FindByServerURL(ctx context.Context, userID int64, serverURL, mountType string) (*Mount, error) {
	row := m.conn.QueryRowContext(ctx, `
		SELECT `+mountColumns+` FROM "user_mount"
		WHERE "serverUrl" = ? AND "type" = ? AND "userId" = ?
		LIMIT 1
	`, serverURL, mountType, userID)
	return scanMount(row)
}

// FindByRoomOwner 按房间房主的挂载查找（旧数据兜底路径）。
func (m *Mounts) FindByRoomOwner(ctx context.Context, ownerUserID int64, serverURL, mountType string) (*Mount, error) {
	row := m.conn.QueryRowContext(ctx, `
		SELECT `+mountColumns+` FROM "user_mount"
		WHERE "serverUrl" = ? AND "type" = ? AND "userId" = ?
		LIMIT 1
	`, serverURL, mountType, ownerUserID)
	return scanMount(row)
}

func scanMount(row rowScanner) (*Mount, error) {
	var (
		mount       Mount
		name        sql.NullString
		serverURL   sql.NullString
		port        sql.NullInt64
		path        sql.NullString
		username    sql.NullString
		password    sql.NullString
		indexURL    sql.NullString
		apiKey      sql.NullString
		embyUserID  sql.NullString
		httpsDirect sql.NullBool
	)
	err := row.Scan(
		&mount.ID, &mount.UserID, &mount.Type, &name, &serverURL, &port, &path,
		&username, &password, &indexURL, &apiKey, &embyUserID,
		&mount.DirectLink, &httpsDirect,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrMountNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取挂载失败: %w", err)
	}
	mount.Name = name.String
	mount.ServerURL = nullString(serverURL)
	if port.Valid {
		v := port.Int64
		mount.Port = &v
	}
	mount.Path = nullString(path)
	mount.Username = nullString(username)
	mount.Password = decryptNonEmpty(password)
	mount.IndexURL = nullString(indexURL)
	mount.APIKey = decryptNonEmpty(apiKey)
	mount.EmbyUserID = nullString(embyUserID)
	if httpsDirect.Valid {
		v := httpsDirect.Bool
		mount.HttpsDirect = &v
	}
	return &mount, nil
}
