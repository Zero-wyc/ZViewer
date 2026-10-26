package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrRoomNotFound 表示房间不存在。
var ErrRoomNotFound = errors.New("房间不存在")

// Room 对应 "room" 表，是 REST、房间清理与推流配置共用的读取模型。
//
// 两个字段有额外的序列化约束：password 是 bcrypt 密文，对外只通过 HasPassword
// 表达（禁止下发）；streamKey 由 `UPDATE "streamKey"` 单独写，别整行回写。
type Room struct {
	ID              int64
	RoomID          string
	Name            *string
	Status          string
	Mode            string
	MaxViewers      int64
	RequireApproval bool
	// HasPassword 对应 Node 的 `hasPassword: !!room.password`：
	// 空串也算没有密码（`!!''` 为 false）。
	HasPassword bool
	// Password 是 bcrypt 密文，只在服务端内部使用（房间密码校验）。
	// 对外一律通过 HasPassword 表达，禁止下发。
	Password        *string
	ShareMethod     string
	StreamKey       *string
	MutedViewers    string
	ApprovedViewers string
	Moderators      string
	VoiceMuted      string
	OwnerUserID     *int64
	LastAccessedAt  time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Rooms 提供房间表读写。
type Rooms struct {
	conn *sql.DB
}

// NewRooms 构造房间仓库。
func NewRooms(conn *sql.DB) *Rooms { return &Rooms{conn: conn} }

const roomColumns = `"id", "roomId", "name", "status", "mode", "maxViewers",
	"requireApproval", "password", "shareMethod", "streamKey",
	"mutedViewers", "approvedViewers", "moderators", "voiceMuted",
	"ownerUserId", "lastAccessedAt", "createdAt", "updatedAt"`

// FindByRoomID 读取房间。
func (r *Rooms) FindByRoomID(ctx context.Context, roomID string) (*Room, error) {
	row := r.conn.QueryRowContext(ctx,
		`SELECT `+roomColumns+` FROM "room" WHERE "roomId" = ? LIMIT 1`, roomID)
	room, err := scanRoom(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRoomNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取房间失败: %w", err)
	}
	return room, nil
}

// ListActive 返回所有状态为 active 的房间，按最后访问时间倒序
// （对应 rooms.ts 的 `where: { status: 'active' }, order: { lastAccessedAt: 'DESC' }`）。
func (r *Rooms) ListActive(ctx context.Context) ([]*Room, error) {
	rows, err := r.conn.QueryContext(ctx, `
		SELECT `+roomColumns+` FROM "room"
		WHERE "status" = 'active'
		ORDER BY "lastAccessedAt" DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("查询房间列表失败: %w", err)
	}
	defer rows.Close()

	var list []*Room
	for rows.Next() {
		room, err := scanRoom(rows)
		if err != nil {
			return nil, fmt.Errorf("读取房间行失败: %w", err)
		}
		list = append(list, room)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历房间列表失败: %w", err)
	}
	return list, nil
}

// ListStaleActive 返回「状态 active 且最后访问时间早于阈值」的房间号。
//
// 对应房间清理定时任务的 `where: { status: 'active', lastAccessedAt: LessThan(threshold) }`。
// 只取 roomId：清理只拿它喂 DeleteRoomAndRelations，多读几列是白读。
func (r *Rooms) ListStaleActive(ctx context.Context, threshold time.Time) ([]string, error) {
	rows, err := r.conn.QueryContext(ctx, `
		SELECT "roomId" FROM "room"
		WHERE "status" = 'active' AND "lastAccessedAt" < ?
	`, threshold.UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return nil, fmt.Errorf("查询待清理房间失败: %w", err)
	}
	defer rows.Close()

	var roomIDs []string
	for rows.Next() {
		var roomID string
		if err := rows.Scan(&roomID); err != nil {
			return nil, fmt.Errorf("读取待清理房间失败: %w", err)
		}
		roomIDs = append(roomIDs, roomID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历待清理房间失败: %w", err)
	}
	return roomIDs, nil
}

// SessionCounts 是房间在线统计：观众数与 sharer（投屏端）是否存在。
type SessionCounts struct {
	Viewers map[string]int64
	Sharers map[string]struct{}
}

// ActiveSessionCounts 一次性统计一批房间的在线观众与 sharer。
//
// 刻意只查一回（rooms.ts 用 In(roomIds) 批量查询消 N+1）：房间列表页
// 可能一次几十个房间，逐个查会把首屏拖成几十次往返。
func (r *Rooms) ActiveSessionCounts(ctx context.Context, roomIDs []string) (*SessionCounts, error) {
	counts := &SessionCounts{
		Viewers: make(map[string]int64, len(roomIDs)),
		Sharers: make(map[string]struct{}, len(roomIDs)),
	}
	if len(roomIDs) == 0 {
		return counts, nil
	}

	// 参数占位符按房间数动态生成，避免 SQL 注入也避免固定上限。
	placeholders := make([]byte, 0, len(roomIDs)*2)
	args := make([]any, 0, len(roomIDs))
	for i, id := range roomIDs {
		if i > 0 {
			placeholders = append(placeholders, ',')
		}
		placeholders = append(placeholders, '?')
		args = append(args, id)
	}

	rows, err := r.conn.QueryContext(ctx, `
		SELECT "roomId", "role", COUNT(*) FROM "session"
		WHERE "roomId" IN (`+string(placeholders)+`) AND "endedAt" IS NULL
		GROUP BY "roomId", "role"
	`, args...)
	if err != nil {
		return nil, fmt.Errorf("统计房间在线人数失败: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id    string
			role  string
			total int64
		)
		if err := rows.Scan(&id, &role, &total); err != nil {
			return nil, fmt.Errorf("读取在线统计失败: %w", err)
		}
		switch role {
		case "viewer":
			counts.Viewers[id] = total
		case "sharer":
			counts.Sharers[id] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历在线统计失败: %w", err)
	}
	return counts, nil
}

// Rename 修改房间名称。
func (r *Rooms) Rename(ctx context.Context, roomID, name string) error {
	res, err := r.conn.ExecContext(ctx,
		`UPDATE "room" SET "name" = ?, "updatedAt" = datetime('now') WHERE "roomId" = ?`,
		name, roomID)
	if err != nil {
		return fmt.Errorf("修改房间名称失败: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrRoomNotFound
	}
	return nil
}

// Create 插入房间并回填 ID。调用方负责生成唯一 roomId。
//
// 只显式写 Node 侧 `roomRepo.create({...})` 给出的那些列，其余交给表默认值：
// 多写一列就多一处与 TypeORM 的潜在分叉（默认值、空串 vs NULL）。
func (r *Rooms) Create(ctx context.Context, room *Room) error {
	now := time.Now()
	res, err := r.conn.ExecContext(ctx, `
		INSERT INTO "room" ("roomId", "name", "password", "maxViewers", "status",
			"mode", "requireApproval", "ownerUserId", "lastAccessedAt")
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, room.RoomID, nullableStringPtr(room.Name), nullableStringPtr(room.Password),
		room.MaxViewers, room.Status, room.Mode, room.RequireApproval,
		nullableInt64(room.OwnerUserID), FormatSQLiteTime(now))
	if err != nil {
		return fmt.Errorf("创建房间失败: %w", err)
	}
	if id, err := res.LastInsertId(); err == nil {
		room.ID = id
	}
	room.LastAccessedAt = now
	return nil
}

// ListAll 返回全部房间（含已关闭），按创建时间倒序（管理端房间列表）。
//
// 与 ListActive 的区别：管理端要看到 closed 的房间才能「重新开启」，
// 所以不能按 status 过滤。同样**不加 `id DESC` 兜底**——见 Users.ListAll 的说明。
func (r *Rooms) ListAll(ctx context.Context) ([]*Room, error) {
	rows, err := r.conn.QueryContext(ctx,
		`SELECT `+roomColumns+` FROM "room" ORDER BY "createdAt" DESC`)
	if err != nil {
		return nil, fmt.Errorf("查询房间列表失败: %w", err)
	}
	defer rows.Close()

	list := make([]*Room, 0, 16)
	for rows.Next() {
		room, err := scanRoom(rows)
		if err != nil {
			return nil, fmt.Errorf("读取房间行失败: %w", err)
		}
		list = append(list, room)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历房间列表失败: %w", err)
	}
	return list, nil
}

// DeleteCascade 物理删除房间及其全部关联数据（一个事务内完成）。
//
// 顺序不能改：playback_states / music_playback_states / music_queue_item
// 通过外键引用 room，必须在删 room 之前清掉，否则 SQLite 抛
// FOREIGN KEY constraint failed（movie / comment 无外键约束不敏感）。
//
// 与 Node 的 deleteRoomAndRelations 相比这里**不碰内存**——
// 运行时状态与音乐基线的清理由 room 层的 DeleteRoomAndRelations 负责，
// 仓储层只做持久化。
func (r *Rooms) DeleteCascade(ctx context.Context, roomID string) error {
	tx, err := r.conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("删除房间失败: %w", err)
	}
	defer func() {
		_ = tx.Rollback() // 已提交时是无操作
	}()

	now := FormatSQLiteTime(time.Now())
	if _, err := tx.ExecContext(ctx,
		`UPDATE "session" SET "endedAt" = ? WHERE "roomId" = ? AND "endedAt" IS NULL`,
		now, roomID); err != nil {
		return fmt.Errorf("结束房间会话失败: %w", err)
	}

	relations := []string{
		"movie", "comment", "playback_states", "music_playback_states",
		"music_queue_item", "danmaku_track", "room_danmaku_meta",
	}
	for _, table := range relations {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM "`+table+`" WHERE "roomId" = ?`, roomID); err != nil {
			return fmt.Errorf("删除房间关联数据(%s)失败: %w", table, err)
		}
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM "room" WHERE "roomId" = ?`, roomID); err != nil {
		return fmt.Errorf("删除房间失败: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("删除房间失败: %w", err)
	}
	return nil
}

// SetStatus 修改房间状态（active / closed）。
func (r *Rooms) SetStatus(ctx context.Context, roomID, status string) error {
	_, err := r.conn.ExecContext(ctx, `
		UPDATE "room" SET "status" = ?, "streamKey" = CASE WHEN ? = 'closed' THEN NULL ELSE "streamKey" END, "updatedAt" = ? WHERE "roomId" = ?
	`, status, status, FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return fmt.Errorf("修改房间状态失败: %w", err)
	}
	return nil
}

// SetOwner 设置房间归属用户（无主房间被接管时用）。
//
// 允许传 nil：关闭房间/转移所有权时要把 ownerUserId 置空。
func (r *Rooms) SetOwner(ctx context.Context, roomID string, userID *int64) error {
	_, err := r.conn.ExecContext(ctx, `
		UPDATE "room" SET "ownerUserId" = ?, "updatedAt" = ? WHERE "roomId" = ?
	`, nullableInt64(userID), FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return fmt.Errorf("修改房间归属失败: %w", err)
	}
	return nil
}

// TouchLastAccess 刷新最后访问时间。
func (r *Rooms) TouchLastAccess(ctx context.Context, roomID string) error {
	_, err := r.conn.ExecContext(ctx, `
		UPDATE "room" SET "lastAccessedAt" = ? WHERE "roomId" = ?
	`, FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return fmt.Errorf("刷新房间访问时间失败: %w", err)
	}
	return nil
}

// SetMode 修改房间模式（对应 update-room-mode）。
func (r *Rooms) SetMode(ctx context.Context, roomID, mode string) error {
	_, err := r.conn.ExecContext(ctx, `
		UPDATE "room" SET "mode" = ?, "updatedAt" = ? WHERE "roomId" = ?
	`, mode, FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return fmt.Errorf("修改房间模式失败: %w", err)
	}
	return nil
}

// SetShareMethod 修改房间投屏子模式，并在需要时写入推流密钥。
//
// streamKey 为 nil 表示不动该列：切到 stream-push 时若已有密钥就复用，
// 无条件覆盖会让 OBS 里已经填好的推流码下次连接就失效。
func (r *Rooms) SetShareMethod(ctx context.Context, roomID, shareMethod string, streamKey *string) error {
	if streamKey == nil {
		_, err := r.conn.ExecContext(ctx, `
			UPDATE "room" SET "shareMethod" = ?, "updatedAt" = ? WHERE "roomId" = ?
		`, shareMethod, FormatSQLiteTime(time.Now()), roomID)
		if err != nil {
			return fmt.Errorf("修改投屏子模式失败: %w", err)
		}
		return nil
	}
	_, err := r.conn.ExecContext(ctx, `
		UPDATE "room" SET "shareMethod" = ?, "streamKey" = ?, "updatedAt" = ? WHERE "roomId" = ?
	`, shareMethod, *streamKey, FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return fmt.Errorf("修改投屏子模式失败: %w", err)
	}
	return nil
}

// EnsureStreamKey 原子补齐/迁移推流码，并返回实际保存的码。
//
// 并发下载必须复用已生成的八位码；旧房主的请求不能覆盖转交后的码。
// 不改 shareMethod，保留先下载配置、再切换 OBS 模式的流程。
func (r *Rooms) EnsureStreamKey(ctx context.Context, roomID string, ownerUserID *int64, candidate string) (string, error) {
	var key string
	err := r.conn.QueryRowContext(ctx, `
		UPDATE "room" SET "streamKey" = CASE WHEN length("streamKey") = ? THEN "streamKey" ELSE ? END,
		"updatedAt" = ? WHERE "roomId" = ? AND "ownerUserId" IS ? AND "status" = 'active' AND "mode" = 'screen-share'
		RETURNING "streamKey"
	`, len(candidate), candidate, FormatSQLiteTime(time.Now()), roomID, nullableInt64(ownerUserID)).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrRoomNotFound
	}
	if err != nil {
		return "", fmt.Errorf("写入推流码失败: %w", err)
	}
	return key, nil
}

// RoomSettingsPatch 是 update-room-settings 的三列补丁：字段为 nil 表示不改。
//
// 三列都用指针而不是「零值即不改」：`requireApproval=false` 是合法取值，
// 用 bool 零值判断会让「关闭审批」这个方向永远改不掉。
type RoomSettingsPatch struct {
	// Password 是已加密的密文；指向空串表示清空密码（列写 NULL）。
	Password        *string
	MaxViewers      *int64
	RequireApproval *bool
}

// PatchSettings 按列更新房间设置。
//
// 只写调用方显式给出的列：少写一列不会把别的列冲成 NULL，
// 这是与 SetListColumns 一致的「别整行覆盖」纪律。
func (r *Rooms) PatchSettings(ctx context.Context, roomID string, patch RoomSettingsPatch) error {
	sets := make([]string, 0, 4)
	args := make([]any, 0, 5)
	if patch.Password != nil {
		sets = append(sets, `"password" = ?`)
		if *patch.Password == "" {
			// Node 侧清空密码是 `room.password = null`，落库是 NULL 不是空串；
			// 写成空串会让 `hasPassword = !!password` 仍然为 false，
			// 但两种形态会让对拍与后续迁移多一种分支。
			args = append(args, nil)
		} else {
			args = append(args, *patch.Password)
		}
	}
	if patch.MaxViewers != nil {
		sets = append(sets, `"maxViewers" = ?`)
		args = append(args, *patch.MaxViewers)
	}
	if patch.RequireApproval != nil {
		sets = append(sets, `"requireApproval" = ?`)
		args = append(args, *patch.RequireApproval)
	}
	if len(sets) == 0 {
		return nil
	}
	sets = append(sets, `"updatedAt" = ?`)
	args = append(args, FormatSQLiteTime(time.Now()), roomID)

	_, err := r.conn.ExecContext(ctx,
		`UPDATE "room" SET `+strings.Join(sets, ", ")+` WHERE "roomId" = ?`, args...)
	if err != nil {
		return fmt.Errorf("修改房间设置失败: %w", err)
	}
	return nil
}

// SetModerators 覆盖房管名单（JSON 数组列）。
func (r *Rooms) SetModerators(ctx context.Context, roomID string, ids []int64) error {
	return r.setIDList(ctx, roomID, "moderators", ids)
}

// SetMutedViewers 覆盖禁言名单（JSON 数组列）。
func (r *Rooms) SetMutedViewers(ctx context.Context, roomID string, ids []int64) error {
	return r.setIDList(ctx, roomID, "mutedViewers", ids)
}

// SetApprovedViewers 覆盖审批白名单（JSON 数组列）。
func (r *Rooms) SetApprovedViewers(ctx context.Context, roomID string, ids []int64) error {
	return r.setIDList(ctx, roomID, "approvedViewers", ids)
}

// setIDList 写单个 JSON 数组列。
//
// 表名/列名只由本文件的三个包装传入（不来自请求参数），因此可以直接拼接；
// 值一律走占位符。
func (r *Rooms) setIDList(ctx context.Context, roomID, column string, ids []int64) error {
	if ids == nil {
		ids = []int64{}
	}
	encoded, err := json.Marshal(ids)
	if err != nil {
		return fmt.Errorf("编码 %s 失败: %w", column, err)
	}
	_, err = r.conn.ExecContext(ctx,
		`UPDATE "room" SET "`+column+`" = ?, "updatedAt" = ? WHERE "roomId" = ?`,
		string(encoded), FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return fmt.Errorf("修改 %s 失败: %w", column, err)
	}
	return nil
}

// SetListColumns 覆盖三个 JSON 数组列（mutedViewers / approvedViewers / moderators）。
//
// 三列常常要一起改（例如转交房主时同时动 owner 与 moderators），
// 但**不要**因此把 ownerUserId 也塞进来：职责分开后，调用点更不容易
// 忘带某一列的现值（这是 MountPatch 那类「按列整行覆盖」的老坑）。
func (r *Rooms) SetListColumns(ctx context.Context, roomID string, muted, approved, moderators string) error {
	_, err := r.conn.ExecContext(ctx, `
		UPDATE "room" SET "mutedViewers" = ?, "approvedViewers" = ?, "moderators" = ?,
			"updatedAt" = ?
		WHERE "roomId" = ?
	`, muted, approved, moderators, FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return fmt.Errorf("修改房间成员列失败: %w", err)
	}
	return nil
}

func scanRoom(row rowScanner) (*Room, error) {
	var (
		room       Room
		name       sql.NullString
		status     sql.NullString
		mode       sql.NullString
		maxViewers sql.NullInt64
		approval   sql.NullInt64
		password   sql.NullString
		shareMeth  sql.NullString
		streamKey  sql.NullString
		muted      sql.NullString
		approved   sql.NullString
		moderators sql.NullString
		voiceMuted sql.NullString
		owner      sql.NullInt64
		lastAccess sql.NullString
		createdAt  sql.NullString
		updatedAt  sql.NullString
	)
	err := row.Scan(
		&room.ID, &room.RoomID, &name, &status, &mode, &maxViewers,
		&approval, &password, &shareMeth, &streamKey,
		&muted, &approved, &moderators, &voiceMuted,
		&owner, &lastAccess, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	room.Name = nullString(name)
	room.Status = status.String
	room.Mode = mode.String
	room.MaxViewers = maxViewers.Int64
	room.RequireApproval = approval.Int64 != 0
	room.HasPassword = password.Valid && password.String != ""
	room.Password = nullString(password)
	room.ShareMethod = shareMeth.String
	room.StreamKey = nullString(streamKey)
	room.MutedViewers = muted.String
	room.ApprovedViewers = approved.String
	room.Moderators = moderators.String
	room.VoiceMuted = voiceMuted.String
	if owner.Valid {
		v := owner.Int64
		room.OwnerUserID = &v
	}
	room.LastAccessedAt = parseTimeOrZero(lastAccess)
	room.CreatedAt = parseTimeOrZero(createdAt)
	room.UpdatedAt = parseTimeOrZero(updatedAt)
	return &room, nil
}

// parseTimeOrZero 复刻 TypeORM 的 datetime 水合：`new Date(str + 'Z')`。
//
// 解析失败返回零值而不是报错——时间列只影响展示，读不出来不该让
// 整个房间列表挂掉（TypeORM 那边会得到 Invalid Date，同样不致命）。
func parseTimeOrZero(v sql.NullString) time.Time {
	if !v.Valid {
		return time.Time{}
	}
	if t, ok := parseSQLiteTime(v.String); ok {
		return t
	}
	return time.Time{}
}

// Exists 判断房间是否存在。
func (r *Rooms) Exists(ctx context.Context, roomID string) (bool, error) {
	var one int
	err := r.conn.QueryRowContext(ctx,
		`SELECT 1 FROM "room" WHERE "roomId" = ? LIMIT 1`, roomID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("查询房间失败: %w", err)
	}
	return true, nil
}

// HasActiveSession 判断某身份在该房间是否有未结束的会话。
//
// 这是「房间准入」的唯一依据：REST 与媒体请求都继承这个判定。
// 游客（userID=0）必须按 guestId 匹配——只看 userId 会让所有游客互相
// 冒用同一间房的准入。
func (r *Rooms) HasActiveSession(ctx context.Context, roomID string, userID int64, guestID string) (bool, error) {
	var one int
	var err error
	if userID > 0 {
		err = r.conn.QueryRowContext(ctx, `
			SELECT 1 FROM "session"
			WHERE "roomId" = ? AND "userId" = ? AND "endedAt" IS NULL
			LIMIT 1
		`, roomID, userID).Scan(&one)
	} else {
		err = r.conn.QueryRowContext(ctx, `
			SELECT 1 FROM "session"
			WHERE "roomId" = ? AND "userId" = 0 AND "guestId" = ? AND "endedAt" IS NULL
			LIMIT 1
		`, roomID, guestID).Scan(&one)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("查询房间会话失败: %w", err)
	}
	return true, nil
}
