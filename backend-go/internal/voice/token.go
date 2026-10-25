package voice

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// VideoGrant 是 LiveKit 的 video 授权块。
//
// 字段名必须是 LiveKit 认识的 camelCase（`roomJoin` 而不是 `room_join`）：
// 这套 claims 由 LiveKit 服务端直接反序列化，写错不会报错，只会「没权限」。
type VideoGrant struct {
	Room           string `json:"room,omitempty"`
	RoomJoin       bool   `json:"roomJoin,omitempty"`
	RoomAdmin      bool   `json:"roomAdmin,omitempty"`
	CanPublish     bool   `json:"canPublish,omitempty"`
	CanSubscribe   bool   `json:"canSubscribe,omitempty"`
	CanPublishData bool   `json:"canPublishData,omitempty"`
}

// IssueJoinToken 签发客户端接入凭证。
//
// identity 是 LiveKit 的参与者标识：登录用户用 `user:<id>`（重连能顶替同一条轨），
// 游客每次加入用一次性身份（否则两个游客会互相顶掉）。
func (s *Service) IssueJoinToken(roomID, identity, name string) (string, error) {
	return s.sign(VideoGrant{
		Room:           VoiceRoomName(roomID),
		RoomJoin:       true,
		CanPublish:     true,
		CanSubscribe:   true,
		CanPublishData: true,
	}, identity, name)
}

// adminToken 签发仅用于调 Twirp 管理接口的短命 token。
//
// 不带 sub：LiveKit 只校验 video.roomAdmin + video.room，不需要一个"参与者身份"。
// 10 分钟足够一次 REST 调用，泄漏面也小。
func (s *Service) adminToken(roomID string) (string, error) {
	return s.sign(VideoGrant{
		RoomAdmin: true,
		Room:      VoiceRoomName(roomID),
	}, "", "")
}

func (s *Service) sign(grant VideoGrant, identity, name string) (string, error) {
	if !s.Configured() {
		return "", errors.New("LIVEKIT_API_KEY/SECRET 未配置")
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"iss":   s.apiKey(),
		"exp":   now.Add(defaultTokenTTL * time.Second).Unix(),
		"nbf":   now.Unix(),
		"video": grant,
	}
	if identity != "" {
		claims["sub"] = identity
	}
	if name != "" {
		claims["name"] = name
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	// livekit-server-sdk 的 header 只有 alg（没有 typ）。两者 LiveKit 都收，
	// 这里保持同形，方便拿两个实现签出来的 token 直接比对 payload。
	token.Header = map[string]any{"alg": "HS256"}
	return token.SignedString([]byte(s.secret()))
}
