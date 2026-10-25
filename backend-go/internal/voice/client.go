package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// TrackKind 是 LiveKit 轨道类型的字符串形态。
const (
	TrackAudio = "AUDIO"
	TrackVideo = "VIDEO"
	TrackData  = "DATA"
)

// Track 是参与者发布的一条轨。
type Track struct {
	SID  string
	Kind string
}

// Participant 是 LiveKit 房间里的一个参与者。
type Participant struct {
	Identity string
	Tracks   []Track
}

// ListParticipants 列出语音房间里的人。
func (s *Service) ListParticipants(ctx context.Context, roomID string) ([]Participant, error) {
	var resp struct {
		Participants []struct {
			Identity string `json:"identity"`
			Tracks   []struct {
				SID  string          `json:"sid"`
				Type json.RawMessage `json:"type"`
			} `json:"tracks"`
		} `json:"participants"`
	}
	if err := s.twirp(ctx, "ListParticipants", roomID,
		map[string]string{"room": VoiceRoomName(roomID)}, &resp); err != nil {
		return nil, err
	}

	participants := make([]Participant, 0, len(resp.Participants))
	for _, raw := range resp.Participants {
		tracks := make([]Track, 0, len(raw.Tracks))
		for _, track := range raw.Tracks {
			tracks = append(tracks, Track{SID: track.SID, Kind: trackKind(track.Type)})
		}
		participants = append(participants, Participant{Identity: raw.Identity, Tracks: tracks})
	}
	return participants, nil
}

// MutePublishedTrack 在服务器侧静音/取消静音一条已发布的轨。
//
// 这是**服务端强制**：客户端本地再怎么切换麦克风开关都绕不过去，
// 禁言才真的禁得住。
func (s *Service) MutePublishedTrack(ctx context.Context, roomID, identity, trackSID string, muted bool) error {
	return s.twirp(ctx, "MutePublishedTrack", roomID, map[string]any{
		"room":     VoiceRoomName(roomID),
		"identity": identity,
		"trackSid": trackSID,
		"muted":    muted,
	}, nil)
}

// UpdateParticipantMetadata 改写参与者 metadata。
//
// 禁言状态就是靠它下发的：两端 UI 从这个字段判断「我是不是被管理员禁言」，
// 解禁后客户端据此自动恢复麦克风。
func (s *Service) UpdateParticipantMetadata(ctx context.Context, roomID, identity, metadata string) error {
	return s.twirp(ctx, "UpdateParticipant", roomID, map[string]any{
		"room":     VoiceRoomName(roomID),
		"identity": identity,
		"metadata": metadata,
	}, nil)
}

// RemoveParticipant 把参与者踢出房间。
func (s *Service) RemoveParticipant(ctx context.Context, roomID, identity string) error {
	return s.twirp(ctx, "RemoveParticipant", roomID, map[string]string{
		"room":     VoiceRoomName(roomID),
		"identity": identity,
	}, nil)
}

// twirp 调一次 LiveKit 的 Twirp 接口。
//
// 路径与请求体形状照抄 livekit-server-sdk：
// `POST {host}/twirp/livekit.RoomService/{Method}`，JSON 体用 camelCase 字段名，
// 鉴权是「带 roomAdmin + room 授权的短命 JWT」。
func (s *Service) twirp(ctx context.Context, method, roomID string, payload, out any) error {
	token, err := s.adminToken(roomID)
	if err != nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	target := s.apiHost() + "/twirp/livekit.RoomService/" + method
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := s.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("livekit %s: %w", method, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Twirp 的错误体是 JSON（{code,msg,meta}），原样带进日志最有诊断价值。
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("livekit %s: HTTP %d: %s", method, resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// trackKind 解析 protojson 里的轨道类型。
//
// 两种形态都要认：protojson 默认**省略零值枚举**，所以 AUDIO 轨的 type 字段
// 常常整个不存在——那就是 AUDIO，不能当成「未知」而漏禁言。Node 的
// `fromJson` 同样把缺失当 0（AUDIO）。
func trackKind(raw json.RawMessage) string {
	if len(raw) == 0 {
		return TrackAudio
	}
	var name string
	if err := json.Unmarshal(raw, &name); err == nil {
		return strings.ToUpper(name)
	}
	var value int
	if err := json.Unmarshal(raw, &value); err == nil {
		switch value {
		case 0:
			return TrackAudio
		case 1:
			return TrackVideo
		case 2:
			return TrackData
		}
	}
	return ""
}
