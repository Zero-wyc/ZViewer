package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ErrServerFolderNotFound 表示自定义根目录不存在。
var ErrServerFolderNotFound = errors.New("根目录不存在")

// ServerFolder 对应 "server_folder" 表（服务器文件管理的自定义根目录）。
type ServerFolder struct {
	ID        int64
	Name      string
	AbsPath   string
	Readonly  bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ServerFolders 提供 server_folder 表读写。
type ServerFolders struct {
	conn *sql.DB
}

// NewServerFolders 构造仓库。
func NewServerFolders(conn *sql.DB) *ServerFolders { return &ServerFolders{conn: conn} }

const serverFolderColumns = `"id", "name", "absPath", "readonly", "createdAt", "updatedAt"`

func scanServerFolder(row rowScanner) (*ServerFolder, error) {
	var (
		f        ServerFolder
		readonly int
		created  string
		updated  string
	)
	if err := row.Scan(&f.ID, &f.Name, &f.AbsPath, &readonly, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrServerFolderNotFound
		}
		return nil, err
	}
	f.Readonly = readonly != 0
	if t, ok := parseSQLiteTime(created); ok {
		f.CreatedAt = t
	}
	if t, ok := parseSQLiteTime(updated); ok {
		f.UpdatedAt = t
	}
	return &f, nil
}

// List 按 id 升序返回全部自定义根目录。
//
// 顺序即注册表顺序：Node 的 loadRootRegistry 用 `order: { id: 'ASC' }`，
// 前端「根目录」下拉按此顺序展示。
func (r *ServerFolders) List(ctx context.Context) ([]*ServerFolder, error) {
	rows, err := r.conn.QueryContext(ctx,
		`SELECT `+serverFolderColumns+` FROM "server_folder" ORDER BY "id" ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]*ServerFolder, 0, 4)
	for rows.Next() {
		f, scanErr := scanServerFolder(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		list = append(list, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// FindByID 按主键读取。
func (r *ServerFolders) FindByID(ctx context.Context, id int64) (*ServerFolder, error) {
	row := r.conn.QueryRowContext(ctx,
		`SELECT `+serverFolderColumns+` FROM "server_folder" WHERE "id" = ? LIMIT 1`, id)
	return scanServerFolder(row)
}

// FindByAbsPath 按绝对路径读取（新增时用来查重）。
func (r *ServerFolders) FindByAbsPath(ctx context.Context, absPath string) (*ServerFolder, error) {
	row := r.conn.QueryRowContext(ctx,
		`SELECT `+serverFolderColumns+` FROM "server_folder" WHERE "absPath" = ? LIMIT 1`, absPath)
	return scanServerFolder(row)
}

// Create 插入一条自定义根目录并返回落库结果。
func (r *ServerFolders) Create(ctx context.Context, name, absPath string, readonly bool) (*ServerFolder, error) {
	now := FormatSQLiteTime(time.Now())
	res, err := r.conn.ExecContext(ctx, `
		INSERT INTO "server_folder" ("name", "absPath", "readonly", "createdAt", "updatedAt")
		VALUES (?, ?, ?, ?, ?)`,
		name, absPath, boolInt(readonly), now, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return r.FindByID(ctx, id)
}

// Delete 删除一条自定义根目录（只删挂载记录，不动真实文件）。
func (r *ServerFolders) Delete(ctx context.Context, id int64) error {
	res, err := r.conn.ExecContext(ctx, `DELETE FROM "server_folder" WHERE "id" = ?`, id)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrServerFolderNotFound
	}
	return nil
}
