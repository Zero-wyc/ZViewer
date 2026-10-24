// Package sio 实现 Socket.IO v4 服务端的协议层：Engine.IO v4 传输 + Socket.IO v5 报文。
//
// 对应 Node 侧的 socket.io@4.8.3。前端用的是 socket.io-client@4.8.3，
// 它只认这套线上格式，任何一个字节的不同都会表现为「连不上」或「事件收不到」，
// 所以这里的编解码必须与 socket.io-parser 逐字符对齐。
//
// 当前只实现默认命名空间 "/" 的完整能力（本项目没有多命名空间）：
// 连接、事件、双向 ack、断线、房间与广播。
package sio

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Engine.IO v4 包类型（协议首字节）。官方把 "open" 记为 0，
// 但线上就是字符 '0'，所以直接沿用字符，避免多一层映射。
const (
	eioOpen    byte = '0' // 握手（仅服务端在首个 GET 响应里发）
	eioClose   byte = '1' // 主动关闭
	eioPing    byte = '2' // v4 由服务端发起，客户端回 pong
	eioPong    byte = '3'
	eioMessage byte = '4' // 载荷是 socket.io 包
	eioUpgrade byte = '5' // 传输升级完成
	eioNoop    byte = '6' // 长轮询超时占位
)

// Socket.IO v5 包类型（紧跟在 eioMessage 之后的那一位数字）。
const (
	sioConnect      = 0
	sioDisconnect   = 1
	sioEvent        = 2
	sioAck          = 3
	sioConnectError = 4
	sioBinaryEvent  = 5
	sioBinaryAck    = 6
)

// errBadPacket 表示收到的包不符合线上格式。
var errBadPacket = errors.New("sio: 报文格式错误")

// sioPacket 是一个 socket.io 包的解析结果。
//
// 因为有/没有 ack id 必须严格区分，而 id 0 本身是合法的，
// 所以不能用「ID 的零值」表示「没有 id」——那样 CONNECT 应答会被编成
// `400{"sid":...}`（多一个 0），客户端解析出的 sid 直接是错的。
// 这里用独立的 HasID 标志，让零值天然表示「无回执」。
type sioPacket struct {
	Type        int
	Nsp         string
	ID          int64
	HasID       bool
	Attachments int
	Data        string
}

// encode 把包编码成线上字节串。
//
// 顺序是 `<type><attachments-><nsp,><id><json>`，其中 namespace 为 "/" 时省略，
// 与 socket.io-parser 的 Encoder 一致：
//
//	42["ev",1]        → 默认命名空间、无 ack
//	421["ev",1]       → 默认命名空间、ack id = 1
//	42/foo,1["ev",1]  → 命名空间 /foo、ack id = 1
func (p sioPacket) encode() string {
	var b strings.Builder
	b.WriteByte(eioMessage)
	b.WriteByte(byte('0' + p.Type))

	nsp := p.Nsp
	if nsp == "" {
		nsp = "/"
	}
	if p.Type == sioBinaryEvent || p.Type == sioBinaryAck {
		b.WriteString(strconv.Itoa(p.Attachments))
		b.WriteByte('-')
	}
	if nsp != "/" {
		b.WriteString(nsp)
		b.WriteByte(',')
	}
	if p.HasID {
		b.WriteString(strconv.FormatInt(p.ID, 10))
	}
	b.WriteString(p.Data)
	return b.String()
}

// decodeSioPacket 解析一个以 '4' 开头的 engine.io message 包。
func decodeSioPacket(raw string) (sioPacket, error) {
	p := sioPacket{Nsp: "/"}
	if len(raw) < 2 || raw[0] != eioMessage {
		return p, fmt.Errorf("%w: 不是 message 包", errBadPacket)
	}
	if raw[1] < '0' || raw[1] > '6' {
		return p, fmt.Errorf("%w: 未知包类型 %q", errBadPacket, raw[1])
	}
	p.Type = int(raw[1] - '0')
	i := 2

	// 二进制包的附件数：`<n>-`
	if p.Type == sioBinaryEvent || p.Type == sioBinaryAck {
		j := i
		for j < len(raw) && raw[j] >= '0' && raw[j] <= '9' {
			j++
		}
		if j == i || j >= len(raw) || raw[j] != '-' {
			return p, fmt.Errorf("%w: 二进制包缺少附件数", errBadPacket)
		}
		n, err := strconv.Atoi(raw[i:j])
		if err != nil {
			return p, fmt.Errorf("%w: 附件数非法", errBadPacket)
		}
		p.Attachments = n
		i = j + 1
	}

	// 命名空间：`/nsp,`，默认命名空间不出现
	if i < len(raw) && raw[i] == '/' {
		j := i
		for j < len(raw) && raw[j] != ',' {
			j++
		}
		p.Nsp = raw[i:j]
		i = j
		if i < len(raw) && raw[i] == ',' {
			i++
		}
	}

	// ack id：紧接其后的一串数字
	j := i
	for j < len(raw) && raw[j] >= '0' && raw[j] <= '9' {
		j++
	}
	if j > i {
		id, err := strconv.ParseInt(raw[i:j], 10, 64)
		if err != nil {
			return p, fmt.Errorf("%w: ack id 非法", errBadPacket)
		}
		p.ID = id
		p.HasID = true
		i = j
	}

	p.Data = raw[i:]
	return p, nil
}

// splitPayload 按 Engine.IO v4 的包分隔符切分轮询响应体。
//
// v3 是 `<len>:<packet>` 前缀长度编码，v4 改成了记录分隔符 0x1e（RS），
// 混用会导致「第一个包之后的全部内容被当成同一个包」。
func splitPayload(body string) []string {
	if body == "" {
		return nil
	}
	return strings.Split(body, "\x1e")
}

// joinPayload 把多个包拼成一个轮询响应体。
func joinPayload(packets []string) string {
	return strings.Join(packets, "\x1e")
}
