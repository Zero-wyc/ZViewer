package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
)

// Backup 用 `VACUUM INTO` 生成一致性快照。
//
// 为什么不直接复制 .sqlite 文件：WAL 模式下已提交但还没 checkpoint 的事务
// 只存在于 `-wal` 旁文件里，单拷主文件会**静默丢失最近的数据**（而且文件
// 本身看起来完全正常，这是最难发现的一种坏备份）。
// VACUUM INTO 在同一个读事务里把整库重写成新文件，天然一致，也不需要停服。
//
// 目标文件必须不存在：SQLite 不会覆盖已有文件，这里提前给出可读的报错。
func Backup(ctx context.Context, conn *sql.DB, dest string) error {
	if _, err := os.Stat(dest); err == nil {
		return fmt.Errorf("备份目标已存在，不做覆盖: %s", dest)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("备份目标不可用: %s: %w", dest, err)
	}

	if _, err := conn.ExecContext(ctx, `VACUUM INTO ?`, dest); err != nil {
		return fmt.Errorf("生成备份失败: %w", err)
	}

	info, err := os.Stat(dest)
	if err != nil {
		return fmt.Errorf("备份写入后无法读取: %w", err)
	}
	if info.Size() == 0 {
		return fmt.Errorf("备份文件为空: %s", dest)
	}
	return nil
}
