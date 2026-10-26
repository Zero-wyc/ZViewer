package db

import (
	"database/sql"
	"fmt"
)

// EnsurePlaybackMetadata upgrades only an already verified playback table.
// A nullable JSON column preserves optional booleans without rewriting old rows.
func EnsurePlaybackMetadata(conn *sql.DB) error {
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
