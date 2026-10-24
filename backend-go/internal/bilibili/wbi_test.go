package bilibili

import "testing"

// 这组黄金值由 Node 侧的 wbi.ts 算法（同一张 mixin 表 + 同一套 encodeURIComponent）
// 实跑得出。任何一项不一致，都说明 Go 侧的编码或排序与 B站 服务端算出的 w_rid 不同，
// 症状是搜索/view/playurl 全线 -403，而代码看起来毫无问题。
func TestMixinKeyMatchesNode(t *testing.T) {
	const (
		imgKey = "7cd084941338484aae1ad9425b84077c"
		subKey = "493c2d56d5e7f4d0f9a0f2e5b6c8d901"
	)
	if got := MixinKey(imgKey, subKey); got != "d01d2124aa3cc04c474993dea704454c" {
		t.Fatalf("mixinKey 不一致:\n  Go   = %s\n  Node = d01d2124aa3cc04c474993dea704454c", got)
	}
}

func TestSignParamsMatchesNode(t *testing.T) {
	const (
		imgKey = "7cd084941338484aae1ad9425b84077c"
		subKey = "493c2d56d5e7f4d0f9a0f2e5b6c8d901"
	)

	cases := []struct {
		name     string
		params   *Params
		wts      int64
		wantWrid string
	}{
		{
			name: "playurl 参数",
			params: NewParams().
				Set("bvid", "BV1GJ411x7h7").
				Set("cid", "123456").
				Set("qn", "80").
				Set("fnver", "0").
				Set("fnval", "16").
				Set("fourk", "1"),
			wts:      1700000000,
			wantWrid: "1578e87b9dc8cdb8179b47a28289e495",
		},
		{
			name: "搜索词含特殊字符",
			params: NewParams().
				Set("keyword", "原神 4K 测试!@#$%^&*()_+-=[]{};:,.<>/?~`|'\"").
				Set("search_type", "video").
				Set("page", "1").
				Set("page_size", "20"),
			wts:      1700000001,
			wantWrid: "7110c33937e4f987aeebe9289f2dfd17",
		},
		{
			name:     "空值参数不参与签名",
			params:   NewParams().Set("keyword", "中文 😀 emoji").Set("empty", ""),
			wts:      1700000002,
			wantWrid: "bfee537b5d4738e48ce7db040c1b46a1",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			signed := signParamsAt(tc.params, imgKey, subKey, tc.wts)
			if got := signed.Get("w_rid"); got != tc.wantWrid {
				t.Fatalf("w_rid 不一致:\n  Go   = %s\n  Node = %s\n  query = %s",
					got, tc.wantWrid, signed.Encode())
			}
			if signed.Get("wts") != itoa(tc.wts) {
				t.Fatalf("wts 未写入: %s", signed.Get("wts"))
			}
		})
	}
}

// TestEncodeComponentMatchesEncodeURIComponent 逐字符验证编码表。
//
// 最容易出错的是这五个字符：! * ( ) ' —— encodeURIComponent 保留它们，
// Go 的 url.QueryEscape 会转义。用 QueryEscape 实现签名会得到完全不同的 w_rid。
func TestEncodeComponentMatchesEncodeURIComponent(t *testing.T) {
	cases := []struct{ input, want string }{
		{"a b", "a%20b"},
		{"!*()~'-_.", "!*()~'-_."},
		{"+/=&?#[]@$,;:%", "%2B%2F%3D%26%3F%23%5B%5D%40%24%2C%3B%3A%25"},
		{"中文", "%E4%B8%AD%E6%96%87"},
		{"😀", "%F0%9F%98%80"},
		{"BV1GJ411x7h7", "BV1GJ411x7h7"},
		// Node 侧对整串的实测输出，用作交叉校验
		{"a b!*()~'-_.中😀+/=&?#[]@$,;:%",
			"a%20b!*()~'-_.%E4%B8%AD%F0%9F%98%80%2B%2F%3D%26%3F%23%5B%5D%40%24%2C%3B%3A%25"},
	}
	for _, tc := range cases {
		if got := encodeComponent(tc.input); got != tc.want {
			t.Errorf("encodeComponent(%q):\n  Go   = %s\n  期望 = %s", tc.input, got, tc.want)
		}
	}
}

func TestParamsEncodeKeepsInsertionOrder(t *testing.T) {
	p := NewParams().Set("bvid", "BV1").Set("cid", "2").Set("qn", "80")
	// 重复 Set 同一键不改变位置（与 JS 对象赋值语义一致）
	p.Set("bvid", "BV2")
	if got, want := p.Encode(), "bvid=BV2&cid=2&qn=80"; got != want {
		t.Fatalf("Encode() = %s, 期望 %s", got, want)
	}
	// Clone 后改副本不影响原参数
	clone := p.Clone().Set("qn", "32")
	if p.Get("qn") != "80" {
		t.Fatalf("Clone 未隔离: 原参数 qn = %s", p.Get("qn"))
	}
	if clone.Get("qn") != "32" {
		t.Fatalf("Clone 写入失败")
	}
}

func TestKeyFromURL(t *testing.T) {
	cases := map[string]string{
		"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png": "7cd084941338484aae1ad9425b84077c",
		"https://i0.hdslb.com/bfs/wbi/abc123":                               "abc123",
		"":                                                                  "",
	}
	for input, want := range cases {
		if got := keyFromURL(input); got != want {
			t.Errorf("keyFromURL(%q) = %q, 期望 %q", input, got, want)
		}
	}
}

// itoa 避免为一条断言引入 strconv。
func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for v > 0 {
		pos--
		buf[pos] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[pos:])
}
