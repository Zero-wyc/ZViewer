package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"zviewer/backend/internal/emby"
)

// HLS 子资源白名单：它是 /proxy 不被当成开放代理的唯一防线，
// 所以每条放行/拒绝规则都单独锁住。
func TestValidateEmbyHLSResource(t *testing.T) {
	mustURL := func(raw string) *url.URL {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("URL 解析失败: %s", raw)
		}
		return parsed
	}
	cases := []struct {
		name     string
		upstream string
		target   string
		wantOK   bool
	}{
		{
			name:     "同源同条目的分片",
			upstream: "http://nas:8096/emby/Videos/m1/main.m3u8?api_key=t",
			target:   "http://nas:8096/emby/Videos/m1/hls1/main/0.ts",
			wantOK:   true,
		},
		{
			name:     "同源但换了条目",
			upstream: "http://nas:8096/emby/Videos/m1/main.m3u8?api_key=t",
			target:   "http://nas:8096/emby/Videos/m2/hls1/main/0.ts",
			wantOK:   false,
		},
		{
			name:     "换主机（开放代理）",
			upstream: "http://nas:8096/emby/Videos/m1/main.m3u8?api_key=t",
			target:   "http://169.254.169.254/latest/meta-data/",
			wantOK:   false,
		},
		{
			name:     "同主机不同端口",
			upstream: "http://nas:8096/emby/Videos/m1/main.m3u8?api_key=t",
			target:   "http://nas:9999/emby/Videos/m1/hls1/0.ts",
			wantOK:   false,
		},
		{
			// Jellyfin 的绝对路径子项会省略可选的 /emby 前缀
			name:     "Jellyfin 省略 emby 前缀",
			upstream: "http://nas:8096/emby/Videos/m1/main.m3u8?api_key=t",
			target:   "http://nas:8096/Videos/m1/hls1/main/0.ts",
			wantOK:   true,
		},
		{
			name:     "Jellyfin 自身就没有 emby 前缀",
			upstream: "http://nas:8096/Videos/m1/main.m3u8?api_key=t",
			target:   "http://nas:8096/Videos/m1/hls1/main/0.ts",
			wantOK:   true,
		},
		{
			name:     "带用户名的地址必须拒绝",
			upstream: "http://nas:8096/emby/Videos/m1/main.m3u8?api_key=t",
			target:   "http://user:pw@nas:8096/emby/Videos/m1/hls1/0.ts",
			wantOK:   false,
		},
		{
			name:     "跨出 videos 子树",
			upstream: "http://nas:8096/emby/Videos/m1/main.m3u8?api_key=t",
			target:   "http://nas:8096/emby/Users/../System/Info",
			wantOK:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			upstream := mustURL(tc.upstream)
			target := mustURL(tc.target)
			err := validateEmbyHLSResource(target, upstream, "m1")
			if tc.wantOK && err != nil {
				t.Fatalf("应放行，却拒绝了: %v", err)
			}
			if !tc.wantOK && err == nil {
				t.Fatalf("应拒绝，却放行了")
			}
		})
	}
}

func TestResolveEmbyHLSResource(t *testing.T) {
	const upstream = "http://nas:8096/emby/Videos/m1/stream?static=true&api_key=SECRET"

	// 没有 resource：原样返回（不碰 query）
	r := httptest.NewRequest(http.MethodGet, "/api/emby/proxy?mountId=1&path=m1", nil)
	got, err := resolveEmbyHLSResource(r, upstream, "m1")
	if err != nil || got != upstream {
		t.Fatalf("无 resource 时应原样返回，实际 %q / %v", got, err)
	}

	// 合法子资源：会补上 api_key（上游要它），指向同一分片
	r = httptest.NewRequest(http.MethodGet,
		"/api/emby/proxy?mountId=1&path=m1&resource="+
			url.QueryEscape("/emby/Videos/m1/hls1/main/0.ts"), nil)
	got, err = resolveEmbyHLSResource(r, upstream, "m1")
	if err != nil {
		t.Fatalf("合法子资源被拒: %v", err)
	}
	if got != "http://nas:8096/emby/Videos/m1/hls1/main/0.ts?api_key=SECRET" {
		t.Fatalf("子资源地址错误: %q", got)
	}

	// 非法子资源：必须报错（否则 /proxy 就是开放代理）
	r = httptest.NewRequest(http.MethodGet,
		"/api/emby/proxy?mountId=1&path=m1&resource="+
			url.QueryEscape("http://evil.example/x.ts"), nil)
	if _, err = resolveEmbyHLSResource(r, upstream, "m1"); err == nil {
		t.Fatalf("跨站子资源必须拒绝")
	}

	// 重复参数（Express 下是数组，typeof !== 'string'）→ 忽略，返回原地址
	r = httptest.NewRequest(http.MethodGet,
		"/api/emby/proxy?mountId=1&path=m1&resource=a&resource=b", nil)
	got, err = resolveEmbyHLSResource(r, upstream, "m1")
	if err != nil || got != upstream {
		t.Fatalf("重复 resource 应忽略，实际 %q / %v", got, err)
	}
}

// weakETag 必须与 Express 默认（etag: 'weak'）逐字符一致：
// 期望值来自 node -e "require('etag')(Buffer.from('PNG-m1'), null, {weak:true})"。
func TestWeakETag(t *testing.T) {
	cases := map[string]string{
		"PNG-m1":                 `W/"6-xxyv375B/NgLHhRnmuU1FjQApT0"`,
		"":                       `W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"`,
		strings.Repeat("x", 300): `W/"12c-Av1oJTBx+JVxjI1B9/9mWr4aYpA"`,
	}
	for body, want := range cases {
		if got := weakETag([]byte(body)); got != want {
			t.Errorf("weakETag(%q) = %q，期望 %q", body, got, want)
		}
	}
}

func TestMatchesIfNoneMatch(t *testing.T) {
	const etag = `W/"6-abc"`
	cases := map[string]bool{
		"":                   false,
		`W/"6-abc"`:          true,
		`"6-abc"`:            true, // 弱比较：忽略 W/ 前缀
		`W/"1-a", W/"6-abc"`: true,
		"*":                  true,
		`W/"9-zzz"`:          false,
	}
	for header, want := range cases {
		if got := matchesIfNoneMatch(header, etag); got != want {
			t.Errorf("If-None-Match %q → %v，期望 %v", header, got, want)
		}
	}
}

// 条目 DTO 的字段缺失语义：Node 侧 undefined 的键必须整键消失，
// 不能下发 ""/0（前端用 `??` 兜底，空串会让兜底失效）。
func TestMapEmbyEntries(t *testing.T) {
	intp := func(v int) *int { return &v }
	i64p := func(v int64) *int64 { return &v }
	strp := func(v string) *string { return &v }
	boolp := func(v bool) *bool { return &v }

	items := []emby.EmbyItem{
		{
			ID: "m1", Name: strp("电影"), Type: strp("Movie"),
			Path: strp("/media/a.mkv"), ImageTags: &emby.EmbyImageTags{Primary: "tag1"},
			ProductionYear: intp(2021), RunTimeTicks: i64p(97200000000), ChildCount: intp(0),
		},
		{
			// ImageTags 为空对象 + 没有 Path/年份/时长
			ID: "f1", Name: strp("文件夹"), Type: strp("CollectionFolder"),
			ImageTags: &emby.EmbyImageTags{}, IsFile: boolp(false),
		},
		{
			// 类型不认识但 IsFile === true → 仍然算文件
			ID: "x1", Type: strp("Unknown"), IsFile: boolp(true),
		},
		{
			// 剧集：有集号与递归条目数
			ID: "s1", Name: strp("某剧"), Type: strp("TvSeries"),
			IndexNumber: intp(2), ParentIndexNumber: intp(1), RecursiveItemCount: intp(12),
		},
	}
	entries := mapEmbyEntries(items)
	if len(entries) != 4 {
		t.Fatalf("条目数 = %d", len(entries))
	}

	raw, err := json.Marshal(entries[0])
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	var first map[string]any
	_ = json.Unmarshal(raw, &first)
	if first["duration"] != float64(9720) {
		t.Errorf("时长应换算成秒: %v", first["duration"])
	}
	if first["type"] != "file" || first["embyType"] != "Movie" {
		t.Errorf("可播放类型映射错误: %v", first)
	}
	if first["imageTag"] != "tag1" || first["filePath"] != "/media/a.mkv" {
		t.Errorf("海报/路径字段错误: %v", first)
	}

	raw, _ = json.Marshal(entries[1])
	var second map[string]any
	_ = json.Unmarshal(raw, &second)
	for _, key := range []string{"imageTag", "filePath", "productionYear", "duration", "recursiveItemCount"} {
		if _, present := second[key]; present {
			t.Errorf("缺失字段 %q 不应出现在响应里: %v", key, second)
		}
	}
	if second["type"] != "directory" || second["childCount"] != float64(0) {
		t.Errorf("目录映射错误: %v", second)
	}

	if entries[2].Type != "file" {
		t.Errorf("IsFile=true 应算文件: %+v", entries[2])
	}
	if entries[3].Type != "file" {
		t.Errorf("TvSeries 应算文件: %+v", entries[3])
	}
}
