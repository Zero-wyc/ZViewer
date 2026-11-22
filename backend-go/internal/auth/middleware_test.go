package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 失效的 access_token cookie 不能压过客户端手里刚签发的有效 Bearer。
//
// 这是「/api/auth/guest 每次 200、其余请求与 socket 握手却一直 401」的根因：
// 浏览器残留的旧 HTTPS cookie 优先级更高，只取第一个令牌就永远认证失败，
// 前端于是不停重新申请游客身份（一分钟上千次）。
func TestRequireFallsBackPastStaleCookie(t *testing.T) {
	manager := newTestManager(t)
	tokens, err := manager.GenerateGuest("")
	if err != nil {
		t.Fatal(err)
	}
	// 游客身份不查库，Users 传 nil 也能覆盖 assertActive 的游客分支
	authenticator := NewAuthenticator(manager, nil)
	handler := authenticator.Require(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	t.Run("失效 cookie + 有效 Bearer 放行", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://localhost/api/auth/me", nil)
		request.AddCookie(&http.Cookie{Name: AccessCookieName, Value: "stale-access-token"})
		request.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
		response := httptest.NewRecorder()
		handler(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("状态码 = %d，期望 200（应回退到 Bearer）", response.Code)
		}
	})

	t.Run("只有失效 cookie 时按无效拒绝", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://localhost/api/auth/me", nil)
		request.AddCookie(&http.Cookie{Name: AccessCookieName, Value: "stale-access-token"})
		response := httptest.NewRecorder()
		handler(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("状态码 = %d，期望 401", response.Code)
		}
		// 有令牌但校验不过 → 「无效」文案，不能误报成「未提供」
		if body := response.Body.String(); !strings.Contains(body, "认证令牌无效") {
			t.Fatalf("响应体 = %s，期望包含「认证令牌无效」", body)
		}
	})

	t.Run("完全没有令牌时提示未提供", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://localhost/api/auth/me", nil)
		response := httptest.NewRecorder()
		handler(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("状态码 = %d，期望 401", response.Code)
		}
		if body := response.Body.String(); !strings.Contains(body, "未提供认证令牌") {
			t.Fatalf("响应体 = %s，期望包含「未提供认证令牌」", body)
		}
	})
}

// 候选顺序保持 Node 版语义（query → cookie → Bearer），并做去重。
func TestAccessTokenCandidatesOrder(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://localhost/live?token=from-query", nil)
	request.AddCookie(&http.Cookie{Name: AccessCookieName, Value: "from-cookie"})
	request.Header.Set("Authorization", "Bearer from-header")

	got := AccessTokenCandidates(request)
	want := []string{"from-query", "from-cookie", "from-header"}
	if len(got) != len(want) {
		t.Fatalf("候选 = %v，期望 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("候选 = %v，期望 %v", got, want)
		}
	}

	// 同一个令牌既在 cookie 又在 header 里时只保留一个
	duplicated := httptest.NewRequest(http.MethodGet, "http://localhost/api/auth/me", nil)
	duplicated.AddCookie(&http.Cookie{Name: AccessCookieName, Value: "same"})
	duplicated.Header.Set("Authorization", "Bearer same")
	if got := AccessTokenCandidates(duplicated); len(got) != 1 || got[0] != "same" {
		t.Fatalf("去重后 = %v，期望 [same]", got)
	}
}
