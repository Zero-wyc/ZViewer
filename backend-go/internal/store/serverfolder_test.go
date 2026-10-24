package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

const testServerFolderDDL = `
CREATE TABLE "server_folder" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" varchar NOT NULL, "absPath" varchar NOT NULL, "readonly" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
`

func newTestServerFolderDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetMaxOpenConns(1)
	for _, stmt := range strings.Split(testServerFolderDDL, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatalf("建表失败: %v（语句: %s）", err, stmt)
		}
	}
	return conn
}

func TestServerFoldersCRUD(t *testing.T) {
	ctx := context.Background()
	repo := NewServerFolders(newTestServerFolderDB(t))

	first, err := repo.Create(ctx, "影片盘", "/data/movies", false)
	if err != nil {
		t.Fatalf("新增失败: %v", err)
	}
	if first.ID <= 0 || first.Name != "影片盘" || first.AbsPath != "/data/movies" || first.Readonly {
		t.Fatalf("新增结果不符合预期: %+v", first)
	}

	// readonly 是 boolean 列：必须原样读回 true，否则只读根会被当成可写
	second, err := repo.Create(ctx, "只读盘", "/data/ro", true)
	if err != nil {
		t.Fatalf("新增只读根失败: %v", err)
	}
	if !second.Readonly {
		t.Fatal("readonly=true 未能读回")
	}

	list, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if len(list) != 2 || list[0].ID != first.ID || list[1].ID != second.ID {
		t.Fatalf("列表顺序应为 id 升序，得到 %+v", list)
	}

	found, err := repo.FindByAbsPath(ctx, "/data/ro")
	if err != nil || found.ID != second.ID {
		t.Fatalf("按路径查找失败: %+v, %v", found, err)
	}
	if _, err := repo.FindByAbsPath(ctx, "/nope"); !errors.Is(err, ErrServerFolderNotFound) {
		t.Fatalf("不存在的路径应返回 ErrServerFolderNotFound，得到 %v", err)
	}

	if err := repo.Delete(ctx, first.ID); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if _, err := repo.FindByID(ctx, first.ID); !errors.Is(err, ErrServerFolderNotFound) {
		t.Fatalf("删除后仍能读到: %v", err)
	}
	if err := repo.Delete(ctx, first.ID); !errors.Is(err, ErrServerFolderNotFound) {
		t.Fatalf("重复删除应返回 ErrServerFolderNotFound，得到 %v", err)
	}
}
