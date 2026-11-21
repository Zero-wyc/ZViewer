package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// 桌面壳令牌：仅 GUI 托管 + 令牌相等时放行，其余情况退回管理员 JWT 校验。
func TestRequireDesktopOrAdmin(t *testing.T) {
	authenticator := &Authenticator{}
	called := 0
	handler := authenticator.RequireDesktopOrAdmin(func(w http.ResponseWriter, r *http.Request) {
		called++
		claims := ClaimsFrom(r.Context())
		if claims == nil || claims.Role != RoleRoot {
			t.Errorf("desktop claims = %+v", claims)
		}
		w.WriteHeader(http.StatusOK)
	})

	request := func(header, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/crawler/status", nil)
		if header != "" {
			req.Header.Set("X-Desktop-Token", header)
			req.Header.Set("Authorization", "")
		}
		_ = token
		recorder := httptest.NewRecorder()
		handler(recorder, req)
		return recorder
	}

	// 1) GUI 托管 + 正确令牌 → 放行。
	t.Setenv("ZVIEWER_DESKTOP", "1")
	t.Setenv("ZVIEWER_DESKTOP_TOKEN", "token-abc")
	if got := request("token-abc", ""); got.Code != http.StatusOK {
		t.Fatalf("valid desktop token = %d", got.Code)
	}

	// 2) 令牌错误 → 401（没有 JWT 可退）。
	if got := request("token-wrong", ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d, want 401", got.Code)
	}

	// 3) 没令牌 → 401。
	if got := request("", ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("missing token = %d, want 401", got.Code)
	}

	// 4) 非 GUI 托管：即使知道令牌也不生效。
	t.Setenv("ZVIEWER_DESKTOP", "0")
	if got := request("token-abc", ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("non-desktop env = %d, want 401", got.Code)
	}

	// 5) 空令牌环境变量：不开启后门。
	t.Setenv("ZVIEWER_DESKTOP", "1")
	t.Setenv("ZVIEWER_DESKTOP_TOKEN", "")
	if got := request("", ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("empty env token = %d, want 401", got.Code)
	}

	if called != 1 {
		t.Errorf("handler called %d times, want 1", called)
	}
}
