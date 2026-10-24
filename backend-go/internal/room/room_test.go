package room

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/store"
)

// 建表语句直接取自 Node 版 TypeORM 生成的 schema（config/dev.sqlite 里
// sqlite_master 的原文），保证测试里的约束（CHECK / DEFAULT / 外键）与
// 生产库一致——用简化表结构测出来的行为不算数。
const testRoomDDL = `
CREATE TABLE "room" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "name" varchar, "password" varchar, "maxViewers" integer NOT NULL DEFAULT (10), "status" varchar CHECK( "status" IN ('active','closed') ) NOT NULL DEFAULT ('active'), "mode" varchar CHECK( "mode" IN ('screen-share','watch-together','listen-together') ) NOT NULL DEFAULT ('screen-share'), "shareMethod" varchar CHECK( "shareMethod" IN ('webrtc','stream-push') ) NOT NULL DEFAULT ('webrtc'), "streamKey" varchar, "requireApproval" boolean NOT NULL DEFAULT (0), "ownerUserId" integer, "mutedViewers" text NOT NULL DEFAULT ('[]'), "approvedViewers" text NOT NULL DEFAULT ('[]'), "moderators" text NOT NULL DEFAULT ('[]'), "voiceMuted" text NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "lastAccessedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_45770efde052e41dee06d89c85c" UNIQUE ("roomId"));
CREATE TABLE "session" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "socketId" varchar NOT NULL, "role" varchar CHECK( "role" IN ('sharer','viewer') ) NOT NULL, "userId" integer, "startedAt" datetime NOT NULL DEFAULT (datetime('now')), "endedAt" datetime, "guestId" varchar, CONSTRAINT "FK_6bfcd8b79900d13de31fc4098f2" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION);
CREATE TABLE "playback_states" ("roomId" varchar(50) PRIMARY KEY NOT NULL, "sourceUrl" text NOT NULL, "sourceType" varchar(50) NOT NULL, "audioUrl" text, "format" varchar(20), "videoCodec" varchar(50), "audioCodec" varchar(50), "cid" bigint, "isPlaying" boolean NOT NULL DEFAULT (0), "currentTime" double NOT NULL, "playbackRate" double NOT NULL DEFAULT (1), "duration" double NOT NULL DEFAULT (0), "currentQn" integer, "acceptQuality" text, "headers" text, "isPreview" boolean NOT NULL DEFAULT (0), "previewTitle" varchar(200), "bufferMode" boolean NOT NULL DEFAULT (0), "currentMovieId" integer, "lastUpdatedAt" bigint NOT NULL, "hostSocketId" varchar(50), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "noProxyFallback" boolean, CONSTRAINT "FK_0b6bb13f02277263045c6aa108e" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION);
CREATE TABLE "music_playback_states" ("roomId" varchar(50) PRIMARY KEY NOT NULL, "trackSongId" integer, "trackKey" text, "isPlaying" boolean NOT NULL DEFAULT (0), "positionSec" double NOT NULL DEFAULT (0), "playMode" varchar(20) NOT NULL DEFAULT ('sequence'), "lastUpdatedAt" bigint NOT NULL, "hostSocketId" varchar(50), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_2e193fbae181ec89918248d21de" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION);
CREATE TABLE "comment" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "username" varchar NOT NULL, "content" varchar NOT NULL, "isDanmaku" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "room_danmaku_meta" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "blockKeywords" text NOT NULL DEFAULT ('[]'), "deletedLog" text NOT NULL DEFAULT ('[]'), "realtimeLog" text NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "music_queue_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "source" text NOT NULL DEFAULT ('ncm'), "songId" integer NOT NULL, "sourceId" text, "name" text NOT NULL, "artist" text NOT NULL, "album" text NOT NULL, "cover" text, "durationMs" integer NOT NULL, "vip" boolean NOT NULL DEFAULT (0), "order" integer NOT NULL, "addedBy" integer NOT NULL DEFAULT (0), "recommended" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "movie" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "url" text NOT NULL DEFAULT (''), "title" varchar NOT NULL DEFAULT (''), "order" integer NOT NULL DEFAULT (0));
CREATE TABLE "danmaku_track" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "trackId" varchar NOT NULL DEFAULT (''), "roomId" varchar NOT NULL, "label" varchar NOT NULL DEFAULT (''), "source" varchar NOT NULL DEFAULT ('file'), "items" text NOT NULL DEFAULT ('[]'), "offset" double NOT NULL DEFAULT (0), "hidden" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
`

// fakeHub 记录所有广播，用于断言「发没发、发给谁」。
type fakeHub struct {
	rooms       []string
	roomsExcept []string
	roomsNoArgs []string
	direct      []string
	global      []string
	left        []string
	joined      []string
	kicked      []string
	online      map[string]bool
	members     map[string][]string
	socketData  map[string]map[string]any
}

func newFakeHub() *fakeHub {
	return &fakeHub{
		online:     make(map[string]bool),
		members:    make(map[string][]string),
		socketData: make(map[string]map[string]any),
	}
}

func (h *fakeHub) EmitRoom(roomID, event string, _ any) { h.rooms = append(h.rooms, roomID+"|"+event) }
func (h *fakeHub) EmitRoomExcept(roomID, exceptSocketID, event string, _ any) {
	h.roomsExcept = append(h.roomsExcept, roomID+"|"+exceptSocketID+"|"+event)
}
func (h *fakeHub) EmitRoomExceptNoArgs(roomID, exceptSocketID, event string) {
	h.roomsExcept = append(h.roomsExcept, roomID+"|"+exceptSocketID+"|"+event)
}
func (h *fakeHub) EmitRoomNoArgs(roomID, event string) {
	h.roomsNoArgs = append(h.roomsNoArgs, roomID+"|"+event)
}
func (h *fakeHub) SetSocketData(id, key string, value any) {
	if _, ok := h.socketData[id]; !ok {
		h.socketData[id] = make(map[string]any)
	}
	h.socketData[id][key] = value
}
func (h *fakeHub) EmitTo(socketID, event string, _ any) {
	h.direct = append(h.direct, socketID+"|"+event)
}
func (h *fakeHub) EmitGlobal(event string, _ any) {
	h.global = append(h.global, event)
}
func (h *fakeHub) SocketIDs(roomID string) []string { return h.members[roomID] }
func (h *fakeHub) SocketRooms(socketID string) []string {
	out := []string{socketID}
	for roomID, ids := range h.members {
		for _, id := range ids {
			if id == socketID {
				out = append(out, roomID)
			}
		}
	}
	return out
}
func (h *fakeHub) MemberCount(roomID string) int { return len(h.members[roomID]) }
func (h *fakeHub) Connected(id string) bool      { return h.online[id] }
func (h *fakeHub) Leave(id, roomID string)       { h.left = append(h.left, id+"|"+roomID) }
func (h *fakeHub) Join(id, roomID string)        { h.joined = append(h.joined, id+"|"+roomID) }
func (h *fakeHub) DeleteSocketData(id, key string) {
	if data, ok := h.socketData[id]; ok {
		delete(data, key)
	}
}
func (h *fakeHub) Disconnect(id string)                { h.kicked = append(h.kicked, id) }
func (h *fakeHub) SocketData(id string) map[string]any { return h.socketData[id] }

func (h *fakeHub) hasRoomEvent(roomID, event string) bool {
	for _, e := range h.rooms {
		if e == roomID+"|"+event {
			return true
		}
	}
	return false
}

func (h *fakeHub) hasDirect(socketID, event string) bool {
	for _, e := range h.direct {
		if e == socketID+"|"+event {
			return true
		}
	}
	return false
}

type testEnv struct {
	svc *Service
	db  *sql.DB
	hub *fakeHub
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	// :memory: 每连接独立，必须锁到单连接
	conn.SetMaxOpenConns(1)
	// modernc 的驱动一次 Exec 只认一条语句，按分号拆开逐条执行。
	for _, stmt := range strings.Split(testRoomDDL, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatalf("建表失败: %v（语句: %s）", err, stmt)
		}
	}

	hub := newFakeHub()
	rooms := store.NewRooms(conn)
	sessions := store.NewSessions(conn)
	// 音乐基线要核对「房主连接是否还在线」，必须拿到同一个假 Hub。
	music := NewMusicMemory(conn)
	music.SetHub(hub)
	svc := NewService(Deps{
		DB:       conn,
		Rooms:    rooms,
		Sessions: sessions,
		Comments: store.NewComments(conn),
		Metas:    store.NewMetas(conn),
		Users:    store.NewUsers(conn),
		Playback: NewPlaybackMemory(conn),
		Hub:      hub,
		Music:    music,
	})
	return &testEnv{svc: svc, db: conn, hub: hub}
}

func (e *testEnv) insertRoom(t *testing.T, roomID string, owner *int64, maxViewers int64, approval bool) {
	t.Helper()
	_, err := e.db.Exec(`INSERT INTO "room" ("roomId","name","status","mode","maxViewers",
		"requireApproval","ownerUserId") VALUES (?,?,'active','watch-together',?,?,?)`,
		roomID, "测试房间", maxViewers, approval, owner)
	if err != nil {
		t.Fatalf("插入房间失败: %v", err)
	}
}

func int64p(v int64) *int64 { return &v }

func TestCanCreateRoom(t *testing.T) {
	adminOnly := &store.SystemSettings{RoomCreationMode: "admin-only"}
	allUsers := &store.SystemSettings{RoomCreationMode: "all-users"}

	cases := []struct {
		role     string
		settings *store.SystemSettings
		want     bool
	}{
		{RoleGuest, allUsers, false},
		{RoleUser, adminOnly, false},
		{RoleUser, allUsers, true},
		{RoleAdmin, adminOnly, true},
		{RoleRoot, adminOnly, true},
		// 读不到设置时按 admin-only 兜底：宁可少放人进来
		{RoleUser, nil, false},
	}
	for _, c := range cases {
		if got := CanCreateRoom(c.role, c.settings); got != c.want {
			t.Errorf("CanCreateRoom(%s, %v) = %v, want %v", c.role, c.settings, got, c.want)
		}
	}
}

func TestRegisterHostOwnership(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	other := int64(2)
	env.insertRoom(t, "ROOMAAAA", &other, 10, false)

	// 非房主：返回 nil（调用方统一回「房间不存在或无权限」）
	res, err := env.svc.RegisterHost(ctx, "sock-1", "ROOMAAAA", 1)
	if err != nil {
		t.Fatalf("意外错误: %v", err)
	}
	if res != nil {
		t.Fatalf("非房主不应注册成功: %+v", res)
	}

	// 房间已关闭
	env.db.Exec(`UPDATE "room" SET "status"='closed' WHERE "roomId"='ROOMAAAA'`)
	res, err = env.svc.RegisterHost(ctx, "sock-1", "ROOMAAAA", 2)
	if err != nil || res != nil {
		t.Fatalf("已关闭房间不应注册成功: res=%+v err=%v", res, err)
	}
}

func TestRegisterHostReusesSession(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMBBBB", int64p(7), 10, false)

	if _, err := env.svc.RegisterHost(ctx, "sock-old", "ROOMBBBB", 7); err != nil {
		t.Fatalf("首次注册失败: %v", err)
	}
	res, err := env.svc.RegisterHost(ctx, "sock-new", "ROOMBBBB", 7)
	if err != nil || res == nil {
		t.Fatalf("重连注册失败: res=%+v err=%v", res, err)
	}

	// 重连必须复用同一条 sharer 会话（改 socketId），不能攒出新行
	var total int
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM "session" WHERE "roomId"='ROOMBBBB' AND "role"='sharer'`).Scan(&total); err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if total != 1 {
		t.Fatalf("sharer 会话数 = %d, want 1（重连应复用）", total)
	}
	var socketID string
	env.db.QueryRow(`SELECT "socketId" FROM "session" WHERE "roomId"='ROOMBBBB'`).Scan(&socketID)
	if socketID != "sock-new" {
		t.Fatalf("socketId = %q, want sock-new", socketID)
	}
	if res.Mode != "watch-together" || res.ShareMethod != "webrtc" {
		t.Fatalf("房间信息不符: %+v", res)
	}
}

func TestAdmitViewerRespectsMaxViewers(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMCCCC", int64p(1), 1, false)
	env.hub.online["v1"] = true
	env.hub.online["v2"] = true

	if _, err := env.svc.AdmitViewer(ctx, "v1", "ROOMCCCC", int64p(5), nil); err != nil {
		t.Fatalf("第一人应可进入: %v", err)
	}
	// maxViewers=1：第二个人必须被挡（用 >= 而不是 >，写错就成 2 人才挡）
	if _, err := env.svc.AdmitViewer(ctx, "v2", "ROOMCCCC", int64p(6), nil); err != ErrRoomFull {
		t.Fatalf("第二人应被拒（房间已满），实际 err=%v", err)
	}
}

func TestAdmitViewerGuestKeepsGuestID(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMDDDD", int64p(1), 10, false)
	env.hub.online["g1"] = true

	guest := "guest-uuid-1"
	sess, err := env.svc.AdmitViewer(ctx, "g1", "ROOMDDDD", int64p(0), &guest)
	if err != nil {
		t.Fatalf("游客进入失败: %v", err)
	}
	if sess.GuestID == nil || *sess.GuestID != guest {
		t.Fatalf("游客会话必须记录 guestId，实际 %+v", sess.GuestID)
	}

	// 登录用户即使传了 guestId 也不能记：否则「同账号多端」判定会走错分支
	env.hub.online["u1"] = true
	sess2, err := env.svc.AdmitViewer(ctx, "u1", "ROOMDDDD", int64p(9), &guest)
	if err != nil {
		t.Fatalf("登录用户进入失败: %v", err)
	}
	if sess2.GuestID != nil {
		t.Fatalf("登录用户不应记 guestId，实际 %q", *sess2.GuestID)
	}
}

func TestAdmitViewerRejectsDisconnectedSocket(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMEEEE", int64p(1), 10, false)
	// online 里没有这个 socket → 视为已断开

	if _, err := env.svc.AdmitViewer(ctx, "gone", "ROOMEEEE", int64p(3), nil); err != ErrViewerGone {
		t.Fatalf("已断开的 socket 应被拒，实际 err=%v", err)
	}
}

func TestEndSessionInvalidatesPermissionCache(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMFFFF", int64p(1), 10, false)
	if _, err := env.svc.RegisterHost(ctx, "s1", "ROOMFFFF", 1); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	host, err := env.svc.IsRoomHost(ctx, "s1", "ROOMFFFF")
	if err != nil || !host {
		t.Fatalf("应为房主: %v %v", host, err)
	}
	// 命中缓存后再结束会话：缓存必须立刻失效，否则 5s 内还能继续当房主
	if _, err := env.svc.EndSession(ctx, "s1"); err != nil {
		t.Fatalf("结束会话失败: %v", err)
	}
	host, err = env.svc.IsRoomHost(ctx, "s1", "ROOMFFFF")
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if host {
		t.Fatal("会话结束后仍被判为房主：权限缓存没有失效")
	}
}

func TestCloseAndNotify(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMGGGG", int64p(1), 10, false)
	if _, err := env.svc.RegisterHost(ctx, "host", "ROOMGGGG", 1); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	env.hub.online["viewer-a"] = true
	env.hub.members["ROOMGGGG"] = []string{"host", "viewer-a"}
	env.svc.SetMovies("ROOMGGGG", []any{map[string]any{"id": 1}}, []int64{1})
	env.svc.SetSubtitle("ROOMGGGG", map[string]any{"trackId": 3})

	if err := env.svc.CloseAndNotify(ctx, "ROOMGGGG", "host"); err != nil {
		t.Fatalf("关闭失败: %v", err)
	}

	var status string
	env.db.QueryRow(`SELECT "status" FROM "room" WHERE "roomId"='ROOMGGGG'`).Scan(&status)
	if status != "closed" {
		t.Fatalf("status = %q, want closed", status)
	}
	var active int
	env.db.QueryRow(`SELECT COUNT(*) FROM "session" WHERE "roomId"='ROOMGGGG' AND "endedAt" IS NULL`).Scan(&active)
	if active != 0 {
		t.Fatalf("仍有 %d 条未结束会话", active)
	}
	if !env.hub.hasRoomEvent("ROOMGGGG", "room-closed") {
		t.Fatal("缺少 room-closed 广播（前端的唯一退房信号）")
	}
	// 房主不被踢，其余人先 leave 再 disconnect
	if len(env.hub.left) != 1 || env.hub.left[0] != "viewer-a|ROOMGGGG" {
		t.Fatalf("leave 记录不符: %v", env.hub.left)
	}
	if len(env.hub.kicked) != 1 || env.hub.kicked[0] != "viewer-a" {
		t.Fatalf("kick 记录不符: %v", env.hub.kicked)
	}
	// 运行时状态必须清干净，否则下次同 ID 房间会带着上一场的字幕
	if got := env.svc.Movies("ROOMGGGG"); len(got) != 0 {
		t.Fatalf("运行时影片未清理: %v", got)
	}
	if got := env.svc.Subtitle("ROOMGGGG"); got != nil {
		t.Fatalf("运行时字幕未清理: %v", got)
	}
}

func TestPlaybackAdvancedClampsAtDuration(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMHHHH", int64p(1), 10, false)

	// 3 秒前开始播、进度 10s、总时长 12s、1x → 推算 13s，必须钉在 12s 并停止
	_, err := env.db.Exec(`INSERT INTO "playback_states"
		("roomId","sourceUrl","sourceType","isPlaying","currentTime","playbackRate","duration","lastUpdatedAt","hostSocketId")
		VALUES ('ROOMHHHH','https://x/a.m3u8','url',1,10,1,12,?, 'host')`,
		time.Now().Add(-3*time.Second).UnixMilli())
	if err != nil {
		t.Fatalf("插入播放状态失败: %v", err)
	}

	p, err := env.svc.Playback.Advanced(ctx, "ROOMHHHH")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if p.CurrentTime != 12 || p.IsPlaying {
		t.Fatalf("应钉在时长并停止：currentTime=%v isPlaying=%v", p.CurrentTime, p.IsPlaying)
	}
}

func TestPlaybackAdvancedKeepsPlaying(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMIIII", int64p(1), 10, false)

	_, err := env.db.Exec(`INSERT INTO "playback_states"
		("roomId","sourceUrl","sourceType","isPlaying","currentTime","playbackRate","duration","lastUpdatedAt","hostSocketId")
		VALUES ('ROOMIIII','https://x/a.m3u8','url',1,100,2,1000,?, 'host')`,
		time.Now().Add(-2*time.Second).UnixMilli())
	if err != nil {
		t.Fatalf("插入播放状态失败: %v", err)
	}

	p, err := env.svc.Playback.Advanced(ctx, "ROOMIIII")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	// 2 秒 × 2 倍速 = 前进约 4s（允许调度误差）
	if p.CurrentTime < 103 || p.CurrentTime > 106 {
		t.Fatalf("推算进度异常: %v", p.CurrentTime)
	}
	if !p.IsPlaying {
		t.Fatal("未到时长不应停止")
	}
}

func TestPlaybackUpdateHostSocketNoRow(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMJJJJ", int64p(1), 10, false)

	// 没有播放状态时 update 不应插入空行：插出来的 sourceUrl 是空串，
	// 观众加入时就会拿到一个「有播放状态但没有源」的畸形快照。
	host := "sock-1"
	if err := env.svc.Playback.UpdateHostSocket(ctx, "ROOMJJJJ", &host); err != nil {
		t.Fatalf("更新失败: %v", err)
	}
	var n int
	env.db.QueryRow(`SELECT COUNT(*) FROM "playback_states" WHERE "roomId"='ROOMJJJJ'`).Scan(&n)
	if n != 0 {
		t.Fatalf("不应凭空创建播放状态行，实际 %d 行", n)
	}
}

func TestBroadcastMovieListClearsStaleCurrentMovie(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMKKKK", int64p(1), 10, false)
	env.svc.SetCurrentMovie("ROOMKKKK", int64(9))
	env.svc.SetMovieLister(func(context.Context, string) (*MovieList, error) {
		return &MovieList{DTOs: []any{map[string]any{"id": 1}}, IDs: []int64{1}}, nil
	})

	if err := env.svc.BroadcastMovieList(ctx, "ROOMKKKK"); err != nil {
		t.Fatalf("广播失败: %v", err)
	}
	// 当前播放的影片已被删：必须清空并广播 current-movie，否则播放器不会停
	if got := env.svc.CurrentMovieID("ROOMKKKK"); got != nil {
		t.Fatalf("currentMovieId 应被清空，实际 %v", got)
	}
	if !env.hub.hasRoomEvent("ROOMKKKK", "current-movie") {
		t.Fatal("缺少 current-movie 广播")
	}
	if !env.hub.hasRoomEvent("ROOMKKKK", "movie-list") {
		t.Fatal("缺少 movie-list 广播")
	}
}

func TestRecentSharerGrace(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOMLLLL", int64p(1), 10, false)
	if _, err := env.svc.RegisterHost(ctx, "s1", "ROOMLLLL", 1); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	if _, err := env.svc.EndSession(ctx, "s1"); err != nil {
		t.Fatalf("结束会话失败: %v", err)
	}

	// 刚断开：宽限期内仍算在场（观众还能进来看）
	sess, err := env.svc.RecentSharer(ctx, "ROOMLLLL", 5*time.Minute)
	if err != nil || sess == nil {
		t.Fatalf("宽限期内应视为在场: %v %v", sess, err)
	}
	// 宽限期设成 0：同一个已结束会话立刻过期
	sess, err = env.svc.RecentSharer(ctx, "ROOMLLLL", 0)
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if sess != nil {
		t.Fatal("超出宽限期不应视为在场")
	}
}

func TestRandomRoomIDShape(t *testing.T) {
	seen := make(map[string]struct{}, 500)
	for i := 0; i < 500; i++ {
		id, err := randomRoomID()
		if err != nil {
			t.Fatalf("生成失败: %v", err)
		}
		if len(id) != 8 {
			t.Fatalf("长度 = %d, want 8: %q", len(id), id)
		}
		for _, c := range id {
			if !containsByte(roomIDAlphabet, byte(c)) {
				t.Fatalf("非法字符 %q in %q", c, id)
			}
		}
		seen[id] = struct{}{}
	}
	// 500 次几乎不可能重复；出现大量重复说明随机源退化了
	if len(seen) < 495 {
		t.Fatalf("重复过多：500 次只生成 %d 个不同 ID", len(seen))
	}
}

func containsByte(s string, b byte) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return true
		}
	}
	return false
}
