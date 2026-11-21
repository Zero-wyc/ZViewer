package db

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// 启动期自动迁移必须满足四件事：补齐结构、留可回滚的备份、不动数据、幂等。
func TestAutoMigrateUpgradesLegacyDatabase(t *testing.T) {
	ctx := context.Background()
	conn, path := legacyDatabase(t)
	// 迁移会改表，测试连接先让位（openTemp 的 Cleanup 关闭是幂等的）。
	conn.Close()

	result, err := AutoMigrate(ctx, path, false)
	if err != nil {
		t.Fatalf("AutoMigrate: %v", err)
	}
	if !result.Migrated() {
		t.Fatalf("老库应当被迁移，plan = %+v", result.Plan)
	}
	if result.BackupPath == "" {
		t.Fatal("迁移前必须留备份")
	}
	if _, statErr := os.Stat(result.BackupPath); statErr != nil {
		t.Fatalf("备份文件不存在: %v", statErr)
	}
	if got := filepath.Base(result.BackupPath); got[len(got)-5:] != "-auto" {
		t.Fatalf("自动备份应带 -auto 后缀: %s", got)
	}

	reopened, err := Open(path, false)
	if err != nil {
		t.Fatalf("迁移后 Open 仍失败: %v", err)
	}
	defer reopened.Close()

	// 只加结构不动行：老数据必须还在。
	var name string
	if err := reopened.QueryRowContext(ctx, `SELECT "name" FROM "room" WHERE "roomId" = 'r1'`).Scan(&name); err != nil {
		t.Fatalf("读取老数据失败: %v", err)
	}
	if name != "老房间" {
		t.Fatalf("老数据被改动: %q", name)
	}
	// 补上的列对已有行取 DDL 默认值，不应是 NULL。
	var musicEnabled int
	if err := reopened.QueryRowContext(ctx, `SELECT "musicEnabled" FROM "room" WHERE "roomId" = 'r1'`).Scan(&musicEnabled); err != nil {
		t.Fatalf("新列不可读: %v", err)
	}
	if musicEnabled != 1 {
		t.Fatalf("新列默认值不对: %d", musicEnabled)
	}
}

// 结构已是最新时必须一行都不碰，也不能凭空产生备份。
func TestAutoMigrateNoopOnCurrentSchema(t *testing.T) {
	ctx := context.Background()
	conn, path := openTemp(t)
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}
	conn.Close()

	result, err := AutoMigrate(ctx, path, false)
	if err != nil {
		t.Fatalf("AutoMigrate: %v", err)
	}
	if result.Migrated() {
		t.Fatalf("当前结构不该被改动: %+v", result.Plan)
	}
	if result.BackupPath != "" {
		t.Fatalf("没有改动就不该备份: %s", result.BackupPath)
	}
	matches, err := filepath.Glob(path + ".bak-*-auto")
	if err != nil {
		t.Fatalf("Glob: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("不该产生备份文件: %v", matches)
	}

	// 连跑两次仍然无差异（幂等）。
	again, err := AutoMigrate(ctx, path, false)
	if err != nil {
		t.Fatalf("二次 AutoMigrate: %v", err)
	}
	if again.Migrated() {
		t.Fatalf("二次调用仍有差异: %+v", again.Plan)
	}
}

// 库文件存在但没有任何表：报告空库，交给调用方走首次初始化，这里不能先建半套表。
func TestAutoMigrateReportsEmptyDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.sqlite")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatalf("准备空库: %v", err)
	}

	result, err := AutoMigrate(context.Background(), path, false)
	if err != nil {
		t.Fatalf("AutoMigrate: %v", err)
	}
	if !result.EmptyDatabase {
		t.Fatalf("应识别为空库: %+v", result)
	}
	if result.Migrated() {
		t.Fatal("空库不该在这里建表")
	}

	conn, err := OpenForInit(path, false)
	if err != nil {
		t.Fatalf("OpenForInit: %v", err)
	}
	defer conn.Close()
	tables, err := ExistingTables(conn)
	if err != nil {
		t.Fatalf("ExistingTables: %v", err)
	}
	if len(tables) != 0 {
		t.Fatalf("空库被建了表: %d 张", len(tables))
	}
}

// 库文件不存在不是错误路径：返回 ErrNotExist，由启动路径转去首启初始化。
func TestAutoMigrateMissingFile(t *testing.T) {
	_, err := AutoMigrate(context.Background(), filepath.Join(t.TempDir(), "nope.sqlite"), false)
	if !errors.Is(err, ErrNotExist) {
		t.Fatalf("应返回 ErrNotExist，实际: %v", err)
	}
}

// 自动备份只保留最近 keepAutoBackups 份，且不能误删手工备份。
func TestPruneAutoBackupsKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dev.sqlite")
	stamps := []string{
		"20260101-000001",
		"20260102-000001",
		"20260103-000001",
		"20260104-000001",
		"20260105-000001",
	}
	for _, stamp := range stamps {
		if err := os.WriteFile(path+".bak-"+stamp+"-auto", []byte("x"), 0o600); err != nil {
			t.Fatalf("写入备份: %v", err)
		}
	}
	manual := path + ".bak-20260101-000002"
	if err := os.WriteFile(manual, []byte("x"), 0o600); err != nil {
		t.Fatalf("写入手工备份: %v", err)
	}

	pruneAutoBackups(path)

	matches, err := filepath.Glob(path + ".bak-*-auto")
	if err != nil {
		t.Fatalf("Glob: %v", err)
	}
	if len(matches) != keepAutoBackups {
		t.Fatalf("应保留 %d 份，实际 %d 份: %v", keepAutoBackups, len(matches), matches)
	}
	for _, stamp := range stamps[len(stamps)-keepAutoBackups:] {
		if _, statErr := os.Stat(path + ".bak-" + stamp + "-auto"); statErr != nil {
			t.Fatalf("最新的备份被误删: %s", stamp)
		}
	}
	if _, statErr := os.Stat(manual); statErr != nil {
		t.Fatalf("手工备份被误删: %v", statErr)
	}
}
