package api

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"zviewer/backend/internal/flvcrypt"
)

func TestScreenE2EEKeyB64(t *testing.T) {
	srv := &Server{}
	if got := srv.screenE2EEKeyB64("room-1", false); got != "" {
		t.Fatalf("关闭加密时不应下发密钥, got %q", got)
	}
	got := srv.screenE2EEKeyB64("room-1", true)
	raw, err := base64.StdEncoding.DecodeString(got)
	if err != nil {
		t.Fatalf("密钥不是合法 base64: %v", err)
	}
	if len(raw) != flvcrypt.KeySize {
		t.Fatalf("密钥长度 = %d, want %d", len(raw), flvcrypt.KeySize)
	}
	if again := srv.screenE2EEKeyB64("room-1", true); again != got {
		t.Fatal("同一房间的密钥应保持稳定（与 watch 接口下发的是同一把）")
	}
	if other := srv.screenE2EEKeyB64("room-2", true); other == got {
		t.Fatal("不同房间不应共用密钥")
	}
}

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
		`{"roomId":" r1 ","voiceEnabled":false,"voiceAutoJoin":true,"musicEnabled":false,"screenE2EEEnabled":true}`,
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
		MusicEnabled:      true,
		ScreenE2EEEnabled: true,
	}
	got := payload.applyTo(base)
	want := roomFeatureState{
		VoiceEnabled:      false,
		VoiceAutoJoin:     true,
		MusicEnabled:      false,
		ScreenE2EEEnabled: true,
	}
	if got != want {
		t.Fatalf("applyTo() = %+v, want %+v", got, want)
	}

	partial := parseRoomFeaturesSet(args(`{"roomId":"r2","musicEnabled":false}`))
	if !partial.hasAnyField() {
		t.Fatal("单个字段补丁被判定为空")
	}
	got = partial.applyTo(roomFeatureState{VoiceEnabled: true, VoiceAutoJoin: true, MusicEnabled: true, ScreenE2EEEnabled: true})
	if got.MusicEnabled || !got.VoiceEnabled || !got.VoiceAutoJoin || !got.ScreenE2EEEnabled {
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

func TestParseVoiceInvite(t *testing.T) {
	cases := []struct {
		name   string
		args   []json.RawMessage
		want   voiceInvitePayload
		wantOK bool
	}{
		{
			name:   "livekit 邀请",
			args:   args(`{"roomId":"r1","targetSocketId":"s1","kind":"livekit"}`),
			want:   voiceInvitePayload{RoomID: "r1", TargetSocketID: "s1", Kind: "livekit"},
			wantOK: true,
		},
		{
			name:   "relay 邀请并去空白/小写",
			args:   args(`{"roomId":" r1 ","targetSocketId":" s1 ","kind":" RELAY "}`),
			want:   voiceInvitePayload{RoomID: "r1", TargetSocketID: "s1", Kind: "relay"},
			wantOK: true,
		},
		{
			name:   "非法 kind",
			args:   args(`{"roomId":"r1","targetSocketId":"s1","kind":"screen"}`),
			wantOK: false,
		},
		{
			name:   "缺目标",
			args:   args(`{"roomId":"r1","kind":"livekit"}`),
			wantOK: false,
		},
		{
			name:   "缺房间",
			args:   args(`{"targetSocketId":"s1","kind":"relay"}`),
			wantOK: false,
		},
		{
			name:   "空参数",
			args:   nil,
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseVoiceInvite(tc.args)
			if ok != tc.wantOK {
				t.Fatalf("parseVoiceInvite() ok = %v, want %v", ok, tc.wantOK)
			}
			if ok && got != tc.want {
				t.Fatalf("parseVoiceInvite() = %+v, want %+v", got, tc.want)
			}
		})
	}

	if validVoiceInviteKind("") || validVoiceInviteKind("livestream") {
		t.Fatal("validVoiceInviteKind 接受了非法值")
	}
	if !validVoiceInviteKind("livekit") || !validVoiceInviteKind("relay") {
		t.Fatal("validVoiceInviteKind 拒绝了合法值")
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
