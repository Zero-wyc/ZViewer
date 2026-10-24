package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrMountNotFound 表示挂载记录不存在。
var ErrMountNotFound = errors.New("挂载不存在")

// Mount 对应 "user_mount" 表。
//
// 重要：password / apiKey 在 user_mount 表里是**明文**。
// 全仓只有 entities/Movie.ts 用 ValueTransformer 加密（AES-CBC），
// 挂载表没有 transformer，Node 侧写进去的是什么读出来就是什么。
// 这里仍做「能解就解」的兼容处理（plainOrDecrypted），是为了兜住历史上
// 可能手工加密过的数据，但绝不能把解不出来当成"没有密码"——
// 那样真实的明文密码会被静默丢掉，表现为挂载一直认证失败。
type Mount struct {
	ID          int64
	UserID      int64
	Type        string
	Name        string
	ServerURL   *string
	Port        *int64
	Path        *string
	Username    *string
	Password    *string // 已解密/明文
	IndexURL    *string
	APIKey      *string // 已解密/明文
	EmbyUserID  *string
	DirectLink  bool
	HttpsDirect *bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Mounts 提供挂载表读写。
type Mounts struct {
	conn *sql.DB
}

// NewMounts 构造挂载仓库。
func NewMounts(conn *sql.DB) *Mounts { return &Mounts{conn: conn} }

const mountColumns = `"id", "userId", "type", "name", "serverUrl", "port", "path",
	"username", "password", "indexUrl", "apiKey", "embyUserId", "directLink", "httpsDirect",
	"createdAt", "updatedAt"`

// FindByID 按主键 + 类型读取挂载（凭证解析优先走这条：同服务器多用户
// 挂载时，锚定的 ID 才能唯一确定凭证）。
func (m *Mounts) FindByID(ctx context.Context, id int64, mountType string) (*Mount, error) {
	row := m.conn.QueryRowContext(ctx,
		`SELECT `+mountColumns+` FROM "user_mount" WHERE "id" = ? AND "type" = ? LIMIT 1`,
		id, mountType)
	return scanMount(row)
}

// FindOwned 按主键 + 归属用户 + 类型读取挂载。
//
// 挂载 ID 是可枚举的整数，所有挂载类端点都必须用这条（带上 userId），
// 只按 id 查等于允许任何登录用户使用别人的 NAS 凭证。
func (m *Mounts) FindOwned(ctx context.Context, id, userID int64, mountType string) (*Mount, error) {
	row := m.conn.QueryRowContext(ctx, `
		SELECT `+mountColumns+` FROM "user_mount"
		WHERE "id" = ? AND "userId" = ? AND "type" = ?
		LIMIT 1
	`, id, userID, mountType)
	return scanMount(row)
}

// ListByUserType 列出用户某类型的挂载，按创建时间倒序。
//
// 刻意不加第二排序键：Node 侧是 `order: { createdAt: 'DESC' }`，
// createdAt 相同（同一秒创建）时依赖 sqlite 的自然行序，
// 加个 id DESC 反而会让两端的顺序在「同秒创建」时不一致。
func (m *Mounts) ListByUserType(ctx context.Context, userID int64, mountType string) ([]*Mount, error) {
	rows, err := m.conn.QueryContext(ctx, `
		SELECT `+mountColumns+` FROM "user_mount"
		WHERE "userId" = ? AND "type" = ?
		ORDER BY "createdAt" DESC
	`, userID, mountType)
	if err != nil {
		return nil, fmt.Errorf("查询挂载列表失败: %w", err)
	}
	defer rows.Close()

	var list []*Mount
	for rows.Next() {
		mount, err := scanMount(rows)
		if err != nil {
			return nil, fmt.Errorf("读取挂载行失败: %w", err)
		}
		list = append(list, mount)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历挂载列表失败: %w", err)
	}
	return list, nil
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

// MountInput 是新建挂载的入参（nil 表示落库为 NULL）。
type MountInput struct {
	UserID      int64
	Type        string
	Name        string
	ServerURL   *string
	Port        *int64
	Path        *string
	Username    *string
	Password    *string
	IndexURL    *string
	APIKey      *string
	EmbyUserID  *string
	DirectLink  bool
	HttpsDirect *bool
}

// Create 插入一条挂载并返回落库结果。
func (m *Mounts) Create(ctx context.Context, in MountInput) (*Mount, error) {
	res, err := m.conn.ExecContext(ctx, `
		INSERT INTO "user_mount"
			("userId","type","name","serverUrl","port","path","username","password",
			 "indexUrl","apiKey","embyUserId","directLink","httpsDirect")
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
	`, in.UserID, in.Type, in.Name, in.ServerURL, in.Port, in.Path, in.Username, in.Password,
		in.IndexURL, in.APIKey, in.EmbyUserID, in.DirectLink, in.HttpsDirect)
	if err != nil {
		return nil, fmt.Errorf("创建挂载失败: %w", err)
	}
	id, _ := res.LastInsertId()
	return m.FindOwned(ctx, id, in.UserID, in.Type)
}

// MountPatch 是更新挂载的入参。
//
// 全部字段必填（指针可为 nil 表示写成 NULL）：更新语义是「整条覆盖」，
// 与 Node 侧 save(完整实体) 一致，而不是部分更新。
type MountPatch struct {
	Name        string
	ServerURL   *string
	Path        *string
	Username    *string
	Password    *string // nil = 写成 NULL；调用方需要「不传就沿用旧密码」时自行填旧值
	DirectLink  bool
	HttpsDirect *bool
}

// Update 覆盖一条挂载（按 id + userId + type 限定归属）。
func (m *Mounts) Update(ctx context.Context, id, userID int64, mountType string, patch MountPatch) error {
	res, err := m.conn.ExecContext(ctx, `
		UPDATE "user_mount"
		SET "name" = ?, "serverUrl" = ?, "path" = ?, "username" = ?, "password" = ?,
		    "directLink" = ?, "httpsDirect" = ?, "updatedAt" = datetime('now')
		WHERE "id" = ? AND "userId" = ? AND "type" = ?
	`, patch.Name, patch.ServerURL, patch.Path, patch.Username, patch.Password,
		patch.DirectLink, patch.HttpsDirect, id, userID, mountType)
	if err != nil {
		return fmt.Errorf("更新挂载失败: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrMountNotFound
	}
	return nil
}

// Delete 删除一条挂载（按 id + userId + type 限定归属）。
func (m *Mounts) Delete(ctx context.Context, id, userID int64, mountType string) error {
	res, err := m.conn.ExecContext(ctx,
		`DELETE FROM "user_mount" WHERE "id" = ? AND "userId" = ? AND "type" = ?`,
		id, userID, mountType)
	if err != nil {
		return fmt.Errorf("删除挂载失败: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrMountNotFound
	}
	return nil
}

// SaveHTTPSDirect 只写 httpsDirect 一列。
//
// 直链升级前的现场探测失败时要「自愈写回」false（缓存陈旧），
// 这条路径必须只动一列：整行覆盖会把并发请求刚改进的其他字段冲掉。
func (m *Mounts) SaveHTTPSDirect(ctx context.Context, id int64, value *bool) error {
	_, err := m.conn.ExecContext(ctx,
		`UPDATE "user_mount" SET "httpsDirect" = ? WHERE "id" = ?`, value, id)
	if err != nil {
		return fmt.Errorf("写入 HTTPS 探测结果失败: %w", err)
	}
	return nil
}

// plainOrDecrypted 读取凭证列：能解就解，解不出就按明文用。
//
// user_mount 的密码本来就是明文（该表没有 ValueTransformer），
// 早先版本误用 decryptNonEmpty 处理，导致真实挂载密码被判定为"解密失败"
// 而静默变成 nil——所有挂载都会变成无凭证访问。这里的兜底顺序是硬要求。
func plainOrDecrypted(raw sql.NullString) *string {
	if !raw.Valid || raw.String == "" {
		return nil
	}
	if plain := DecryptMovieField(raw.String); plain != "" {
		return &plain
	}
	value := raw.String
	return &value
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
		createdAt   sql.NullString
		updatedAt   sql.NullString
	)
	err := row.Scan(
		&mount.ID, &mount.UserID, &mount.Type, &name, &serverURL, &port, &path,
		&username, &password, &indexURL, &apiKey, &embyUserID,
		&mount.DirectLink, &httpsDirect, &createdAt, &updatedAt,
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
	mount.Password = plainOrDecrypted(password)
	mount.IndexURL = nullString(indexURL)
	mount.APIKey = plainOrDecrypted(apiKey)
	mount.EmbyUserID = nullString(embyUserID)
	if httpsDirect.Valid {
		v := httpsDirect.Bool
		mount.HttpsDirect = &v
	}
	mount.CreatedAt = parseTimeOrZero(createdAt)
	mount.UpdatedAt = parseTimeOrZero(updatedAt)
	return &mount, nil
}
