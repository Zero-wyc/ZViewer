package db

import (
	"context"
	"database/sql"
	"fmt"
)

// IndexSpec 是一条 Go 侧补建的索引。
type IndexSpec struct {
	Name string
	DDL  string
}

// RequiredIndexes 是 Node/TypeORM 建库时**没有**、但 Go 侧查询模式需要的索引。
//
// 这与「绝不自动改表结构」并不冲突，边界要分清：
//   - 表/列的增删改仍然一律拒绝（`VerifySchema` 缺表缺列直接退出）；
//   - 索引是纯性能结构，`IF NOT EXISTS` 幂等，建与不建都不改变任何一行的
//     可读性与语义，也不会让别的实现读这个库时出错。
//
// 为什么必须补：
//   - `danmaku_track` 的取数全是 `WHERE "roomId" = ? ORDER BY "id"`，没有索引
//     就是全表扫。表有 AUTOINCREMENT 主键，二级索引隐含 rowid，所以单列
//     `(roomId)` 就能同时满足过滤与排序。
//   - `session` 的五个查询全部带 `endedAt IS NULL`，且都以 `roomId` 或
//     `socketId` 起头。用**部分索引**只索引活跃行：索引更小、写放大更低，
//     而且谓词与查询完全一致（SQLite 只有查询条件能推出 `WHERE` 子句时才会
//     用上它）。
var RequiredIndexes = []IndexSpec{
	{
		Name: "idx_danmaku_track_room",
		DDL:  `CREATE INDEX IF NOT EXISTS idx_danmaku_track_room ON "danmaku_track" ("roomId")`,
	},
	{
		Name: "idx_session_active_room",
		DDL:  `CREATE INDEX IF NOT EXISTS idx_session_active_room ON "session" ("roomId") WHERE "endedAt" IS NULL`,
	},
	{
		Name: "idx_session_active_socket",
		DDL:  `CREATE INDEX IF NOT EXISTS idx_session_active_socket ON "session" ("socketId") WHERE "endedAt" IS NULL`,
	},
}

// EnsureIndexes 幂等地补建 RequiredIndexes。
//
// 启动时调用一次；已存在的索引不会重建，也不会因为并发启动互相打架。
func EnsureIndexes(ctx context.Context, conn *sql.DB) error {
	for _, spec := range RequiredIndexes {
		if _, err := conn.ExecContext(ctx, spec.DDL); err != nil {
			return fmt.Errorf("创建索引 %s 失败: %w", spec.Name, err)
		}
	}
	return nil
}
