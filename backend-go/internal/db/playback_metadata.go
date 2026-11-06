package db

import (
	"database/sql"
	"fmt"
)

// EnsurePlaybackMetadata upgrades only an already verified playback table.
// A nullable JSON column preserves optional booleans without rewriting old rows.
//
// 表不存在时直接返回：空库/极老的库由 VerifySchema 统一报错，这里不抢先报
// 一条信息更少的错。
func EnsurePlaybackMetadata(conn *sql.DB) error {
	existing, err := ExistingTables(conn)
	if err != nil {
		return err
	}
	if _, ok := existing["playback_states"]; !ok {
		return nil
	}
	columns, err := Columns(conn, "playback_states")
	if err != nil {
		return err
	}
	if columns["metadata"] {
		return nil
	}
	if _, err := conn.Exec(`ALTER TABLE "playback_states" ADD COLUMN "metadata" text`); err != nil {
		return fmt.Errorf("升级播放元数据列失败: %w", err)
	}
	return nil
}
