package db

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// UpgradePlan 描述一次结构升级需要补什么。
type UpgradePlan struct {
	// MissingTables 是整个表都不存在（4.5.5 之前的库没有 music_playback_states）。
	MissingTables []string
	// MissingColumns 是表存在但列不全（4.6/4.7 的 session.guestId 等）。
	MissingColumns map[string][]string
}

// Empty 表示结构已经是当前版本。
func (p *UpgradePlan) Empty() bool {
	return len(p.MissingTables) == 0 && len(p.MissingColumns) == 0
}

// ColumnCount 统计要补的列总数。
func (p *UpgradePlan) ColumnCount() int {
	n := 0
	for _, cols := range p.MissingColumns {
		n += len(cols)
	}
	return n
}

// Describe 返回人读的逐条清单，供命令行打印。
func (p *UpgradePlan) Describe() []string {
	out := make([]string, 0, len(p.MissingTables)+len(p.MissingColumns))
	for _, table := range p.MissingTables {
		out = append(out, "补建表 "+table)
	}
	tables := make([]string, 0, len(p.MissingColumns))
	for table := range p.MissingColumns {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	for _, table := range tables {
		out = append(out, fmt.Sprintf("补列 %s: %s", table, strings.Join(p.MissingColumns[table], ", ")))
	}
	return out
}

// PlanUpgrade 只计算差异，不改库。`--upgrade-db` 用它打印「将要做什么」。
func PlanUpgrade(conn *sql.DB) (*UpgradePlan, error) {
	spec, err := Schema()
	if err != nil {
		return nil, fmt.Errorf("解析 schema.sql 失败: %w", err)
	}
	existing, err := ExistingTables(conn)
	if err != nil {
		return nil, err
	}

	plan := &UpgradePlan{MissingColumns: make(map[string][]string)}
	for _, table := range spec {
		if _, ok := existing[table.Name]; !ok {
			plan.MissingTables = append(plan.MissingTables, table.Name)
			continue
		}
		actual, err := Columns(conn, table.Name)
		if err != nil {
			return nil, err
		}
		for _, col := range table.Columns {
			if !actual[col.Name] {
				plan.MissingColumns[table.Name] = append(plan.MissingColumns[table.Name], col.Name)
			}
		}
	}
	sort.Strings(plan.MissingTables)
	return plan, nil
}

// UpgradeSchema 把已有库的结构补到 schema.sql 的样子。
//
// 这是**显式**动作（`--upgrade-db`），不是启动路径的一部分：「绝不自动改表」
// 的原则不变，只是把「用户手动改」变成「用户手动触发一条命令」。
//
// 安全性按这个顺序保证：
//  1. 先算差异，没有差异就直接返回，不碰库；
//  2. 再一次性算出所有补列语句——有补不了的列就整批拒绝，此时库还没被碰过；
//  3. 才做 VACUUM INTO 一致性备份（WAL 下直接拷 .sqlite 会静默丢掉只存在于
//     -wal 里的已提交事务），备份失败即中止；
//  4. 所有 DDL 在一个事务里执行，中途出错整批回滚，不会留下半升级状态；
//  5. 结束后立刻 VerifySchema 自检。
//
// backupPath 为空表示不备份——只给测试用，命令行必须传。
func UpgradeSchema(ctx context.Context, conn *sql.DB, backupPath string) (*UpgradePlan, error) {
	plan, err := PlanUpgrade(conn)
	if err != nil {
		return nil, err
	}
	if plan.Empty() {
		return plan, nil
	}

	spec, err := Schema()
	if err != nil {
		return nil, fmt.Errorf("解析 schema.sql 失败: %w", err)
	}

	// 补列能否机械生成，先一次性算清楚：不要备份了、改了一半才发现某列补不了。
	alters := make([]string, 0, plan.ColumnCount())
	for _, table := range spec {
		for _, name := range plan.MissingColumns[table.Name] {
			col, ok := table.Column(name)
			if !ok {
				continue
			}
			ddl, ok := col.AlterDDL(table.Name)
			if !ok {
				return nil, fmt.Errorf(
					"列 %s.%s 无法用 ALTER TABLE 补上（NOT NULL 但没有常量默认值，或带主键/唯一约束）；"+
						"请先升级到 4.8.0 再升 5.x", table.Name, name)
			}
			alters = append(alters, ddl)
		}
	}

	if backupPath != "" {
		if err := Backup(ctx, conn, backupPath); err != nil {
			return nil, fmt.Errorf("升级前备份失败，已中止（数据库未改动）: %w", err)
		}
	}

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("开启事务失败: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // 已提交时再回滚只会返回 ErrTxDone

	// 先补表。schema.sql 按外键依赖排序，整份跑一遍顺序天然正确；
	// 全是 CREATE TABLE IF NOT EXISTS，已存在的表一行都不会动。
	for _, table := range spec {
		if _, err := tx.ExecContext(ctx, table.CreateSQL); err != nil {
			return nil, fmt.Errorf("补建表 %s 失败: %w", table.Name, err)
		}
	}
	// 再补列。ADD COLUMN 只会加在末尾，不改变已有列的位置与数据。
	for _, ddl := range alters {
		if _, err := tx.ExecContext(ctx, ddl); err != nil {
			return nil, fmt.Errorf("补列失败: %w\n语句: %s", err, ddl)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("提交结构升级失败: %w", err)
	}

	if err := VerifySchema(conn); err != nil {
		return nil, fmt.Errorf("升级后自检失败: %w", err)
	}
	return plan, nil
}
