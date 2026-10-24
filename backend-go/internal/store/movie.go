package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"zviewer/backend/internal/openlist"
)

// ErrMovieNotFound 表示影片不存在。
var ErrMovieNotFound = errors.New("影片不存在")

// Movie 对应 "movie" 表。
//
// 时间字段按「TypeORM 水合语义」解释（见 parseMovieTime）：DB 里存的是
// UTC 分解的字符串，但 TypeORM 读出时用 `new Date(str)` 按**本地时区**解析，
// 于是 API 返回的 ISO 时间比真实 UTC 早了一个时区偏移。这是 Node 版既有的
// 行为，Go 必须复刻，否则两端 createdAt 差 8 小时（前端按时间排序会错位）。
type Movie struct {
	ID       int64
	RoomID   string
	URL      string
	Title    string
	Cover    *string
	Source   *string
	AudioURL *string
	Format   *string
	// VideoCodec / AudioCodec 是容器内的实际编码名，用于前端判断是否需要转码。
	VideoCodec *string
	AudioCodec *string
	Duration   *float64
	Cid        *int64
	CurrentQn  *int64
	// AcceptQuality / Pages / SourceMeta 保持 DB 原始 JSON 字符串，
	// 由 DTO 层做「解析成功才返数组/对象」的兼容处理。
	AcceptQuality     *string
	Pages             *string
	CurrentPage       *int64
	ServerURL         *string
	SourceMountID     *int64
	Path              *string
	Username          *string
	Password          *string // 已解密明文；写入前由 store 加密
	DirectLink        bool
	ServerProxy       bool
	WasmEngine        bool
	PlaysVideoEnabled bool
	CLIOnly           bool
	MultiVersion      bool
	SourceMeta        *string
	Order             int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// MovieInput 是新增影片的入参（对应 MovieDto 的可写子集）。
type MovieInput struct {
	URL               string
	Title             string
	Cover             *string
	Source            *string
	AudioURL          *string
	Format            *string
	VideoCodec        *string
	AudioCodec        *string
	Duration          *float64
	Cid               *int64
	CurrentQn         *int64
	AcceptQuality     json.RawMessage // 原样保管：string 直接 trim，其余 JSON.stringify
	Pages             json.RawMessage
	CurrentPage       *int64
	ServerURL         *string
	Path              *string
	Username          *string
	Password          *string
	DirectLink        bool
	ServerProxy       bool
	WasmEngine        bool
	PlaysVideoEnabled bool
	MultiVersion      bool
	SourceMeta        json.RawMessage
}

// MoviePatch 是更新影片的入参。
//
// 语义与 movie.service.ts#updateMovie 逐条对齐：**只有提供了值才写**，
// 传 null 等同"不修改"（Node 用 `typeof x === 'string'` 判定，null 的
// typeof 是 'object'）。三个 JSON 列例外——它们用 `!== undefined` 判定，
// 传 null 是要**清空**，所以用 json.RawMessage 区分「缺失」与「显式 null」。
type MoviePatch struct {
	URL               *string
	Title             *string
	Cover             *string
	Order             *int64
	Source            *string
	AudioURL          *string
	Format            *string
	VideoCodec        *string
	AudioCodec        *string
	Duration          *float64
	Cid               *int64
	CurrentQn         *int64
	AcceptQuality     json.RawMessage `json:"-"`
	Pages             json.RawMessage `json:"-"`
	CurrentPage       *int64
	ServerURL         *string
	Path              *string
	Username          *string
	Password          *string
	DirectLink        *bool
	ServerProxy       *bool
	WasmEngine        *bool
	PlaysVideoEnabled *bool
	CLIOnly           *bool
	MultiVersion      *bool
	SourceMeta        json.RawMessage
	// SourceMountIDTouched 表示调用方显式提供了 sourceMountId（值本身会被忽略，
	// 因为挂载必须由服务端按 serverUrl + source 重新锚定，不信任客户端）。
	SourceMountIDTouched bool
}

// Movies 提供影片表读写。
type Movies struct {
	conn *sql.DB
}

// NewMovies 构造影片仓库。
func NewMovies(conn *sql.DB) *Movies { return &Movies{conn: conn} }

const movieColumns = `"id", "roomId", "url", "title", "cover", "source", "audioUrl",
	"format", "videoCodec", "audioCodec", "duration", "cid", "currentQn",
	"acceptQuality", "pages", "currentPage", "serverUrl", "sourceMountId",
	"path", "username", "password", "directLink", "serverProxy", "wasmEngine",
	"playsvideoEnabled", "cliOnly", "multiVersion", "sourceMeta", "order",
	"createdAt", "updatedAt"`

// RoomOwnerUserID 返回影片所属房间的房主用户 ID。
//
// 用途：观众端解析时用「房主」的 B站 Cookie 而非观众自己的。
// 房主是大会员时，会员专享集拿到的是完整内容；用观众身份只会拿到 3 分钟试看。
func (m *Movies) RoomOwnerUserID(ctx context.Context, movieID int64) (int64, error) {
	var ownerID sql.NullInt64
	err := m.conn.QueryRowContext(ctx, `
		SELECT r."ownerUserId"
		FROM "movie" mv
		JOIN "room" r ON r."roomId" = mv."roomId"
		WHERE mv."id" = ?
		LIMIT 1
	`, movieID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrMovieNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("查询影片房主失败: %w", err)
	}
	if !ownerID.Valid {
		return 0, ErrMovieNotFound
	}
	return ownerID.Int64, nil
}

// FindByID 按主键读取影片（不校验 roomId）。
func (m *Movies) FindByID(ctx context.Context, id int64) (*Movie, error) {
	row := m.conn.QueryRowContext(ctx,
		`SELECT `+movieColumns+` FROM "movie" WHERE "id" = ? LIMIT 1`, id)
	return scanMovie(row)
}

// FindInRoom 按主键 + 房间读取影片。
func (m *Movies) FindInRoom(ctx context.Context, roomID string, id int64) (*Movie, error) {
	row := m.conn.QueryRowContext(ctx,
		`SELECT `+movieColumns+` FROM "movie" WHERE "id" = ? AND "roomId" = ? LIMIT 1`, id, roomID)
	return scanMovie(row)
}

// ListByRoom 返回房间内影片，按 order、id 升序（与 Node 的排序一致）。
func (m *Movies) ListByRoom(ctx context.Context, roomID string) ([]*Movie, error) {
	rows, err := m.conn.QueryContext(ctx,
		`SELECT `+movieColumns+` FROM "movie" WHERE "roomId" = ? ORDER BY "order" ASC, "id" ASC`, roomID)
	if err != nil {
		return nil, fmt.Errorf("查询影片列表失败: %w", err)
	}
	defer rows.Close()

	out := make([]*Movie, 0, 16)
	for rows.Next() {
		mv, err := scanMovie(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, mv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历影片列表失败: %w", err)
	}
	return out, nil
}

// Create 新增影片并返回落库后的实体。
//
// order 取当前房间最大值 + 1（首条为 0）；挂载型源会按 serverUrl 锚定
// sourceMountId；非直链的挂载型源在落库后把 url 改写成
// `/api/<source>/stream?movieId=<id>`——这样房间内任何成员（含观众）都能
// 访问该影片流，不依赖各自的挂载表。
func (m *Movies) Create(ctx context.Context, roomID string, in MovieInput, userID int64) (*Movie, error) {
	var maxOrder sql.NullInt64
	err := m.conn.QueryRowContext(ctx,
		`SELECT MAX("order") FROM "movie" WHERE "roomId" = ?`, roomID).Scan(&maxOrder)
	if err != nil {
		return nil, fmt.Errorf("查询影片排序失败: %w", err)
	}
	nextOrder := int64(0)
	if maxOrder.Valid {
		nextOrder = maxOrder.Int64 + 1
	}

	mountID, err := m.resolveSourceMountID(ctx, in.Source, in.ServerURL, userID)
	if err != nil {
		return nil, err
	}

	encPassword, err := encryptOptional(in.Password)
	if err != nil {
		return nil, err
	}

	now := truncateToMillis(time.Now())
	created := FormatSQLiteTime(now)
	res, err := m.conn.ExecContext(ctx, `
		INSERT INTO "movie" (
			"roomId", "url", "title", "cover", "source", "audioUrl", "format",
			"videoCodec", "audioCodec", "duration", "cid", "currentQn",
			"acceptQuality", "pages", "currentPage", "serverUrl", "sourceMountId",
			"path", "username", "password", "directLink", "serverProxy",
			"wasmEngine", "playsvideoEnabled", "cliOnly", "multiVersion",
			"sourceMeta", "order", "createdAt", "updatedAt"
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
	`,
		roomID, strings.TrimSpace(in.URL), strings.TrimSpace(in.Title),
		in.Cover, in.Source, in.AudioURL, in.Format,
		in.VideoCodec, in.AudioCodec, in.Duration, in.Cid, in.CurrentQn,
		normalizeJSONText(in.AcceptQuality, true), normalizeJSONText(in.Pages, true),
		in.CurrentPage, in.ServerURL, mountID,
		in.Path, in.Username, encPassword, boolInt(in.DirectLink), boolInt(in.ServerProxy),
		boolInt(in.WasmEngine), boolInt(in.PlaysVideoEnabled), 0, boolInt(in.MultiVersion),
		normalizeJSONText(in.SourceMeta, false), nextOrder, created, created,
	)
	if err != nil {
		return nil, fmt.Errorf("新增影片失败: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("获取影片 ID 失败: %w", err)
	}

	// 代理模式：把 url 改写成基于影片 ID 的流地址。
	if !in.DirectLink {
		if sourceType := derefString(in.Source); isMountSource(sourceType) {
			streamURL := fmt.Sprintf("/api/%s/stream?movieId=%d", sourceType, id)
			if _, err := m.conn.ExecContext(ctx,
				`UPDATE "movie" SET "url" = ? WHERE "id" = ?`, streamURL, id); err != nil {
				return nil, fmt.Errorf("重写影片流地址失败: %w", err)
			}
		}
	}

	return m.FindByID(ctx, id)
}

// Update 更新影片；影片不存在返回 ErrMovieNotFound。
func (m *Movies) Update(ctx context.Context, roomID string, id int64, patch MoviePatch, userID int64) (*Movie, error) {
	current, err := m.FindInRoom(ctx, roomID, id)
	if err != nil {
		return nil, err
	}

	sets := make([]string, 0, 20)
	args := make([]any, 0, 21)
	add := func(col string, value any) {
		sets = append(sets, `"`+col+`" = ?`)
		args = append(args, value)
	}

	if patch.URL != nil {
		if v := strings.TrimSpace(*patch.URL); v != "" {
			add("url", v)
		}
	}
	if patch.Title != nil {
		if v := strings.TrimSpace(*patch.Title); v != "" {
			add("title", v)
		}
	}
	if patch.Cover != nil {
		add("cover", *patch.Cover)
	}
	if patch.Order != nil {
		add("order", *patch.Order)
	}
	if patch.Source != nil {
		add("source", *patch.Source)
	}
	if patch.AudioURL != nil {
		add("audioUrl", *patch.AudioURL)
	}
	if patch.Format != nil {
		add("format", *patch.Format)
	}
	if patch.VideoCodec != nil {
		add("videoCodec", *patch.VideoCodec)
	}
	if patch.AudioCodec != nil {
		add("audioCodec", *patch.AudioCodec)
	}
	if patch.Duration != nil {
		add("duration", *patch.Duration)
	}
	if patch.Cid != nil {
		add("cid", *patch.Cid)
	}
	if patch.CurrentQn != nil {
		add("currentQn", *patch.CurrentQn)
	}
	if patch.AcceptQuality != nil {
		add("acceptQuality", normalizeJSONText(patch.AcceptQuality, true))
	}
	if patch.Pages != nil {
		add("pages", normalizeJSONText(patch.Pages, true))
	}
	if patch.CurrentPage != nil {
		add("currentPage", *patch.CurrentPage)
	}
	if patch.ServerURL != nil {
		add("serverUrl", *patch.ServerURL)
	}
	if patch.Path != nil {
		add("path", *patch.Path)
	}
	if patch.Username != nil {
		add("username", *patch.Username)
	}
	if patch.Password != nil {
		enc, err := encryptOptional(patch.Password)
		if err != nil {
			return nil, err
		}
		add("password", enc)
	}
	if patch.DirectLink != nil {
		add("directLink", boolInt(*patch.DirectLink))
	}
	if patch.ServerProxy != nil {
		add("serverProxy", boolInt(*patch.ServerProxy))
	}
	if patch.WasmEngine != nil {
		add("wasmEngine", boolInt(*patch.WasmEngine))
	}
	if patch.PlaysVideoEnabled != nil {
		add("playsvideoEnabled", boolInt(*patch.PlaysVideoEnabled))
	}
	if patch.CLIOnly != nil {
		add("cliOnly", boolInt(*patch.CLIOnly))
	}
	if patch.MultiVersion != nil {
		add("multiVersion", boolInt(*patch.MultiVersion))
	}
	if patch.SourceMeta != nil {
		add("sourceMeta", normalizeJSONText(patch.SourceMeta, false))
	}

	// serverUrl / source 变更时重新锚定挂载（不信任客户端直接指定的挂载 ID）。
	if patch.SourceMountIDTouched || patch.ServerURL != nil || patch.Source != nil {
		src := patch.Source
		if src == nil {
			src = current.Source
		}
		serverURL := patch.ServerURL
		if serverURL == nil {
			serverURL = current.ServerURL
		}
		mountID, err := m.resolveSourceMountID(ctx, src, serverURL, userID)
		if err != nil {
			return nil, err
		}
		add("sourceMountId", mountID)
	}

	if len(sets) > 0 {
		args = append(args, FormatSQLiteTime(truncateToMillis(time.Now())))
		query := `UPDATE "movie" SET ` + strings.Join(sets, ", ") +
			`, "updatedAt" = ? WHERE "id" = ? AND "roomId" = ?`
		args = append(args, id, roomID)
		if _, err := m.conn.ExecContext(ctx, query, args...); err != nil {
			return nil, fmt.Errorf("更新影片失败: %w", err)
		}
	}

	return m.FindInRoom(ctx, roomID, id)
}

// Delete 删除单条影片。
func (m *Movies) Delete(ctx context.Context, roomID string, id int64) (bool, error) {
	res, err := m.conn.ExecContext(ctx,
		`DELETE FROM "movie" WHERE "id" = ? AND "roomId" = ?`, id, roomID)
	if err != nil {
		return false, fmt.Errorf("删除影片失败: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, nil
	}
	return n > 0, nil
}

// ClearRoom 删除房间内全部影片，返回删除条数。
func (m *Movies) ClearRoom(ctx context.Context, roomID string) (int64, error) {
	res, err := m.conn.ExecContext(ctx, `DELETE FROM "movie" WHERE "roomId" = ?`, roomID)
	if err != nil {
		return 0, fmt.Errorf("清空影片失败: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return n, nil
}

// Reorder 批量更新排序值。
//
// 放在单事务里：中途失败会留下「一半新序、一半旧序」的错乱状态，
// 而影片列表是用户可见的，错序很难被察觉更难被修复。
func (m *Movies) Reorder(ctx context.Context, roomID string, orders []MovieOrder) error {
	if len(orders) == 0 {
		return nil
	}
	tx, err := m.conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开启重排序事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx,
		`UPDATE "movie" SET "order" = ? WHERE "id" = ? AND "roomId" = ?`)
	if err != nil {
		return fmt.Errorf("准备重排序语句失败: %w", err)
	}
	defer stmt.Close()

	for _, item := range orders {
		if _, err := stmt.ExecContext(ctx, item.Order, item.ID, roomID); err != nil {
			return fmt.Errorf("重排序影片 %d 失败: %w", item.ID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交重排序事务失败: %w", err)
	}
	return nil
}

// MovieOrder 是重排序的一项。
type MovieOrder struct {
	ID    int64
	Order int64
}

// mountSourceTypes 是需要从 user_mount 取凭证的源类型。
//
// kazumi / anime / cms / bilibili / mp4 都是「自解析」源，凭证在 sourceMeta
// 或解析链路里，不来自挂载表。
var mountSourceTypes = map[string]bool{
	"webdav":   true,
	"openlist": true,
	"ftp":      true,
	"emby":     true,
	"jellyfin": true,
}

func isMountSource(source string) bool { return mountSourceTypes[strings.ToLower(source)] }

// resolveSourceMountID 按 source + serverUrl 反查挂载并返回锚定 ID。
//
// 同一服务器可能被多个用户挂载（凭证不同），优先取 userId 命中的挂载
// （推送者自己的）；**不借用其他用户的挂载**。openlist 的 movie.serverUrl
// 存原始输入，匹配前需 normalize（挂载表存规范化地址）。
func (m *Movies) resolveSourceMountID(ctx context.Context, source, serverURL *string, userID int64) (any, error) {
	src := strings.ToLower(derefString(source))
	if src == "" || serverURL == nil || !isMountSource(src) {
		return nil, nil
	}
	normalize := func(u string) string {
		if src == "openlist" {
			return NormalizeOpenListServerURL(u)
		}
		return strings.TrimSpace(u)
	}
	target := normalize(*serverURL)

	rows, err := m.conn.QueryContext(ctx,
		`SELECT "id", "userId", "serverUrl" FROM "user_mount" WHERE "type" = ?`, src)
	if err != nil {
		return nil, fmt.Errorf("查询挂载失败: %w", err)
	}
	defer rows.Close()

	var matched int64
	for rows.Next() {
		var (
			id       int64
			ownerID  sql.NullInt64
			mountURL sql.NullString
		)
		if err := rows.Scan(&id, &ownerID, &mountURL); err != nil {
			return nil, fmt.Errorf("读取挂载失败: %w", err)
		}
		if !mountURL.Valid || normalize(mountURL.String) != target {
			continue
		}
		// 只认 userId 命中的挂载（不借用他人凭证），未命中即 null。
		if userID > 0 && ownerID.Valid && ownerID.Int64 == userID {
			matched = id
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历挂载失败: %w", err)
	}
	if matched > 0 {
		return matched, nil
	}
	return nil, nil
}

// NormalizeOpenListServerURL 复刻 openlist-errors.ts#normalizeOpenListServerUrl。
//
// 实现放在 internal/openlist：那里是 AList 协议的唯一归属地，store 只需要
// 「匹配挂载」这一个用途，不希望两份 /dav 补全逻辑各自演化。
func NormalizeOpenListServerURL(serverURL string) string {
	return openlist.NormalizeServerURL(serverURL)
}

// parseMovieTime 解析影片表的时间列，统一按 **UTC** 理解。
//
// 这条结论来自 Node/Go 对拍实测（scripts/movie-parity.sh）：
// 种子行写入 '2026-10-21 14:15:50.000'（TypeORM 用 UTC 分解落库），
// Node 侧 movieService.listMovies 输出 `2026-10-21T14:15:50.000Z` ——
// 字面量原样当 UTC，没有任何时区偏移。
//
// 曾经按「TypeORM 用 `new Date(str)` 水合，JS 对无时区串按本地解释」推断
// 需要 +8h 偏移，实测直接把这个推断推翻了：sql.js 路径根本不走
// normalizeHydratedDate，DATE 列由驱动自己处理。**这类跨实现的语义只能实测，
// 不能靠读一两个函数推断**——反了就是全天时间戳差 8 小时，而且两边
// 各自自洽，不报错。
func parseMovieTime(raw string) (time.Time, bool) {
	return parseSQLiteTime(raw)
}

// rowScanner 抽象 *sql.Row 与 *sql.Rows 的公共能力（两者 Scan 签名一致），
// 避免为两种来源各写一份 30 列的 Scan 样板。
type rowScanner interface {
	Scan(dest ...any) error
}

func scanMovie(row rowScanner) (*Movie, error) {
	var (
		mv          Movie
		cover       sql.NullString
		source      sql.NullString
		audioURL    sql.NullString
		format      sql.NullString
		videoCodec  sql.NullString
		audioCodec  sql.NullString
		duration    sql.NullFloat64
		cid         sql.NullInt64
		currentQn   sql.NullInt64
		acceptQ     sql.NullString
		pages       sql.NullString
		currentPage sql.NullInt64
		serverURL   sql.NullString
		sourceMount sql.NullInt64
		path        sql.NullString
		username    sql.NullString
		password    sql.NullString
		sourceMeta  sql.NullString
		createdAt   string
		updatedAt   string
	)
	err := row.Scan(
		&mv.ID, &mv.RoomID, &mv.URL, &mv.Title, &cover, &source, &audioURL,
		&format, &videoCodec, &audioCodec, &duration, &cid, &currentQn,
		&acceptQ, &pages, &currentPage, &serverURL, &sourceMount,
		&path, &username, &password, &mv.DirectLink, &mv.ServerProxy, &mv.WasmEngine,
		&mv.PlaysVideoEnabled, &mv.CLIOnly, &mv.MultiVersion, &sourceMeta, &mv.Order,
		&createdAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrMovieNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取影片失败: %w", err)
	}
	mv.Cover = nullString(cover)
	mv.Source = nullString(source)
	mv.AudioURL = nullString(audioURL)
	mv.Format = nullString(format)
	mv.VideoCodec = nullString(videoCodec)
	mv.AudioCodec = nullString(audioCodec)
	if duration.Valid {
		v := duration.Float64
		mv.Duration = &v
	}
	if cid.Valid {
		v := cid.Int64
		mv.Cid = &v
	}
	if currentQn.Valid {
		v := currentQn.Int64
		mv.CurrentQn = &v
	}
	mv.AcceptQuality = nullString(acceptQ)
	mv.Pages = nullString(pages)
	if currentPage.Valid {
		v := currentPage.Int64
		mv.CurrentPage = &v
	}
	mv.ServerURL = nullString(serverURL)
	if sourceMount.Valid {
		v := sourceMount.Int64
		mv.SourceMountID = &v
	}
	mv.Path = nullString(path)
	mv.Username = nullString(username)
	if plain := decryptNonEmpty(password); plain != nil {
		mv.Password = plain
	}
	mv.SourceMeta = nullString(sourceMeta)
	mv.CreatedAt, _ = parseMovieTime(createdAt)
	mv.UpdatedAt, _ = parseMovieTime(updatedAt)
	return &mv, nil
}

// decryptNonEmpty 解密凭证列，解不出来就当没有。
//
// 返回 nil 而不是空串指针是有意的：调用方用 `!= nil` 判定「有没有凭证」，
// 空串指针会被当成「有凭证但为空」，进而覆盖掉挂载表里的真实密码——
// 表现为「配了密码却提示未授权」，且没有任何日志可查。
// 解不出来通常意味着 MOVIE_SECRET_KEY 变了（换机器/换环境变量）。
func decryptNonEmpty(raw sql.NullString) *string {
	if !raw.Valid || raw.String == "" {
		return nil
	}
	plain := DecryptMovieField(raw.String)
	if plain == "" {
		return nil
	}
	return &plain
}

func nullString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// encryptOptional 只在给出非空值时加密（空串按 null 存，与 Node 的
// `typeof data.password === 'string' ? data.password : null` 语义一致）。
func encryptOptional(plain *string) (any, error) {
	if plain == nil || *plain == "" {
		return nil, nil
	}
	return EncryptMovieField(*plain)
}

// normalizeJSONText 复刻 normalizeAcceptQuality / normalizePages / normalizeSourceMeta。
//
// - string：trim 后返回，空串 → nil
// - 其他 JSON 值：原样序列化（对象/数组）
// - 显式 null / 缺失 → nil
//
// rejectEmptyObject 为 true 时，空对象 `{}` 也会被丢弃（acceptQuality/pages 只
// 接受数组或字符串）；sourceMeta 的空对象同样丢弃，这正是 Node 里
// `json === '{}' ? null : json` 那条分支。
func normalizeJSONText(raw json.RawMessage, arrayOnly bool) any {
	if len(raw) == 0 {
		return nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	// 字符串字面量：按已序列化的 JSON 处理，trim 后返回。
	if strings.HasPrefix(trimmed, `"`) {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil
		}
		if v := strings.TrimSpace(s); v != "" {
			return v
		}
		return nil
	}
	if arrayOnly && !strings.HasPrefix(trimmed, "[") {
		return nil
	}
	if trimmed == "{}" {
		return nil
	}
	return trimmed
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// truncateToMillis 抹掉亚毫秒部分：SQLite 的 datetime 文本只保留到毫秒，
// 不截断会让「刚写入的行」与「随后读回的行」在纳秒位上不等，测试里
// reflect.DeepEqual 直接失败。
func truncateToMillis(t time.Time) time.Time {
	return t.Truncate(time.Millisecond)
}
