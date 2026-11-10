package jellyfin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Jellyfin 12 的三条硬约束：无 /emby 前缀、Authorization: MediaBrowser、
// 列表走 /Items?userId=。任何一条回退都会让挂载在 12.x 上 404/401。
func TestItemsUseNativeJellyfinAPI(t *testing.T) {
	var (
		gotPath  string
		gotQuery map[string]string
		gotAuth  string
		gotToken string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotToken = r.Header.Get("X-Emby-Token")
		gotQuery = map[string]string{
			"userId":  r.URL.Query().Get("userId"),
			"ApiKey":  r.URL.Query().Get("ApiKey"),
			"api_key": r.URL.Query().Get("api_key"),
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Items":[],"TotalRecordCount":0}`))
	}))
	t.Cleanup(srv.Close)

	client := NewClient(srv.URL, "tok-1")
	if _, err := client.Items(context.Background(), "user-9", "", ""); err != nil {
		t.Fatalf("Items: %v", err)
	}

	if gotPath != "/Items" {
		t.Errorf("路径应为 /Items（无前缀），实际 %q", gotPath)
	}
	if gotQuery["userId"] != "user-9" {
		t.Errorf("userId = %q", gotQuery["userId"])
	}
	if !strings.HasPrefix(gotAuth, "MediaBrowser Client=") || !strings.Contains(gotAuth, `Token="tok-1"`) {
		t.Errorf("Authorization 必须是带令牌的 MediaBrowser 头，实际 %q", gotAuth)
	}
	if gotToken != "" {
		t.Errorf("不应再发 X-Emby-Token，实际 %q", gotToken)
	}
	if gotQuery["api_key"] != "" {
		t.Errorf("legacy api_key 参数不应出现")
	}
}

func TestUserViewsUseUserViewsEndpoint(t *testing.T) {
	var gotPath, gotUserID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotUserID = r.URL.Query().Get("userId")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Items":[]}`))
	}))
	t.Cleanup(srv.Close)

	client := NewClient(srv.URL, "tok-2")
	if _, err := client.UserViews(context.Background(), "u-1"); err != nil {
		t.Fatalf("UserViews: %v", err)
	}
	if gotPath != "/UserViews" {
		t.Errorf("路径应为 /UserViews，实际 %q", gotPath)
	}
	if gotUserID != "u-1" {
		t.Errorf("userId = %q", gotUserID)
	}
}

func TestLoginUsesJellyfinEndpoint(t *testing.T) {
	var (
		gotPath string
		gotAuth string
		gotBody map[string]string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"AccessToken":"tok-login","ServerId":"s1","User":{"Id":"u1","Name":"root"}}`))
	}))
	t.Cleanup(srv.Close)

	result, err := Login(context.Background(), srv.URL, "root", "pw")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	if gotPath != "/Users/AuthenticateByName" {
		t.Errorf("登录路径错误: %q", gotPath)
	}
	if strings.Contains(gotAuth, "Token=") {
		t.Errorf("登录请求不应携带令牌: %q", gotAuth)
	}
	if !strings.HasPrefix(gotAuth, "MediaBrowser Client=") {
		t.Errorf("登录请求缺少客户端标识: %q", gotAuth)
	}
	if gotBody["Username"] != "root" || gotBody["Pw"] != "pw" {
		t.Errorf("登录体错误: %+v", gotBody)
	}
	if result.Token != "tok-login" || result.UserID != "u1" {
		t.Errorf("登录结果解析错误: %+v", result)
	}
}

func TestDirectURLUsesNativePrefixAndApiKey(t *testing.T) {
	static := Protocol.DirectURL("http://nas:8096", "tok", "item-1", false, "&MediaSourceId=ms")
	want := "http://nas:8096/Videos/item-1/stream?static=true&ApiKey=tok&MediaSourceId=ms"
	if static != want {
		t.Errorf("直链错误:\n got %q\nwant %q", static, want)
	}

	audio := Protocol.DirectURL("http://nas:8096", "tok", "item-1", true, "")
	if !strings.HasPrefix(audio, "http://nas:8096/Videos/item-1/master.m3u8?ApiKey=tok") {
		t.Errorf("转码直链错误: %q", audio)
	}
	if strings.Contains(audio, "/emby/") {
		t.Errorf("转码直链不应带 /emby 前缀: %q", audio)
	}
}
