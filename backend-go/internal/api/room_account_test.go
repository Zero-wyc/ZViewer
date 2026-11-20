package api

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestRoomID(t *testing.T) {
	long := strings.Repeat("a", 64)
	cases := []struct {
		name   string
		header string
		query  string
		want   string
	}{
		{name: "无头无 query", want: ""},
		{name: "header 去空白", header: " room-1 ", want: "room-1"},
		{name: "query 兜底", query: "roomId=room-2", want: "room-2"},
		{name: "header 优先于 query", header: "room-1", query: "roomId=room-2", want: "room-1"},
		{name: "超长无效", header: strings.Repeat("a", 65), want: ""},
		{name: "恰好 64 字符有效", header: long, want: long},
		{name: "全空白视为无效", header: "   ", query: "roomId=  ", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/rooms/x/accounts", nil)
			if tc.header != "" {
				req.Header.Set("X-Room-Id", tc.header)
			}
			if tc.query != "" {
				req.URL.RawQuery = tc.query
			}
			if got := requestRoomID(req); got != tc.want {
				t.Fatalf("requestRoomID() = %q, want %q", got, tc.want)
			}
		})
	}
	if got := requestRoomID(nil); got != "" {
		t.Fatalf("requestRoomID(nil) = %q, want empty", got)
	}
}
