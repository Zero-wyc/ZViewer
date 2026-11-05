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
