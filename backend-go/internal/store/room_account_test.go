package store

import (
	"context"
	"testing"
)

const roomAccountTestDDL = `CREATE TABLE "room_account" (
  "provider" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "updatedAt" TEXT NOT NULL,
  PRIMARY KEY ("provider", "roomId")
);`

// TestRoomAccountsRoundTrip 覆盖绑定、覆盖、读取与解绑。
func TestRoomAccountsRoundTrip(t *testing.T) {
	ctx := context.Background()
	conn := newAdminTestDB(t)
	if _, err := conn.Exec(roomAccountTestDDL); err != nil {
		t.Fatalf("建 room_account 表失败: %v", err)
	}
	repo := NewRoomAccounts(conn)

	userID, ok, err := repo.GetRoomAccount(ctx, "ncm", "room-1")
	if err != nil || ok || userID != 0 {
		t.Fatalf("未绑定时应返回 (0,false,nil)，实际 (%d,%v,%v)", userID, ok, err)
	}
	if err := repo.SetRoomAccount(ctx, "ncm", "room-1", 7); err != nil {
		t.Fatalf("SetRoomAccount: %v", err)
	}
	userID, ok, err = repo.GetRoomAccount(ctx, "ncm", "room-1")
	if err != nil || !ok || userID != 7 {
		t.Fatalf("读取绑定失败: (%d,%v,%v)", userID, ok, err)
	}

	// 后登录者覆盖前一个绑定。
	if err := repo.SetRoomAccount(ctx, "ncm", "room-1", 9); err != nil {
		t.Fatalf("覆盖绑定: %v", err)
	}
	userID, _, _ = repo.GetRoomAccount(ctx, "ncm", "room-1")
	if userID != 9 {
		t.Fatalf("覆盖后 userId = %d，期望 9", userID)
	}

	// 不同平台互不影响。
	if err := repo.SetRoomAccount(ctx, "bilibili", "room-1", 11); err != nil {
		t.Fatalf("SetRoomAccount bilibili: %v", err)
	}
	if userID, _, _ := repo.GetRoomAccount(ctx, "bilibili", "room-1"); userID != 11 {
		t.Fatalf("bilibili userId = %d，期望 11", userID)
	}

	if err := repo.ClearRoomAccount(ctx, "ncm", "room-1"); err != nil {
		t.Fatalf("ClearRoomAccount: %v", err)
	}
	if _, ok, _ := repo.GetRoomAccount(ctx, "ncm", "room-1"); ok {
		t.Fatal("解绑后不应再命中")
	}
	// 重复解绑也是成功。
	if err := repo.ClearRoomAccount(ctx, "ncm", "room-1"); err != nil {
		t.Fatalf("重复解绑: %v", err)
	}
}
