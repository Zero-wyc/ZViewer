// 命令 sio-spike 是 Socket.IO 协议层的验证用服务端。
//
// 它**不是**业务代码：只挂一小组用于验证协议能力的事件（ack、房间广播、
// 大载荷、服务端主动断开），由 scripts/spike-sio.js 用真实的
// socket.io-client@4.8.3 连接并逐项断言。
//
// 业务事件（create-room / join-room / watch-together-state …）等
// 协议层验收通过后再逐个迁移到 internal/api 下的实时模块，这个二进制届时删除。
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"time"

	"zviewer/backend/internal/sio"
)

// spikeToken 是验证用的固定令牌（真实鉴权会用 JWT + 撤销表）。
const spikeToken = "spike-token"

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = "127.0.0.1:3411"
	}

	srv := sio.NewServer(sio.Options{
		// 缩短心跳，便于在几秒内观察到 ping/pong
		PingInterval: 2 * time.Second,
		PingTimeout:  3 * time.Second,
	})

	srv.UseAuth(func(h *sio.Handshake) error {
		var agent string
		if raw, ok := h.Auth["agent"]; ok {
			_ = json.Unmarshal(raw, &agent)
		}
		if agent == "zcontrol-cli" {
			h.Data["isCliAgent"] = true
			return nil
		}
		var token string
		if raw, ok := h.Auth["token"]; ok {
			_ = json.Unmarshal(raw, &token)
		}
		if token == "" {
			token = h.Query.Get("token")
		}
		if token != spikeToken {
			return errors.New("未提供认证令牌")
		}
		h.Data["userId"] = 42
		return nil
	})

	srv.OnConnect(func(sc *sio.Socket) {
		// 原样回传参数，用来验证 ack 的双向编码
		sc.On("echo", func(args []json.RawMessage, ack func(...any)) {
			if ack == nil {
				return
			}
			vals := make([]any, 0, len(args))
			for _, raw := range args {
				var v any
				if err := json.Unmarshal(raw, &v); err == nil {
					vals = append(vals, v)
				}
			}
			ack(vals...)
		})

		sc.On("whoami", func(_ []json.RawMessage, ack func(...any)) {
			if ack != nil {
				ack(sc.ID, sc.Data["userId"])
			}
		})

		sc.On("join", func(args []json.RawMessage, ack func(...any)) {
			sc.Join(stringArg(args, 0))
			if ack != nil {
				ack(sc.ID)
			}
		})

		// socket.to(room) 语义：广播给房间内**除自己**的成员
		sc.On("broadcast", func(args []json.RawMessage, ack func(...any)) {
			sc.To(stringArg(args, 0)).Emit("room-msg", stringArg(args, 1))
			if ack != nil {
				ack(true)
			}
		})

		// io.to(room) 语义：广播给房间内**所有**成员（含自己）
		sc.On("broadcast-all", func(args []json.RawMessage, ack func(...any)) {
			srv.To(stringArg(args, 0)).Emit("room-msg", stringArg(args, 1))
			if ack != nil {
				ack(true)
			}
		})

		// 服务端主动要求客户端回执：验证 EmitWithAck + ACK 包解析
		sc.On("ask-client", func(args []json.RawMessage, ack func(...any)) {
			prompt := stringArg(args, 0)
			sc.EmitWithAck("ask-client", func(vals ...any) {
				sc.Emit("ack-result", vals[0])
			}, prompt)
			if ack != nil {
				ack(true)
			}
		})

		// 上行大载荷：返回字节数
		sc.On("big", func(args []json.RawMessage, ack func(...any)) {
			if ack == nil {
				return
			}
			var s string
			if len(args) > 0 {
				_ = json.Unmarshal(args[0], &s)
			}
			ack(len(s))
		})

		// 下行大载荷：客户端要多大就发多大
		sc.On("please-big-down", func(args []json.RawMessage, ack func(...any)) {
			var n int
			if len(args) > 0 {
				_ = json.Unmarshal(args[0], &n)
			}
			sc.Emit("big-down", repeat('z', n))
			if ack != nil {
				ack(n)
			}
		})

		// 服务端主动断开：客户端应收到 io server disconnect
		sc.On("kick", func(_ []json.RawMessage, ack func(...any)) {
			if ack != nil {
				ack(true)
			}
			sc.Disconnect("spike kick")
		})
	})

	mux := http.NewServeMux()
	mux.Handle("/socket.io/", srv)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("[sio-spike] 监听 %s", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[sio-spike] 启动失败: %v", err)
	}
}

func stringArg(args []json.RawMessage, i int) string {
	if i >= len(args) {
		return ""
	}
	var s string
	_ = json.Unmarshal(args[i], &s)
	return s
}

func repeat(ch byte, n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = ch
	}
	return string(b)
}
