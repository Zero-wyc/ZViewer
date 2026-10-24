package api_test

import (
	"net/http"
	"net/url"
	"testing"
)

// TestAntileechProxyRequiresAuth 四个数据源代理都必须鉴权。
//
// 这些端点会把客户端自带的 Cookie/Referer 转发给任意公网地址，
// 不鉴权等于给外部一个免费的探测跳板。
func TestAntileechProxyRequiresAuth(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	for _, module := range []string{"anime", "anisubs", "kazumi", "cms"} {
		t.Run(module, func(t *testing.T) {
			resp := env.do(t, http.MethodGet,
				"/api/stream/"+module+"/proxy?url=https%3A%2F%2Fexample.com%2Fa.mp4", "", nil)
			if resp.status != http.StatusUnauthorized {
				t.Fatalf("期望 401，实际 %d %s", resp.status, resp.raw)
			}
		})
	}
}

func TestAntileechProxyValidatesTarget(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "proxier", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "proxier")

	t.Run("缺 url 参数", func(t *testing.T) {
		resp := env.do(t, http.MethodGet, "/api/stream/kazumi/proxy", token, nil)
		if resp.status != http.StatusBadRequest || resp.message() != "缺少 url 参数" {
			t.Fatalf("期望 400 缺少 url 参数，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("空白 url", func(t *testing.T) {
		resp := env.do(t, http.MethodGet, "/api/stream/kazumi/proxy?url=%20%20", token, nil)
		if resp.status != http.StatusBadRequest {
			t.Fatalf("期望 400，实际 %d", resp.status)
		}
	})

	internalTargets := []string{
		"http://127.0.0.1:8096/video.mp4",
		"http://192.168.1.5:3333/api/admin/settings",
		"http://[::1]:3333/",
		"http://localhost/x",
	}
	for _, target := range internalTargets {
		t.Run("拒绝内网 "+target, func(t *testing.T) {
			path := "/api/stream/kazumi/proxy?url=" + url.QueryEscape(target)
			resp := env.do(t, http.MethodGet, path, token, nil)
			if resp.status != http.StatusForbidden || resp.message() != "不允许代理内网地址" {
				t.Fatalf("期望 403 不允许代理内网地址，实际 %d %q", resp.status, resp.message())
			}
		})
	}

	// 不带协议前缀的裸地址同样要拦（NAS 用户常这么填）
	t.Run("拒绝裸内网地址", func(t *testing.T) {
		path := "/api/stream/cms/proxy?url=" + url.QueryEscape("192.168.1.5:8096/live.m3u8")
		resp := env.do(t, http.MethodGet, path, token, nil)
		if resp.status != http.StatusForbidden {
			t.Fatalf("期望 403，实际 %d", resp.status)
		}
	})
}
