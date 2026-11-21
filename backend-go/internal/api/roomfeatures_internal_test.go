package api

import (
	"encoding/json"
	"testing"
)

func TestParseRoomFeaturesGet(t *testing.T) {
	cases := []struct {
		name   string
		args   []json.RawMessage
		wantID string
		wantOK bool
	}{
		{"正常", args("{\"roomId\":\"abc\"}"), "abc", true},
		{"去空白", args("{\"roomId\":\"  abc  \"}"), "abc", true},
		{"缺参数", nil, "", false},
		{"空对象", args("{}"), "", false},
		{"非法 JSON", args("{"), "", false},
		{"null 参数", args("null"), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotID, gotOK := parseRoomFeaturesGet(tc.args)
			if gotID != tc.wantID || gotOK != tc.wantOK {
				t.Fatalf("parseRoomFeaturesGet() = (%q, %v), want (%q, %v)", gotID, gotOK, tc.wantID, tc.wantOK)
			}
		})
	}
}

func TestParseRoomFeaturesSetAndApply(t *testing.T) {
	payload := parseRoomFeaturesSet(args(
		`{"roomId":" r1 ","voiceEnabled":false,"voiceAutoJoin":true,"screenE2EEEnabled":false}`,
	))
	if payload.RoomID != "r1" {
		t.Fatalf("roomId 未去空白: %q", payload.RoomID)
	}
	if !payload.hasAnyField() {
		t.Fatal("完整补丁被判定为空")
	}
	base := roomFeatureState{
		VoiceEnabled:      true,
		VoiceAutoJoin:     false,
		ScreenE2EEEnabled: true,
	}
	got := payload.applyTo(base)
	want := roomFeatureState{
		VoiceEnabled:      false,
		VoiceAutoJoin:     true,
		ScreenE2EEEnabled: false,
	}
	if got != want {
		t.Fatalf("applyTo() = %+v, want %+v", got, want)
	}

	partial := parseRoomFeaturesSet(args(`{"roomId":"r2","screenE2EEEnabled":false}`))
	if !partial.hasAnyField() {
		t.Fatal("单个字段补丁被判定为空")
	}
	got = partial.applyTo(roomFeatureState{VoiceEnabled: true, VoiceAutoJoin: true, ScreenE2EEEnabled: true})
	if got.ScreenE2EEEnabled || !got.VoiceEnabled || !got.VoiceAutoJoin {
		t.Fatalf("部分补丁影响了未给出的字段: %+v", got)
	}

	empty := parseRoomFeaturesSet(args(`{"roomId":"r3"}`))
	if empty.hasAnyField() {
		t.Fatal("空补丁应当被判定为没有字段")
	}
	if got := parseRoomFeaturesSet(nil); got.RoomID != "" || got.hasAnyField() {
		t.Fatalf("nil 参数解析结果异常: %+v", got)
	}
}

// args 把 JSON 字面量包成 socket.io 事件参数切片。
func args(raw ...string) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(raw))
	for _, s := range raw {
		out = append(out, json.RawMessage(s))
	}
	return out
}
