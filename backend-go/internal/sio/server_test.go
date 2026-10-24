package sio

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newTestServer 起一个只挂 /socket.io/ 的服务，注册 spike 用的事件。
func newTestServer(t *testing.T, opts Options) (*Server, *httptest.Server) {
	t.Helper()
	srv := NewServer(opts)
	srv.OnConnect(func(sc *Socket) {
		sc.On("echo", func(args []json.RawMessage, ack func(...any)) {
			var s string
			if len(args) > 0 {
				_ = json.Unmarshal(args[0], &s)
			}
			if ack != nil {
				ack(s)
			}
		})
		sc.On("join", func(args []json.RawMessage, ack func(...any)) {
			var room string
			if len(args) > 0 {
				_ = json.Unmarshal(args[0], &room)
			}
			sc.Join(room)
			if ack != nil {
				ack(true)
			}
		})
		sc.On("broadcast", func(args []json.RawMessage, ack func(...any)) {
			var room string
			if len(args) > 0 {
				_ = json.Unmarshal(args[0], &room)
			}
			sc.To(room).Emit("msg", "hi")
			if ack != nil {
				ack(true)
			}
		})
	})
	mux := http.NewServeMux()
	mux.Handle("/socket.io/", srv)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return srv, ts
}

// pollClient 是一个纯轮询的 engine.io 客户端（手搓，便于逐包断言）。
type pollClient struct {
	t    *testing.T
	base string
	sid  string
}

func newPollClient(t *testing.T, base string) *pollClient {
	t.Helper()
	resp, err := http.Get(base + "/socket.io/?EIO=4&transport=polling")
	if err != nil {
		t.Fatalf("握手请求失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("握手状态码 = %d, body = %s", resp.StatusCode, body)
	}
	if len(body) == 0 || body[0] != eioOpen {
		t.Fatalf("首包不是 open: %q", body)
	}
	var hs struct {
		Sid          string   `json:"sid"`
		Upgrades     []string `json:"upgrades"`
		PingInterval int      `json:"pingInterval"`
	}
	if err := json.Unmarshal(body[1:], &hs); err != nil {
		t.Fatalf("open 载荷解析失败: %v (%s)", err, body[1:])
	}
	if hs.Sid == "" {
		t.Fatalf("open 载荷没有 sid")
	}
	if len(hs.Upgrades) != 1 || hs.Upgrades[0] != "websocket" {
		t.Fatalf("upgrades = %v, want [websocket]", hs.Upgrades)
	}
	return &pollClient{t: t, base: base, sid: hs.Sid}
}

func (c *pollClient) url() string {
	return c.base + "/socket.io/?EIO=4&transport=polling&sid=" + c.sid
}

func (c *pollClient) poll() string {
	c.t.Helper()
	resp, err := http.Get(c.url())
	if err != nil {
		c.t.Fatalf("轮询失败: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		c.t.Fatalf("轮询状态码 = %d, body = %s", resp.StatusCode, body)
	}
	return string(body)
}

func (c *pollClient) post(pkts ...string) {
	c.t.Helper()
	body := strings.Join(pkts, "\x1e")
	resp, err := http.Post(c.url(), "text/plain;charset=UTF-8", strings.NewReader(body))
	if err != nil {
		c.t.Fatalf("POST 失败: %v", err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		c.t.Fatalf("POST 状态码 = %d, body = %s", resp.StatusCode, out)
	}
	if string(out) != "ok" {
		c.t.Fatalf("POST 响应 = %q, want ok", out)
	}
}

func (c *pollClient) connect() string {
	c.t.Helper()
	c.post("40")
	return c.poll()
}

// 握手 → CONNECT → 读回 40{"sid":...}
func TestPollingConnect(t *testing.T) {
	_, ts := newTestServer(t, Options{})
	c := newPollClient(t, ts.URL)
	got := c.connect()
	want := `40{"sid":"` + c.sid + `"}`
	if got != want {
		t.Fatalf("CONNECT 应答 = %q, want %q", got, want)
	}
}

// 事件 + 客户端请求 ack：42<id>["echo","hi"] → 43<id>["hi"]
func TestPollingEventAck(t *testing.T) {
	_, ts := newTestServer(t, Options{})
	c := newPollClient(t, ts.URL)
	c.connect()

	c.post(`421["echo","hi"]`)
	if got := c.poll(); got != `431["hi"]` {
		t.Fatalf("ack 回执 = %q, want %q", got, `431["hi"]`)
	}
}

// ack id 0 必须也能正确回执（曾把 0 当成「没有 id」）
func TestPollingAckIDZero(t *testing.T) {
	_, ts := newTestServer(t, Options{})
	c := newPollClient(t, ts.URL)
	c.connect()

	c.post(`420["echo","zero"]`)
	if got := c.poll(); got != `430["zero"]` {
		t.Fatalf("ack 回执 = %q, want %q", got, `430["zero"]`)
	}
}

// 房间广播：A 与 B 同房，A 发 broadcast，B 收到；A 自己不收到。
func TestPollingRoomBroadcast(t *testing.T) {
	_, ts := newTestServer(t, Options{})
	a := newPollClient(t, ts.URL)
	a.connect()
	b := newPollClient(t, ts.URL)
	b.connect()

	a.post(`421["join","r1"]`)
	if got := a.poll(); got != `431[true]` {
		t.Fatalf("A join ack = %q", got)
	}
	b.post(`421["join","r1"]`)
	if got := b.poll(); got != `431[true]` {
		t.Fatalf("B join ack = %q", got)
	}

	a.post(`422["broadcast","r1"]`)
	// A 只收到自己的 ack（socket.to 排除发送者）
	if got := a.poll(); got != `432[true]` {
		t.Fatalf("A 收到 %q, want ack", got)
	}
	if got := b.poll(); got != `42["msg","hi"]` {
		t.Fatalf("B 收到 %q, want 42[\"msg\",\"hi\"]", got)
	}
}

// 长轮询在没有数据时必须及时返回 noop（或 ping），不能挂满 25 秒。
func TestPollingNoopOnIdle(t *testing.T) {
	_, ts := newTestServer(t, Options{PingInterval: 80 * time.Millisecond, PingTimeout: 2 * time.Second})
	c := newPollClient(t, ts.URL)

	start := time.Now()
	got := c.poll()
	elapsed := time.Since(start)
	if elapsed > 2*time.Second {
		t.Fatalf("长轮询挂了 %v，没有按 pingInterval 返回", elapsed)
	}
	if got != string(eioNoop) && got != string(eioPing) {
		t.Fatalf("空轮询返回 %q, want noop 或 ping", got)
	}
}

// 鉴权拒绝：UseAuth 返回错误 → 客户端收到 connect_error，而不是连上。
func TestConnectRejectedByAuth(t *testing.T) {
	srv := NewServer(Options{})
	srv.UseAuth(func(h *Handshake) error {
		if _, ok := h.Auth["token"]; !ok {
			return errors.New("未提供认证令牌")
		}
		h.Data["userId"] = 7
		return nil
	})
	srv.OnConnect(func(sc *Socket) {
		sc.On("whoami", func(args []json.RawMessage, ack func(...any)) {
			if ack != nil {
				ack(sc.Data["userId"])
			}
		})
	})
	mux := http.NewServeMux()
	mux.Handle("/socket.io/", srv)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	c := newPollClient(t, ts.URL)
	c.post("40")
	got := c.poll()
	if !strings.HasPrefix(got, "44") {
		t.Fatalf("拒绝时收到 %q, want connect_error", got)
	}
	if !strings.Contains(got, "未提供认证令牌") {
		t.Fatalf("connect_error 文案 = %q", got)
	}

	// 带上 auth 后应能连上，且 socket.data 生效
	c2 := newPollClient(t, ts.URL)
	c2.post(`40{"token":"t"}`)
	if got := c2.poll(); !strings.HasPrefix(got, "40") {
		t.Fatalf("带 auth 未连上: %q", got)
	}
	c2.post(`421["whoami"]`)
	if got := c2.poll(); got != `431[7]` {
		t.Fatalf("socket.data 未生效: %q", got)
	}
}

// 未知 sid 必须 400，不能静默建新会话（会让断线客户端以为还活着）。
func TestUnknownSessionRejected(t *testing.T) {
	_, ts := newTestServer(t, Options{})
	resp, err := http.Get(ts.URL + "/socket.io/?EIO=4&transport=polling&sid=nope")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("状态码 = %d, want 400", resp.StatusCode)
	}
}

// 非 EIO=4 必须拒绝：v3 的编码是长度前缀，混着处理只会得到乱码。
func TestUnsupportedProtocolVersion(t *testing.T) {
	_, ts := newTestServer(t, Options{})
	resp, err := http.Get(ts.URL + "/socket.io/?EIO=3&transport=polling")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("状态码 = %d, want 400", resp.StatusCode)
	}
}

// 断线后 socket 必须从房间移除，否则广播会一直往死连接写。
func TestDisconnectRemovesFromRoom(t *testing.T) {
	srv, ts := newTestServer(t, Options{})
	a := newPollClient(t, ts.URL)
	a.connect()
	a.post(`421["join","r1"]`)
	if got := a.poll(); got != `431[true]` {
		t.Fatalf("join ack = %q", got)
	}
	if got := len(srv.roomSockets("r1")); got != 1 {
		t.Fatalf("房间成员数 = %d, want 1", got)
	}
	srv.closeSession(srv.session(a.sid), "test")
	if got := len(srv.roomSockets("r1")); got != 0 {
		t.Fatalf("断线后房间成员数 = %d, want 0", got)
	}
	if got := len(srv.allSockets()); got != 0 {
		t.Fatalf("断线后在线数 = %d, want 0", got)
	}
}
