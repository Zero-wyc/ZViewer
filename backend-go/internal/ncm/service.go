package ncm

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/store"
)

// 探测缓存：内部服务在线时 30 秒内不再探，离线时 3 秒后重试。
//
// 为什么需要探测：Node 版的 `getNcmApiBase()` 只有在内部服务**启动成功**后
// 才有值，服务没起时所有端点直接 503。Go 版不带那个 npm 包，Base 是外部配的
// 常量，所以用一次轻量探测来复刻「服务在不在」这个状态——否则 NCM 没跑时
// 每个请求都要等一次连接超时才能报错。
const (
	probeOKTTL   = 30 * time.Second
	probeFailTTL = 3 * time.Second
)

// Service 是网易云服务层：凭证 + 上游调用 + 业务编排。
type Service struct {
	// Base 是内部 NCM API 服务地址（不带尾斜杠）；空串表示未配置。
	Base   string
	Client *Client
	Creds  *store.NcmCredentials
	Rooms  *store.Rooms

	probeMu    sync.Mutex
	probeUntil time.Time
	probeOK    bool
}

// NewService 构造服务。base 为空时所有端点返回 503 NCM_UNAVAILABLE。
func NewService(conn *sql.DB, base string) *Service {
	return &Service{
		Base:   strings.TrimRight(strings.TrimSpace(base), "/"),
		Client: NewClient(),
		Creds:  store.NewNcmCredentials(conn),
		Rooms:  store.NewRooms(conn),
	}
}

// Available 返回可用的基地址；内部服务不可达时 ok=false（路由层回 503）。
func (s *Service) Available(ctx context.Context) (string, bool) {
	if s.Base == "" {
		return "", false
	}
	s.probeMu.Lock()
	defer s.probeMu.Unlock()
	if time.Now().Before(s.probeUntil) {
		return s.Base, s.probeOK
	}
	ok := s.Client.Probe(ctx, s.Base) == nil
	s.probeOK = ok
	if ok {
		s.probeUntil = time.Now().Add(probeOKTTL)
	} else {
		s.probeUntil = time.Now().Add(probeFailTTL)
	}
	return s.Base, ok
}

// LoadCredential 读取用户持久化的网易云凭证；游客/未登录返回 (nil, nil)。
func (s *Service) LoadCredential(ctx context.Context, userID int64) (*store.NcmCredential, error) {
	if userID <= 0 {
		return nil, nil
	}
	return s.Creds.FindByUserID(ctx, userID)
}

// CredentialForRequest 是凭证回退链：当前用户 → 房主（请求带 roomId 时）。
//
// 实现 spec「房主登录网易云后全房间可播 VIP」：观众自己没登录/没凭证时，
// 借用房主的持久化凭证解析直链。`/stream` 与 `/song-quality` 共用。
func (s *Service) CredentialForRequest(ctx context.Context, userID int64, roomID string) (*store.NcmCredential, error) {
	credential, err := s.LoadCredential(ctx, userID)
	if err != nil || credential != nil {
		return credential, err
	}
	if roomID == "" {
		return nil, nil
	}
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		if err == store.ErrRoomNotFound {
			return nil, nil
		}
		return nil, err
	}
	if room.OwnerUserID == nil {
		return nil, nil
	}
	return s.LoadCredential(ctx, *room.OwnerUserID)
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

// formatInt 是 strconv.FormatInt 的短别名（拼 URL / 缓存键用得多）。
func formatInt(value int64) string { return strconv.FormatInt(value, 10) }
