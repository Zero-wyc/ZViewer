package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"zviewer/backend/internal/auth"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/nms"
	"zviewer/backend/internal/store"
)

// OBS 推流模式（复刻 modules/stream-push + routes/stream-push 的 REST 部分）。
//
// 媒体服务默认由 Go 进程内托管（见 internal/nms），也可以指向外部服务：
// `/live` 把 HTTP-FLV 请求反代到媒体服务（默认进程内，`internal/nms`；
// 设了 NMS_HTTP_FLV_URL 时是外部服务），`/api/stream-push/*` 只负责
// 下发 OBS 配置。两者都依赖同一个可用性探测。

func (s *Server) registerStreamPushRoutes(mux *http.ServeMux) {
	// 下载 OBS 场景集合配置（含推流地址与推流码），必须登录。
	mux.HandleFunc("GET /api/stream-push/obs-config/{roomId}", s.Auth.Require(s.handleObsConfig))
	mux.HandleFunc("GET /api/stream-push/watch/{roomId}", s.Auth.Require(s.handleWatchTicket))
}

// handleObsConfig 生成 OBS 场景集合 JSON。
//
// 与 Node 的 buildRtmpServerUrl + router.get 逐条对齐：
// 404 房间不存在 / 400 非投屏模式 / 缺 streamKey 时补一个再落库。
func (s *Server) handleObsConfig(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")

	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.NotFound(w, "房间不存在")
			return
		}
		httpx.InternalError(w, "GET /api/stream-push/obs-config", err)
		return
	}
	if !canControlRoom(auth.ClaimsFrom(r.Context()), room) || room.Status != "active" {
		httpx.Forbidden(w, "仅活动房间的房主或管理员可获取发布配置")
		return
	}
	if room.Mode != "screen-share" {
		httpx.BadRequest(w, "该房间不是投屏模式")
		return
	}

	// 缺码或旧 32 位码在房主下载配置时原子迁移到八位，已有八位码保持稳定。
	streamKey := ""
	if room.StreamKey != nil {
		streamKey = *room.StreamKey
	}
	if len(streamKey) != nms.StreamKeyLength {
		streamKey, err = s.Rooms.EnsureStreamKey(r.Context(), roomID, room.OwnerUserID, nms.GenerateStreamKey())
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.Forbidden(w, "房间已关闭或房主已变更，请重新获取配置")
			return
		}
		if err != nil {
			httpx.InternalError(w, "GET /api/stream-push/obs-config", err)
			return
		}
	}

	// Go 把 Host 头单独放在 r.Host（不进 r.Header），等价 Node 的 req.headers.host。
	serverURL := s.NMS.Config().RtmpServerURL(trustedRtmpHost(r))
	payload := buildOBSConfig(serverURL, streamKey)

	// Node 用 res.json + 显式 Content-Disposition：浏览器直接存成文件。
	// 不带尾换行（Encoder 会补一个 \n，Node 不会），并关掉 HTML 转义。
	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		httpx.InternalError(w, "GET /api/stream-push/obs-config", err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="zviewer-obs-config.json"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}

// OBS 场景集合文件的形状必须逐字节贴近 Node 版：
// 用户在 OBS 里导入后会拿到「ZViewer 推流」场景与一条已配好的自定义推流，
// 少一个键就可能被 OBS 的版本迁移流程改写或丢弃。
type obsConfig struct {
	CurrentScene        string          `json:"current_scene"`
	CurrentProgramScene string          `json:"current_program_scene"`
	Name                string          `json:"name"`
	SceneOrder          []obsSceneOrder `json:"scene_order"`
	Sources             []any           `json:"sources"`
	Service             obsService      `json:"service"`
}

type obsSceneOrder struct {
	Name string `json:"name"`
}

type obsPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type obsSceneItem struct {
	Name            string         `json:"name"`
	SourceUUID      string         `json:"source_uuid"`
	Visible         bool           `json:"visible"`
	Locked          bool           `json:"locked"`
	Rot             float64        `json:"rot"`
	Pos             obsPoint       `json:"pos"`
	Scale           obsPoint       `json:"scale"`
	Alignment       int            `json:"alignment"`
	BoundsType      int            `json:"bounds_type"`
	BoundsAlignment int            `json:"bounds_alignment"`
	Bounds          obsPoint       `json:"bounds"`
	CropLeft        int            `json:"crop_left"`
	CropTop         int            `json:"crop_top"`
	CropRight       int            `json:"crop_right"`
	CropBottom      int            `json:"crop_bottom"`
	GroupItemBackup bool           `json:"group_item_backup"`
	ScaleFilter     string         `json:"scale_filter"`
	BlendMethod     string         `json:"blend_method"`
	BlendType       string         `json:"blend_type"`
	PrivateSettings map[string]any `json:"private_settings"`
}

type obsSceneSettings struct {
	IDCounter int            `json:"id_counter"`
	Items     []obsSceneItem `json:"items"`
}

// obsSceneSource 是场景本身（sources[0]）。注意它**没有** private_settings，
// Node 字面量里就没有——多写一个键同样算形状不一致。
type obsSceneSource struct {
	Name        string           `json:"name"`
	ID          string           `json:"id"`
	VersionedID string           `json:"versioned_id"`
	Settings    obsSceneSettings `json:"settings"`
	Mixers      int              `json:"mixers"`
	Sync        int              `json:"sync"`
	Flags       int              `json:"flags"`
}

type obsOutputSettings struct {
	Server  string `json:"server"`
	Key     string `json:"key"`
	UseAuth bool   `json:"use_auth"`
}

type obsOutputSource struct {
	Name            string            `json:"name"`
	ID              string            `json:"id"`
	VersionedID     string            `json:"versioned_id"`
	Settings        obsOutputSettings `json:"settings"`
	PrivateSettings map[string]any    `json:"private_settings"`
}

type obsServiceSettings struct {
	Server string `json:"server"`
	Key    string `json:"key"`
}

type obsService struct {
	Type     string             `json:"type"`
	Settings obsServiceSettings `json:"settings"`
}

// buildOBSConfig 按 Node 的字面量顺序拼装场景集合。
func buildOBSConfig(serverURL, streamKey string) obsConfig {
	const sceneName = "ZViewer 推流"
	empty := func() map[string]any { return map[string]any{} }

	return obsConfig{
		CurrentScene:        sceneName,
		CurrentProgramScene: sceneName,
		Name:                sceneName,
		SceneOrder:          []obsSceneOrder{{Name: sceneName}},
		Sources: []any{
			obsSceneSource{
				Name:        sceneName,
				ID:          "scene",
				VersionedID: "scene",
				Settings: obsSceneSettings{
					IDCounter: 1,
					Items: []obsSceneItem{{
						Name:            "ZViewer RTMP 推流",
						SourceUUID:      "zviewer-rtmp-push",
						Visible:         true,
						Locked:          false,
						Rot:             0,
						Pos:             obsPoint{},
						Scale:           obsPoint{X: 1, Y: 1},
						Alignment:       5,
						BoundsType:      0,
						BoundsAlignment: 0,
						Bounds:          obsPoint{},
						CropLeft:        0,
						CropTop:         0,
						CropRight:       0,
						CropBottom:      0,
						GroupItemBackup: false,
						ScaleFilter:     "disable",
						BlendMethod:     "default",
						BlendType:       "normal",
						PrivateSettings: empty(),
					}},
				},
				Mixers: 0,
				Sync:   0,
				Flags:  0,
			},
			obsOutputSource{
				Name:        "ZViewer RTMP 推流",
				ID:          "rtmp_output",
				VersionedID: "rtmp_output",
				Settings: obsOutputSettings{
					Server:  serverURL,
					Key:     streamKey,
					UseAuth: false,
				},
				PrivateSettings: empty(),
			},
		},
		Service: obsService{
			Type: "rtmp_custom",
			Settings: obsServiceSettings{
				Server: serverURL,
				Key:    streamKey,
			},
		},
	}
}

// registerLiveRoutes 挂载 /live 的 HTTP-FLV 反代。
//
// 顺序即行为：必须注册在 "/"（SPA 回退）之前，否则 /live 会被回成 index.html。
// 同时注册精确路径与子树：Node 的 app.use('/live', ...) 两者都吃。
func (s *Server) registerLiveRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/live", s.handleLiveProxy)
	mux.HandleFunc("/live/", s.handleLiveProxy)
}

// livePassthroughHeaders 是需要回传给客户端的上游响应头（与 Node 白名单一致）。
var livePassthroughHeaders = []string{
	"Content-Length",
	"Accept-Ranges",
	"Content-Range",
	"Etag",
	"Last-Modified",
}

// handleLiveProxy 把 HTTP-FLV 拉流请求反代到 NMS。
//
// NMS 不可用时**不报错**，而是交回 SPA 回退（Node 的 `return next()` 之后
// 落到静态中间件）：路径不以 /api/ 开头，最终返回 index.html。
func (s *Server) handleLiveProxy(w http.ResponseWriter, r *http.Request) {
	key, valid := s.watchKey(r.Context(), r.URL.Query().Get("ticket"), strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/live/"), ".flv"))
	if !valid {
		httpx.Forbidden(w, "请重新获取房间观看权限")
		return
	}
	if !s.NMS.Available() {
		// 与 Node 的 `if (!nmsService.isAvailable()) return next()` 一致：
		// 交回后续中间件，最终落到 SPA 回退（不是 502）。
		s.spaHandler().ServeHTTP(w, r)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, valid := s.watchKey(ctx, r.URL.Query().Get("ticket"), strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/live/"), ".flv")); !valid {
					cancel()
					return
				}
			}
		}
	}()
	target := s.NMS.Config().LiveUpstream("/live/" + url.PathEscape(key) + ".flv?ticket=" + url.QueryEscape(r.URL.Query().Get("ticket")))
	upstream, err := http.NewRequestWithContext(ctx, r.Method, target, nil)
	if err != nil {
		httpx.Fail(w, http.StatusBadGateway, "HTTP-FLV 拉流代理失败")
		return
	}
	// 与 proxy/http-proxy.ts#buildUpstreamHeaders 对齐：
	// 默认桌面 Chrome UA、Accept 全收，Range 与条件请求头原样透传。
	ua := strings.TrimSpace(r.Header.Get("User-Agent"))
	if ua == "" {
		ua = defaultProxyUA
	}
	upstream.Header.Set("User-Agent", ua)
	upstream.Header.Set("Accept", "*/*")
	for _, name := range []string{"Range", "If-None-Match", "If-Range"} {
		if v := r.Header.Get(name); v != "" {
			upstream.Header.Set(name, v)
		}
	}

	resp, err := http.DefaultClient.Do(upstream)
	if err != nil {
		// 客户端主动断连（关页面/切台）不是错误，别刷日志也别回 502
		if r.Context().Err() != nil {
			return
		}
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		log.Printf("[live] 拉流失败: %v", err)
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			httpx.Fail(w, http.StatusGatewayTimeout, "上游请求超时")
			return
		}
		httpx.Fail(w, http.StatusBadGateway, "HTTP-FLV 拉流代理失败")
		return
	}
	defer resp.Body.Close()

	// video.src 跨源加载媒体要 ACAO:*，否则会被 ORB 拦。
	setWildcardCORS(w)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		for _, name := range livePassthroughHeaders {
			if v := resp.Header.Get(name); v != "" {
				w.Header().Set(name, v)
			}
		}
		// 错误响应不转发正文；非 HEAD 的长度必须显式归零，
		// 否则客户端会一直等一个永远不来的正文。
		if r.Method != http.MethodHead {
			w.Header().Set("Content-Length", "0")
		}
		w.WriteHeader(resp.StatusCode)
		return
	}

	contentType := resp.Header.Get("Content-Type")
	// NMS 偶发把 FLV 回成 application/json，此时按调用方默认值纠正，
	// 否则浏览器解析不了流（与 Node 的 isJsonMismatch 分支同义）。
	// 其余情况**原样透传**（含 charset 参数），别做 ParseMediaType，
	// 那会把 `; charset=utf-8` 这类参数裁掉，与 Node 的写法不一致。
	if contentType == "" || strings.Contains(strings.ToLower(contentType), "application/json") {
		contentType = "video/x-flv"
	}
	w.Header().Set("Content-Type", contentType)

	for _, name := range livePassthroughHeaders {
		if v := resp.Header.Get(name); v != "" {
			w.Header().Set(name, v)
		}
	}
	if w.Header().Get("Accept-Ranges") == "" {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	// 直播流：禁止中间代理（Nginx）缓冲整个响应体。
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Proxy-Buffering", "no")
	w.Header().Set("Cache-Control", "no-transform")

	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodHead {
		return
	}
	streamCopy(w, resp.Body)
}

// streamCopy 逐块转写并及时 flush：FLV 是长连接推送，
// 攒在 4KB 缓冲里会让首帧与后续 GOP 都延迟到能凑满一块才出去。
func streamCopy(w http.ResponseWriter, body io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// setWildcardCORS 与 proxy/http-proxy.ts#setWildcardCors 一致。
func setWildcardCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
}

// defaultProxyUA 是上游默认 UA（与 Node 的 DEFAULT_PROXY_UA 同一串）。
const defaultProxyUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// Forwarded hosts are trusted only for an explicitly configured proxy network.
func trustedRtmpHost(r *http.Request) string {
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.Host
	}
	ip := net.ParseIP(remote)
	trusted := false
	for _, raw := range strings.Split(os.Getenv("TRUSTED_PROXY_CIDRS"), ",") {
		_, cidr, err := net.ParseCIDR(strings.TrimSpace(raw))
		if err == nil && cidr.Contains(ip) {
			trusted = true
		}
	}
	if !trusted {
		return r.Host
	}
	forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if forwarded == "" || strings.ContainsAny(forwarded, ",/\\@?# \r\n\t") {
		return r.Host
	}
	u, err := url.Parse("http://" + forwarded)
	if err != nil || u.Hostname() == "" {
		return r.Host
	}
	return forwarded
}

type watchGrant struct {
	RoomID string      `json:"r"`
	Claims auth.Claims `json:"c"`
}

func (s *Server) handleWatchTicket(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !s.requireRoomRead(w, r, roomID) {
		return
	}
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil || room.Status != "active" || room.Mode != "screen-share" || room.ShareMethod != "stream-push" || room.StreamKey == nil {
		httpx.Forbidden(w, "房间当前未启用推流观看")
		return
	}
	body, _ := json.Marshal(watchGrant{roomID, *auth.ClaimsFrom(r.Context())})
	ticket := s.Tokens.SignCapability("flv-watch", string(body), 12*time.Hour)
	w.Header().Set("Cache-Control", "no-store")
	httpx.OK(w, map[string]any{"success": true, "url": "/live/" + url.PathEscape(roomID) + ".flv?ticket=" + url.QueryEscape(ticket)})
}
func (s *Server) watchKey(ctx context.Context, ticket, roomID string) (string, bool) {
	if s.Tokens == nil {
		return "", false
	}
	raw, err := s.Tokens.VerifyCapability(ticket, "flv-watch")
	if err != nil {
		return "", false
	}
	var grant watchGrant
	if json.Unmarshal([]byte(raw), &grant) != nil || grant.RoomID != roomID {
		return "", false
	}
	if err := s.Auth.AssertActive(ctx, &grant.Claims); err != nil {
		return "", false
	}
	allowed, err := s.canReadRoom(ctx, roomID, &grant.Claims)
	if err != nil || !allowed {
		return "", false
	}
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil || room.Status != "active" || room.Mode != "screen-share" || room.ShareMethod != "stream-push" || room.StreamKey == nil {
		return "", false
	}
	return *room.StreamKey, true
}
func (s *Server) authorizePublish(ctx context.Context, key string) bool {
	if s.DB == nil || len(key) != nms.StreamKeyLength {
		return false
	}
	var count int
	err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM room WHERE streamKey = ? AND status = 'active' AND mode = 'screen-share' AND shareMethod = 'stream-push'`, key).Scan(&count)
	return err == nil && count == 1
}
func (s *Server) authorizeFLV(ctx context.Context, key, ticket string) bool {
	if s.Tokens == nil {
		return false
	}
	raw, err := s.Tokens.VerifyCapability(ticket, "flv-watch")
	if err != nil {
		return false
	}
	var grant watchGrant
	if json.Unmarshal([]byte(raw), &grant) != nil {
		return false
	}
	expected, ok := s.watchKey(ctx, ticket, grant.RoomID)
	return ok && expected == key
}
