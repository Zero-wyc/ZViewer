package api

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/emby"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/mountutil"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/store"
)

// embyLikeKind 参数化 Emby / Jellyfin 的差异。
//
// Jellyfin 是 Emby 的开源分支，API 完全兼容。Node 侧为了消掉两份逐行平行的
// 拷贝做了 emby-like-factory；Go 侧同样只写一套 handler，靠这个结构体区分
// 挂载类型、错误文案与路由前缀。
type embyLikeKind struct {
	MountType string // UserMount.type
	Label     string // 错误文案里的显示名
	Prefix    string // /api/{prefix}
	// FallbackCode 是「非客户端错误」的错误码兜底（EMBY_ERROR / JELLYFIN_ERROR）
	FallbackCode string
}

var (
	embyKind     = embyLikeKind{MountType: "emby", Label: "Emby", Prefix: "emby", FallbackCode: "EMBY_ERROR"}
	jellyfinKind = embyLikeKind{MountType: "jellyfin", Label: "Jellyfin", Prefix: "jellyfin", FallbackCode: "JELLYFIN_ERROR"}
)

// registerEmbyRoutes 注册 Emby 与 Jellyfin 两套端点（一套 handler 注册两次）。
func (s *Server) registerEmbyRoutes(mux *http.ServeMux) {
	for _, kind := range []embyLikeKind{embyKind, jellyfinKind} {
		base := "/api/" + kind.Prefix
		// 海报图免认证：<img> 无法带 Authorization 头，且本项目的 HTTP 部署
		// 场景下 httpOnly cookie 也不可用（与 /proxy-image 同理）。
		// 弱保护靠 tag：ImageTags.Primary 是不可枚举的 hash，必须先通过
		// 认证的 browse 才能拿到。
		mux.HandleFunc("GET "+base+"/mounts/{id}/image", s.handleEmbyMountImage(kind))

		mux.HandleFunc("GET "+base+"/mounts", s.Auth.Require(s.handleEmbyListMounts(kind)))
		mux.HandleFunc("POST "+base+"/mounts/test", s.Auth.Require(s.handleEmbyTestMount(kind)))
		mux.HandleFunc("POST "+base+"/mounts", s.Auth.Require(s.handleEmbyCreateMount(kind)))
		mux.HandleFunc("PUT "+base+"/mounts/{id}", s.Auth.Require(s.handleEmbyUpdateMount(kind)))
		mux.HandleFunc("DELETE "+base+"/mounts/{id}", s.Auth.Require(s.handleEmbyDeleteMount(kind)))
		mux.HandleFunc("GET "+base+"/mounts/{id}/browse", s.Auth.Require(s.handleEmbyBrowseMount(kind)))
		mux.HandleFunc("GET "+base+"/mounts/{id}/search", s.Auth.Require(s.handleEmbySearchMount(kind)))
		mux.HandleFunc("GET "+base+"/resolve", s.Auth.Require(s.handleEmbyResolve(kind)))
		mux.HandleFunc("GET "+base+"/movie-source", s.Auth.Require(s.handleEmbyMovieSource(kind)))
		mux.HandleFunc("GET "+base+"/proxy", s.Auth.Require(s.handleEmbyProxy(kind)))
		mux.HandleFunc("GET "+base+"/stream", s.Auth.Require(s.handleEmbyStream(kind)))
	}
}

// ==================== 错误映射 ====================

// embyErrorCode 对应 Node 的 extractErrorCode：
// 只有 EmbyError 才有业务码，其余一律 UNREACHABLE。
func embyErrorCode(kind embyLikeKind, err error) string {
	var embyErr *emby.Error
	if errors.As(err, &embyErr) {
		if embyErr.Code != "" {
			return embyErr.Code
		}
		return kind.FallbackCode
	}
	return "UNREACHABLE"
}

// embyErrorMessage 对应 extractErrorMessage：有文案就用原文案。
func embyErrorMessage(err error, fallback string) string {
	if err != nil && err.Error() != "" {
		return err.Error()
	}
	return fallback
}

// embyErrorStatus 对应 mapMountErrorCodeToStatus。
//
// timeout 传 0 表示「不特判 TIMEOUT」（Node 的 timeout 选项未传）。
func embyErrorStatus(code string, fallback int, notFound bool, timeout int) int {
	if code == "AUTH_FAILED" {
		return http.StatusUnauthorized
	}
	if notFound && code == "NOT_FOUND" {
		return http.StatusNotFound
	}
	if timeout != 0 && code == "TIMEOUT" {
		return timeout
	}
	return fallback
}

// failEmby 输出带 code 的错误（code 为空则不下发该字段）。
func failEmby(w http.ResponseWriter, status int, message, code string) {
	failMount(w, status, message, code)
}

// embyStreamError 是 /stream 的 StreamMovieError 收尾（对应
// sendStreamMovieErrorResponse）：熔断命中不打日志、headers 已发只能断连。
func embyStreamError(w http.ResponseWriter, tag string, err *proxy.StreamError, extra string) {
	if !err.FromCache {
		suffix := ""
		if extra != "" {
			suffix = " " + extra
		}
		log.Printf("[%s] stream %s %d: %s%s", tag, err.Code, err.Status, err.Message, suffix)
	}
	httpx.FailWithCode(w, err.Status, err.Message, err.Code)
}

// ==================== 条目 DTO ====================

// embyEntry 是前端可识别的条目（browse / search 共用）。
//
// 指针 + omitempty 是硬要求：Node 侧 `filePath: item.Path` 在 Path 缺失时
// 是 undefined，JSON.stringify 会整键丢掉；用 string 会下发 ""，
// 前端 `entry.filePath ?? 从文件名解析集号` 的兜底就永远不触发。
type embyEntry struct {
	Name               *string `json:"name,omitempty"`
	Path               *string `json:"path,omitempty"`
	Type               string  `json:"type"`
	EmbyType           *string `json:"embyType,omitempty"`
	ChildCount         int     `json:"childCount"`
	ImageTag           *string `json:"imageTag,omitempty"`
	ProductionYear     *int    `json:"productionYear,omitempty"`
	IndexNumber        *int    `json:"indexNumber,omitempty"`
	ParentIndexNumber  *int    `json:"parentIndexNumber,omitempty"`
	Duration           *int    `json:"duration,omitempty"`
	FilePath           *string `json:"filePath,omitempty"`
	RecursiveItemCount *int    `json:"recursiveItemCount,omitempty"`
}

// playableTypes 是可以直接播放的条目类型（其余按目录处理）。
var playableTypes = map[string]bool{
	"Movie": true, "Video": true, "Episode": true, "TvSeries": true,
}

func mapEmbyEntries(items []emby.EmbyItem) []embyEntry {
	entries := make([]embyEntry, 0, len(items))
	for _, item := range items {
		isFile := item.Type != nil && playableTypes[*item.Type]
		if !isFile && item.IsFile != nil && *item.IsFile {
			isFile = true
		}
		entryType := "directory"
		if isFile {
			entryType = "file"
		}
		entry := embyEntry{
			Type:       entryType,
			EmbyType:   item.Type,
			ChildCount: 0,
			FilePath:   item.Path,
		}
		if item.ID != "" {
			id := item.ID
			entry.Path = &id
		}
		entry.Name = item.Name
		if item.ChildCount != nil {
			entry.ChildCount = *item.ChildCount
		}
		// 只有真的拿到 tag 才下发：Emby 对没有海报的条目返回
		// `ImageTags: {}`，Node 取到的是 undefined（整键丢弃）。
		// 这里下发 "" 会让前端的「有 tag 才渲染 <img>」判断失效。
		if item.ImageTags != nil && item.ImageTags.Primary != "" {
			tag := item.ImageTags.Primary
			entry.ImageTag = &tag
		}
		entry.ProductionYear = item.ProductionYear
		entry.IndexNumber = item.IndexNumber
		entry.ParentIndexNumber = item.ParentIndexNumber
		if item.RunTimeTicks != nil {
			// 1 tick = 100ns；前端要的是秒（Node 用 Math.round）。
			seconds := int(math.Round(float64(*item.RunTimeTicks) / 10_000_000))
			entry.Duration = &seconds
		}
		entry.RecursiveItemCount = item.RecursiveItemCount
		entries = append(entries, entry)
	}
	return entries
}

// ==================== 请求体 ====================

// embyMountBody 用 any 接收，是为了复刻 Node 的真值判断：
// `!apiKey && (!username || !password)` 对 ""/0/false/null/undefined 都算缺失，
// 而 `typeof serverUrl !== 'string'` 又要求必须是字符串。
type embyMountBody struct {
	Name       any `json:"name"`
	ServerURL  any `json:"serverUrl"`
	APIKey     any `json:"apiKey"`
	Username   any `json:"username"`
	Password   any `json:"password"`
	DirectLink any `json:"directLink"`
	// 更新时用来区分「没传」与「传了空」
	raw map[string]json.RawMessage
}

func decodeEmbyBody(r *http.Request) (embyMountBody, error) {
	body := embyMountBody{}
	raw := map[string]json.RawMessage{}
	if err := httpx.DecodeJSON(r, &raw); err != nil {
		// 空体 / 非法 JSON：Node 的 req.body 会是 {}（express.json 允许空体）
		return embyMountBody{raw: map[string]json.RawMessage{}}, nil
	}
	body.raw = raw
	for key, dst := range map[string]*any{
		"name": &body.Name, "serverUrl": &body.ServerURL, "apiKey": &body.APIKey,
		"username": &body.Username, "password": &body.Password, "directLink": &body.DirectLink,
	} {
		if value, ok := raw[key]; ok {
			*dst = decodeAny(value)
		}
	}
	return body, nil
}

func decodeAny(raw json.RawMessage) any {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

// has 判断键是否出现过（对应 Node 的 `x !== undefined`）。
func (b embyMountBody) has(key string) bool {
	_, ok := b.raw[key]
	return ok
}

// jsTruthy 复刻 JS 的真值判断（用于凭证 / 名称的非空校验）。
func jsTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	case float64:
		return v != 0
	default:
		// 数组 / 对象在 JS 里恒为真
		return true
	}
}

// jsString 复刻 String(x)，用于把非字符串凭证交给登录逻辑。
func jsString(value any) string {
	switch v := value.(type) {
	case nil:
		return "undefined"
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

// stringValue 对应 `typeof x === 'string'` 的取值。
func stringValue(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// ==================== 挂载辅助 ====================

// requireOwnedEmbyMount 校验 mountId 归属并取挂载（对应 resolveUserMount）。
func (s *Server) requireOwnedEmbyMount(
	w http.ResponseWriter, r *http.Request, kind embyLikeKind,
) (*store.Mount, string, bool) {
	query := r.URL.Query()
	if !query.Has("mountId") {
		failEmby(w, http.StatusBadRequest, "缺少 mountId 参数", "")
		return nil, "", false
	}
	raw := query.Get("mountId")
	mountID := int64(0)
	if raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			failEmby(w, http.StatusBadRequest, "mountId 不正确", "")
			return nil, "", false
		}
		mountID = parsed
	}
	targetPath := strings.TrimSpace(query.Get("path"))
	if targetPath == "" {
		failEmby(w, http.StatusBadRequest, "缺少 path 参数", "")
		return nil, "", false
	}

	claims := auth.ClaimsFrom(r.Context())
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, kind.MountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failEmby(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return nil, "", false
		}
		httpx.InternalError(w, "GET /api/"+kind.Prefix+"/proxy", err)
		return nil, "", false
	}
	if mount.ServerURL == nil || *mount.ServerURL == "" {
		failEmby(w, http.StatusBadRequest, "该挂载未配置服务器地址", "")
		return nil, "", false
	}
	return mount, targetPath, true
}

// findOwnedEmbyMount 是 browse / search / resolve 的归属校验。
func (s *Server) findOwnedEmbyMount(
	w http.ResponseWriter, r *http.Request, kind embyLikeKind, rawID string,
) (*store.Mount, bool) {
	mountID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil {
		failEmby(w, http.StatusBadRequest, "挂载 ID 不正确", "INVALID_PARAMS")
		return nil, false
	}
	claims := auth.ClaimsFrom(r.Context())
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, kind.MountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failEmby(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return nil, false
		}
		httpx.InternalError(w, "GET /api/"+kind.Prefix+"/mounts", err)
		return nil, false
	}
	return mount, true
}

// mountSession 取挂载会话（登录缓存保证不会每次请求都打 authenticatebyname）。
func (s *Server) mountSession(r *http.Request, mount *store.Mount) (*emby.Session, error) {
	return emby.ResolveSession(r.Context(), mount)
}

// resolveEmbyDirectLink 在 resolve 里替换掉未升级的直链（保持字段语义集中）。
func derefEmbyID(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

// ==================== 挂载 CRUD ====================

func (s *Server) handleEmbyListMounts(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.ClaimsFrom(r.Context())
		mounts, err := s.Mounts.ListByUserType(r.Context(), claims.UserID, kind.MountType)
		if err != nil {
			log.Printf("[%s] list mounts error: %v", kind.Prefix, err)
			httpx.Fail(w, http.StatusInternalServerError, "获取 "+kind.Label+" 挂载列表失败")
			return
		}
		items := make([]mountDTO, 0, len(mounts))
		for _, mount := range mounts {
			items = append(items, toMountDTO(mount))
		}
		httpx.OK(w, map[string]any{"success": true, "mounts": items})
	}
}

func (s *Server) handleEmbyTestMount(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := decodeEmbyBody(r)
		serverURL, ok := stringValue(body.ServerURL)
		if !ok || strings.TrimSpace(serverURL) == "" {
			failEmby(w, http.StatusBadRequest, "服务器地址不能为空", "INVALID_URL")
			return
		}
		if !jsTruthy(body.APIKey) && (!jsTruthy(body.Username) || !jsTruthy(body.Password)) {
			failEmby(w, http.StatusBadRequest, "请填写 API Key，或用户名与密码", "MISSING_CREDENTIALS")
			return
		}

		token := ""
		if apiKey, isString := stringValue(body.APIKey); isString && strings.TrimSpace(apiKey) != "" {
			token = strings.TrimSpace(apiKey)
		}
		userID, userName, serverID := "", "", ""
		if token == "" {
			result, err := emby.Login(r.Context(), strings.TrimSpace(serverURL),
				jsString(body.Username), jsString(body.Password))
			if err != nil {
				code := embyErrorCode(kind, err)
				failEmby(w, http.StatusBadRequest, embyErrorMessage(err, "连接 "+kind.Label+" 失败"), code)
				return
			}
			token, userID, userName, serverID = result.Token, result.UserID, result.UserName, result.ServerID
		}
		// API Key 模式拿不到用户信息，必须问 /Users/Me；账号密码模式
		// 登录结果已含 userId，跳过这次往返（与 Node 一致）。
		if userID == "" {
			client := emby.NewClient(strings.TrimSpace(serverURL), token)
			me, err := client.Me(r.Context())
			if err != nil {
				code := embyErrorCode(kind, err)
				failEmby(w, http.StatusBadRequest, embyErrorMessage(err, "连接 "+kind.Label+" 失败"), code)
				return
			}
			userID, userName, serverID = me.ID, me.Name, me.ServerID
		}
		httpx.OK(w, map[string]any{
			"success":  true,
			"userId":   userID,
			"userName": userName,
			"serverId": serverID,
		})
	}
}

func (s *Server) handleEmbyCreateMount(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := decodeEmbyBody(r)
		name, nameIsString := stringValue(body.Name)
		if !nameIsString || strings.TrimSpace(name) == "" {
			failEmby(w, http.StatusBadRequest, "挂载名称不能为空", "INVALID_PARAMS")
			return
		}
		serverURL, urlIsString := stringValue(body.ServerURL)
		if !urlIsString || strings.TrimSpace(serverURL) == "" {
			failEmby(w, http.StatusBadRequest, "服务器地址不能为空", "INVALID_URL")
			return
		}
		if !jsTruthy(body.APIKey) && (!jsTruthy(body.Username) || !jsTruthy(body.Password)) {
			failEmby(w, http.StatusBadRequest, "请填写 API Key，或用户名与密码", "MISSING_CREDENTIALS")
			return
		}

		// 先测连接拿 userId 一起落库：之后每次播放都省掉一次 /Users/Me。
		var embyUserID string
		token := ""
		if apiKey, isString := stringValue(body.APIKey); isString && strings.TrimSpace(apiKey) != "" {
			token = strings.TrimSpace(apiKey)
		}
		if token == "" {
			result, err := emby.Login(r.Context(), strings.TrimSpace(serverURL),
				jsString(body.Username), jsString(body.Password))
			if err != nil {
				code := embyErrorCode(kind, err)
				failEmby(w, http.StatusBadRequest, embyErrorMessage(err, "连接 "+kind.Label+" 失败"), code)
				return
			}
			embyUserID = result.UserID
			token = result.Token
		}
		if embyUserID == "" {
			client := emby.NewClient(strings.TrimSpace(serverURL), token)
			me, err := client.Me(r.Context())
			if err != nil {
				code := embyErrorCode(kind, err)
				failEmby(w, http.StatusBadRequest, embyErrorMessage(err, "连接 "+kind.Label+" 失败"), code)
				return
			}
			embyUserID = me.ID
		}

		claims := auth.ClaimsFrom(r.Context())
		normalized := netutil.NormalizeServerURLWithScheme(serverURL)
		input := store.MountInput{
			UserID:    claims.UserID,
			Type:      kind.MountType,
			Name:      strings.TrimSpace(name),
			ServerURL: &normalized,
			APIKey:    optionalTrimmed(body.APIKey),
			Username:  optionalTrimmed(body.Username),
			Password:  optionalRaw(body.Password),
			// Node 这里用的是 `directLink === true`，**没有**套
			// resolveDirectLinkWithInternalCheck：内网强制中转是影片级
			// （movie.routes.ts）的判定，不是挂载级。别顺手改。
			DirectLink: body.DirectLink == true,
		}
		if embyUserID != "" {
			input.EmbyUserID = &embyUserID
		}
		mount, err := s.Mounts.Create(r.Context(), input)
		if err != nil {
			log.Printf("[%s] create mount error: %v", kind.Prefix, err)
			httpx.Fail(w, http.StatusInternalServerError, "创建 "+kind.Label+" 挂载失败")
			return
		}
		s.InvalidateMount(mount.ID)
		warning := mountutil.ProbeForMountSave(r.Context(), s.Mounts, mount)
		payload := map[string]any{"success": true, "mount": toMountDTO(mount)}
		if warning != "" {
			payload["warning"] = warning
		}
		httpx.JSON(w, http.StatusCreated, payload)
	}
}

func (s *Server) handleEmbyUpdateMount(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mountID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			failEmby(w, http.StatusBadRequest, "挂载 ID 不正确", "INVALID_PARAMS")
			return
		}
		claims := auth.ClaimsFrom(r.Context())
		mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, kind.MountType)
		if err != nil {
			if errors.Is(err, store.ErrMountNotFound) {
				failEmby(w, http.StatusNotFound, "挂载不存在或无权限", "")
				return
			}
			log.Printf("[%s] update mount error: %v", kind.Prefix, err)
			httpx.Fail(w, http.StatusInternalServerError, "更新 "+kind.Label+" 挂载失败")
			return
		}

		body, _ := decodeEmbyBody(r)
		patch := store.MountPatch{
			Name:        mount.Name,
			ServerURL:   mount.ServerURL,
			Port:        mount.Port,
			Path:        mount.Path,
			Username:    mount.Username,
			Password:    mount.Password,
			APIKey:      mount.APIKey,
			EmbyUserID:  mount.EmbyUserID,
			DirectLink:  mount.DirectLink,
			HttpsDirect: mount.HttpsDirect,
		}
		if name, ok := stringValue(body.Name); ok && strings.TrimSpace(name) != "" {
			patch.Name = strings.TrimSpace(name)
		}
		if serverURL, ok := stringValue(body.ServerURL); ok && strings.TrimSpace(serverURL) != "" {
			normalized := netutil.NormalizeServerURLWithScheme(serverURL)
			patch.ServerURL = &normalized
			// 服务器变了：userId 与 HTTPS 能力都必须重新获取/探测。
			patch.EmbyUserID = nil
			patch.HttpsDirect = nil
		}
		if body.has("apiKey") {
			patch.APIKey = optionalTrimmed(body.APIKey)
		}
		if body.has("username") {
			patch.Username = optionalTrimmed(body.Username)
		}
		if body.has("password") {
			patch.Password = optionalRaw(body.Password)
		}
		if body.has("directLink") {
			patch.DirectLink = body.DirectLink == true
		}

		// 更新后重取 userId：换账号 / 换服务器都会让它变，而它决定了
		// 之后能否跳过 /Users/Me。取不到就保持原样，运行时再兜底。
		if session, err := s.mountSession(r, mount); err == nil && session.UserID != "" {
			userID := session.UserID
			patch.EmbyUserID = &userID
		}

		if err := s.Mounts.Update(r.Context(), mountID, claims.UserID, kind.MountType, patch); err != nil {
			if errors.Is(err, store.ErrMountNotFound) {
				failEmby(w, http.StatusNotFound, "挂载不存在或无权限", "")
				return
			}
			log.Printf("[%s] update mount error: %v", kind.Prefix, err)
			httpx.Fail(w, http.StatusInternalServerError, "更新 "+kind.Label+" 挂载失败")
			return
		}
		s.InvalidateMount(mountID)
		updated, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, kind.MountType)
		if err != nil {
			updated = mount
		}
		warning := mountutil.ProbeForMountSave(r.Context(), s.Mounts, updated)
		payload := map[string]any{"success": true, "mount": toMountDTO(updated)}
		if warning != "" {
			payload["warning"] = warning
		}
		httpx.OK(w, payload)
	}
}

func (s *Server) handleEmbyDeleteMount(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mountID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			failEmby(w, http.StatusBadRequest, "挂载 ID 不正确", "INVALID_PARAMS")
			return
		}
		claims := auth.ClaimsFrom(r.Context())
		if _, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, kind.MountType); err != nil {
			if errors.Is(err, store.ErrMountNotFound) {
				failEmby(w, http.StatusNotFound, "挂载不存在或无权限", "")
				return
			}
			log.Printf("[%s] delete mount error: %v", kind.Prefix, err)
			httpx.Fail(w, http.StatusInternalServerError, "删除 "+kind.Label+" 挂载失败")
			return
		}
		if err := s.Mounts.Delete(r.Context(), mountID, claims.UserID, kind.MountType); err != nil {
			if errors.Is(err, store.ErrMountNotFound) {
				failEmby(w, http.StatusNotFound, "挂载不存在或无权限", "")
				return
			}
			log.Printf("[%s] delete mount error: %v", kind.Prefix, err)
			httpx.Fail(w, http.StatusInternalServerError, "删除 "+kind.Label+" 挂载失败")
			return
		}
		s.InvalidateMount(mountID)
		httpx.OK(w, map[string]any{"success": true})
	}
}

// optionalTrimmed 对应 `typeof x === 'string' && x.trim() ? x.trim() : null`。
func optionalTrimmed(value any) *string {
	text, ok := stringValue(value)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// optionalRaw 对应 `typeof x === 'string' && x ? x : null`（密码不 trim）。
func optionalRaw(value any) *string {
	text, ok := stringValue(value)
	if !ok || text == "" {
		return nil
	}
	return &text
}

// ==================== 海报 ====================

func (s *Server) handleEmbyMountImage(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		mountID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		itemID := query.Get("itemId")
		tag := query.Get("tag")
		if err != nil || strings.TrimSpace(itemID) == "" {
			failEmby(w, http.StatusBadRequest, "缺少 mountId 或 itemId", "INVALID_PARAMS")
			return
		}
		// 免认证端点：不按 userId 过滤（没有身份可查），tag 即访问凭证。
		mount, err := s.Mounts.FindByID(r.Context(), mountID, kind.MountType)
		if err != nil {
			if errors.Is(err, store.ErrMountNotFound) {
				httpx.Fail(w, http.StatusNotFound, "挂载不存在")
				return
			}
			log.Printf("[%s] mount image error: %v", kind.Prefix, err)
			httpx.Fail(w, http.StatusNotFound, "获取海报失败")
			return
		}

		maxWidth := 300
		if raw := query.Get("maxWidth"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed != 0 {
				maxWidth = parsed
			}
		}

		session, err := s.mountSession(r, mount)
		if err != nil {
			s.failEmbyImage(w, kind, err)
			return
		}
		image, err := session.Client.ItemImage(r.Context(), itemID, tag, maxWidth)
		if err == nil {
			writeEmbyImage(w, r, image)
			return
		}
		// 回退：逐个试带主海报的后代条目（竖版优先）。文件夹条目自身的
		// ImageTags.Primary 常为空，官方前端同样会回退到子项封面。
		candidates, listErr := session.Client.FindPosterChildren(r.Context(), session.UserID, itemID)
		if listErr == nil {
			for _, childID := range candidates {
				child, childErr := session.Client.ItemImage(r.Context(), childID, "", maxWidth)
				if childErr != nil {
					continue
				}
				writeEmbyImage(w, r, child)
				return
			}
		}
		s.failEmbyImage(w, kind, err)
	}
}

// failEmbyImage 是海报端点的错误收尾（status 兜底 404、超时 504）。
func (s *Server) failEmbyImage(w http.ResponseWriter, kind embyLikeKind, err error) {
	log.Printf("[%s] mount image error: %v", kind.Prefix, err)
	code := embyErrorCode(kind, err)
	status := embyErrorStatus(code, http.StatusNotFound, false, http.StatusGatewayTimeout)
	failEmby(w, status, embyErrorMessage(err, "获取海报失败"), code)
}

// writeEmbyImage 输出海报，并复刻 Express 的弱 ETag / 304 行为。
//
// 海报基本不变：弱 ETag + Cache-Control 让浏览器直接复用本地缓存，
// 每次滚动瀑布流都重新拉一遍图在慢网络下非常明显。
func writeEmbyImage(w http.ResponseWriter, r *http.Request, image *emby.ImageResult) {
	etag := weakETag(image.Buffer)
	w.Header().Set("Content-Type", image.ContentType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("ETag", etag)
	if matchesIfNoneMatch(r.Header.Get("If-None-Match"), etag) {
		w.Header().Del("Content-Type")
		w.Header().Del("Content-Length")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(image.Buffer)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(image.Buffer)
	}
}

// weakETag 复刻 etag 包对 Buffer 的输出：W/"<长度十六进制>-<sha1 base64 前 27 位>"。
func weakETag(body []byte) string {
	sum := sha1.Sum(body)
	digest := base64.StdEncoding.EncodeToString(sum[:])
	if len(digest) > 27 {
		digest = digest[:27]
	}
	size := strconv.FormatInt(int64(len(body)), 16)
	return `W/"` + size + "-" + digest + `"`
}

// matchesIfNoneMatch 判断 If-None-Match 是否命中（支持逗号分隔与 *）。
func matchesIfNoneMatch(header, etag string) bool {
	if header == "" {
		return false
	}
	for _, candidate := range strings.Split(header, ",") {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "*" || trimmed == etag || strings.TrimPrefix(trimmed, "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

// ==================== 浏览 / 搜索 ====================

func (s *Server) handleEmbyBrowseMount(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mount, ok := s.findOwnedEmbyMount(w, r, kind, r.PathValue("id"))
		if !ok {
			return
		}
		browsePath := r.URL.Query().Get("path")
		session, err := s.mountSession(r, mount)
		if err != nil {
			s.failEmbyList(w, kind, err, "浏览 "+kind.Label+" 失败")
			return
		}
		var items []emby.EmbyItem
		if browsePath == "" || browsePath == "views" || browsePath == "/" {
			items, err = session.Client.UserViews(r.Context(), session.UserID)
		} else {
			items, err = session.Client.Items(r.Context(), session.UserID, browsePath, "")
		}
		if err != nil {
			s.failEmbyList(w, kind, err, "浏览 "+kind.Label+" 失败")
			return
		}
		httpx.OK(w, map[string]any{"success": true, "entries": mapEmbyEntries(items)})
	}
}

func (s *Server) handleEmbySearchMount(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		term := strings.TrimSpace(r.URL.Query().Get("term"))
		if term == "" {
			failEmby(w, http.StatusBadRequest, "搜索关键词不能为空", "INVALID_PARAMS")
			return
		}
		mount, ok := s.findOwnedEmbyMount(w, r, kind, r.PathValue("id"))
		if !ok {
			return
		}
		session, err := s.mountSession(r, mount)
		if err != nil {
			s.failEmbyList(w, kind, err, "搜索 "+kind.Label+" 失败")
			return
		}
		items, err := session.Client.Search(r.Context(), session.UserID, term)
		if err != nil {
			s.failEmbyList(w, kind, err, "搜索 "+kind.Label+" 失败")
			return
		}
		httpx.OK(w, map[string]any{"success": true, "entries": mapEmbyEntries(items)})
	}
}

// failEmbyList 是 browse / search 的错误收尾（兜底 400、超时 504）。
func (s *Server) failEmbyList(w http.ResponseWriter, kind embyLikeKind, err error, fallback string) {
	log.Printf("[%s] list error: %v", kind.Prefix, err)
	code := embyErrorCode(kind, err)
	status := embyErrorStatus(code, http.StatusBadRequest, false, http.StatusGatewayTimeout)
	failEmby(w, status, embyErrorMessage(err, fallback), code)
}

// ==================== 解析 ====================

func (s *Server) handleEmbyResolve(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if !query.Has("mountId") || !query.Has("path") {
			failEmby(w, http.StatusBadRequest, "缺少 mountId 或 path 参数", "INVALID_PARAMS")
			return
		}
		mountID, err := strconv.ParseInt(query.Get("mountId"), 10, 64)
		if err != nil {
			failEmby(w, http.StatusBadRequest, "mountId 不正确", "INVALID_PARAMS")
			return
		}
		itemID := query.Get("path")
		if strings.TrimSpace(itemID) == "" {
			failEmby(w, http.StatusBadRequest, "itemId 不能为空", "INVALID_PARAMS")
			return
		}
		claims := auth.ClaimsFrom(r.Context())
		mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, kind.MountType)
		if err != nil {
			if errors.Is(err, store.ErrMountNotFound) {
				failEmby(w, http.StatusNotFound, "挂载不存在或无权限", "")
				return
			}
			s.failEmbyResolve(w, kind, err, "解析 "+kind.Label+" 条目失败")
			return
		}
		session, err := s.mountSession(r, mount)
		if err != nil {
			s.failEmbyResolve(w, kind, err, "解析 "+kind.Label+" 条目失败")
			return
		}
		payload, err := emby.BuildResolvePayload(r.Context(), emby.ResolveParams{
			Session:       session,
			Mount:         mount,
			Mounts:        s.Mounts,
			ItemID:        itemID,
			MountID:       mountID,
			Prefix:        kind.Prefix,
			MediaSourceID: query.Get("ms"),
		})
		if err != nil {
			s.failEmbyResolve(w, kind, err, "解析 "+kind.Label+" 条目失败")
			return
		}
		payload["success"] = true
		httpx.OK(w, payload)
	}
}

// failEmbyResolve 是 resolve 的错误收尾（恒 400，与 Node 一致）。
func (s *Server) failEmbyResolve(w http.ResponseWriter, kind embyLikeKind, err error, fallback string) {
	log.Printf("[%s] resolve error: %v", kind.Prefix, err)
	failEmby(w, http.StatusBadRequest, embyErrorMessage(err, fallback), embyErrorCode(kind, err))
}

func (s *Server) handleEmbyMovieSource(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// requireMovieReadAccess 在 Node 里是路由级中间件，先于 handler 执行；
		// 所以「缺少 movieId」的实际文案来自它（movieId 参数无效），
		// handler 内部那两句判断其实不可达。这里照抄这个顺序。
		if _, ok := s.requireMovieReadAccess(w, r); !ok {
			return
		}
		movieID, err := proxy.MovieIDFromRequest(r)
		if err != nil {
			failEmby(w, http.StatusBadRequest, "movieId 不正确", "")
			return
		}
		resolved, err := s.Stream.Resolve(r.Context(), movieID, kind.MountType, nil)
		if err != nil {
			s.sendEmbyStreamResolveError(w, kind, err)
			return
		}
		if resolved.Mount == nil {
			failEmby(w, http.StatusNotFound, "未找到对应的 "+kind.Label+" 挂载配置", "")
			return
		}
		if resolved.Movie.Path == nil || *resolved.Movie.Path == "" {
			failEmby(w, http.StatusBadRequest, "该影片缺少 itemId 信息", "")
			return
		}
		session, err := s.mountSession(r, resolved.Mount)
		if err != nil {
			s.failEmbyResolve(w, kind, err, "解析 "+kind.Label+" 影片版本失败")
			return
		}
		id := movieID
		payload, err := emby.BuildResolvePayload(r.Context(), emby.ResolveParams{
			Session:       session,
			Mount:         resolved.Mount,
			Mounts:        s.Mounts,
			ItemID:        *resolved.Movie.Path,
			MountID:       resolved.Mount.ID,
			Prefix:        kind.Prefix,
			MediaSourceID: r.URL.Query().Get("ms"),
			MovieID:       &id,
		})
		if err != nil {
			s.failEmbyResolve(w, kind, err, "解析 "+kind.Label+" 影片版本失败")
			return
		}
		payload["success"] = true
		httpx.OK(w, payload)
	}
}

// sendEmbyStreamResolveError 处理 StreamMovieError（movie-source 分支）。
func (s *Server) sendEmbyStreamResolveError(w http.ResponseWriter, kind embyLikeKind, err error) {
	var streamErr *proxy.StreamError
	if errors.As(err, &streamErr) {
		embyStreamError(w, kind.Prefix, streamErr, "")
		return
	}
	log.Printf("[%s] movie-source error: %v", kind.Prefix, err)
	httpx.Fail(w, http.StatusBadRequest, kind.Label+" 影片版本解析失败")
}

// ==================== HLS 资源校验 ====================

// hlsInvalidResource 是「resource 参数不合法」的错误文案（与 Node 逐字一致）。
const hlsInvalidResource = "无效的 HLS 资源路径"

// errInvalidHLSResource 是校验失败的错误（带 code，便于 /stream 分支复用）。
type errInvalidHLSResource struct{}

func (errInvalidHLSResource) Error() string { return hlsInvalidResource }

// resolveEmbyHLSResource 处理 `?resource=` 参数（HLS 子资源透传）。
//
// 这个参数是给 m3u8 里的分片/密钥用的：前端把改写后的 /proxy 地址换回
// 上游真实地址时，必须限定在同一 origin、同一 videos/{itemId}/ 前缀下，
// 否则 /proxy 就是一个任何人可用的开放代理（可读内网、可带 token 打任意地址）。
func resolveEmbyHLSResource(r *http.Request, upstreamURL, itemID string) (string, error) {
	values, has := r.URL.Query()["resource"]
	if !has || len(values) != 1 {
		return upstreamURL, nil
	}
	base, err := url.Parse(upstreamURL)
	if err != nil {
		return "", errInvalidHLSResource{}
	}
	target, err := url.Parse(values[0])
	if err != nil {
		return "", errInvalidHLSResource{}
	}
	target = base.ResolveReference(target)
	if err := validateEmbyHLSResource(target, base, itemID); err != nil {
		return "", err
	}
	query := target.Query()
	query.Set("api_key", base.Query().Get("api_key"))
	target.RawQuery = query.Encode()
	return target.String(), nil
}

// validateEmbyHLSResource 校验子资源与主播放地址同源同前缀。
func validateEmbyHLSResource(target, upstream *url.URL, itemID string) error {
	if target.Scheme != upstream.Scheme || target.Host != upstream.Host {
		return errInvalidHLSResource{}
	}
	if target.User != nil {
		return errInvalidHLSResource{}
	}
	basePath := upstream.EscapedPath()
	videosAt := strings.LastIndex(strings.ToLower(basePath), "/videos/")
	prefix := basePath
	if videosAt >= 0 {
		prefix = basePath[:videosAt]
	} else if len(prefix) > 0 {
		// JS 的 slice(0, -1) 会砍掉最后一个字符，这里保持一致
		prefix = prefix[:len(prefix)-1]
	}
	// Jellyfin 的绝对路径子项会省略可选的 /emby 前缀，两种都放行。
	prefixes := []string{prefix}
	if strings.HasSuffix(strings.ToLower(prefix), "/emby") {
		prefixes = append(prefixes, prefix[:len(prefix)-len("/emby")])
	}
	expected := strings.ToLower("/videos/" + netutil.EncodeURIComponent(itemID) + "/")
	targetPath := strings.ToLower(target.EscapedPath())
	for _, candidate := range prefixes {
		if strings.HasPrefix(targetPath, strings.ToLower(candidate)+expected) {
			return nil
		}
	}
	return errInvalidHLSResource{}
}

// rewriteEmbyHLSURI 生成 m3u8 里每条 URI 的改写函数。
//
// 校验失败时返回空串（= 该条 URI 作废），不回退成原地址：
// 原地址带着 api_key，回退等于把令牌直接交给客户端。
// Node 在这种情况下会抛错并回 400/500，差异已记入 MIGRATION「刻意不同」。
func rewriteEmbyHLSURI(r *http.Request, kind embyLikeKind, itemID, upstreamURL string) func(string, string) string {
	return func(uri, playlistURL string) string {
		base, err := url.Parse(upstreamURL)
		if err != nil {
			return ""
		}
		target, err := url.Parse(uri)
		if err != nil {
			return ""
		}
		target = base.ResolveReference(target)
		if err := validateEmbyHLSResource(target, base, itemID); err != nil {
			return ""
		}
		// 删掉上游令牌：客户端拿到的代理地址里绝不能再带 api_key，
		// 否则一个 playlist 就把服务器令牌发给每个观众（这也是 SSRF 白名单
		// 之外的第二道锁）。
		query := target.Query()
		for _, key := range []string{"api_key", "x-emby-token", "token"} {
			for existing := range query {
				if strings.EqualFold(existing, key) {
					query.Del(existing)
				}
			}
		}
		target.RawQuery = query.Encode()
		resourcePath := target.EscapedPath()
		if target.RawQuery != "" {
			resourcePath += "?" + target.RawQuery
		}

		values := url.Values{}
		if movieID := r.URL.Query().Get("movieId"); movieID != "" {
			values.Set("movieId", movieID)
			values.Set("resource", resourcePath)
			return "/api/" + kind.Prefix + "/stream?" + values.Encode()
		}
		values.Set("mountId", r.URL.Query().Get("mountId"))
		values.Set("path", itemID)
		values.Set("resource", resourcePath)
		return "/api/" + kind.Prefix + "/proxy?" + values.Encode()
	}
}

// ==================== 代理 / 流 ====================

// embyUpstreamURL 拼上游播放地址（at=1 → 服务端转码播放列表）。
func embyUpstreamURL(
	baseURL, token, itemID string, audioTranscode bool, mediaSourceID string,
) string {
	msSuffix := ""
	if mediaSourceID != "" {
		msSuffix = "&MediaSourceId=" + netutil.EncodeURIComponent(mediaSourceID)
	}
	encoded := netutil.EncodeURIComponent(itemID)
	if audioTranscode {
		return baseURL + "/emby/Videos/" + encoded + "/main.m3u8?api_key=" + token +
			"&AudioCodec=aac&TranscodingMaxAudioChannels=2" +
			"&VideoBitrate=8000000&AudioBitrate=192000" + msSuffix
	}
	return baseURL + "/emby/Videos/" + encoded + "/stream?static=true&api_key=" + token + msSuffix
}

func (s *Server) handleEmbyProxy(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mount, targetPath, ok := s.requireOwnedEmbyMount(w, r, kind)
		if !ok {
			return
		}
		session, err := s.mountSession(r, mount)
		if err != nil {
			s.failEmbyProxy(w, kind, err, "代理 "+kind.Label+" 视频流失败")
			return
		}
		audioTranscode := r.URL.Query().Get("at") == "1"
		upstreamURL := embyUpstreamURL(
			session.Client.BaseURL, session.Token(), targetPath,
			audioTranscode, r.URL.Query().Get("ms"),
		)
		resolvedURL, err := resolveEmbyHLSResource(r, upstreamURL, targetPath)
		if err != nil {
			// Node 对非 EmbyError 一律取 UNREACHABLE，状态码走 502 兜底。
			failEmby(w, http.StatusBadGateway, embyErrorMessage(err, hlsInvalidResource), "UNREACHABLE")
			return
		}
		s.proxyEmbyUpstream(w, r, kind, session, resolvedURL, upstreamURL, targetPath, audioTranscode)
	}
}

func (s *Server) handleEmbyStream(kind embyLikeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.requireMovieReadAccess(w, r); !ok {
			return
		}
		movieID, err := proxy.MovieIDFromRequest(r)
		if err != nil {
			failEmby(w, http.StatusBadRequest, "movieId 不正确", "")
			return
		}
		// emby 系的影片 serverUrl 不做归一化（与 Node 一致）：挂载表里存的
		// 就是规范化后的地址，影片表也存的是同一串。
		resolved, err := s.Stream.Resolve(r.Context(), movieID, kind.MountType, nil)
		if err != nil {
			s.sendEmbyStreamResolveError(w, kind, err)
			return
		}
		if resolved.Mount == nil {
			failEmby(w, http.StatusNotFound, "未找到对应的 "+kind.Label+" 挂载配置", "")
			return
		}
		if resolved.Movie.Path == nil || *resolved.Movie.Path == "" {
			failEmby(w, http.StatusBadRequest, "该影片缺少 itemId 信息", "")
			return
		}
		session, err := s.mountSession(r, resolved.Mount)
		if err != nil {
			s.sendEmbyStreamProxyError(w, kind, err)
			return
		}
		itemID := *resolved.Movie.Path
		// 转码判定：resolve 阶段发现音轨不兼容时会把 format 落成 'hls'。
		// 不能只看 movie.url 有没有 at=1 —— 代理模式新增影片时 url 会被
		// 重写成 /api/<prefix>/stream?movieId=N，at=1 在那一步就丢了。
		audioTranscode := r.URL.Query().Get("at") == "1" ||
			strings.EqualFold(derefEmbyID(resolved.Movie.Format), "hls")
		upstreamURL := embyUpstreamURL(
			session.Client.BaseURL, session.Token(), itemID,
			audioTranscode, r.URL.Query().Get("ms"),
		)
		resolvedURL, err := resolveEmbyHLSResource(r, upstreamURL, itemID)
		if err != nil {
			// /stream 对 StreamMovieError 特判：直接按错误自带的状态码回。
			embyStreamError(w, kind.Prefix, &proxy.StreamError{
				Message: hlsInvalidResource,
				Code:    "INVALID_RESOURCE",
				Status:  http.StatusBadRequest,
			}, "")
			return
		}
		s.proxyEmbyUpstream(w, r, kind, session, resolvedURL, upstreamURL, itemID, audioTranscode)
	}
}

// proxyEmbyUpstream 把上游字节流转发出去（proxy 与 stream 共用）。
func (s *Server) proxyEmbyUpstream(
	w http.ResponseWriter,
	r *http.Request,
	kind embyLikeKind,
	session *emby.Session,
	resolvedURL, upstreamURL, itemID string,
	audioTranscode bool,
) {
	opts := proxy.HTTPOptions{
		URL: resolvedURL,
		Headers: proxy.UpstreamHeaders{
			Extra: map[string]string{
				"X-Emby-Token": session.Token(),
				"Referer":      session.Client.BaseURL,
			},
		},
		CORS: proxy.CORSWildcard,
		DefaultContentType: func() string {
			if audioTranscode {
				return "application/x-mpegURL"
			}
			return "video/mp4"
		}(),
		LogTag:        kind.Prefix + "-proxy",
		ErrorMessage:  kind.Label + " 视频流代理失败",
		RewriteHLSUri: rewriteEmbyHLSURI(r, kind, itemID, upstreamURL),
	}
	if audioTranscode {
		// 转码冷启动：要先起 ffmpeg 才吐第一个分片，30s 默认超时会误杀。
		opts.TimeoutMs = 90_000
		opts.LogTag = kind.Prefix + "-proxy-transcode"
	}
	s.proxyEmbyHTTP(w, r, kind, opts)
}

// proxyEmbyHTTP 调代理并处理「未发头」的异常收尾。
func (s *Server) proxyEmbyHTTP(w http.ResponseWriter, r *http.Request, kind embyLikeKind, opts proxy.HTTPOptions) {
	proxy.ProxyHTTPUpstream(w, r, opts)
}

// sendEmbyStreamProxyError 是 /stream 的非业务错误收尾（兜底 502）。
func (s *Server) sendEmbyStreamProxyError(w http.ResponseWriter, kind embyLikeKind, err error) {
	log.Printf("[%s] stream error: %v", kind.Prefix, err)
	code := embyErrorCode(kind, err)
	status := embyErrorStatus(code, http.StatusBadGateway, false, 0)
	failEmby(w, status, embyErrorMessage(err, kind.Label+" 视频流代理失败"), code)
}

// failEmbyProxy 是 /proxy 的错误收尾（兜底 502）。
func (s *Server) failEmbyProxy(w http.ResponseWriter, kind embyLikeKind, err error, fallback string) {
	log.Printf("[%s] proxy error: %v", kind.Prefix, err)
	code := embyErrorCode(kind, err)
	status := embyErrorStatus(code, http.StatusBadGateway, false, 0)
	failEmby(w, status, embyErrorMessage(err, fallback), code)
}
