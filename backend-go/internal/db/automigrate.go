package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// 启动期自动升级：版本更新后 `schema.sql` 多了表或列，旧库会在 `Open` 的强校验里
// 被直接拒绝启动。`AutoMigrate` 把「拒绝启动 + 让用户敲命令」换成「先备份、再在
// 一个事务里补齐」，多条路径共用同一套 `UpgradeSchema`，安全顺序完全一致：
// 算差异 → 校验补列可行 → VACUUM INTO 备份 → 事务内 DDL → VerifySchema 自检。
//
// 三条边界（都返回可判定的信号，不靠字符串匹配）：
//   - 库文件不存在 → `ErrNotExist`，交给调用方走首次初始化（这里不建库）；
//   - 库存在但一张表都没有 → `EmptyDatabase`，同样交给首次初始化：空库除了建表
//     还要建初始管理员，那属于 `--init-db` 的职责，不在迁移里做；
//   - 结构已是最新版 → `Plan.Empty()`，一行都不碰，也不产生备份。
//
// 备份命名与手工备份同口径（`<库文件>.bak-<时间戳>`），后缀加 `-auto` 以区分来源；
// 每次成功后只保留最近 keepAutoBackups 份自动备份，避免反复失败时把磁盘堆满。

// keepAutoBackups 是自动备份的保留份数（含刚生成的那一份）。
const keepAutoBackups = 3

// AutoMigrateResult 是一次自动迁移的结果。
type AutoMigrateResult struct {
	// Plan 是本次补的表/列；结构已最新时非 nil 但 Empty() 为真。
	Plan *UpgradePlan
	// BackupPath 是改动前的一致性备份；没有改动时为空。
	BackupPath string
	// EmptyDatabase 表示库文件存在但没有任何表，调用方应改走首次初始化。
	EmptyDatabase bool
}

// Migrated 报告本次是否真的改了库。
func (r *AutoMigrateResult) Migrated() bool {
	return r != nil && r.Plan != nil && !r.Plan.Empty()
}

// AutoMigrate 在启动路径上把旧结构补到当前 schema。
//
// 与 `--upgrade-db` 的唯一区别是「谁来触发」：这里由进程启动自动触发，
// 判定条件仍然是 `PlanUpgrade` 算出的真实差异，不是版本号比对——结构没变就
// 什么都不做，所以每次启动多花的只是几次 PRAGMA 查询。
func AutoMigrate(ctx context.Context, path string, wal bool) (*AutoMigrateResult, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", ErrNotExist, path)
		}
		return nil, fmt.Errorf("数据库不可访问: %s: %w", path, err)
	}

	// 迁移期允许别的进程短暂持锁：OpenForInit 的 DSN 已带 busy_timeout。
	conn, err := OpenForInit(path, wal)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	existing, err := ExistingTables(conn)
	if err != nil {
		return nil, err
	}
	if len(existing) == 0 {
		return &AutoMigrateResult{EmptyDatabase: true}, nil
	}

	// 顺序与 db.Open 保持一致：先补历史上唯一的自动列，再算全量差异。
	// 反过来的话，4.8.0 的库会把 playback_states.metadata 当成「又一处新列」。
	if err := EnsurePlaybackMetadata(conn); err != nil {
		return nil, err
	}

	plan, err := PlanUpgrade(conn)
	if err != nil {
		return nil, err
	}
	if plan.Empty() {
		return &AutoMigrateResult{Plan: plan}, nil
	}

	backup := autoBackupPath(path)
	if _, err := UpgradeSchema(ctx, conn, backup); err != nil {
		// 并发兜底：桌面壳与 dev server 可能同时拉起后端，两个进程都会算到同一份
		// 差异，后到的那个会在 ADD COLUMN 上撞 duplicate column name。以「重算一遍
		// 差异」为准——差异为空就说明别人刚做完了，本次按成功处理。
		if again, planErr := PlanUpgrade(conn); planErr == nil && again.Empty() {
			pruneAutoBackups(path)
			return &AutoMigrateResult{Plan: plan, BackupPath: backup}, nil
		}
		return nil, err
	}

	pruneAutoBackups(path)
	return &AutoMigrateResult{Plan: plan, BackupPath: backup}, nil
}

// autoBackupPath 生成自动备份路径：与手工备份同名规则 + `-auto` 后缀。
func autoBackupPath(path string) string {
	return path + ".bak-" + time.Now().Format("20060102-150405") + "-auto"
}

// pruneAutoBackups 只保留最近 keepAutoBackups 份自动备份。
//
// 时间戳在同一次运行里可能撞秒（同名会覆盖，不会堆积），所以按文件名排序即可，
// 不需要读文件时间：`20060102-150405` 的字典序就是时间序。
// 迁移失败时这份备份是为回滚准备的，因此只在成功之后才清理。
func pruneAutoBackups(path string) {
	pattern := filepath.Join(filepath.Dir(path), filepath.Base(path)+".bak-*-auto")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) <= keepAutoBackups {
		return
	}
	sort.Sort(sort.Reverse(sort.StringSlice(matches)))
	for _, old := range matches[keepAutoBackups:] {
		// 清理失败不影响启动：备份多留几份只是占空间，不该让进程起不来。
		if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
			continue
		}
	}
}
