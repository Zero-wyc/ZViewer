package sio

import "testing"

// 黄金值全部取自 socket.io-parser@4 的 Encoder 实际输出。
// 任何一个字符的偏差都会让 socket.io-client 直接丢弃该包（不报错），
// 表现为「事件发了但前端没反应」，所以这里逐字节锁死。
func TestEncodeSioPacket(t *testing.T) {
	cases := []struct {
		name string
		pkt  sioPacket
		want string
	}{
		{
			name: "默认命名空间事件",
			pkt:  sioPacket{Type: sioEvent, Nsp: "/", Data: `["a",1]`},
			want: `42["a",1]`,
		},
		{
			name: "默认命名空间带 ack id",
			pkt:  sioPacket{Type: sioEvent, Nsp: "/", ID: 1, HasID: true, Data: `["a"]`},
			want: `421["a"]`,
		},
		{
			name: "ack id 为 0 不能被当成无 id",
			pkt:  sioPacket{Type: sioEvent, Nsp: "/", ID: 0, HasID: true, Data: `["a"]`},
			want: `420["a"]`,
		},
		{
			name: "命名空间带 ack id",
			pkt:  sioPacket{Type: sioEvent, Nsp: "/foo", ID: 3, HasID: true, Data: `["a"]`},
			want: `42/foo,3["a"]`,
		},
		{
			name: "命名空间无 ack id",
			pkt:  sioPacket{Type: sioEvent, Nsp: "/foo", Data: `["a"]`},
			want: `42/foo,["a"]`,
		},
		{
			name: "CONNECT 应答",
			pkt:  sioPacket{Type: sioConnect, Nsp: "/", Data: `{"sid":"x"}`},
			want: `40{"sid":"x"}`,
		},
		{
			name: "ACK 回执",
			pkt:  sioPacket{Type: sioAck, Nsp: "/", ID: 7, HasID: true, Data: `[true]`},
			want: `437[true]`,
		},
		{
			name: "connect_error",
			pkt:  sioPacket{Type: sioConnectError, Nsp: "/", Data: `{"message":"x"}`},
			want: `44{"message":"x"}`,
		},
		{
			name: "DISCONNECT",
			pkt:  sioPacket{Type: sioDisconnect, Nsp: "/"},
			want: `41`,
		},
		{
			name: "二进制事件带附件数",
			pkt:  sioPacket{Type: sioBinaryEvent, Nsp: "/", Attachments: 2, Data: `["a"]`},
			want: `452-["a"]`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.pkt.encode(); got != tc.want {
				t.Fatalf("encode = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDecodeSioPacket(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want sioPacket
	}{
		{
			name: "事件",
			raw:  `42["a",1]`,
			want: sioPacket{Type: sioEvent, Nsp: "/", Data: `["a",1]`},
		},
		{
			name: "事件带 ack id",
			raw:  `421["a"]`,
			want: sioPacket{Type: sioEvent, Nsp: "/", ID: 1, HasID: true, Data: `["a"]`},
		},
		{
			name: "CONNECT 无载荷",
			raw:  `40`,
			want: sioPacket{Type: sioConnect, Nsp: "/", Data: ""},
		},
		{
			name: "CONNECT 带 auth 载荷",
			raw:  `40{"token":"abc"}`,
			want: sioPacket{Type: sioConnect, Nsp: "/", Data: `{"token":"abc"}`},
		},
		{
			name: "命名空间事件",
			raw:  `42/foo,3["a"]`,
			want: sioPacket{Type: sioEvent, Nsp: "/foo", ID: 3, HasID: true, Data: `["a"]`},
		},
		{
			name: "ACK",
			raw:  `437[true]`,
			want: sioPacket{Type: sioAck, Nsp: "/", ID: 7, HasID: true, Data: `[true]`},
		},
		{
			name: "二进制事件",
			raw:  `452-["a"]`,
			want: sioPacket{Type: sioBinaryEvent, Nsp: "/", Attachments: 2, Data: `["a"]`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := decodeSioPacket(tc.raw)
			if err != nil {
				t.Fatalf("decode(%q) 出错: %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("decode(%q) = %+v, want %+v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestDecodeSioPacketRejectsBadInput(t *testing.T) {
	bad := []string{
		``,
		`4`,
		`2["a"]`,   // 不是 message 包
		`49["a"]`,  // 未知包类型
		`451["a"]`, // 二进制包缺少附件数分隔符
	}
	for _, raw := range bad {
		if _, err := decodeSioPacket(raw); err == nil {
			t.Fatalf("decode(%q) 应该报错", raw)
		}
	}
}

// 往返一致性：解码再编码必须得到同一串。
func TestSioPacketRoundTrip(t *testing.T) {
	raws := []string{
		`42["a",1,"b"]`,
		`421["a"]`,
		`40{"sid":"abc"}`,
		`42/foo,3["a"]`,
		`437[true]`,
		`41`,
	}
	for _, raw := range raws {
		p, err := decodeSioPacket(raw)
		if err != nil {
			t.Fatalf("decode(%q): %v", raw, err)
		}
		if got := p.encode(); got != raw {
			t.Fatalf("往返不一致: %q → %q", raw, got)
		}
	}
}

func TestSplitPayload(t *testing.T) {
	if got := splitPayload(""); got != nil {
		t.Fatalf("空串应返回 nil，得到 %v", got)
	}
	got := splitPayload("42[\"a\"]\x1e2")
	if len(got) != 2 || got[0] != `42["a"]` || got[1] != "2" {
		t.Fatalf("切分结果不对: %#v", got)
	}
	if joinPayload(got) != "42[\"a\"]\x1e2" {
		t.Fatalf("拼回不一致")
	}
}

// 握手载荷的 upgrades 在直连 WebSocket 时必须为空数组，
// 否则客户端会尝试自我升级（engine.io 会因此断开连接）。
func TestHandshakeJSON(t *testing.T) {
	srv := NewServer(Options{})
	withUpgrade := srv.handshakeJSON("abc", true)
	want := `{"sid":"abc","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":20971520}`
	if withUpgrade != want {
		t.Fatalf("open 载荷 = %s, want %s", withUpgrade, want)
	}
	direct := srv.handshakeJSON("abc", false)
	wantDirect := `{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":20971520}`
	if direct != wantDirect {
		t.Fatalf("直连 open 载荷 = %s, want %s", direct, wantDirect)
	}
}
