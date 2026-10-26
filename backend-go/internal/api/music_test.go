package api_test

import (
	"net/http"
	"testing"
)

// /api/music 的 HTTP 层验证：路由 + 参数校验 + 「NCM 未启动」的降级分支。
//
// 测试环境里 NCM 基地址为空（等价于 Node 版内部服务没起来），
// 所以凡是要打上游的端点都走 503；真正打上游的分支由
// internal/ncm 的单测与 scripts/http-music-parity.sh 覆盖。

func TestMusicRequiresZViewerAccountForCookie(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	resp := env.do(t, http.MethodGet, "/api/music/ncm-cookie", "", nil)
	if resp.status != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401", resp.status)
	}
	if resp.body["message"] != "请先登录 ZViewer 账号（游客不持有凭证）" {
		t.Errorf("文案 = %v", resp.body["message"])
	}

	resp = env.do(t, http.MethodPost, "/api/music/ncm-cookie-login", "", map[string]any{"cookie": "MUSIC_U=x"})
	if resp.status != http.StatusUnauthorized {
		t.Fatalf("cookie-login 状态码 = %d，期望 401", resp.status)
	}
}

func TestMusicLoginStatusForGuest(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	resp := env.do(t, http.MethodGet, "/api/music/login/status", "", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("状态码 = %d", resp.status)
	}
	if resp.body["loggedIn"] != false {
		t.Errorf("loggedIn = %v，期望 false", resp.body["loggedIn"])
	}
	// 四个资料字段必须是 null（不是缺键）——前端按 null 判定「未登录」
	for _, key := range []string{"nickname", "avatarUrl", "vipType", "vipStatus"} {
		value, present := resp.body[key]
		if !present {
			t.Errorf("缺字段 %s", key)
			continue
		}
		if value != nil {
			t.Errorf("%s = %v，期望 null", key, value)
		}
	}
}

func TestMusicLogoutForGuest(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	resp := env.do(t, http.MethodPost, "/api/music/logout", "", nil)
	if resp.status != http.StatusOK || resp.body["success"] != true {
		t.Fatalf("响应 = %d %v", resp.status, resp.body)
	}
}

func TestMusicCookieLoginValidatesCookie(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "music-user", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "music-user")

	// 空 Cookie
	resp := env.do(t, http.MethodPost, "/api/music/ncm-cookie-login", token, map[string]any{"cookie": "  "})
	if resp.status != http.StatusBadRequest || resp.body["message"] != "请输入 Cookie" {
		t.Fatalf("空 Cookie 响应 = %d %v", resp.status, resp.body)
	}

	// 缺 MUSIC_U
	resp = env.do(t, http.MethodPost, "/api/music/ncm-cookie-login", token,
		map[string]any{"cookie": "NMTID=abc; __csrf=xyz"})
	if resp.status != http.StatusBadRequest {
		t.Fatalf("缺 MUSIC_U 状态码 = %d", resp.status)
	}
	if resp.body["message"] != "Cookie 中缺少 MUSIC_U（请从已登录网易云音乐的浏览器复制）" {
		t.Errorf("文案 = %v", resp.body["message"])
	}

	// 有 MUSIC_U 但 NCM 没起 → 500「Cookie 登录失败」（Node 在 fetch 处抛错落这里）
	resp = env.do(t, http.MethodPost, "/api/music/ncm-cookie-login", token,
		map[string]any{"cookie": "MUSIC_U=abc"})
	if resp.status != http.StatusInternalServerError || resp.body["message"] != "Cookie 登录失败" {
		t.Fatalf("响应 = %d %v", resp.status, resp.body)
	}
}

func TestMusicAlbumFullValidation(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "music-album", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "music-album")

	// 注意 Node 只校验 finite 且 >0，**不要求整数**（1.5 是合法 id）
	for _, raw := range []string{"", "abc", "0", "-1"} {
		path := "/api/music/album/full"
		if raw != "" {
			path += "?id=" + raw
		}
		resp := env.do(t, http.MethodGet, path, token, nil)
		if resp.status != http.StatusBadRequest {
			t.Errorf("id=%q 状态码 = %d，期望 400", raw, resp.status)
			continue
		}
		if resp.body["message"] != "缺少有效的专辑 id" {
			t.Errorf("id=%q 文案 = %v", raw, resp.body["message"])
		}
	}

	// 合法 id 之后是上游解析链，由 internal/ncm 的单测覆盖：API 层只守参数闸门，
	// 不在这里真连网易云。
}

func TestMusicStreamValidation(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	for _, raw := range []string{"", "abc", "0", "1.5"} {
		path := "/api/music/stream"
		if raw != "" {
			path += "?songId=" + raw
		}
		resp := env.do(t, http.MethodGet, path, "", nil)
		if resp.status != http.StatusBadRequest {
			t.Errorf("songId=%q 状态码 = %d，期望 400", raw, resp.status)
			continue
		}
		if resp.body["message"] != "songId 参数无效" {
			t.Errorf("songId=%q 文案 = %v", raw, resp.body["message"])
		}
	}

	// 合法 songId 之后的解析链由 internal/ncm 覆盖；这里只验参数规则。
	resp := env.do(t, http.MethodGet, "/api/music/song-quality?songId=abc", "", nil)
	if resp.status != http.StatusBadRequest {
		t.Errorf("song-quality 状态码 = %d", resp.status)
	}
}

// code 取响应里的 code 字段（字符串）。
func (r apiResponse) code() string {
	value, _ := r.body["code"].(string)
	return value
}
