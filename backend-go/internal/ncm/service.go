package ncm

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strconv"

	"zviewer/backend/internal/store"
)

// Service 是网易云服务层：接口调用 + 凭证 + 业务编排。
//
// 它同时承担「上游」的角色——`/api/music/ncm/*` 与音质解析都落在同一套
// 进程内实现上，没有服务地址、没有可用性探测，也不存在「音乐服务未启动」
// 这种状态：拿不到数据只可能是请求本身失败。
type Service struct {
	api   *api
	Creds *store.NcmCredentials
	Rooms *store.Rooms
	// RoomAccounts 是房间共享账号绑定（房间内任意成员登录后全房复用）。
	RoomAccounts *store.RoomAccounts
}

// roomAccountProviderNCM 是 room_account 表里网易云平台的取值。
const roomAccountProviderNCM = "ncm"

// NewService 构造服务。
func NewService(conn *sql.DB) *Service {
	return &Service{
		api:          newAPI(),
		Creds:        store.NewNcmCredentials(conn),
		Rooms:        store.NewRooms(conn),
		RoomAccounts: store.NewRoomAccounts(conn),
	}
}

// LoadCredential 读取用户持久化的网易云凭证；游客/未登录返回 (nil, nil)。
func (s *Service) LoadCredential(ctx context.Context, userID int64) (*store.NcmCredential, error) {
	if userID <= 0 {
		return nil, nil
	}
	return s.Creds.FindByUserID(ctx, userID)
}

// CredentialForRequest 是凭证回退链：房间共享账号 → 房主 → 请求者自己。
//
// 实现 spec「房间内任意成员登录网易云后全房间可播」：请求带 roomId 且该房间
// 绑定过共享账号时优先用绑定者的持久化凭证；没有绑定则沿用旧链（房主凭证
// 兜底观众，最后才是请求者本人）。`/stream` 与 `/song-quality` 共用。
func (s *Service) CredentialForRequest(ctx context.Context, userID int64, roomID string) (*store.NcmCredential, error) {
	if roomID != "" && s.RoomAccounts != nil {
		binderID, ok, err := s.RoomAccounts.GetRoomAccount(ctx, roomAccountProviderNCM, roomID)
		if err != nil {
			// 绑定表读失败不该让播放整体失败：降级到旧链（没有共享账号时的行为）。
			log.Printf("[ncm] 读取房间共享账号失败 room=%s: %v", roomID, err)
		} else if ok && binderID > 0 {
			credential, loadErr := s.LoadCredential(ctx, binderID)
			if loadErr != nil || credential != nil {
				return credential, loadErr
			}
			// 绑定者已经清掉凭证：继续走旧链，避免整房间突然不可播。
		}
	}

	if roomID != "" {
		room, err := s.Rooms.FindByRoomID(ctx, roomID)
		if err != nil {
			if errors.Is(err, store.ErrRoomNotFound) {
				return nil, nil
			}
			return nil, err
		}
		if room.OwnerUserID != nil {
			credential, err := s.LoadCredential(ctx, *room.OwnerUserID)
			if err != nil || credential != nil {
				return credential, err
			}
		}
	}
	return s.LoadCredential(ctx, userID)
}

// CookieHeaderFor 取凭证的请求头 cookie（无凭证时为空串）。
func CookieHeaderFor(credential *store.NcmCredential) string {
	if credential == nil {
		return ""
	}
	return ToCookieHeader(credential.Cookies)
}

// CredentialKey 是「凭证归属」键（缓存 key 用）。
//
// 有凭证时用凭证的 userId（房主凭证解出来的直链只给同一条凭证链的请求），
// 没有则退回请求者 userId（游客为 0）。
func CredentialKey(credential *store.NcmCredential, userID int64) string {
	if credential != nil && credential.UserID > 0 {
		return formatInt(credential.UserID)
	}
	return formatInt(userID)
}

// formatInt 是 strconv.FormatInt 的短别名（拼路径 / 缓存键用得多）。
func formatInt(value int64) string { return strconv.FormatInt(value, 10) }
