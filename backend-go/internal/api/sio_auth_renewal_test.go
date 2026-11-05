package api_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"zviewer/backend/internal/api"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/sio"
)

func TestSocketSessionRenewalKeepsRoomAndHonorsRevocation(t *testing.T) {
	for _, transport := range []string{"cookie", "bearer", "guest"} {
		t.Run(transport, func(t *testing.T) {
			t.Setenv("JWT_ACCESS_EXPIRES_IN", "2s")
			t.Setenv("JWT_ACCESS_SECRET", "long-session-test-access-key-fixture")
			e := newTestEnv(t)
			defer e.teardown()
			id := e.seedUser(t, "renewal-fixture", "fixture-password", "user", "active")
			pair, err := e.tokens.Generate(id, "user", "renewal-fixture")
			if transport == "guest" {
				pair, err = e.tokens.GenerateGuest("renewal-guest")
				if err == nil {
					claims, _ := e.tokens.VerifyAccess(pair.AccessToken)
					claims.ExpiresAt = jwt.NewNumericDate(time.Now().Add(2 * time.Second))
					pair.AccessToken, err = jwt.NewWithClaims(jwt.SigningMethodHS256, claims).
						SignedString([]byte("long-session-test-access-key-fixture"))
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			hub, endpoint := renewalTestServer(t, e)
			sc := connectRenewalClient(t, hub, endpoint.URL, pair, transport == "cookie")
			sc.Join("renewal-room")
			original, _ := e.tokens.VerifyAccess(pair.AccessToken)
			time.Sleep(time.Until(original.ExpiresAt.Time) + 100*time.Millisecond)
			token, _ := sc.GetData("__token")
			if token == pair.AccessToken {
				t.Fatal("server did not renew the expired access token")
			}
			if !hub.Connected(sc.ID) || !sc.InRoom("renewal-room") {
				t.Fatal("renewal interrupted the socket or room membership")
			}
			if transport == "guest" {
				guestID, _ := sc.GetData("guestId")
				if guestID != "renewal-guest" {
					t.Fatal("renewal replaced the guest identity")
				}
				return
			}
			// Revoke only the original credential. A newly issued access token
			// would pass this timestamp, so this proves refresh revocation is checked.
			cutoff := time.UnixMilli(original.IssuedAtMs + 1).UTC().Format(time.RFC3339Nano)
			if _, err := e.conn.Exec(`UPDATE "user" SET "tokenInvalidBefore"=? WHERE id=?`, cutoff, id); err != nil {
				t.Fatal(err)
			}
			postRenewalPacket(t, endpoint.URL, sc.ID, `42["fixture"]`)
			if hub.Connected(sc.ID) {
				t.Fatal("revoked original refresh session kept controlling the room")
			}
		})
	}
}

func TestSocketRenewalStopsAtOriginalRefreshExpiry(t *testing.T) {
	t.Setenv("JWT_ACCESS_EXPIRES_IN", "1s")
	t.Setenv("JWT_REFRESH_EXPIRES_IN", "3s")
	e := newTestEnv(t)
	defer e.teardown()
	id := e.seedUser(t, "expiry-fixture", "fixture-password", "user", "active")
	pair, err := e.tokens.Generate(id, "user", "expiry-fixture")
	if err != nil {
		t.Fatal(err)
	}
	hub, endpoint := renewalTestServer(t, e)
	sc := connectRenewalClient(t, hub, endpoint.URL, pair, false)
	access, _ := e.tokens.VerifyAccess(pair.AccessToken)
	refresh, _ := e.tokens.VerifyRefresh(pair.RefreshToken)
	time.Sleep(time.Until(access.ExpiresAt.Time) + 100*time.Millisecond)
	if !hub.Connected(sc.ID) {
		t.Fatal("socket disconnected instead of renewing access")
	}
	time.Sleep(time.Until(refresh.ExpiresAt.Time) + 100*time.Millisecond)
	if hub.Connected(sc.ID) {
		t.Fatal("renewed socket outlived the original refresh credential")
	}
}

func TestSocketExpiryRejectsMissingOrMismatchedRefresh(t *testing.T) {
	for _, mode := range []string{"missing", "other-user", "invalid"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("JWT_ACCESS_EXPIRES_IN", "1s")
			e := newTestEnv(t)
			defer e.teardown()
			id := e.seedUser(t, "access-fixture", "fixture-password", "user", "active")
			pair, err := e.tokens.Generate(id, "user", "access-fixture")
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "missing":
				pair.RefreshToken = ""
			case "invalid":
				pair.RefreshToken = "invalid-fixture"
			case "other-user":
				other, _ := e.tokens.Generate(id+1, "user", "other-fixture")
				pair.RefreshToken = other.RefreshToken
			}
			hub, endpoint := renewalTestServer(t, e)
			sc := connectRenewalClient(t, hub, endpoint.URL, pair, false)
			claims, _ := e.tokens.VerifyAccess(pair.AccessToken)
			time.Sleep(time.Until(claims.ExpiresAt.Time) + 100*time.Millisecond)
			if hub.Connected(sc.ID) {
				t.Fatal("invalid refresh credential extended the socket")
			}
		})
	}
}

func renewalTestServer(t *testing.T, e *testEnv) (*sio.Server, *httptest.Server) {
	t.Helper()
	hub := sio.NewServer(sio.Options{})
	server := api.New(api.Deps{
		Cfg:    &config.Config{ProjectRoot: t.TempDir()},
		Tokens: e.tokens, Auth: auth.NewAuthenticator(e.tokens, e.users), Socket: hub,
	})
	endpoint := httptest.NewServer(server.Handler())
	t.Cleanup(endpoint.Close)
	return hub, endpoint
}

func connectRenewalClient(t *testing.T, hub *sio.Server, base string, pair auth.Tokens, cookie bool) *sio.Socket {
	t.Helper()
	openRequest, _ := http.NewRequest(http.MethodGet, base+"/socket.io/?EIO=4&transport=polling", nil)
	if cookie {
		openRequest.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: pair.AccessToken})
		openRequest.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: pair.RefreshToken})
	}
	response, err := http.DefaultClient.Do(openRequest)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	var open struct {
		SID string `json:"sid"`
	}
	if len(body) < 2 || json.Unmarshal(body[1:], &open) != nil || open.SID == "" {
		t.Fatalf("invalid Engine.IO open packet: %s", body)
	}
	credentials := map[string]string{"token": pair.AccessToken, "refreshToken": pair.RefreshToken}
	payload, _ := json.Marshal(credentials)
	if cookie {
		payload = []byte("{}")
	}
	request, _ := http.NewRequest(http.MethodPost, renewalPollURL(base, open.SID), strings.NewReader("40"+string(payload)))
	request.Header.Set("Content-Type", "text/plain")
	if cookie {
		request.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: pair.AccessToken})
		request.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: pair.RefreshToken})
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	sc := hub.SocketByID(open.SID)
	if sc == nil {
		t.Fatal("socket authentication failed")
	}
	t.Cleanup(func() { sc.Disconnect("fixture cleanup") })
	return sc
}

func renewalPollURL(base, sid string) string {
	return fmt.Sprintf("%s/socket.io/?EIO=4&transport=polling&sid=%s", base, url.QueryEscape(sid))
}

func postRenewalPacket(t *testing.T, base, sid, packet string) {
	t.Helper()
	response, err := http.Post(renewalPollURL(base, sid), "text/plain", strings.NewReader(packet))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
}
