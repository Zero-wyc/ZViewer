package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCookiesFollowConfiguredTokenLifetime(t *testing.T) {
	for _, ttl := range []struct{ access, refresh string }{
		{"24h", "30d"}, {"15m", "7d"}, {"48h", "2d"},
	} {
		t.Run(ttl.access+"/"+ttl.refresh, func(t *testing.T) {
			t.Setenv("JWT_ACCESS_EXPIRES_IN", ttl.access)
			t.Setenv("JWT_REFRESH_EXPIRES_IN", ttl.refresh)
			manager := newTestManager(t)
			tokens, err := manager.Generate(1, RoleUser, "fixture")
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "https://example.test/api/auth/login", nil)
			response := httptest.NewRecorder()
			SetAuthCookies(response, request, tokens)
			cookies := response.Result().Cookies()
			if len(cookies) != 2 {
				t.Fatalf("expected two cookies, got %d", len(cookies))
			}
			for _, cookie := range cookies {
				ttl, margin := parseTTL(ttl.access, 0), 5
				if cookie.Name == RefreshCookieName {
					ttl, margin = manager.refreshTTL, 0
				}
				expected := int(ttl/time.Second) - margin
				if cookie.MaxAge > expected || cookie.MaxAge < expected-2 {
					t.Fatalf("%s MaxAge=%d, expected about %d", cookie.Name, cookie.MaxAge, expected)
				}
				if !cookie.HttpOnly || !cookie.Secure {
					t.Fatal("cookie security attributes lost")
				}
			}
			refreshed := httptest.NewRecorder()
			SetAccessTokenCookie(refreshed, request, tokens.AccessToken)
			if got := refreshed.Result().Cookies()[0].MaxAge; got > cookies[0].MaxAge || got < cookies[0].MaxAge-1 {
				t.Fatalf("login and refresh cookie lifetimes differ: %d vs %d", got, cookies[0].MaxAge)
			}
		})
	}
}

func TestDefaultAndGuestTokenLifetimes(t *testing.T) {
	t.Setenv("JWT_ACCESS_EXPIRES_IN", "")
	t.Setenv("JWT_REFRESH_EXPIRES_IN", "")
	manager := newTestManager(t)
	if manager.accessTTL != 24*time.Hour || manager.refreshTTL != 30*24*time.Hour {
		t.Fatal("registered user defaults must be 24h/30d")
	}
	tokens, err := manager.GenerateGuest("fixture-guest")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://example.test/api/auth/guest", nil)
	response := httptest.NewRecorder()
	SetAuthCookies(response, request, tokens)
	cookies := response.Result().Cookies()
	if cookies[0].MaxAge > 3600 || cookies[1].MaxAge > 7*24*3600 {
		t.Fatal("guest cookies must follow the shorter guest JWTs")
	}
	plain := httptest.NewRecorder()
	SetAuthCookies(plain, httptest.NewRequest(http.MethodPost, "http://example.test", nil), tokens)
	if len(plain.Result().Cookies()) != 0 {
		t.Fatal("HTTP must retain Bearer authentication")
	}
}
