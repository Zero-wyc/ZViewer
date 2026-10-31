package share

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// decode 是测试里解码一帧的简写。
func decode(t *testing.T, frame string) (ClientMessage, error) {
	t.Helper()
	return DecodeClient([]byte(frame))
}

func TestDecodeClientHello(t *testing.T) {
	message, err := decode(t, `{"t":"share.hello","roomId":"12345678"}`)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	hello, ok := message.(HelloMessage)
	if !ok {
		t.Fatalf("期望 HelloMessage，实际 %T", message)
	}
	if hello.RoomID != "12345678" {
		t.Fatalf("roomId 错误: %q", hello.RoomID)
	}
	if hello.MessageType() != TypeHello {
		t.Fatalf("t 错误: %q", hello.MessageType())
	}
	if hello.ShareGeneration != nil {
		t.Fatalf("未传 shareGeneration 时应为 nil，实际 %q", *hello.ShareGeneration)
	}
}

func TestDecodeClientHelloWithGeneration(t *testing.T) {
	message, err := decode(t, `{"t":"share.hello","roomId":"r","shareGeneration":"share_abc"}`)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	hello := message.(HelloMessage)
	if hello.ShareGeneration == nil || *hello.ShareGeneration != "share_abc" {
		t.Fatalf("shareGeneration 未保留: %+v", hello.ShareGeneration)
	}
}

// 未知字段必须拒绝：宽容解码会让「拼错字段名」变成静默失效。
func TestDecodeClientRejectsUnknownField(t *testing.T) {
	_, err := decode(t, `{"t":"share.hello","roomId":"r","extra":1}`)
	if err == nil {
		t.Fatal("未知字段应被拒绝")
	}
	if !strings.Contains(err.Error(), `unknown field "extra"`) {
		t.Fatalf("错误信息不对: %v", err)
	}
}

// Go 的 struct 解码接受大小写折叠的名字，必须提前挡掉，否则 RoomId 能绕过 roomId。
func TestDecodeClientRejectsCaseFoldedField(t *testing.T) {
	if _, err := decode(t, `{"t":"share.hello","RoomId":"r"}`); err == nil {
		t.Fatal("大小写折叠字段应被拒绝")
	}
}

func TestDecodeClientRejectsUnknownType(t *testing.T) {
	_, err := decode(t, `{"t":"share.nope","roomId":"r"}`)
	if !errors.Is(err, ErrUnknownType) {
		t.Fatalf("期望 ErrUnknownType，实际 %v", err)
	}
}

func TestDecodeClientRejectsMissingType(t *testing.T) {
	if _, err := decode(t, `{"roomId":"r"}`); !errors.Is(err, ErrUnknownType) {
		t.Fatalf("缺 t 应返回 ErrUnknownType，实际 %v", err)
	}
}

func TestDecodeClientRejectsMissingRequiredField(t *testing.T) {
	if _, err := decode(t, `{"t":"share.hello"}`); err == nil {
		t.Fatal("缺 roomId 应被拒绝")
	}
	if _, err := decode(t, `{"t":"share.stop","roomId":"r"}`); err == nil {
		t.Fatal("缺 shareGeneration 应被拒绝")
	}
	if _, err := decode(t, `{"t":"share.pause","roomId":"r","shareGeneration":"g"}`); err == nil {
		t.Fatal("缺 paused 应被拒绝")
	}
}

// 重复键只保留最后一个，与 JSON.parse / Piik protocol/codec.go 的注释一致。
func TestDecodeClientCollapsesDuplicateKeys(t *testing.T) {
	message, err := decode(t, `{"t":"share.hello","roomId":"first","roomId":"last"}`)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if got := message.(HelloMessage).RoomID; got != "last" {
		t.Fatalf("重复键应取最后一个，实际 %q", got)
	}
}

func TestDecodeClientRejectsOversizedFrame(t *testing.T) {
	frame := `{"t":"share.hello","roomId":"` + strings.Repeat("a", MaxFrameBytes) + `"}`
	if _, err := decode(t, frame); err == nil {
		t.Fatal("超过 64KiB 的帧应被拒绝")
	}
}

func TestDecodeClientValidatesPhase(t *testing.T) {
	valid := `{"t":"share.route-ready","roomId":"r","revision":3,"phase":"prepare"}`
	if _, err := decode(t, valid); err != nil {
		t.Fatalf("合法 phase 解码失败: %v", err)
	}
	invalid := `{"t":"share.route-ready","roomId":"r","revision":3,"phase":"ready"}`
	if _, err := decode(t, invalid); err == nil {
		t.Fatal(`"ready" 不是路由阶段（那是 punch 子阶段），应被拒绝`)
	}
}

func TestDecodeClientValidatesSignalKind(t *testing.T) {
	valid := `{"t":"share.signal","roomId":"r","connectionId":"route_1","kind":"offer","payload":{"type":"offer"}}`
	if _, err := decode(t, valid); err != nil {
		t.Fatalf("合法 kind 解码失败: %v", err)
	}
	invalid := `{"t":"share.signal","roomId":"r","connectionId":"route_1","kind":"rollback","payload":{}}`
	if _, err := decode(t, invalid); err == nil {
		t.Fatal("未知 kind 应被拒绝")
	}
}

func TestDecodeClientKeepsSignalPayload(t *testing.T) {
	message, err := decode(t, `{"t":"share.signal","roomId":"r","connectionId":"route_1","kind":"candidate","payload":{"candidate":"candidate:1 1 udp 1 1.2.3.4 1 typ host"}}`)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	signal := message.(SignalMessage)
	var payload map[string]any
	if err := json.Unmarshal(signal.Payload, &payload); err != nil {
		t.Fatalf("payload 不是合法 JSON: %v", err)
	}
	if payload["candidate"] == "" || payload["candidate"] == nil {
		t.Fatalf("payload 内容丢失: %+v", payload)
	}
}

func TestDecodeClientRestart(t *testing.T) {
	message, err := decode(t, `{"t":"share.restart","roomId":"r","connectionId":"route_1","rebuild":true}`)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if !message.(RestartMessage).Rebuild {
		t.Fatal("rebuild 未保留")
	}
}

// 快照的线上形状是前后端的唯一契约，键名改一个字都会静默打空前端。
func TestEncodeSnapshotShape(t *testing.T) {
	encoded, err := Encode(SnapshotMessage{
		T:               TypeSnapshot,
		RoomID:          "r",
		ShareGeneration: "share_x",
		Revision:        7,
		Paused:          false,
		Sharing:         true,
		QualitySettings: QualitySettings{ResolutionPreset: "1080p", FrameRate: 30, MaxBitrateMbps: 8},
		Participants:    []Participant{},
	})
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("输出不是合法 JSON: %v", err)
	}
	expected := []string{
		"t", "roomId", "shareGeneration", "revision", "paused",
		"sharing", "qualitySettings", "participants",
	}
	for _, key := range expected {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("快照缺少键 %q: %s", key, encoded)
		}
	}
	// assignment 为空时必须整键消失（Piik 的 undefined → 键不存在）。
	if _, ok := decoded["assignment"]; ok {
		t.Fatalf("assignment 为 nil 时不应出现: %s", encoded)
	}
	quality, ok := decoded["qualitySettings"].(map[string]any)
	if !ok {
		t.Fatalf("qualitySettings 形状错误: %v", decoded["qualitySettings"])
	}
	if quality["resolutionPreset"] != "1080p" || quality["frameRate"] != float64(30) {
		t.Fatalf("qualitySettings 内容错误: %v", quality)
	}
}

// 昵称可能带 < > &，编码不能转义（与 JSON.stringify 一致）。
func TestEncodeDoesNotEscapeHTML(t *testing.T) {
	encoded, err := Encode(ErrorMessage{T: TypeError, Code: CodeForbidden, Message: "<b>&</b>"})
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	if !strings.Contains(string(encoded), "<b>&</b>") {
		t.Fatalf("HTML 字符被转义了: %s", encoded)
	}
}
