package anisubs

import "testing"

// ani-subs 的订阅里存在 `.nav-tabs a[href^=#playlist]` 这种未加引号的属性值，
// 浏览器 querySelectorAll 能吃，cascadia 会直接解析失败返回空集。
// 这是「规则看起来完全对得上页面，却一个剧集都提取不出来」的根因。
func TestNormalizeSelector(t *testing.T) {
	cases := map[string]string{
		`.nav-tabs a[href^=#playlist]`:      `.nav-tabs a[href^="#playlist"]`,
		`a[href*=/play/]`:                   `a[href*="/play/"]`,
		`.myui-content__list`:               `.myui-content__list`,
		`a[href^="#playlist"]`:              `a[href^="#playlist"]`,
		`ul li a`:                           `ul li a`,
		`div[data-src=abc] span`:            `div[data-src="abc"] span`,
		`a[href$=.html][target=_blank]`:     `a[href$=".html"][target="_blank"]`,
		`#glist-1 > div.module-blocklist a`: `#glist-1 > div.module-blocklist a`,
	}
	for input, want := range cases {
		if got := normalizeSelector(input); got != want {
			t.Fatalf("normalizeSelector(%q)=%q want=%q", input, got, want)
		}
	}
}

// MacCMS 播放页把地址放在 player_aaaa 里；规则正则带 `^` 锚定整行，
// 作用在整页 HTML 上必然失配。这里固定住三种 encrypt 语义。
func TestParsePlayerConfig(t *testing.T) {
	config := &MatchVideo{}

	t.Run("encrypt=0 绝对地址", func(t *testing.T) {
		html := `<script>var player_aaaa={"url":"https:\/\/play.example.com\/play\/abc\/index.m3u8","encrypt":0,"from":"xlm3u8"}</script>`
		match := parsePlayerConfig(html, config, "https://site.example/v/1.html")
		if match == nil {
			t.Fatal("应当解析出地址")
		}
		if match.URL != "https://play.example.com/play/abc/index.m3u8" {
			t.Fatalf("url=%q", match.URL)
		}
		if match.Format != FormatHLS {
			t.Fatalf("format=%q", match.Format)
		}
	})

	t.Run("encrypt=2 base64", func(t *testing.T) {
		// base64("https://cdn.example.com/a/index.m3u8")
		html := `<script>player_aaaa={"url":"aHR0cHM6Ly9jZG4uZXhhbXBsZS5jb20vYS9pbmRleC5tM3U4","encrypt":2}</script>`
		match := parsePlayerConfig(html, config, "https://site.example/v/1.html")
		if match == nil || match.URL != "https://cdn.example.com/a/index.m3u8" {
			t.Fatalf("match=%+v", match)
		}
	})

	t.Run("相对路径补全", func(t *testing.T) {
		html := `<script>player_aaaa={"url":"/play/1/index.m3u8","encrypt":0}</script>`
		match := parsePlayerConfig(html, config, "https://site.example/v/1.html")
		if match == nil || match.URL != "https://site.example/play/1/index.m3u8" {
			t.Fatalf("match=%+v", match)
		}
	})

	// 站点自定义加密串（樱花动漫的 MCZY-、热播之家的 encrypt=3 hex）不能
	// 拼成相对路径：那样会得到一个永远 404 的假地址，比解析失败更难排查。
	t.Run("拒绝自定义加密串", func(t *testing.T) {
		for _, body := range []string{
			`{"url":"MCZY-e9e9F_CCKeiXYnCeeN-5LdWQCuqgjQ90","encrypt":0}`,
			`{"url":"69534a34464248696c6832706e6a45344637703149","encrypt":3}`,
		} {
			html := `<script>player_aaaa=` + body + `</script>`
			if match := parsePlayerConfig(html, config, "https://site.example/v/1.html"); match != nil {
				t.Fatalf("不该把加密串当播放地址: %q -> %q", body, match.URL)
			}
		}
	})
}
