package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// seedRoom 直接插库：管理端房间列表只关心库里的行，不经过创建流程。
func (e *testEnv) seedRoom(t *testing.T, roomID, status string, ownerID *int64) {
	t.Helper()
	if _, err := e.conn.Exec(
		`INSERT INTO "room" ("roomId","name","status","ownerUserId","password")
		 VALUES (?,?,?,?,?)`,
		roomID, "房间"+roomID, status, ownerID, nil,
	); err != nil {
		t.Fatalf("插入房间失败: %v", err)
	}
}

func (e *testEnv) seedSession(t *testing.T, roomID, socketID, role string) {
	t.Helper()
	if _, err := e.conn.Exec(
		`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES (?,?,?,?)`,
		roomID, socketID, role, 1,
	); err != nil {
		t.Fatalf("插入会话失败: %v", err)
	}
}

func (e *testEnv) countRoomRows(t *testing.T, roomID string) int {
	t.Helper()
	var n int
	if err := e.conn.QueryRow(`SELECT COUNT(*) FROM "room" WHERE "roomId" = ?`, roomID).Scan(&n); err != nil {
		t.Fatalf("统计房间失败: %v", err)
	}
	return n
}

// TestAdminAuthBoundaries 三套 403 文案必须各自对上，不能互相顶替。
func TestAdminAuthBoundaries(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	adminID := env.seedUser(t, "bob", "pass1234", "admin", "active")
	userToken := env.token(t, userID, "user", "alice")
	adminToken := env.token(t, adminID, "admin", "bob")

	// 未登录 → 401。
	if resp := env.do(t, http.MethodGet, "/api/admin/users", "", nil); resp.status != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，得到 %d", resp.status)
	}

	// 普通用户 → 403「仅管理员可操作」。
	resp := env.do(t, http.MethodGet, "/api/admin/users", userToken, nil)
	if resp.status != http.StatusForbidden || resp.message() != "无权限：仅管理员可操作" {
		t.Fatalf("普通用户应 403/仅管理员可操作，得到 %d/%q", resp.status, resp.message())
	}

	// admin 访问 root-only 端点 → 403「仅 root 可操作」（不是"仅管理员"）。
	resp = env.do(t, http.MethodPost, "/api/admin/rooms/delete-all", adminToken, nil)
	if resp.status != http.StatusForbidden || resp.message() != "无权限：仅 root 可操作" {
		t.Fatalf("admin 打 root 端点应 403/仅 root 可操作，得到 %d/%q", resp.status, resp.message())
	}

	// admin 访问 admin 档端点 → 放行。
	if resp := env.do(t, http.MethodGet, "/api/admin/users", adminToken, nil); resp.status != http.StatusOK {
		t.Fatalf("admin 应可读用户列表，得到 %d/%s", resp.status, resp.raw)
	}
}

func TestAdminUserManagement(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root", "pass1234", "root", "active")
	targetID := env.seedUser(t, "carol", "pass1234", "guest", "pending")
	rootToken := env.token(t, rootID, "root", "root")

	// 列表：字段集合固定，且绝不能带 passwordHash。
	resp := env.do(t, http.MethodGet, "/api/admin/users", rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("列表应 200，得到 %d/%s", resp.status, resp.raw)
	}
	users, _ := resp.body["users"].([]any)
	if len(users) != 2 {
		t.Fatalf("应有 2 个用户，得到 %d", len(users))
	}
	first, _ := users[0].(map[string]any)
	for _, key := range []string{"id", "username", "role", "status", "avatar", "createdAt", "updatedAt"} {
		if _, ok := first[key]; !ok {
			t.Fatalf("用户 DTO 缺少键 %s（%v）", key, first)
		}
	}
	for _, forbidden := range []string{"passwordHash", "tokenInvalidBefore"} {
		if _, ok := first[forbidden]; ok {
			t.Fatalf("用户 DTO 不应包含 %s", forbidden)
		}
	}

	// 审核通过：guest → user，status → active。
	resp = env.do(t, http.MethodPost, "/api/admin/users/"+itoa(targetID)+"/approve", rootToken, nil)
	if resp.status != http.StatusOK || resp.userField("role") != "user" || resp.userField("status") != "active" {
		t.Fatalf("审核结果不对: %d %v", resp.status, resp.body)
	}

	// 改角色：非法值 → 400。
	resp = env.do(t, http.MethodPatch, "/api/admin/users/"+itoa(targetID)+"/role", rootToken, map[string]any{"role": "root"})
	if resp.status != http.StatusBadRequest || resp.message() != "角色必须是 admin / user" {
		t.Fatalf("非法角色应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 改角色：合法值 → 200。
	resp = env.do(t, http.MethodPatch, "/api/admin/users/"+itoa(targetID)+"/role", rootToken, map[string]any{"role": "admin"})
	if resp.status != http.StatusOK || resp.userField("role") != "admin" {
		t.Fatalf("改角色失败: %d %v", resp.status, resp.body)
	}

	// root 账户不可改角色 / 不可删。
	if resp := env.do(t, http.MethodPatch, "/api/admin/users/"+itoa(rootID)+"/role", rootToken, map[string]any{"role": "admin"}); resp.status != http.StatusBadRequest || resp.message() != "不能修改 root 账户" {
		t.Fatalf("改 root 角色应 400，得到 %d/%q", resp.status, resp.message())
	}
	if resp := env.do(t, http.MethodDelete, "/api/admin/users/"+itoa(rootID), rootToken, nil); resp.status != http.StatusBadRequest || resp.message() != "不能删除 root 账户" {
		t.Fatalf("删 root 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 不存在的用户 → 404；非数字 ID → 400（两者不能混为一谈）。
	if resp := env.do(t, http.MethodDelete, "/api/admin/users/99999", rootToken, nil); resp.status != http.StatusNotFound || resp.message() != "用户不存在" {
		t.Fatalf("不存在用户应 404，得到 %d/%q", resp.status, resp.message())
	}
	if resp := env.do(t, http.MethodDelete, "/api/admin/users/abc", rootToken, nil); resp.status != http.StatusBadRequest || resp.message() != "用户 ID 不正确" {
		t.Fatalf("非数字 ID 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 删除普通用户 → 200，且行已消失。
	if resp := env.do(t, http.MethodDelete, "/api/admin/users/"+itoa(targetID), rootToken, nil); resp.status != http.StatusOK {
		t.Fatalf("删用户应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if _, err := env.users.FindByID(t.Context(), targetID); err == nil {
		t.Fatal("用户仍存在")
	}
}

func TestAdminRoomManagement(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root", "pass1234", "root", "active")
	adminID := env.seedUser(t, "dave", "pass1234", "admin", "active")
	rootToken := env.token(t, rootID, "root", "root")
	adminToken := env.token(t, adminID, "admin", "dave")

	owned := "11111111"
	foreign := "22222222"
	closed := "33333333"
	env.seedRoom(t, owned, "active", &adminID)
	env.seedRoom(t, foreign, "active", nil)
	env.seedRoom(t, closed, "closed", nil)
	env.seedSession(t, owned, "sock-v", "viewer")
	env.seedSession(t, owned, "sock-s", "sharer")

	// 列表：含已关闭房间，人数与 sharer 在线状态正确。
	resp := env.do(t, http.MethodGet, "/api/admin/rooms", adminToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("列表应 200，得到 %d/%s", resp.status, resp.raw)
	}
	rooms, _ := resp.body["rooms"].([]any)
	if len(rooms) != 3 {
		t.Fatalf("应列出 3 个房间（含 closed），得到 %d", len(rooms))
	}
	byID := map[string]map[string]any{}
	for _, item := range rooms {
		row, _ := item.(map[string]any)
		byID[row["roomId"].(string)] = row
	}
	ownedRow := byID[owned]
	if ownedRow == nil {
		t.Fatal("缺 owned 房间")
	}
	if ownedRow["viewerCount"].(float64) != 1 || ownedRow["sharerOnline"] != true {
		t.Fatalf("在线统计不对: %v", ownedRow)
	}
	if ownedRow["hasPassword"] != false {
		t.Fatalf("hasPassword 应为 false: %v", ownedRow)
	}
	for _, key := range []string{"id", "roomId", "name", "status", "requireApproval", "maxViewers", "hasPassword", "viewerCount", "sharerOnline", "ownerUserId", "lastAccessedAt", "createdAt", "updatedAt"} {
		if _, ok := ownedRow[key]; !ok {
			t.Fatalf("房间 DTO 缺少键 %s", key)
		}
	}

	// admin 不能删别人创建的房间。
	resp = env.do(t, http.MethodDelete, "/api/admin/rooms/"+foreign, adminToken, nil)
	if resp.status != http.StatusForbidden || resp.message() != "无权限：仅 root 或房间创建者可关闭该房间" {
		t.Fatalf("非房主 admin 删除应 403，得到 %d/%q", resp.status, resp.message())
	}
	// root 可以删任意房间。
	if resp := env.do(t, http.MethodDelete, "/api/admin/rooms/"+foreign, rootToken, nil); resp.status != http.StatusOK {
		t.Fatalf("root 删除应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if env.countRoomRows(t, foreign) != 0 {
		t.Fatal("房间未删除")
	}

	// admin 可以删自己创建的房间，并级联清掉会话。
	if resp := env.do(t, http.MethodDelete, "/api/admin/rooms/"+owned, adminToken, nil); resp.status != http.StatusOK {
		t.Fatalf("房主 admin 删除应 200，得到 %d/%s", resp.status, resp.raw)
	}
	var openSessions int
	if err := env.conn.QueryRow(
		`SELECT COUNT(*) FROM "session" WHERE "roomId" = ? AND "endedAt" IS NULL`, owned).Scan(&openSessions); err != nil {
		t.Fatalf("统计会话失败: %v", err)
	}
	if openSessions != 0 {
		t.Fatalf("房间删除后仍有 %d 条未结束会话", openSessions)
	}

	// 重开：active 房间 → 400；closed 房间 → 200 且状态回 active。
	if resp := env.do(t, http.MethodPost, "/api/admin/rooms/"+closed+"/cleanup-noop", rootToken, nil); resp.status != http.StatusNotFound {
		// 顺带确认未知子路径不会被 /reopen 吃掉。
		t.Fatalf("未知子路径应 404，得到 %d", resp.status)
	}
	if resp := env.do(t, http.MethodPost, "/api/admin/rooms/"+closed+"/reopen", rootToken, nil); resp.status != http.StatusOK {
		t.Fatalf("重开应 200，得到 %d/%s", resp.status, resp.raw)
	}

	// 批量删除：空数组 → 400。
	resp = env.do(t, http.MethodPost, "/api/admin/rooms/batch-delete", rootToken, map[string]any{"roomIds": []string{}})
	if resp.status != http.StatusBadRequest || resp.message() != "roomIds 必须是非空数组" {
		t.Fatalf("空数组应 400，得到 %d/%q", resp.status, resp.message())
	}
	// 非数组同样落到这条 400（不是「请求参数格式不正确」）。
	resp = env.do(t, http.MethodPost, "/api/admin/rooms/batch-delete", rootToken, map[string]any{"roomIds": "abc"})
	if resp.status != http.StatusBadRequest || resp.message() != "roomIds 必须是非空数组" {
		t.Fatalf("非数组应 400/roomIds 必须是非空数组，得到 %d/%q", resp.status, resp.message())
	}

	// 批量删除：两个房间里只有一个存在，count 只算成功的。
	// 批量删除：**不存在的房间号也计入 count**。
	// Node 的 deleteRoomAndRelations 不校验存在性（DELETE 0 行不报错），
	// 所以这里 count=2 才是与 Node 一致的行为，不是 bug——别"修正"成 1。
	env.seedRoom(t, "44444444", "active", nil)
	resp = env.do(t, http.MethodPost, "/api/admin/rooms/batch-delete", rootToken,
		map[string]any{"roomIds": []string{"44444444", "99999999"}})
	if resp.status != http.StatusOK || resp.body["count"].(float64) != 2 {
		t.Fatalf("批量删除 count 应为 2（含不存在的房间号），得到 %v", resp.body)
	}

	// 清理无人房间：closed 的即使无会话也清；有活跃会话的保留。
	env.seedRoom(t, "55555555", "active", nil) // 无人
	env.seedRoom(t, "66666666", "active", nil) // 有人
	env.seedSession(t, "66666666", "sock-x", "viewer")
	resp = env.do(t, http.MethodPost, "/api/admin/rooms/cleanup-unused", rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("清理应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if env.countRoomRows(t, "55555555") != 0 {
		t.Fatal("无人房间未被清理")
	}
	if env.countRoomRows(t, "66666666") != 1 {
		t.Fatal("有人的房间被误清理")
	}

	// 删全部：清空后 count 等于剩余房间数。
	resp = env.do(t, http.MethodPost, "/api/admin/rooms/delete-all", rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("全删应 200，得到 %d/%s", resp.status, resp.raw)
	}
	var remaining int
	if err := env.conn.QueryRow(`SELECT COUNT(*) FROM "room"`).Scan(&remaining); err != nil {
		t.Fatalf("统计房间失败: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("仍有 %d 个房间", remaining)
	}
	if int(resp.body["count"].(float64)) == 0 {
		t.Fatal("全删 count 不应为 0")
	}
}

func TestAdminSettings(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root", "pass1234", "root", "active")
	rootToken := env.token(t, rootID, "root", "root")

	// GET：默认值 + desktopManaged 键（运行时标识，不落库）。
	resp := env.do(t, http.MethodGet, "/api/admin/settings", rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("GET 应 200，得到 %d/%s", resp.status, resp.raw)
	}
	settings, _ := resp.body["settings"].(map[string]any)
	if settings["registrationMode"] != "approval" || settings["cdnProxyUrl"] != "https://gh-proxy.com" {
		t.Fatalf("默认值不对: %v", settings)
	}
	if _, ok := settings["desktopManaged"]; !ok {
		t.Fatal("缺少 desktopManaged")
	}
	// CLI 房主解析分发默认开启：新部署无需先去设置页开一次。
	if settings["allowCliHostResolve"] != true {
		t.Fatalf("allowCliHostResolve 默认应为 true，得到 %v", settings["allowCliHostResolve"])
	}
	// dataSourceConfig / roomPermissionMatrix 未配置时必须是显式 null。
	if v, ok := settings["dataSourceConfig"]; !ok || v != nil {
		t.Fatalf("dataSourceConfig 应为 null，得到 %v（键存在=%v）", v, ok)
	}
	if v, ok := settings["roomPermissionMatrix"]; !ok || v != nil {
		t.Fatalf("roomPermissionMatrix 应为 null，得到 %v（键存在=%v）", v, ok)
	}

	// 必填缺失 → 400。
	if resp := env.do(t, http.MethodPut, "/api/admin/settings", rootToken, map[string]any{"autoDeleteAfterHours": 12}); resp.status != http.StatusBadRequest || resp.message() != "autoDeleteInactiveRooms 必须是布尔值" {
		t.Fatalf("缺 autoDeleteInactiveRooms 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 音量越界 / 非整数 → 400（先于必填校验）。
	for _, value := range []any{101, -1, 50.5, "50"} {
		body := map[string]any{"roomDefaultMusicVolume": value}
		resp := env.do(t, http.MethodPut, "/api/admin/settings", rootToken, body)
		if resp.status != http.StatusBadRequest || resp.message() != "一起听默认音量必须是 0 到 100 的整数" {
			t.Fatalf("音量 %v 应 400，得到 %d/%q", value, resp.status, resp.message())
		}
	}

	// 开播模式非法枚举 → 400。
	bad := map[string]any{"autoDeleteInactiveRooms": true, "autoDeleteAfterHours": 12, "registrationMode": "nope"}
	if resp := env.do(t, http.MethodPut, "/api/admin/settings", rootToken, bad); resp.status != http.StatusBadRequest || resp.message() != "registrationMode 必须是 open / approval / closed 之一" {
		t.Fatalf("非法枚举应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 权限矩阵格式非法 → 400。
	bad = map[string]any{"autoDeleteInactiveRooms": true, "autoDeleteAfterHours": 12,
		"roomPermissionMatrix": map[string]any{"unknownAction": map[string]any{"user": true}}}
	if resp := env.do(t, http.MethodPut, "/api/admin/settings", rootToken, bad); resp.status != http.StatusBadRequest || resp.message() != "roomPermissionMatrix 格式无效" {
		t.Fatalf("非法矩阵应 400，得到 %d/%q", resp.status, resp.message())
	}
	// 值不是布尔 → 同样 400。
	bad = map[string]any{"autoDeleteInactiveRooms": true, "autoDeleteAfterHours": 12,
		"roomPermissionMatrix": map[string]any{"kickViewer": map[string]any{"user": "yes"}}}
	if resp := env.do(t, http.MethodPut, "/api/admin/settings", rootToken, bad); resp.status != http.StatusBadRequest || resp.message() != "roomPermissionMatrix 格式无效" {
		t.Fatalf("矩阵值类型错误应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 合法提交：写入并按入参回显。
	good := map[string]any{
		"autoDeleteInactiveRooms":   false,
		"autoDeleteAfterHours":      6,
		"roomDefaultMusicVolume":    80,
		"registrationMode":          "open",
		"roomCreationMode":          "all-users",
		"betaFeaturesEnabled":       true,
		"dashDisabled":              true,
		"bilibiliDefaultParseMode":  "dash",
		"bilibiliPgcDefaultMode":    "cliOnly",
		"cdnAccelerate":             true,
		"cdnProxyUrl":               "https://gh-proxy.example.com",
		"playsvideoEnabled":         false,
		"roomMultiInstanceLogin":    true,
		"announceAutoPopupOnUpdate": false,
		"dataSourceConfig":          map[string]any{"anime": true},
		"roomPermissionMatrix":      map[string]any{"kickViewer": map[string]any{"user": false}},
		"allowCliHostResolve":       false,
	}
	resp = env.do(t, http.MethodPut, "/api/admin/settings", rootToken, good)
	if resp.status != http.StatusOK {
		t.Fatalf("保存应 200，得到 %d/%s", resp.status, resp.raw)
	}
	saved, _ := resp.body["settings"].(map[string]any)
	if saved["autoDeleteInactiveRooms"] != false || saved["autoDeleteAfterHours"].(float64) != 6 {
		t.Fatalf("保存后回显不对: %v", saved)
	}
	if saved["registrationMode"] != "open" || saved["roomCreationMode"] != "all-users" {
		t.Fatalf("枚举未生效: %v", saved)
	}
	if saved["cdnProxyUrl"] != "https://gh-proxy.example.com" {
		t.Fatalf("字符串列未生效: %v", saved)
	}
	if saved["allowCliHostResolve"] != false {
		t.Fatalf("CLI 房主解析开关未生效: %v", saved["allowCliHostResolve"])
	}

	// 重新 GET，确认真的落库（而不是只在响应里改）。
	resp = env.do(t, http.MethodGet, "/api/admin/settings", rootToken, nil)
	reloaded, _ := resp.body["settings"].(map[string]any)
	matrix, ok := reloaded["roomPermissionMatrix"].(map[string]any)
	if !ok {
		t.Fatalf("矩阵未落库: %v", reloaded["roomPermissionMatrix"])
	}
	kick, _ := matrix["kickViewer"].(map[string]any)
	if kick["user"] != false {
		t.Fatalf("矩阵内容不对: %v", matrix)
	}
	if _, ok := reloaded["dataSourceConfig"].(map[string]any); !ok {
		t.Fatalf("dataSourceConfig 未落库: %v", reloaded["dataSourceConfig"])
	}
	if reloaded["allowCliHostResolve"] != false {
		t.Fatalf("CLI 房主解析开关未落盘: %v", reloaded["allowCliHostResolve"])
	}

	// 非布尔 → 400。
	if resp := env.do(t, http.MethodPut, "/api/admin/settings", rootToken,
		map[string]any{"autoDeleteInactiveRooms": true, "autoDeleteAfterHours": 24, "allowCliHostResolve": "yes"}); resp.status != http.StatusBadRequest || resp.message() != "allowCliHostResolve 必须是布尔值" {
		t.Fatalf("非法类型应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 只提交必填两项：其余字段保持不变（Node 的 `!== undefined` 语义）。
	resp = env.do(t, http.MethodPut, "/api/admin/settings", rootToken,
		map[string]any{"autoDeleteInactiveRooms": true, "autoDeleteAfterHours": 24})
	if resp.status != http.StatusOK {
		t.Fatalf("最小提交应 200，得到 %d/%s", resp.status, resp.raw)
	}
	partial, _ := resp.body["settings"].(map[string]any)
	if partial["registrationMode"] != "open" || partial["roomDefaultMusicVolume"].(float64) != 80 {
		t.Fatalf("未提交的字段被重置了: %v", partial)
	}

	// 显式 null 清空矩阵。
	resp = env.do(t, http.MethodPut, "/api/admin/settings", rootToken,
		map[string]any{"autoDeleteInactiveRooms": true, "autoDeleteAfterHours": 24, "roomPermissionMatrix": nil})
	if resp.status != http.StatusOK {
		t.Fatalf("清空矩阵应 200，得到 %d/%s", resp.status, resp.raw)
	}
	cleared, _ := resp.body["settings"].(map[string]any)
	if v, ok := cleared["roomPermissionMatrix"]; !ok || v != nil {
		t.Fatalf("矩阵应被清成 null，得到 %v", v)
	}
}

// TestAdminSettingsSingleRow 确认反复保存不会堆积多行设置。
func TestAdminSettingsSingleRow(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root", "pass1234", "root", "active")
	rootToken := env.token(t, rootID, "root", "root")

	body := map[string]any{"autoDeleteInactiveRooms": true, "autoDeleteAfterHours": 24}
	for i := 0; i < 3; i++ {
		if resp := env.do(t, http.MethodPut, "/api/admin/settings", rootToken, body); resp.status != http.StatusOK {
			t.Fatalf("第 %d 次保存失败: %d/%s", i+1, resp.status, resp.raw)
		}
	}

	var rows int
	if err := env.conn.QueryRow(`SELECT COUNT(*) FROM "system_settings"`).Scan(&rows); err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if rows != 1 {
		t.Fatalf("system_settings 应只有 1 行，得到 %d", rows)
	}
}

// itoa 避免测试文件里再引一次 strconv。
func itoa(v int64) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

// roomModerators 读房间表的原始 moderators 列（JSON 数组文本）。
func (e *testEnv) roomModerators(t *testing.T, roomID string) string {
	t.Helper()
	var raw string
	if err := e.conn.QueryRow(
		`SELECT "moderators" FROM "room" WHERE "roomId" = ?`, roomID,
	).Scan(&raw); err != nil {
		t.Fatalf("读取房管名单失败: %v", err)
	}
	return raw
}

// TestAdminRoomModerators 覆盖管理端房管名单的读写、幂等、上限与权限边界。
//
// 与管理端「关闭/重开房间」保持同一套权限：root 任意房间，admin 仅自己创建的。
// 这里刻意验证 admin 在别人房间上吃 403——否则任何管理员都能往别人的房间塞房管。
func TestAdminRoomModerators(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root", "pass1234", "root", "active")
	ownerID := env.seedUser(t, "owner", "pass1234", "user", "active")
	adminID := env.seedUser(t, "bob", "pass1234", "admin", "active")
	targetID := env.seedUser(t, "carol", "pass1234", "user", "active")
	pendingID := env.seedUser(t, "dave", "pass1234", "guest", "pending")

	rootToken := env.token(t, rootID, "root", "root")
	adminToken := env.token(t, adminID, "admin", "bob")

	env.seedRoom(t, "ROOMS100", "active", &ownerID)
	base := "/api/admin/rooms/ROOMS100/moderators"

	// admin 对别人创建的房间：读也拒（避免列表泄漏 + 写入口不一致）。
	resp := env.do(t, http.MethodGet, base, adminToken, nil)
	if resp.status != http.StatusForbidden ||
		resp.message() != "无权限：仅 root 或房间创建者可管理该房间的房管" {
		t.Fatalf("admin 读他人房间房管应 403，得到 %d/%q", resp.status, resp.message())
	}

	// root 读：空名单 + 上限字段。
	resp = env.do(t, http.MethodGet, base, rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("root 读房管列表应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if mods, ok := resp.body["moderators"].([]any); !ok || len(mods) != 0 {
		t.Fatalf("初始房管应为空数组，得到 %v", resp.body["moderators"])
	}
	if got := resp.body["maxModerators"]; got != float64(10) {
		t.Fatalf("maxModerators 应为 10，得到 %v", got)
	}

	// admin 写别人房间：同样 403。
	resp = env.do(t, http.MethodPost, base, adminToken, map[string]any{"userId": targetID})
	if resp.status != http.StatusForbidden {
		t.Fatalf("admin 改他人房间房管应 403，得到 %d/%s", resp.status, resp.raw)
	}

	// 参数非法：userId 缺失 / 账号不存在 / 未审核 / 房主本人。
	if resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{}); resp.status != http.StatusBadRequest || resp.message() != "请选择要任命的账号" {
		t.Fatalf("缺 userId 应 400/请选择要任命的账号，得到 %d/%q", resp.status, resp.message())
	}
	if resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{"userId": 9999}); resp.status != http.StatusBadRequest || resp.message() != "账号不存在" {
		t.Fatalf("不存在的账号应 400/账号不存在，得到 %d/%q", resp.status, resp.message())
	}
	if resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{"userId": pendingID}); resp.status != http.StatusBadRequest || resp.message() != "该账号未通过审核，无法任命为房管" {
		t.Fatalf("待审核账号应 400，得到 %d/%q", resp.status, resp.message())
	}
	if resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{"userId": ownerID}); resp.status != http.StatusBadRequest || resp.message() != "房主无需任命" {
		t.Fatalf("房主本人应 400/房主无需任命，得到 %d/%q", resp.status, resp.message())
	}
	if got := env.roomModerators(t, "ROOMS100"); got != "[]" {
		t.Fatalf("失败路径不应写库，实际 %s", got)
	}

	// 正常任命：落库 + 回包带用户名（离线账号也能任命，这是管理端的核心场景）。
	resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{"userId": targetID})
	if resp.status != http.StatusOK {
		t.Fatalf("任命应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if got := env.roomModerators(t, "ROOMS100"); got != "["+itoa(targetID)+"]" {
		t.Fatalf("房管名单应写入目标账号，实际 %s", got)
	}
	mods, _ := resp.body["moderators"].([]any)
	if len(mods) != 1 {
		t.Fatalf("回包应带 1 个房管，得到 %v", resp.body["moderators"])
	}
	first, _ := mods[0].(map[string]any)
	if first["username"] != "carol" {
		t.Fatalf("回包应补上用户名 carol，得到 %v", first)
	}

	// 重复任命：幂等，不重复写、不报错。
	if resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{"userId": targetID}); resp.status != http.StatusOK {
		t.Fatalf("重复任命应幂等 200，得到 %d/%s", resp.status, resp.raw)
	}
	if got := env.roomModerators(t, "ROOMS100"); got != "["+itoa(targetID)+"]" {
		t.Fatalf("重复任命不应产生两条记录，实际 %s", got)
	}

	// 达到上限后拒绝：直接把列写成 10 个 id。
	ids := make([]int64, 0, 10)
	for i := int64(0); i < 10; i++ {
		ids = append(ids, 1000+i)
	}
	rawIDs, _ := json.Marshal(ids)
	if _, err := env.conn.Exec(`UPDATE "room" SET "moderators" = ? WHERE "roomId" = ?`, string(rawIDs), "ROOMS100"); err != nil {
		t.Fatalf("写入满员名单失败: %v", err)
	}
	resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{"userId": targetID})
	if resp.status != http.StatusBadRequest || resp.message() != "房管人数已达上限（10）" {
		t.Fatalf("满员应 400/上限，得到 %d/%q", resp.status, resp.message())
	}

	// 还原成只含 target，再验撤销与幂等。
	if _, err := env.conn.Exec(`UPDATE "room" SET "moderators" = ? WHERE "roomId" = ?`, "["+itoa(targetID)+"]", "ROOMS100"); err != nil {
		t.Fatalf("还原名单失败: %v", err)
	}
	// 明确指定路径参数写错时的 400。
	if resp = env.do(t, http.MethodDelete, base+"/abc", rootToken, nil); resp.status != http.StatusBadRequest || resp.message() != "用户 ID 不正确" {
		t.Fatalf("非法 userId 应 400，得到 %d/%q", resp.status, resp.message())
	}
	resp = env.do(t, http.MethodDelete, base+"/"+itoa(targetID), rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("撤销应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if got := env.roomModerators(t, "ROOMS100"); got != "[]" {
		t.Fatalf("撤销后名单应为空，实际 %s", got)
	}
	if resp = env.do(t, http.MethodDelete, base+"/"+itoa(targetID), rootToken, nil); resp.status != http.StatusOK {
		t.Fatalf("重复撤销应幂等 200，得到 %d/%s", resp.status, resp.raw)
	}

	// 房间列表带上房管数与可管理标记（前端据此禁用按钮）。
	if resp = env.do(t, http.MethodPost, base, rootToken, map[string]any{"userId": targetID}); resp.status != http.StatusOK {
		t.Fatalf("重新任命失败: %d/%s", resp.status, resp.raw)
	}
	resp = env.do(t, http.MethodGet, "/api/admin/rooms", rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("房间列表应 200，得到 %d/%s", resp.status, resp.raw)
	}
	rooms, _ := resp.body["rooms"].([]any)
	var found map[string]any
	for _, item := range rooms {
		room, _ := item.(map[string]any)
		if room["roomId"] == "ROOMS100" {
			found = room
			break
		}
	}
	if found == nil {
		t.Fatalf("房间列表里没有 ROOMS100：%s", resp.raw)
	}
	if found["moderatorCount"] != float64(1) {
		t.Fatalf("moderatorCount 应为 1，得到 %v", found["moderatorCount"])
	}
	if found["canManage"] != true {
		t.Fatalf("root 的 canManage 应为 true，得到 %v", found["canManage"])
	}

	// 房间不存在：404，而不是把它当成空名单。
	if resp = env.do(t, http.MethodGet, "/api/admin/rooms/NOPE/moderators", rootToken, nil); resp.status != http.StatusNotFound {
		t.Fatalf("不存在的房间应 404，得到 %d/%s", resp.status, resp.raw)
	}
}
