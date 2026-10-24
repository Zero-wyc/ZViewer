package emby

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"zviewer/backend/internal/store"
)

// 版本标签的期望值是用 Node 的 buildEmbyVersions 跑出来的（不是我算的）：
// 体积文案走的是 JS 的 toFixed(1)，与 Go 的 %.1f 在 .x5 边界上不一致。
// 需要更新时先跑：
//
//	node -e "console.log(JSON.stringify(require('./backend/dist/services/emby-versions').buildEmbyVersions([...])))"
func TestBuildVersionsGolden(t *testing.T) {
	int64p := func(v int64) *int64 { return &v }
	intp := func(v int) *int { return &v }
	strp := func(v string) *string { return &v }

	cases := []struct {
		name    string
		source  EmbyMediaSrc
		label   string
		height  *int
		size    *int64
		hasCont bool
		cont    string
	}{
		{
			name: "1080P MKV 1.25GiB",
			source: EmbyMediaSrc{
				ID: "a", Size: int64p(1342177280), Container: strp("mkv"),
				MediaStreams: []EmbyMediaStream{{Type: "Video", Height: intp(1080)}},
			},
			label: "1080P · MKV · 1.3GB", height: intp(1080), size: int64p(1342177280),
			hasCont: true, cont: "mkv",
		},
		{
			// Name 参与拼接；容器要 trim 后大写；恰好 1GiB 要输出 1.0GB（不是 1GB）
			name: "Remux 2160P 1GiB",
			source: EmbyMediaSrc{
				ID: "b", Size: int64p(1073741824), Container: strp(" MKV "), Name: strp("Remux"),
				MediaStreams: []EmbyMediaStream{{Type: "Video", Height: intp(2160)}},
			},
			label: "Remux · 2160P · MKV · 1.0GB", height: intp(2160), size: int64p(1073741824),
			hasCont: true, cont: "MKV",
		},
		{
			// Height 为 0 时不拼 "0P"，但字段本身照样下发
			name: "MP4 1MB height0",
			source: EmbyMediaSrc{
				ID: "c", Size: int64p(1234567), Container: strp("mp4"),
				MediaStreams: []EmbyMediaStream{{Type: "Video", Height: intp(0)}, {Type: "Audio", Codec: strp("aac")}},
			},
			label: "MP4 · 1MB", height: intp(0), size: int64p(1234567),
			hasCont: true, cont: "mp4",
		},
		{
			// Size 为 0：不拼体积，但 size 字段要出现（Node 用 !== undefined 判断）
			name: "size0",
			source: EmbyMediaSrc{
				ID: "d", Size: int64p(0), Container: strp(""),
			},
			label: "版本 1", size: int64p(0),
		},
		{
			// 什么都没有 → 版本 N（N 从 1 开始）
			name:   "empty",
			source: EmbyMediaSrc{ID: "e"},
			label:  "版本 1",
		},
		{
			name: "2.2GB",
			source: EmbyMediaSrc{
				ID: "f", Size: int64p(2362232012),
			},
			label: "2.2GB", size: int64p(2362232012),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := BuildVersions([]EmbyMediaSrc{tc.source})
			if len(got) != 1 {
				t.Fatalf("期望 1 个版本，实际 %d", len(got))
			}
			v := got[0]
			if v.Label != tc.label {
				t.Fatalf("label = %q，期望 %q", v.Label, tc.label)
			}
			if (v.Height == nil) != (tc.height == nil) || (v.Height != nil && *v.Height != *tc.height) {
				t.Fatalf("height 不匹配: %v", v.Height)
			}
			if (v.Size == nil) != (tc.size == nil) || (v.Size != nil && *v.Size != *tc.size) {
				t.Fatalf("size 不匹配: %v", v.Size)
			}
			if tc.hasCont && v.Container != tc.cont {
				t.Fatalf("container = %q，期望 %q", v.Container, tc.cont)
			}
			if !tc.hasCont && v.Container != "" {
				t.Fatalf("container 应为空，实际 %q", v.Container)
			}
		})
	}
}

// 版本序号在整份列表里递增（"版本 N" 的 N 用的是原始下标，不是过滤后的）。
func TestBuildVersionsIndexForFallbackLabel(t *testing.T) {
	got := BuildVersions([]EmbyMediaSrc{{ID: "a", Size: ptrInt64(0)}, {ID: "b", Size: ptrInt64(0)}})
	if got[0].Label != "版本 1" || got[1].Label != "版本 2" {
		t.Fatalf("兜底标签错误: %q / %q", got[0].Label, got[1].Label)
	}
}

func ptrInt64(v int64) *int64 { return &v }

// toFixed 的边界：期望值来自 node -e "1.25.toFixed(1)" 等。
func TestJSFormatSize(t *testing.T) {
	cases := map[int64]string{
		1342177280: "1.3GB",
		1073741824: "1.0GB",
		2684354560: "2.5GB",
		1610612736: "1.5GB",
		2362232012: "2.2GB",
		536870912:  "512MB",
		1234567:    "1MB",
	}
	for size, want := range cases {
		if got := FormatSize(size); got != want {
			t.Errorf("FormatSize(%d) = %q，期望 %q", size, got, want)
		}
	}
}

func TestSelectSource(t *testing.T) {
	sources := []EmbyMediaSrc{{ID: "a"}, {ID: "b"}}
	if got := SelectSource(sources, "b"); got.ID != "b" {
		t.Fatalf("指定版本未命中: %q", got.ID)
	}
	// 未匹配时回退第一个（服务器默认 = 最高码率）
	if got := SelectSource(sources, "nope"); got.ID != "a" {
		t.Fatalf("未匹配应回退第一个，实际 %q", got.ID)
	}
	if got := SelectSource(sources, ""); got.ID != "a" {
		t.Fatalf("空 ms 应取第一个，实际 %q", got.ID)
	}
}

// newFakeSession 起一个只回 PlaybackInfo 的假 Emby。
func newFakeSession(t *testing.T, sourcesJSON string) (*Session, string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 客户端每个请求都必须带这两个头：会话令牌 + 客户端标识。
		if got := r.Header.Get("X-Emby-Token"); got != "tok-test" {
			t.Errorf("X-Emby-Token = %q", got)
		}
		if got := r.Header.Get("X-Emby-Authorization"); !strings.HasPrefix(got, "MediaBrowser Client=") {
			t.Errorf("X-Emby-Authorization = %q", got)
		}
		if !strings.HasSuffix(r.URL.Path, "/PlaybackInfo") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"MediaSources":` + sourcesJSON + `}`))
	}))
	t.Cleanup(srv.Close)
	client := NewClient(srv.URL, "tok-test")
	return &Session{Client: client, UserID: "user-1"}, srv.URL
}

func TestBuildResolvePayloadSingleVersion(t *testing.T) {
	sources := `[{"Id":"ms-1","Path":"/media/影片/a.mkv","Container":"mkv","Size":1024,
		"MediaStreams":[{"Type":"Video","Height":1080},{"Type":"Audio","Codec":"AAC"}]}]`
	session, baseURL := newFakeSession(t, sources)
	noHTTPS := false
	mount := &store.Mount{ID: 7, ServerURL: &baseURL, HttpsDirect: &noHTTPS}

	payload, err := BuildResolvePayload(context.Background(), ResolveParams{
		Session: session, Mount: mount, ItemID: "item-1", MountID: 7, Prefix: "emby",
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	if payload["title"] != "a.mkv" {
		t.Errorf("title = %v", payload["title"])
	}
	if payload["format"] != "mkv" {
		t.Errorf("format = %v", payload["format"])
	}
	// 音轨编码大小写不敏感，AAC 属于浏览器原生支持 → 不转码
	if payload["needsAudioTranscode"] != false {
		t.Errorf("AAC 不应触发转码")
	}
	if payload["audioCodec"] != "AAC" {
		t.Errorf("audioCodec = %v", payload["audioCodec"])
	}
	if payload["videoUrl"] != "/api/emby/proxy?mountId=7&path=item-1" {
		t.Errorf("videoUrl = %v", payload["videoUrl"])
	}
	if payload["multiVersion"] != false {
		t.Errorf("multiVersion 应为 false")
	}
	if _, ok := payload["streamUrl"]; ok {
		t.Errorf("没有 movieId 时不应下发 streamUrl")
	}
	if _, ok := payload["jellyfin"]; ok {
		t.Errorf("前缀是 emby 时不应出现 jellyfin 键")
	}
	direct, _ := payload["directUrl"].(string)
	want := baseURL + "/emby/Videos/item-1/stream?static=true&api_key=tok-test"
	if direct != want {
		t.Errorf("directUrl = %q，期望 %q", direct, want)
	}
}

func TestBuildResolvePayloadMultiVersionAndTranscode(t *testing.T) {
	sources := `[
		{"Id":"ms-hd","Path":"/media/a.mkv","Container":"mkv",
		 "MediaStreams":[{"Type":"Video","Height":1080},{"Type":"Audio","Codec":"aac"}]},
		{"Id":"ms-4k","Path":"/media/a 2160p.mkv","Container":"mkv",
		 "MediaStreams":[{"Type":"Video","Height":2160},{"Type":"Audio","Codec":"dts"}]}]`
	session, baseURL := newFakeSession(t, sources)
	noHTTPS := false
	mount := &store.Mount{ID: 3, ServerURL: &baseURL, HttpsDirect: &noHTTPS}
	movieID := int64(42)

	// 选 4K 版本：DTS 音轨 → 必须转码（format=hls、at=1、main.m3u8）
	payload, err := BuildResolvePayload(context.Background(), ResolveParams{
		Session: session, Mount: mount, ItemID: "it", MountID: 3, Prefix: "jellyfin",
		MediaSourceID: "ms-4k", MovieID: &movieID,
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	if payload["needsAudioTranscode"] != true {
		t.Errorf("DTS 必须触发转码")
	}
	if payload["format"] != "hls" {
		t.Errorf("转码时 format 必须是 hls，实际 %v", payload["format"])
	}
	if payload["mediaSourceId"] != "ms-4k" {
		t.Errorf("mediaSourceId = %v", payload["mediaSourceId"])
	}
	// 多版本 + 转码：两个标记都要出现在 URL 上
	wantVideo := "/api/jellyfin/proxy?mountId=3&path=it&at=1&ms=ms-4k"
	if payload["videoUrl"] != wantVideo {
		t.Errorf("videoUrl = %v，期望 %s", payload["videoUrl"], wantVideo)
	}
	wantStream := "/api/jellyfin/stream?movieId=42&at=1&ms=ms-4k"
	if payload["streamUrl"] != wantStream {
		t.Errorf("streamUrl = %v，期望 %s", payload["streamUrl"], wantStream)
	}
	direct, _ := payload["directUrl"].(string)
	if !strings.Contains(direct, "/emby/Videos/it/main.m3u8?api_key=tok-test") ||
		!strings.Contains(direct, "AudioCodec=aac") ||
		!strings.Contains(direct, "MediaSourceId=ms-4k") {
		t.Errorf("转码直链不对: %s", direct)
	}
	nested, ok := payload["jellyfin"].(map[string]any)
	if !ok || nested["itemId"] != "it" || nested["container"] != "mkv" {
		t.Errorf("前缀载荷不对: %v", payload["jellyfin"])
	}
}

// Path 缺失时 title / format 的兜底：title 用 item-<id>，format 仍取空串 → unknown。
func TestBuildResolvePayloadMissingPath(t *testing.T) {
	sources := `[{"Id":"ms-x","Container":"mp4","MediaStreams":[{"Type":"Video","Height":720}]}]`
	session, baseURL := newFakeSession(t, sources)
	noHTTPS := false
	mount := &store.Mount{ID: 1, ServerURL: &baseURL, HttpsDirect: &noHTTPS}

	payload, err := BuildResolvePayload(context.Background(), ResolveParams{
		Session: session, Mount: mount, ItemID: "abc", MountID: 1, Prefix: "emby",
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	if payload["title"] != "item-abc" {
		t.Errorf("title = %v，期望 item-abc", payload["title"])
	}
	if payload["format"] != "unknown" {
		t.Errorf("缺 Path 时 format 应为 unknown，实际 %v", payload["format"])
	}
	if payload["audioCodec"] != nil {
		t.Errorf("没有音轨时 audioCodec 应为 null，实际 %v", payload["audioCodec"])
	}
}

// 载荷必须是可 JSON 化的（map 里混了 nil 也不能让编码失败）。
func TestBuildResolvePayloadMarshalable(t *testing.T) {
	sources := `[{"Id":"m","Path":"a.mp4","MediaStreams":[]}]`
	session, baseURL := newFakeSession(t, sources)
	noHTTPS := false
	mount := &store.Mount{ID: 1, ServerURL: &baseURL, HttpsDirect: &noHTTPS}
	payload, err := BuildResolvePayload(context.Background(), ResolveParams{
		Session: session, Mount: mount, ItemID: "x", MountID: 1, Prefix: "emby",
	})
	if err != nil {
		t.Fatalf("构建失败: %v", err)
	}
	if _, err := json.Marshal(payload); err != nil {
		t.Fatalf("载荷无法编码: %v", err)
	}
}
