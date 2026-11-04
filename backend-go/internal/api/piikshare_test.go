package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"zviewer/backend/internal/share/piikbridge"
)

// 前端把 Piik 当默认链路，只有这个探头说 false 时才会退回旧实现。
// 桥接层没起来却回 true，等于让所有人的共享页都对着一个 503 的 /signal。
func TestShareCapabilitiesReportsBridgeAvailability(t *testing.T) {
	cases := []struct {
		name   string
		bridge *piikbridge.Bridge
		want   bool
	}{
		{name: "桥接层没起来", bridge: nil, want: false},
		{name: "桥接层已挂载", bridge: &piikbridge.Bridge{}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := &Server{Deps: Deps{PiikShare: tc.bridge}}
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/share/capabilities", nil)

			server.handleShareCapabilities(recorder, request)

			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
			}
			var payload struct {
				Piik *bool `json:"piik"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("解析响应失败: %v（body=%s）", err, recorder.Body.String())
			}
			if payload.Piik == nil {
				t.Fatalf("响应里没有 piik 字段：%s", recorder.Body.String())
			}
			if *payload.Piik != tc.want {
				t.Fatalf("piik = %v, want %v", *payload.Piik, tc.want)
			}
		})
	}
}
