package room

import (
	"context"
	"testing"
)

// TestDeleteRoomAndRelations 覆盖管理端「删除房间」的完整副作用：
// 内存清理 + 级联落库 + room-closed 广播 + 踢人。
func TestDeleteRoomAndRelations(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	roomID := "ROOMDEL1"
	owner := int64(3)
	env.insertRoom(t, roomID, &owner, 10, false)

	// 造齐关联数据。
	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := env.db.Exec(query, args...); err != nil {
			t.Fatalf("造数据失败: %v（%s）", err, query)
		}
	}
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES (?,?,?,?)`, roomID, "sock-a", "viewer", 5)
	mustExec(`INSERT INTO "movie" ("roomId") VALUES (?)`, roomID)
	mustExec(`INSERT INTO "comment" ("roomId","username","content") VALUES (?,?,?)`, roomID, "u", "c")
	mustExec(`INSERT INTO "music_queue_item" ("roomId","songId","name","artist","album","durationMs","order") VALUES (?,?,?,?,?,?,?)`,
		roomID, 1, "歌", "手", "集", 1000, 0)
	mustExec(`INSERT INTO "danmaku_track" ("roomId") VALUES (?)`, roomID)
	mustExec(`INSERT INTO "room_danmaku_meta" ("roomId") VALUES (?)`, roomID)
	mustExec(`INSERT INTO "playback_states" ("roomId","sourceUrl","sourceType","currentTime","lastUpdatedAt") VALUES (?,?,?,?,?)`,
		roomID, "http://x", "bilibili", 0, 1)
	mustExec(`INSERT INTO "music_playback_states" ("roomId","lastUpdatedAt") VALUES (?,?)`, roomID, 1)

	// 运行时状态：放一个影片列表进去，删完必须消失。
	env.svc.SetMovies(roomID, []any{map[string]any{"id": 1}}, []int64{1})
	if !env.svc.HasState(roomID) {
		t.Fatal("前置条件失败：运行时状态未建立")
	}

	// 房间里还有两个连接：都要收到 room-closed 并被踢。
	env.hub.members[roomID] = []string{"sock-a", "sock-b"}

	if err := env.svc.DeleteRoomAndRelations(ctx, roomID); err != nil {
		t.Fatalf("删除房间失败: %v", err)
	}

	// 1. 房间行已删。
	if ok, err := env.svc.Rooms.Exists(ctx, roomID); err != nil || ok {
		t.Fatalf("房间仍存在: ok=%v err=%v", ok, err)
	}
	// 2. 运行时状态已清。
	if env.svc.HasState(roomID) {
		t.Fatal("运行时状态未清理")
	}
	// 3. 先广播 room-closed，再逐个踢出。
	if !env.hub.hasRoomEvent(roomID, "room-closed") {
		t.Fatal("缺少 room-closed 广播")
	}
	if len(env.hub.kicked) != 2 {
		t.Fatalf("应踢出 2 条连接，得到 %v", env.hub.kicked)
	}
	for _, id := range []string{"sock-a", "sock-b"} {
		found := false
		for _, left := range env.hub.left {
			if left == id+"|"+roomID {
				found = true
			}
		}
		if !found {
			t.Fatalf("连接 %s 未退出房间: %v", id, env.hub.left)
		}
	}

	// 4. 关联数据与未结束会话都清空。
	for _, check := range []struct {
		table string
	}{
		{"movie"}, {"comment"}, {"playback_states"}, {"music_playback_states"},
		{"music_queue_item"}, {"danmaku_track"}, {"room_danmaku_meta"},
	} {
		var n int
		if err := env.db.QueryRow(`SELECT COUNT(*) FROM "`+check.table+`" WHERE "roomId" = ?`, roomID).Scan(&n); err != nil {
			t.Fatalf("统计 %s 失败: %v", check.table, err)
		}
		if n != 0 {
			t.Fatalf("%s 仍残留 %d 行", check.table, n)
		}
	}
	var open int
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM "session" WHERE "roomId" = ? AND "endedAt" IS NULL`, roomID).Scan(&open); err != nil {
		t.Fatalf("统计会话失败: %v", err)
	}
	if open != 0 {
		t.Fatalf("仍有 %d 条未结束会话", open)
	}
}

// TestDeleteRoomAndRelationsClearsMusicCache 确认音乐基线缓存也被清掉。
//
// 只删 DB 行不清内存的话，下一次 FlushAllDirty 会把刚删掉的基线写回去，
// 表现为「删了房间，重建同号房间后音乐从上一首接着播」。
func TestDeleteRoomAndRelationsClearsMusicCache(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	roomID := "ROOMDEL2"
	env.insertRoom(t, roomID, int64p(1), 10, false)

	trackKey := "ncm:1"
	songID := int64(1)
	state := MusicSyncState{
		TrackKey:    &trackKey,
		TrackSongID: &songID,
		IsPlaying:   true,
		PositionSec: 10,
		PlayMode:    "sequence",
	}
	if err := env.svc.Music.SetPlayback(ctx, roomID, state, "host-sock", 0); err != nil {
		t.Fatalf("写入音乐基线失败: %v", err)
	}
	if _, err := env.svc.Music.GetRawState(ctx, roomID); err != nil {
		t.Fatalf("前置条件失败：基线未建立: %v", err)
	}

	if err := env.svc.DeleteRoomAndRelations(ctx, roomID); err != nil {
		t.Fatalf("删除房间失败: %v", err)
	}

	// GetRawState 在「无基线」时返回 (nil, nil)——不是报错，所以必须判 nil。
	if st, err := env.svc.Music.GetRawState(ctx, roomID); err != nil || st != nil {
		t.Fatalf("音乐基线内存缓存未清理: state=%+v err=%v", st, err)
	}
	var n int
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM "music_playback_states" WHERE "roomId" = ?`, roomID).Scan(&n); err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if n != 0 {
		t.Fatalf("music_playback_states 仍残留 %d 行", n)
	}
	// 再 flush 一次也不该把已删房间写回库。
	env.svc.Music.FlushAllDirty(ctx)
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM "music_playback_states" WHERE "roomId" = ?`, roomID).Scan(&n); err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if n != 0 {
		t.Fatalf("FlushAllDirty 把已删房间的基线写回来了（%d 行）", n)
	}
}
