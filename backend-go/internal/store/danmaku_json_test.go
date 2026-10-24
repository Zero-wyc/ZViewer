package store

import "testing"

// JSONArrayText 决定写库时的文本形态。Node 侧用 JSON.stringify，
// 输出紧凑无空格；Go 侧必须给出同样的字节，否则同一份数据在
// 两端读出来的字符串字段会「看起来不同」（虽然语义一致），
// 把逐字段对拍变成误报。
func TestJSONArrayText(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		fallback string
		want     string
	}{
		{"紧凑化带空格的数组", "[ 1, 2 ,3 ]", "[]", "[1,2,3]"},
		{"原样返回紧凑数组", `["a","b"]`, "[]", `["a","b"]`},
		{"对象数组", "[ {\"k\": 1} ]", "[]", `[{"k":1}]`},
		{"null 用兜底", "null", "[]", "[]"},
		{"空串用兜底", "", "[]", "[]"},
		{"非法 JSON 用兜底", "[1,", "[1]", "[1]"},
		{"对象不是数组也照样紧凑化", `{ "a" : 1 }`, "[]", `{"a":1}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := JSONArrayText([]byte(tc.in), tc.fallback); got != tc.want {
				t.Fatalf("JSONArrayText(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// 中文与转义字符必须原样保留：屏蔽词与已删除记录都是用户可见文案。
func TestJSONArrayTextKeepsUnicode(t *testing.T) {
	in := `["广告","刷屏\n第二行"]`
	if got := JSONArrayText([]byte(in), "[]"); got != in {
		t.Fatalf("got %q want %q", got, in)
	}
}
