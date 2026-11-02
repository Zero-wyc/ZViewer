// Package piikbridge 把 Piik 的 /signal 信令端点接进 ZViewer。
//
// Piik 的房间是它自己的模型：5 位数字房间码 + 房主 token + 观众 grant；ZViewer
// 的房间是另一套：字符串 roomId + socket.io 会话 + 自己的准入策略。两边都不改，
// 桥接层只做三件事：
//
//  1. 房间映射：一个 ZViewer 房间换一个 Piik 房间码，凭证只经带鉴权的 REST
//     下发，浏览器拿不到别的房间的凭证。
//  2. 站点通行证：/signal 升级时 Piik 要 site access，用一枚短期 HttpOnly
//     cookie 表达「这个浏览器刚通过 ZViewer 鉴权」。
//  3. Origin：Piik 的允许来源是启动期固定集合，而 ZViewer 没有固定公网域名
//     （局域网、反代、IP 直连都在用），所以同源判定在本层做完再交给 Piik。
//
// 媒体面（SFU / 转发）不在本阶段：S1 只要求握手与认证这条链路通。
package piikbridge

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/signal"
)

const (
	// SignalPath 是 Piik 客户端写死的信令路径（src/client/lib/signaling.ts）。
	SignalPath = "/signal"

	// 空房保留时长：房主与观众全掉线后才开始计时，够一次浏览器重连。
	defaultRoomEmptyTimeout = 10 * time.Minute
	// Piik 单房间观众上限由协议钉死（protocol.MaxViewersPerRoomLimit）。
	defaultMaxViewersPerRoom = protocol.MaxViewersPerRoomLimit
	// 房间码只有 9000 个。取一半，留出旧实现并行运行的空间。
	defaultMaxRooms = room.Capacity / 2
)

// ErrNoRoom 表示该 ZViewer 房间还没有 Piik 房间（房主没开播，或空房已回收）。
var ErrNoRoom = errors.New("piik room is not open")

// ErrClosed 表示桥接层已随进程关闭。
var ErrClosed = errors.New("piik bridge is closed")

// Credentials 是给浏览器的一份房间凭证，role 决定 token 与 grant 哪个有效。
type Credentials struct {
	RoomID string
	Role   string
	Token  string
	Grant  string
}

// Options 是桥接层的装配参数，零值可用。
type Options struct {
	// PublicBaseURL 仅用于 Piik 生成邀请链接，不参与鉴权。
	PublicBaseURL *url.URL
	// AllowedOrigins 是 CORS_ORIGIN 显式列出的来源，与同源判定并存。
	AllowedOrigins []string
	// AllowAllOrigins 对应 CORS_ORIGIN=*，即不限制来源。
	AllowAllOrigins bool
	// ICE 是下发给浏览器的 ICE 配置；为零时会用默认公共 STUN。
	ICE protocol.IceConfig
	// RoomEmptyTimeout 为零时取 10 分钟。
	RoomEmptyTimeout  time.Duration
	MaxRooms          int
	MaxViewersPerRoom int
	// TicketSecret 是站点通行证的签名密钥；为空时随机生成，重启即作废。
	TicketSecret []byte
	Logger       *slog.Logger
}

// Bridge 持有 Piik 信令服务器与 ZViewer 房间的映射。
type Bridge struct {
	signal *signal.Server
	ice    protocol.IceConfig

	allowAll bool
	allowed  map[string]struct{}

	secret []byte
	logger *slog.Logger

	mu     sync.Mutex
	rooms  map[string]binding
	closed bool
}

type binding struct {
	roomID string
	token  string
	grant  string
}

// New 构造桥接层并启动 Piik 的心跳。返回后即可挂载 Handler。
func New(options Options) (*Bridge, error) {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	maxRooms := options.MaxRooms
	if maxRooms <= 0 {
		maxRooms = defaultMaxRooms
	}
	maxViewers := options.MaxViewersPerRoom
	if maxViewers <= 0 {
		maxViewers = defaultMaxViewersPerRoom
	}
	emptyTimeout := options.RoomEmptyTimeout
	if emptyTimeout <= 0 {
		emptyTimeout = defaultRoomEmptyTimeout
	}
	ice := options.ICE
	if len(ice.IceServers) == 0 {
		ice = DefaultICE()
	}
	publicBase := options.PublicBaseURL
	if publicBase == nil {
		publicBase = &url.URL{Scheme: "http", Host: "localhost"}
	}

	// 内存房间：Piik 自己的房间库是 SQLite，ZViewer 已经有库，不在这里再开一份。
	store, err := room.New(room.Options{
		MaxRooms:          maxRooms,
		MaxViewersPerRoom: maxViewers,
	})
	if err != nil {
		return nil, err
	}

	b := &Bridge{
		ice:      ice,
		allowAll: options.AllowAllOrigins,
		allowed:  make(map[string]struct{}, len(options.AllowedOrigins)),
		secret:   options.TicketSecret,
		logger:   logger,
		rooms:    map[string]binding{},
	}
	for _, origin := range options.AllowedOrigins {
		if origin != "" {
			b.allowed[origin] = struct{}{}
		}
	}
	if len(b.secret) == 0 {
		secret := make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return nil, err
		}
		b.secret = secret
	}

	// Piik 的 Origin 允许表只认启动期的固定集合，见 origins.go 的说明：
	// 真正的判定在本层，交给它的是规范化后的同一个来源。
	signaling, err := signal.New(signal.Options{
		Store: store,
		// 端点拷贝预算取协议上限 3：`route.effectiveCapacity` 会把它 clamp
		// 到 MaxEndpointMediaCopyCapacity，传更小的值只会让树变矮（默认 2
		// 时 20 人的房间铺不满）。语音的每个中间节点还要额外占一条上游边，
		// 3 条下游 + 1 条上游仍在浏览器能稳定维持的范围内。
		EndpointMediaCopyCapacity: protocol.MaxEndpointMediaCopyCapacity,
		Ice:                       ice,
		AllowedOrigins:            map[string]struct{}{canonicalOrigin: {}},
		SiteAccessAtUpgrade: func(request *http.Request) bool {
			return b.siteAccess(request)
		},
		PublicBaseURL:      publicBase,
		RoomEmptyTimeoutMs: emptyTimeout.Milliseconds(),
		Logger:             logger,
	})
	if err != nil {
		return nil, err
	}
	b.signal = signaling
	return b, nil
}

// ICE 返回下发给浏览器的 ICE 配置。
func (b *Bridge) ICE() protocol.IceConfig { return b.ice }

// Host 返回该 ZViewer 房间的房主凭证；没有房间时新建一个。
//
// 旧映射会先校验：Piik 的空房回收是不通知外部的，缓存的 token 可能已经作废，
// 此时直接换一个新房间码，而不是让房主在 WS 上撞 INVALID_TOKEN。
func (b *Bridge) Host(zviewerRoomID string) (Credentials, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return Credentials{}, ErrClosed
	}
	if current, ok := b.rooms[zviewerRoomID]; ok {
		if b.signal.RoomAuthorityValid(current.roomID, current.token) {
			return Credentials{RoomID: current.roomID, Role: protocol.RoleHost, Token: current.token}, nil
		}
		delete(b.rooms, zviewerRoomID)
	}
	created, err := b.signal.CreateRoom(protocol.CodeEntryPrivate, nil, "")
	if err != nil {
		return Credentials{}, err
	}
	b.rooms[zviewerRoomID] = binding{roomID: created.RoomID, token: created.HostToken, grant: created.ViewerGrant}
	return Credentials{RoomID: created.RoomID, Role: protocol.RoleHost, Token: created.HostToken}, nil
}

// Viewer 返回该 ZViewer 房间的观众凭证。房主没开播时返回 ErrNoRoom。
func (b *Bridge) Viewer(zviewerRoomID string) (Credentials, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return Credentials{}, ErrClosed
	}
	current, ok := b.rooms[zviewerRoomID]
	if !ok {
		return Credentials{}, ErrNoRoom
	}
	if !b.signal.ViewerGrantValid(current.roomID, current.grant) {
		// 空房回收后 grant 一起失效；房间本身可能还在，只是没人开播。
		delete(b.rooms, zviewerRoomID)
		return Credentials{}, ErrNoRoom
	}
	return Credentials{RoomID: current.roomID, Role: protocol.RoleViewer, Grant: current.grant}, nil
}

// Release 结束该 ZViewer 房间对应的 Piik 房间，已连接的会话会收到 room-closed。
func (b *Bridge) Release(zviewerRoomID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return ErrClosed
	}
	current, ok := b.rooms[zviewerRoomID]
	if !ok {
		return nil
	}
	delete(b.rooms, zviewerRoomID)
	if err := b.signal.EndRoom(current.roomID, current.token); err != nil &&
		!errors.Is(err, signal.ErrHostToken) {
		return err
	}
	return nil
}

// Close 停止信令：先给每个会话发 1012，再结束全部房间。
func (b *Bridge) Close(ctx context.Context) error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	b.rooms = map[string]binding{}
	b.mu.Unlock()
	return b.signal.Close(ctx)
}

// DefaultICE 与前端 lib/iceServers.ts 保持同一组 STUN：两边各写一份是刻意的，
// 服务端不能 import 前端模块；改一处就要改另一处。
func DefaultICE() protocol.IceConfig {
	urls := []string{
		"stun:stun.miwifi.com:3478",
		"stun:stun.cdnbye.com:3478",
		"stun:stun.l.google.com:19302",
		"stun:stun1.l.google.com:19302",
	}
	servers := make([]protocol.IceServer, 0, len(urls))
	for _, u := range urls {
		servers = append(servers, protocol.IceServer{URLs: protocol.IceServerURLList(u)})
	}
	return protocol.IceConfig{IceServers: servers}
}
