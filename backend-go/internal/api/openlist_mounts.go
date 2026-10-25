package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/mountutil"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/store"
)

// openListMountType 是 UserMount.type 的一个取值。
const openListMountType = "openlist"

// openListDisplayName 用于错误文案（"获取 OpenList 挂载列表失败"）。
const openListDisplayName = "OpenList"

// openListProxyPrefix 是 /resolve 返回给前端的相对路径。
const openListProxyPrefix = "/api/openlist"

// registerOpenListMountRoutes 注册 OpenList 的挂载管理与解析端点。
//
// 对应 routes/openlist.ts：不走 WebDAV 协议，直接用 AList 的 HTTP API。
// 与 WebDAV 那套的差别只有三处：地址要补 /dav、密码要哈希后落库、
// 流代理透传的是 fs/get 返回的带签名 raw_url。
func (s *Server) registerOpenListMountRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/openlist/mounts", s.Auth.Require(s.handleListOpenListMounts))
	mux.HandleFunc("POST /api/openlist/mounts/test", s.Auth.Require(s.handleTestOpenListMount))
	mux.HandleFunc("POST /api/openlist/mounts", s.Auth.Require(s.handleCreateOpenListMount))
	mux.HandleFunc("PUT /api/openlist/mounts/{id}", s.Auth.Require(s.handleUpdateOpenListMount))
	mux.HandleFunc("DELETE /api/openlist/mounts/{id}", s.Auth.Require(s.handleDeleteOpenListMount))
	mux.HandleFunc("GET /api/openlist/mounts/{id}/browse", s.Auth.Require(s.handleBrowseOpenListMount))
	mux.HandleFunc("GET /api/openlist/resolve", s.Auth.Require(s.handleResolveOpenListFile))
	mux.HandleFunc("GET /api/openlist/direct-url", s.Auth.Require(s.handleOpenListDirectURL))
	mux.HandleFunc("GET /api/openlist/me", s.Auth.Require(s.handleOpenListMe))
	mux.HandleFunc("GET /api/openlist/proxy", s.Auth.Require(s.handleOpenListProxyByMount))
	mux.HandleFunc("GET /api/openlist/search", s.Auth.Require(s.handleOpenListSearch))
}

// ==================== 参数与辅助 ====================

// normalizeOpenListPassword 复刻 normalizePasswordForStorage：明文 → AList 哈希。
//
// 存储层始终保存 sha256(明文+salt)，明文不落盘；客户端与服务层靠
// 「64 位 hex」这个形态识别该走 /api/auth/login/hash 而不是 /api/auth/login。
// 空值返回 nil（Node 的 `if (!password) return null`）。
func normalizeOpenListPassword(password *string) *string {
	if password == nil || *password == "" {
		return nil
	}
	if openlist.IsHashedPassword(*password) {
		return password
	}
	hashed := openlist.HashPassword(*password)
	return &hashed
}

// openListParams 用挂载记录组装连接参数（地址走 OpenList 的规范化：
// 补 scheme、补 /dav —— 库里存的可能是用户手填的 `192.168.1.5:5244`）。
func openListParams(mount *store.Mount) (serverURL, username, password string) {
	return openlist.NormalizeServerURL(derefOr(mount.ServerURL, "")),
		derefOr(mount.Username, ""),
		derefOr(mount.Password, "")
}

// mountErrorStatus 是 mapMountErrorCodeToStatus 的 Go 版。
//
// notFound=false 用于 /me 与 /search：Node 在这两处显式关掉了 NOT_FOUND → 404，
// 因为「账号信息/搜索没命中」不是资源不存在，404 会让前端误以为是路由问题。
func mountErrorStatus(code string, fallback int, notFound bool) int {
	if code == openlist.CodeAuthFailed {
		return http.StatusUnauthorized
	}
	if notFound && code == openlist.CodeNotFound {
		return http.StatusNotFound
	}
	return fallback
}

// requireOwnedOpenListMount 取当前用户拥有的挂载，并校验地址已配置。
func (s *Server) requireOwnedOpenListMount(w http.ResponseWriter, r *http.Request, mountID int64) (*store.Mount, bool) {
	claims := auth.ClaimsFrom(r.Context())
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, openListMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return nil, false
		}
		httpx.InternalError(w, "GET /openlist", err)
		return nil, false
	}
	if mount.ServerURL == nil || *mount.ServerURL == "" {
		failMount(w, http.StatusBadRequest, "该挂载未配置服务器地址", "")
		return nil, false
	}
	return mount, true
}

// ==================== 挂载 CRUD ====================

func (s *Server) handleListOpenListMounts(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	mounts, err := s.Mounts.ListByUserType(r.Context(), claims.UserID, openListMountType)
	if err != nil {
		httpx.InternalError(w, "GET /openlist/mounts", err)
		return
	}
	out := make([]mountDTO, 0, len(mounts))
	for _, m := range mounts {
		out = append(out, toMountDTO(m))
	}
	httpx.OK(w, map[string]any{"success": true, "mounts": out})
}

func (s *Server) handleTestOpenListMount(w http.ResponseWriter, r *http.Request) {
	var body mountBody
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	serverURL, msg, code := body.requireServerURL()
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, code)
		return
	}
	params := body.params(serverURL, nil)
	// 注意顺序：先哈希再测试。明文密码打 /api/auth/login 也能通过，
	// 但这样一来「测试通过、保存后失败」就成了稳定复现的坑。
	password := derefOr(normalizeOpenListPassword(body.Password), "")
	if err := s.OpenList.TestConnection(
		r.Context(), openlist.NormalizeServerURL(strings.TrimSpace(serverURL)),
		params.Username, password, derefOr(body.Path, "/"),
	); err != nil {
		failMount(w, http.StatusBadRequest,
			errText(err, openListDisplayName+" 不可访问"), errCode(err))
		return
	}
	// Node 这里只回 { success: true }（不像 WebDAV 带 itemCount）
	httpx.OK(w, map[string]any{"success": true})
}

func (s *Server) handleCreateOpenListMount(w http.ResponseWriter, r *http.Request) {
	var body mountBody
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	if body.Name == nil || strings.TrimSpace(*body.Name) == "" {
		failMount(w, http.StatusBadRequest, "挂载名称不能为空", "")
		return
	}
	serverURL, msg, code := body.requireServerURL()
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, code)
		return
	}

	normalizedURL := openlist.NormalizeServerURL(serverURL)
	normalizedPassword := normalizeOpenListPassword(body.Password)
	requestedDirect := body.DirectLink != nil && *body.DirectLink
	effectiveDirect := mountutil.ResolveDirectLinkWithInternalCheck(normalizedURL, requestedDirect)

	params := body.params(normalizedURL, normalizedPassword)
	if err := s.OpenList.TestConnection(
		r.Context(), normalizedURL, params.Username, params.Password, params.Path,
	); err != nil {
		failMount(w, http.StatusBadRequest,
			errText(err, openListDisplayName+" 不可访问"), errCode(err))
		return
	}

	claims := auth.ClaimsFrom(r.Context())
	input := store.MountInput{
		UserID:     claims.UserID,
		Type:       openListMountType,
		Name:       strings.TrimSpace(*body.Name),
		ServerURL:  &normalizedURL,
		Path:       &params.Path,
		DirectLink: effectiveDirect,
	}
	if params.Username != "" {
		input.Username = &params.Username
	}
	// 匿名挂载：密码列写 NULL 而不是空串（Node 的 normalizePasswordForStorage
	// 对空值返回 null，前端据此判断「无需凭证」）
	input.Password = normalizedPassword

	mount, err := s.Mounts.Create(r.Context(), input)
	if err != nil {
		httpx.InternalError(w, "POST /openlist/mounts", err)
		return
	}
	s.InvalidateMount(mount.ID)

	httpsWarning := mountutil.ProbeForMountSave(r.Context(), s.Mounts, mount)
	warning := resolveSaveWarning(mount, requestedDirect, httpsWarning)
	payload := map[string]any{"success": true, "mount": toMountDTO(mount)}
	if warning != "" {
		payload["warning"] = warning
	}
	httpx.JSON(w, http.StatusCreated, payload)
}

func (s *Server) handleUpdateOpenListMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	var body mountBody
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, openListMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "PUT /openlist/mounts/:id", err)
		return
	}
	if body.Name == nil || strings.TrimSpace(*body.Name) == "" {
		failMount(w, http.StatusBadRequest, "挂载名称不能为空", "")
		return
	}
	serverURL, msg, code := body.requireServerURL()
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, code)
		return
	}
	normalizedURL := openlist.NormalizeServerURL(serverURL)

	// 密码三态：传非空 → 规范化后覆盖；传空串 → 清空；不传 → 保持原值
	nextPassword := mount.Password
	if body.Password != nil {
		nextPassword = normalizeOpenListPassword(body.Password)
	}
	requestedDirect := body.DirectLink != nil && *body.DirectLink
	effectiveDirect := mountutil.ResolveDirectLinkWithInternalCheck(normalizedURL, requestedDirect)

	nextPath := "/"
	if body.Path != nil && strings.TrimSpace(*body.Path) != "" {
		nextPath = strings.TrimSpace(*body.Path)
	}
	nextUsername := derefOr(body.Username, "")
	if nextUsername == "" {
		nextUsername = derefOr(mount.Username, "")
	}

	// 只有地址/凭证/路径变了才重新测连通性：否则「改个名字」也会要求
	// NAS 在线，挂载暂时不可达时连重命名都做不了。
	serverChanged := mount.ServerURL == nil || *mount.ServerURL != normalizedURL
	credChanged := (body.Username != nil && nextUsername != derefOr(mount.Username, "")) ||
		(body.Password != nil && derefOr(nextPassword, "") != derefOr(mount.Password, ""))
	if serverChanged || credChanged || nextPath != derefOr(mount.Path, "/") {
		if err := s.OpenList.TestConnection(
			r.Context(), normalizedURL, nextUsername, derefOr(nextPassword, ""), nextPath,
		); err != nil {
			failMount(w, http.StatusBadRequest,
				errText(err, openListDisplayName+" 不可访问"), errCode(err))
			return
		}
	}

	httpsDirect := mount.HttpsDirect
	if serverChanged {
		// 旧探测结果对应旧地址，换了地址必须重探
		httpsDirect = nil
	}
	patch := store.MountPatch{
		Name:        strings.TrimSpace(*body.Name),
		ServerURL:   &normalizedURL,
		Path:        &nextPath,
		DirectLink:  effectiveDirect,
		HttpsDirect: httpsDirect,
		// OpenList 不用端口 / apiKey / embyUserId：带现值避免被清空
		Port:       mount.Port,
		APIKey:     mount.APIKey,
		EmbyUserID: mount.EmbyUserID,
	}
	if nextUsername != "" {
		patch.Username = &nextUsername
	}
	patch.Password = nextPassword

	if err := s.Mounts.Update(r.Context(), mountID, claims.UserID, openListMountType, patch); err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "PUT /openlist/mounts/:id", err)
		return
	}
	s.InvalidateMount(mountID)

	updated, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, openListMountType)
	if err != nil {
		httpx.InternalError(w, "PUT /openlist/mounts/:id", err)
		return
	}
	httpsWarning := mountutil.ProbeForMountSave(r.Context(), s.Mounts, updated)
	warning := resolveSaveWarning(updated, requestedDirect, httpsWarning)
	payload := map[string]any{"success": true, "mount": toMountDTO(updated)}
	if warning != "" {
		payload["warning"] = warning
	}
	httpx.OK(w, payload)
}

func (s *Server) handleDeleteOpenListMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	if err := s.Mounts.Delete(r.Context(), mountID, claims.UserID, openListMountType); err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "DELETE /openlist/mounts/:id", err)
		return
	}
	s.InvalidateMount(mountID)
	httpx.OK(w, map[string]any{"success": true})
}

// ==================== 浏览 / 解析 ====================

func (s *Server) handleBrowseOpenListMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	mount, ok := s.requireOwnedOpenListMount(w, r, mountID)
	if !ok {
		return
	}
	query := r.URL.Query()
	browsePath := query.Get("path")
	if browsePath == "" {
		browsePath = derefOr(mount.Path, "/")
	}
	page := atoiOr(query.Get("page"), 1)
	perPage := atoiOr(query.Get("perPage"), 100)

	serverURL, username, password := openListParams(mount)
	key := serverURL + "|" + username + "|" + browsePath + "|" +
		strconv.Itoa(page) + "|" + strconv.Itoa(perPage)
	listing, err := s.openListDirs.Run(key, func() (*openlist.DirListing, error) {
		return s.OpenList.ListDirPaged(r.Context(), serverURL, username, password, browsePath, page, perPage)
	})
	if err != nil {
		failMount(w, mountErrorStatus(errCode(err), http.StatusBadRequest, true),
			errText(err, "浏览 "+openListDisplayName+" 失败"), errCode(err))
		return
	}

	entries := make([]entryDTO, 0, len(listing.Entries))
	for _, e := range listing.Entries {
		fullPath := browsePath + "/" + e.Name
		if strings.HasSuffix(browsePath, "/") {
			fullPath = browsePath + e.Name
		}
		item := entryDTO{Name: e.Name, Path: fullPath, Type: "file", Size: &e.Size}
		if e.IsDir {
			item.Type = "directory"
		}
		if e.Modified != "" {
			modified := e.Modified
			item.LastModified = &modified
		}
		entries = append(entries, item)
	}
	httpx.OK(w, map[string]any{
		"success":  true,
		"entries":  entries,
		"total":    listing.Total,
		"provider": listing.Provider,
	})
}

func (s *Server) handleResolveOpenListFile(w http.ResponseWriter, r *http.Request) {
	mountID, targetPath, ok := s.parseResolveParams(w, r)
	if !ok {
		return
	}
	mount, ok := s.requireOwnedOpenListMount(w, r, mountID)
	if !ok {
		return
	}
	serverURL, username, password := openListParams(mount)
	info, err := s.OpenList.FetchFileInfo(r.Context(), serverURL, username, password, targetPath)
	if err != nil {
		failMount(w, mountErrorStatus(errCode(err), http.StatusBadRequest, true),
			errText(err, "解析 "+openListDisplayName+" 文件失败"), errCode(err))
		return
	}
	name := info.Name
	if name == "" {
		name = targetPath
	}
	httpx.OK(w, map[string]any{
		"success": true,
		"title":   name,
		"videoUrl": openListProxyPrefix + "/proxy?mountId=" + strconv.FormatInt(mountID, 10) +
			"&path=" + urlQueryEscape(targetPath),
		"format":   string(proxy.DetectMediaFormat(name)),
		"duration": 0,
		"size":     info.Size,
	})
}

func (s *Server) handleOpenListDirectURL(w http.ResponseWriter, r *http.Request) {
	mountID, targetPath, ok := s.parseResolveParams(w, r)
	if !ok {
		return
	}
	mount, ok := s.requireOwnedOpenListMount(w, r, mountID)
	if !ok {
		return
	}
	// 内网地址拒绝返回直链：浏览器根本连不到 192.168.x.x 的 raw_url，
	// 给了直链只会让播放器停在「加载中」。挂载层的 directLink 可能被旧数据绕过，
	// 所以这一层必须再拦一次。
	if netutil.IsInternalServerURL(derefOr(mount.ServerURL, "")) {
		failMount(w, http.StatusBadRequest,
			"该挂载为内网地址，无法使用直链模式，请使用服务器转发", "INTERNAL_NETWORK_FORBIDDEN")
		return
	}
	serverURL, username, password := openListParams(mount)
	info, err := s.OpenList.FetchFileInfo(r.Context(), serverURL, username, password, targetPath)
	if err != nil {
		failMount(w, mountErrorStatus(errCode(err), http.StatusBadRequest, true),
			errText(err, "获取 "+openListDisplayName+" 直链失败"), errCode(err))
		return
	}
	httpx.OK(w, map[string]any{
		"success":   true,
		"directUrl": mountutil.UpgradeDirectURLValidated(r.Context(), s.Mounts, mount, info.RawURL),
	})
}

func (s *Server) handleOpenListMe(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDQuery(w, r)
	if !ok {
		return
	}
	mount, ok := s.requireOwnedOpenListMount(w, r, mountID)
	if !ok {
		return
	}
	serverURL, username, password := openListParams(mount)
	info, err := s.OpenList.Me(r.Context(), serverURL, username, password)
	if err != nil {
		failMount(w, mountErrorStatus(errCode(err), http.StatusBadRequest, false),
			errText(err, "获取 "+openListDisplayName+" 账号信息失败"), errCode(err))
		return
	}
	// Node 用 Express 的 res.json：undefined 会被整个丢掉，null 才会输出。
	// 匿名挂载时 info 是 null，前端据此隐藏「账号信息」区块。
	var payload map[string]any
	if info == nil {
		payload = map[string]any{"success": true, "info": nil}
	} else {
		payload = map[string]any{"success": true, "info": json.RawMessage(info)}
	}
	httpx.OK(w, payload)
}

func (s *Server) handleOpenListSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if _, ok := query["mountId"]; !ok {
		failMount(w, http.StatusBadRequest, "缺少 mountId 或 keywords 参数", "")
		return
	}
	if _, ok := query["keywords"]; !ok {
		failMount(w, http.StatusBadRequest, "缺少 mountId 或 keywords 参数", "")
		return
	}
	mountID, err := strconv.ParseInt(query.Get("mountId"), 10, 64)
	if err != nil {
		failMount(w, http.StatusBadRequest, "mountId 不正确", "")
		return
	}
	keywords := strings.TrimSpace(query.Get("keywords"))
	if keywords == "" {
		failMount(w, http.StatusBadRequest, "keywords 不能为空", "")
		return
	}
	parent := query.Get("parent")
	if parent == "" {
		parent = "/"
	}
	mount, ok := s.requireOwnedOpenListMount(w, r, mountID)
	if !ok {
		return
	}
	serverURL, username, password := openListParams(mount)
	result, err := s.OpenList.SearchFiles(r.Context(), serverURL, username, password, parent, keywords)
	if err != nil {
		failMount(w, mountErrorStatus(errCode(err), http.StatusBadRequest, false),
			errText(err, "搜索 "+openListDisplayName+" 文件失败"), errCode(err))
		return
	}
	httpx.OK(w, map[string]any{"success": true, "entries": result.Entries, "total": result.Total})
}

// ==================== 流代理 ====================

// openListRawURL 取带缓存的 raw_url，并在失败时失效缓存重试一次。
//
// Node 的 getCachedRawUrl 同样有这一层：缓存里可能存着已过期的签名直链，
// 不重试的话 5 分钟 TTL 窗口内所有请求都会拿着死 URL 反复失败。
func (s *Server) openListRawURL(r *http.Request, cacheKey, serverURL, username, password, targetPath string) (*openlist.FileInfo, error) {
	info, err := s.OpenList.CachedFileInfo(r.Context(), cacheKey, serverURL, username, password, targetPath)
	if err == nil {
		return info, nil
	}
	s.OpenList.InvalidateRawURL(cacheKey)
	return s.OpenList.CachedFileInfo(r.Context(), cacheKey, serverURL, username, password, targetPath)
}

func (s *Server) handleOpenListProxyByMount(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if _, ok := query["mountId"]; !ok {
		failMount(w, http.StatusBadRequest, "缺少 mountId 参数", "")
		return
	}
	mountID, err := strconv.ParseInt(query.Get("mountId"), 10, 64)
	if err != nil {
		failMount(w, http.StatusBadRequest, "mountId 不正确", "")
		return
	}
	targetPath := strings.TrimSpace(query.Get("path"))
	if targetPath == "" {
		failMount(w, http.StatusBadRequest, "缺少 path 参数", "")
		return
	}
	mount, ok := s.requireOwnedOpenListMount(w, r, mountID)
	if !ok {
		return
	}
	serverURL, username, password := openListParams(mount)
	cacheKey := "mount:" + strconv.FormatInt(mountID, 10) + "|" + targetPath
	s.proxyOpenListFile(w, r, "openlist-proxy", "OpenList 代理流错误", cacheKey,
		serverURL, username, password, targetPath)
}

// proxyOpenListFile 是 /proxy 与 /stream 共用的转发实现。
func (s *Server) proxyOpenListFile(
	w http.ResponseWriter, r *http.Request, logTag, errorMessage, cacheKey,
	serverURL, username, password, targetPath string,
) {
	info, err := s.openListRawURL(r, cacheKey, serverURL, username, password, targetPath)
	if err != nil {
		failMount(w, mountErrorStatus(errCode(err), http.StatusBadRequest, true),
			errText(err, "打开 "+openListDisplayName+" 流失败"), errCode(err))
		return
	}
	name := info.Name
	if name == "" {
		name = targetPath
	}
	proxy.ProxyHTTPUpstream(w, r, proxy.HTTPOptions{
		URL:                info.RawURL,
		CORS:               proxy.CORSWildcard,
		DefaultContentType: proxy.ContentTypeForFormat(proxy.DetectMediaFormat(name)),
		LogTag:             logTag,
		ErrorMessage:       errorMessage,
		// 上游对 raw_url 回 401/403/410 基本等于「签名直链过期」：
		// 立刻失效缓存，下一次 Range 请求重新 fs/get 拿新链接。
		OnUpstreamStatus: func(status int) {
			if status == http.StatusUnauthorized || status == http.StatusForbidden ||
				status == http.StatusGone {
				s.OpenList.InvalidateRawURL(cacheKey)
			}
		},
	})
}

// atoiOr 解析整数，失败或非正数时取 fallback。
func atoiOr(raw string, fallback int) int {
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return fallback
	}
	return v
}

// parseMountIDQuery 解析 /me 这类只有 mountId 的 query。
func parseMountIDQuery(w http.ResponseWriter, r *http.Request) (int64, bool) {
	query := r.URL.Query()
	if _, ok := query["mountId"]; !ok {
		failMount(w, http.StatusBadRequest, "缺少 mountId 参数", "")
		return 0, false
	}
	id, err := strconv.ParseInt(query.Get("mountId"), 10, 64)
	if err != nil {
		failMount(w, http.StatusBadRequest, "mountId 不正确", "")
		return 0, false
	}
	return id, true
}
