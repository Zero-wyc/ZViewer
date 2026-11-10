package emby

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Emby 侧的行为必须与改造前逐字节一致：/emby 前缀 + X-Emby-Token 双头。
func TestItemsKeepEmbyConventions(t *testing.T) {
	var gotPath, gotToken, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Emby-Token")
		gotAuth = r.Header.Get("X-Emby-Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Items":[],"TotalRecordCount":0}`))
	}))
	t.Cleanup(srv.Close)

	client := NewClient(srv.URL, "tok-e")
	if _, err := client.Items(context.Background(), "u-1", "", ""); err != nil {
		t.Fatalf("Items: %v", err)
	}

	if gotPath != "/emby/Users/u-1/Items" {
		t.Errorf("路径错误: %q", gotPath)
	}
	if gotToken != "tok-e" {
		t.Errorf("X-Emby-Token = %q", gotToken)
	}
	if !strings.HasPrefix(gotAuth, "MediaBrowser Client=") {
		t.Errorf("X-Emby-Authorization = %q", gotAuth)
	}
	if strings.Contains(gotAuth, "Token=") {
		t.Errorf("Emby 的标识头不应携带令牌: %q", gotAuth)
	}
}

func TestDirectURLKeepsEmbyConventions(t *testing.T) {
	static := Protocol.DirectURL("http://nas:8096", "tok", "item-1", false, "&MediaSourceId=ms")
	want := "http://nas:8096/emby/Videos/item-1/stream?static=true&api_key=tok&MediaSourceId=ms"
	if static != want {
		t.Errorf("直链错误:\n got %q\nwant %q", static, want)
	}

	audio := Protocol.DirectURL("http://nas:8096", "tok", "item-1", true, "")
	wantAudio := "http://nas:8096/emby/Videos/item-1/main.m3u8?api_key=tok" +
		"&AudioCodec=aac&TranscodingMaxAudioChannels=2" +
		"&VideoBitrate=8000000&AudioBitrate=192000"
	if audio != wantAudio {
		t.Errorf("转码直链错误:\n got %q\nwant %q", audio, wantAudio)
	}
}

// Emby 没有 /Users/Me（它会把 "Me" 当 GUID 解析，回 500），所以协议里
// 不声明该路由：Me() 必须直接走 /Users，少一次必然失败的往返。
func TestMeSkipsUnsupportedUsersMe(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/emby/Users" {
			_, _ = w.Write([]byte(`[{"Id":"admin-1","Name":"boss","Policy":{"IsAdministrator":true}}]`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"Message":"Unrecognized Guid format."}`))
	}))
	t.Cleanup(srv.Close)

	me, err := NewClient(srv.URL, "tok-e").Me(context.Background())
	if err != nil {
		t.Fatalf("Me: %v", err)
	}
	if me.ID != "admin-1" {
		t.Errorf("应取管理员，实际 %q", me.ID)
	}
	for _, p := range paths {
		if p == "/emby/Users/Me" {
			t.Errorf("不应再请求 /Users/Me: %v", paths)
		}
	}
}
