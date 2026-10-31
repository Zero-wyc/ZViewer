// Package sfu 是屏幕共享的中继媒体面：把房主的上行转发给每个观众。
//
// 分层（照 Piik，不改结构）：
//
//	Media       物理资源容器，一个共享代际一份 Publication
//	Publication 房主的那条上行 PC + forwarding.Source（编码数据源头）
//	Transport   每个观众一条下行 PC，内含 DownTrack / BWE / pacer / 分层分配
//	Admission   只做容量记账，不理解媒体
//
// 与 Piik 的差异只有三处，都是因为 ZViewer 只有浏览器房主：
//   - 没有 voice 媒体（Piik 的同包语音留到 P6）；
//   - 没有 inputroute（那是远程控制的 data channel，ZViewer 没有这功能）；
//   - fence 的房号不再是纯数字（ZViewer 的房间号是 8 位自定义字母表）。
package sfu

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

// audioBitrateCeiling 是本 SFU 允许的音频上限（bps）。
//
// 与 Piik protocol.MaxAudioBitrate 一致：510kbps。下发时写进 Opus 的
// maxaveragebitrate，并作为观众 answer 的上行上限校验基准。
const audioBitrateCeiling = 510_000

// maxSafeInteger 是 JavaScript Number.MAX_SAFE_INTEGER。
// 协议里出现比它更大的整数说明客户端在胡说，直接拒。
const maxSafeInteger = 9_007_199_254_740_991

// publicationGenerationPrefix 让日志与抓包里一眼看出这是服务端铸造的值。
const publicationGenerationPrefix = "pub_"

// PublicationFence 标识「一次共享代际里的一路发布」。
//
// ZViewer 的共享代际内只有一位房主，所以 PublicationGeneration 事实上
// 等于「房主这一轮上行的身份」；房主刷新页面重连会换一个新的。
type PublicationFence struct {
	RoomID                string
	ShareGeneration       string
	PublicationGeneration string
}

// SubscriptionFence 标识某个观众到该发布的一条下行连接。
type SubscriptionFence struct {
	PublicationFence
	ViewerPeerID string
	ConnectionID string
}

// Usage 是当前占用的容量。
type Usage struct {
	Ingress int
	Egress  int
}

// newPublicationGeneration 铸造一路发布身份。
//
// 房主的 publicationGeneration 与 connectionId 是**同一个值**：协议里
// 首次发布要求两者相等（Piik router_sfu_signal.go），拆成两个值只会
// 多一条「对不上就静默丢弃」的分支。
func newPublicationGeneration() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return publicationGenerationPrefix + itoaBase36(time.Now().UnixNano())
	}
	return publicationGenerationPrefix + base64.RawURLEncoding.EncodeToString(buffer[:])
}

func itoaBase36(value int64) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var out [16]byte
	index := len(out)
	for value > 0 {
		index--
		out[index] = digits[value%36]
		value /= 36
	}
	if negative {
		index--
		out[index] = '-'
	}
	return string(out[index:])
}

// validOpaqueID 校验服务端铸造的不透明标识。
func validOpaqueID(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z',
			char >= 'A' && char <= 'Z',
			char >= '0' && char <= '9',
			char == '-', char == '_':
		default:
			return false
		}
	}
	return true
}

// validRoomID 校验房号。
//
// ZViewer 的房间号是 8 位自定义字母表（internal/room/randomRoomID），
// 但测试与直达页也会用短标识，所以按「可见 ASCII 标识符」放行。
func validRoomID(value string) bool {
	return validOpaqueID(value)
}

// validPublicationFence 校验一路发布的完整身份。
func validPublicationFence(fence PublicationFence) bool {
	return validRoomID(fence.RoomID) &&
		validOpaqueID(fence.ShareGeneration) &&
		validOpaqueID(fence.PublicationGeneration)
}

// Valid 报告该 fence 是否可用（供包外调用方提前校验）。
func (fence PublicationFence) Valid() bool { return validPublicationFence(fence) }

// String 便于日志。
func (fence PublicationFence) String() string {
	return fence.RoomID + "/" + fence.ShareGeneration + "/" + fence.PublicationGeneration
}
