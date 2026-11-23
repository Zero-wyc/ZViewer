package bilibili

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// resetProbeCache 清空探测结果缓存（测试间隔离）。
func resetProbeCache() {
	probeCache.mu.Lock()
	defer probeCache.mu.Unlock()
	probeCache.items = make(map[string]probeCacheEntry)
}

// TestCheckURLReachableCachesProbe 验证同一签名地址在短时间只探测一次。
//
// 同一首歌在一个会话里会被解析多次（首次播放、歌词页背景、直链失效自愈），
// 每次解析都对音视频主备地址各 HEAD 一次。地址往往完全相同，重复探测纯粹
// 白耗 B站 CDN 的签名额度，因此必须有结果缓存。
func TestCheckURLReachableCachesProbe(t *testing.T) {
	resetProbeCache()
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	first := server.URL + "/audio.m4s?deadline=1&upsig=abc"
	if !checkURLReachable(context.Background(), first) {
		t.Fatal("首次探测应判定可达")
	}
	if !checkURLReachable(context.Background(), first) {
		t.Fatal("缓存命中仍应判定可达")
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("HEAD 次数 = %d，期望 1（第二次命中缓存）", got)
	}

	// 不同地址不能串用缓存
	checkURLReachable(context.Background(), server.URL+"/video.m4s?deadline=1&upsig=abc")
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("不同地址 HEAD 次数 = %d，期望 2", got)
	}
}

// TestCheckURLReachableCachesFailure 验证失败结果同样被缓存（避免坏地址反复探测）。
func TestCheckURLReachableCachesFailure(t *testing.T) {
	resetProbeCache()
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	url := server.URL + "/expired.m4s"
	if checkURLReachable(context.Background(), url) {
		t.Fatal("403 应判定不可达")
	}
	if checkURLReachable(context.Background(), url) {
		t.Fatal("第二次仍应判定不可达")
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("HEAD 次数 = %d，期望 1（失败结果也走缓存）", got)
	}
}

// TestProbeCacheTrimsWhenFull 验证缓存超量时不会无限增长。
func TestProbeCacheTrimsWhenFull(t *testing.T) {
	resetProbeCache()
	for i := 0; i < probeCacheMax+32; i++ {
		writeProbeCache(string(rune('a'+i%26))+string(rune('0'+i%10))+string(rune(i)), true)
	}
	probeCache.mu.Lock()
	size := len(probeCache.items)
	probeCache.mu.Unlock()
	if size > probeCacheMax {
		t.Fatalf("缓存条目 = %d，超过上限 %d", size, probeCacheMax)
	}
}

// TestIsMcdnURL 验证 mcdn 域名识别：只认 mcdn P2P 节点，不误伤形近域名。
func TestIsMcdnURL(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"根域", "https://mcdn.bilivideo.cn/video.m4s", true},
		{"子域带端口", "https://xy1x2x3.mcdn.bilivideo.cn:8082/video.m4s", true},
		{"大写域名", "https://XY.MCDN.BILIVIDEO.CN/video.m4s", true},
		{"upos 不算", "https://upos-sz-mirrorcos.bilivideo.com/video.m4s", false},
		{"形近域名不算", "https://notmcdn.bilivideo.cn/video.m4s", false},
		{"空串", "", false},
	}
	for _, c := range cases {
		if got := isMcdnURL(c.raw); got != c.want {
			t.Errorf("%s: isMcdnURL(%q) = %v，期望 %v", c.name, c.raw, got, c.want)
		}
	}
}

// TestOrderTrackCandidates 验证「非 mcdn 优先」是稳定分区：只挪 mcdn，其余保持原序。
func TestOrderTrackCandidates(t *testing.T) {
	const (
		mcdn1  = "https://a.mcdn.bilivideo.cn:8082/v1.m4s"
		upos1  = "https://upos-sz-mirrorcos.bilivideo.com/v1.m4s"
		upos2  = "https://upos-sz-mirrorali.bilivideo.com/v1.m4s"
		mcdn2  = "https://b.mcdn.bilivideo.cn:8082/v1.m4s"
		direct = "https://cn-hbxy-cu-01.bilivideo.com/v1.m4s"
	)
	got := orderTrackCandidates(mcdn1, []string{upos1, mcdn2, upos2})
	want := []string{upos1, upos2, mcdn1, mcdn2}
	if len(got) != len(want) {
		t.Fatalf("候选数 = %d，期望 %d（%v）", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 个候选 = %q，期望 %q（完整结果 %v）", i, got[i], want[i], got)
		}
	}

	// 全非 mcdn：顺序必须原样保留，不能因为分区被打乱。
	got = orderTrackCandidates(direct, []string{upos1, upos2})
	if got[0] != direct || got[1] != upos1 || got[2] != upos2 {
		t.Fatalf("全非 mcdn 时顺序被改变: %v", got)
	}

	// 空输入不产生空串候选。
	if got := orderTrackCandidates("", nil); len(got) != 0 {
		t.Fatalf("空输入应返回空切片，实际 %v", got)
	}
}

// TestPickTrackURLPrefersNonMcdn 验证跳过探测时不会把 mcdn 死链下发给客户端。
//
// 这是 CLI 房主直链的真实故障场景：baseUrl 落在 mcdn 上，skipCdnCheck 直接把
// 它交给播放器，用户点开即 502。
func TestPickTrackURLPrefersNonMcdn(t *testing.T) {
	track := &DashMediaTrack{
		BaseURL:   "https://xy1.mcdn.bilivideo.cn:8082/video.m4s",
		BackupURL: []string{"https://upos-sz-mirrorcos.bilivideo.com/video.m4s"},
	}
	if got := PickTrackURL(track); got != "https://upos-sz-mirrorcos.bilivideo.com/video.m4s" {
		t.Fatalf("应优先选非 mcdn 候选，实际 %q", got)
	}

	// 全部是 mcdn 时退回第一个（总比没有地址强）。
	onlyMcdn := &DashMediaTrack{
		BaseURL:   "https://a.mcdn.bilivideo.cn:8082/video.m4s",
		BackupURL: []string{"https://b.mcdn.bilivideo.cn:8082/video.m4s"},
	}
	if got := PickTrackURL(onlyMcdn); got != "https://a.mcdn.bilivideo.cn:8082/video.m4s" {
		t.Fatalf("全 mcdn 时应退回 baseUrl，实际 %q", got)
	}

	// http 地址仍要升级成 https（HTTPS 页面里的 Mixed Content 会被浏览器拦截）。
	httpTrack := &DashMediaTrack{BaseURL: "http://upos-sz-mirrorcos.bilivideo.com/video.m4s"}
	if got := PickTrackURL(httpTrack); got != "https://upos-sz-mirrorcos.bilivideo.com/video.m4s" {
		t.Fatalf("http 地址应升级为 https，实际 %q", got)
	}

	if got := PickTrackURL(nil); got != "" {
		t.Fatalf("nil 轨道应返回空串，实际 %q", got)
	}
}

// TestFindReachableMediaURLStillProbes 验证排序改动没有破坏探测主流程：
// 非 mcdn 候选可达时仍能被选中（mcdn 延迟只影响优先级，不影响结论）。
func TestFindReachableMediaURLStillProbes(t *testing.T) {
	resetProbeCache()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	got, ok := FindReachableMediaURL(context.Background(), MediaTrackCandidate{
		BaseURL:   server.URL + "/video.m4s?sig=1",
		BackupURL: []string{server.URL + "/video.m4s?sig=2"},
	})
	if !ok || got == "" {
		t.Fatalf("可达地址应被选中，got=%q ok=%v", got, ok)
	}
}
