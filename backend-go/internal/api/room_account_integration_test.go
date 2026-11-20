package api_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"zviewer/backend/internal/bilibili"
)

// doWithRoom 与 testEnv.do 相同，额外带房间上下文头 X-Room-Id。
func (e *testEnv) doWithRoom(t *testing.T, method, path, token, roomID string, body any) apiResponse {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if roomID != "" {
		req.Header.Set("X-Room-Id", roomID)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	resp := apiResponse{status: rec.Code, raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp.body)
	return resp
}

func accountOf(t *testing.T, resp apiResponse, provider string) map[string]any {
	t.Helper()
	accounts, ok := resp.body["accounts"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺少 accounts: %s", resp.raw)
	}
	account, ok := accounts[provider].(map[string]any)
	if !ok {
		t.Fatalf("响应缺少 accounts.%s: %s", provider, resp.raw)
	}
	return account
}

func accountString(account map[string]any, field string) string {
	value, _ := account[field].(string)
	return value
}

func accountInt(account map[string]any, field string) int64 {
	value, _ := account[field].(float64)
	return int64(value)
}

func accountBool(account map[string]any, field string) bool {
	value, _ := account[field].(bool)
	return value
}

func insertRoomSession(t *testing.T, e *testEnv, roomID, socketID string, userID int64) {
	t.Helper()
	if _, err := e.conn.Exec(
		`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES (?,?,?,?)`,
		roomID, socketID, "viewer", userID,
	); err != nil {
		t.Fatalf("插入会话失败: %v", err)
	}
}

func insertNcmCredential(t *testing.T, e *testEnv, userID int64, nickname string) {
	t.Helper()
	cookies := "[\"MUSIC_U=token-" + strconv.FormatInt(userID, 10) + "\"]"
	if _, err := e.conn.Exec(
		`INSERT INTO "ncm_credential" ("userId","cookies","nickname","avatarUrl","vipType","vipStatus") VALUES (?,?,?,?,?,?)`,
		userID, cookies, nickname, "https://p1.music.126.net/avatar.jpg", 1, 0,
	); err != nil {
		t.Fatalf("插入网易云凭证失败: %v", err)
	}
}

func insertBilibiliCredential(t *testing.T, e *testEnv, userID int64, cookie string) {
	t.Helper()
	encoded := base64.StdEncoding.EncodeToString([]byte(cookie))
	if _, err := e.conn.Exec(
		`INSERT INTO "bilibili_credential" ("userId","cookie") VALUES (?,?)`,
		strconv.FormatInt(userID, 10), encoded,
	); err != nil {
		t.Fatalf("插入 B站 凭证失败: %v", err)
	}
}

// ensureAccountTables 单独建共享账号相关表：全局夹具刻意不建它们，
// 避免影响既有用例（ncm 凭证表缺失是部分用例的预期前提）。
func ensureAccountTables(t *testing.T, e *testEnv) {
	t.Helper()
	ddls := []string{
		`CREATE TABLE IF NOT EXISTS "room_account" ("provider" TEXT NOT NULL, "roomId" TEXT NOT NULL, "userId" INTEGER NOT NULL, "updatedAt" TEXT NOT NULL, PRIMARY KEY ("provider","roomId"))`,
		`CREATE TABLE IF NOT EXISTS "ncm_credential" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "cookies" text NOT NULL, "nickname" text, "avatarUrl" text, "vipType" integer, "vipStatus" integer, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_ncm_credential_userId" UNIQUE ("userId"))`,
		`CREATE TABLE IF NOT EXISTS "bilibili_credential" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" varchar NOT NULL, "cookie" text NOT NULL, "refreshToken" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_bilibili_credential_userId" UNIQUE ("userId"))`,
	}
	for _, ddl := range ddls {
		if _, err := e.conn.Exec(ddl); err != nil {
			t.Fatalf("建共享账号表失败: %v", err)
		}
	}
}
func TestRoomAccountEndpoints(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	ensureAccountTables(t, env)

	ownerID := env.seedUser(t, "room-acc-owner", "fixture-password", "user", "active")
	memberID := env.seedUser(t, "room-acc-member", "fixture-password", "user", "active")
	env.seedRoom(t, "ROOMACC1", "active", &ownerID)
	insertRoomSession(t, env, "ROOMACC1", "sock-owner", ownerID)
	insertRoomSession(t, env, "ROOMACC1", "sock-member", memberID)
	ownerToken := env.token(t, ownerID, "user", "room-acc-owner")
	memberToken := env.token(t, memberID, "user", "room-acc-member")

	// 1) 默认：没有绑定、没有房主凭证时两个平台都是未登录。
	resp := env.doWithRoom(t, http.MethodGet, "/api/rooms/ROOMACC1/accounts", memberToken, "ROOMACC1", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("GET /accounts 状态 = %d, want 200: %s", resp.status, resp.raw)
	}
	for _, provider := range []string{"ncm", "bilibili"} {
		account := accountOf(t, resp, provider)
		if accountBool(account, "loggedIn") || accountString(account, "source") != "" || accountInt(account, "userId") != 0 {
			t.Fatalf("默认状态 %s 应为未登录/空来源: %v", provider, account)
		}
	}

	// 2) 房主有网易云凭证：房间内任何成员看到的都是房主账号（旧行为）。
	insertNcmCredential(t, env, ownerID, "房主网易云")
	resp = env.doWithRoom(t, http.MethodGet, "/api/rooms/ROOMACC1/accounts", memberToken, "ROOMACC1", nil)
	ncm := accountOf(t, resp, "ncm")
	if accountString(ncm, "source") != "owner" || accountInt(ncm, "userId") != ownerID {
		t.Fatalf("房主凭证应判定为 owner/%d: %v", ownerID, ncm)
	}
	if !accountBool(ncm, "loggedIn") || accountString(ncm, "binderName") != "room-acc-owner" {
		t.Fatalf("房主凭证账号状态异常: %v", ncm)
	}
	if accountString(ncm, "nickname") != "房主网易云" {
		t.Fatalf("房主账号资料应来自缓存: %v", ncm)
	}

	// 3) 请求者自己有 B站 凭证：source=self。
	insertBilibiliCredential(t, env, memberID, "SESSDATA=member-token")
	env.srv.Bilibili.Caches.SetUserInfo(strconv.FormatInt(memberID, 10), bilibili.UserInfo{
		Name:   "成员B站",
		Avatar: "//i0.hdslb.com/bfs/face/member.jpg",
	})
	resp = env.doWithRoom(t, http.MethodGet, "/api/rooms/ROOMACC1/accounts", memberToken, "ROOMACC1", nil)
	bili := accountOf(t, resp, "bilibili")
	if accountString(bili, "source") != "self" || accountInt(bili, "userId") != memberID {
		t.Fatalf("成员自己的凭证应判定为 self/%d: %v", memberID, bili)
	}
	if accountString(bili, "nickname") != "成员B站" || accountString(bili, "avatarUrl") != "https://i0.hdslb.com/bfs/face/member.jpg" {
		t.Fatalf("B站 账号资料应来自缓存: %v", bili)
	}

	// 4) 房间绑定优先于房主：成员登录后全房复用，binderName 是绑定者。
	insertNcmCredential(t, env, memberID, "成员网易云")
	if err := env.srv.RoomAccounts.SetRoomAccount(context.Background(), "ncm", "ROOMACC1", memberID); err != nil {
		t.Fatalf("绑定房间共享账号失败: %v", err)
	}
	resp = env.doWithRoom(t, http.MethodGet, "/api/rooms/ROOMACC1/accounts", ownerToken, "ROOMACC1", nil)
	ncm = accountOf(t, resp, "ncm")
	if accountString(ncm, "source") != "room" || accountInt(ncm, "userId") != memberID {
		t.Fatalf("房间绑定应判定为 room/%d: %v", memberID, ncm)
	}
	if accountString(ncm, "binderName") != "room-acc-member" || accountString(ncm, "nickname") != "成员网易云" {
		t.Fatalf("房间绑定账号资料异常: %v", ncm)
	}

	// 5) 退出只解绑房间：个人凭证还在，房主凭证重新生效。
	resp = env.doWithRoom(t, http.MethodPost, "/api/rooms/ROOMACC1/accounts/logout", memberToken, "ROOMACC1", map[string]any{"provider": "ncm"})
	if resp.status != http.StatusOK || resp.body["success"] != true {
		t.Fatalf("退出房间共享账号失败: %d %s", resp.status, resp.raw)
	}
	resp = env.doWithRoom(t, http.MethodGet, "/api/rooms/ROOMACC1/accounts", ownerToken, "ROOMACC1", nil)
	ncm = accountOf(t, resp, "ncm")
	if accountString(ncm, "source") != "owner" || accountInt(ncm, "userId") != ownerID {
		t.Fatalf("解绑后应回落到房主凭证: %v", ncm)
	}
	if _, ok, err := env.srv.RoomAccounts.GetRoomAccount(context.Background(), "ncm", "ROOMACC1"); err != nil || ok {
		t.Fatalf("解绑后 room_account 应为空, ok=%v err=%v", ok, err)
	}

	// 6) 平台校验与房间存在性校验。
	resp = env.doWithRoom(t, http.MethodPost, "/api/rooms/ROOMACC1/accounts/logout", memberToken, "ROOMACC1", map[string]any{"provider": "qq"})
	if resp.status != http.StatusBadRequest || resp.message() != "不支持的平台" {
		t.Fatalf("非法 provider 响应异常: %d %s", resp.status, resp.raw)
	}
	resp = env.doWithRoom(t, http.MethodGet, "/api/rooms/MISSING/accounts", memberToken, "MISSING", nil)
	if resp.status != http.StatusNotFound || resp.message() != "房间不存在" {
		t.Fatalf("未知房间响应异常: %d %s", resp.status, resp.raw)
	}
}
