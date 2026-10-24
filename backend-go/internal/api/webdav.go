package api

import (
	"context"
	"errors"
	"fmt"
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
	"zviewer/backend/internal/webdav"
)

// webdavMountType 是 UserMount.type 的一个取值。
const webdavMountType = "webdav"

// webdavDisplayName 用于错误文案（"获取 WebDAV 挂载列表失败"）。
const webdavDisplayName = "WebDAV"

// webdavProxyPrefix 是 /resolve 返回给前端的相对路径。
const webdavProxyPrefix = "/api/webdav"

// registerWebDAVRoutes 注册 WebDAV 挂载与流代理端点（对应 routes/webdav.ts）。
func (s *Server) registerWebDAVRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/webdav/mounts", s.Auth.Require(s.handleListWebDAVMounts))
	mux.HandleFunc("POST /api/webdav/mounts/test", s.Auth.Require(s.handleTestWebDAVMount))
	mux.HandleFunc("POST /api/webdav/mounts", s.Auth.Require(s.handleCreateWebDAVMount))
	mux.HandleFunc("PUT /api/webdav/mounts/{id}", s.Auth.Require(s.handleUpdateWebDAVMount))
	mux.HandleFunc("DELETE /api/webdav/mounts/{id}", s.Auth.Require(s.handleDeleteWebDAVMount))
	mux.HandleFunc("GET /api/webdav/mounts/{id}/browse", s.Auth.Require(s.handleBrowseWebDAVMount))
	mux.HandleFunc("GET /api/webdav/resolve", s.Auth.Require(s.handleResolveWebDAVFile))
	mux.HandleFunc("GET /api/webdav/proxy", s.Auth.Require(s.handleWebDAVProxy))
	mux.HandleFunc("GET /api/webdav/direct-url", s.Auth.Require(s.handleWebDAVDirectURL))
	mux.HandleFunc("GET /api/webdav/stream", s.Auth.Require(s.handleWebDAVStream))
}

// ==================== DTO / 错误 ====================

// mountDTO 是挂载的对外形状：与 Node 的 stripPassword(实体) 一致，
// 除 password 之外的所有列都下发（apiKey 也在内），时间列为 ISO 字符串。
type mountDTO struct {
	ID          int64   `json:"id"`
	UserID      int64   `json:"userId"`
	Type        string  `json:"type"`
	Name        string  `json:"name"`
	ServerURL   *string `json:"serverUrl"`
	Port        *int64  `json:"port"`
	Path        *string `json:"path"`
	Username    *string `json:"username"`
	IndexURL    *string `json:"indexUrl"`
	APIKey      *string `json:"apiKey"`
	EmbyUserID  *string `json:"embyUserId"`
	DirectLink  bool    `json:"directLink"`
	HttpsDirect *bool   `json:"httpsDirect"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

func toMountDTO(m *store.Mount) mountDTO {
	return mountDTO{
		ID:          m.ID,
		UserID:      m.UserID,
		Type:        m.Type,
		Name:        m.Name,
		ServerURL:   m.ServerURL,
		Port:        m.Port,
		Path:        m.Path,
		Username:    m.Username,
		IndexURL:    m.IndexURL,
		APIKey:      m.APIKey,
		EmbyUserID:  m.EmbyUserID,
		DirectLink:  m.DirectLink,
		HttpsDirect: m.HttpsDirect,
		CreatedAt:   isoMillis(m.CreatedAt),
		UpdatedAt:   isoMillis(m.UpdatedAt),
	}
}

// failMount 输出挂载类错误。
//
// code 为空时**不下发该字段**（Node 的 JSON.stringify 会丢掉 undefined），
// 前端靠「有没有 code」区分「业务错误码」与「纯文案错误」。
func failMount(w http.ResponseWriter, status int, message, code string) {
	if code == "" {
		httpx.Fail(w, status, message)
		return
	}
	httpx.FailWithCode(w, status, message, code)
}

// errText 从未知错误取文案，取不到时用 fallback（对应 extractErrorMessage）。
func errText(err error, fallback string) string {
	var davErr *webdav.Error
	if errors.As(err, &davErr) {
		return davErr.Message
	}
	var olErr *openlist.Error
	if errors.As(err, &olErr) {
		return olErr.Message
	}
	if err != nil && err.Error() != "" {
		return err.Error()
	}
	return fallback
}

// errCode 取错误码，未知一律 UNREACHABLE（对应 extractErrorCode）。
func errCode(err error) string {
	var davErr *webdav.Error
	if errors.As(err, &davErr) {
		return davErr.Code
	}
	var olErr *openlist.Error
	if errors.As(err, &olErr) {
		return olErr.Code
	}
	return webdav.CodeUnreachable
}

// ==================== 入参 ====================

type mountBody struct {
	Name       *string `json:"name"`
	ServerURL  *string `json:"serverUrl"`
	Path       *string `json:"path"`
	Username   *string `json:"username"`
	Password   *string `json:"password"`
	DirectLink *bool   `json:"directLink"`
}

// params 由请求体构造连接参数（path 缺省为 '/'）。
func (b mountBody) params(serverURL string, passwordOverride *string) webdav.Params {
	params := webdav.Params{ServerURL: serverURL, Path: "/"}
	if b.Path != nil && strings.TrimSpace(*b.Path) != "" {
		params.Path = strings.TrimSpace(*b.Path)
	}
	if b.Username != nil && *b.Username != "" {
		params.Username = *b.Username
	}
	password := passwordOverride
	if password == nil {
		password = b.Password
	}
	if password != nil {
		params.Password = *password
	}
	return params
}

// requireServerURL 取并校验 serverUrl。
func (b mountBody) requireServerURL() (string, string, string) {
	if b.ServerURL == nil || strings.TrimSpace(*b.ServerURL) == "" {
		return "", "服务器地址不能为空", "INVALID_URL"
	}
	return strings.TrimSpace(*b.ServerURL), "", ""
}

// testConnectivity 探测连通性（含挂载 path 可访问性）。
//
// 只测根目录时 path 填错也能"测试通过"，浏览/播放才发现问题。
func testConnectivity(ctx context.Context, params webdav.Params) (int, error) {
	entries, err := webdav.ListDir(ctx, params, params.Path)
	if err != nil {
		return 0, err
	}
	return len(entries), nil
}

// ==================== 挂载 CRUD ====================

func (s *Server) handleListWebDAVMounts(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	mounts, err := s.Mounts.ListByUserType(r.Context(), claims.UserID, webdavMountType)
	if err != nil {
		httpx.InternalError(w, "GET /webdav/mounts", err)
		return
	}
	out := make([]mountDTO, 0, len(mounts))
	for _, m := range mounts {
		out = append(out, toMountDTO(m))
	}
	httpx.OK(w, map[string]any{"success": true, "mounts": out})
}

func (s *Server) handleTestWebDAVMount(w http.ResponseWriter, r *http.Request) {
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
	itemCount, err := testConnectivity(r.Context(), body.params(serverURL, nil))
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, webdavDisplayName+" 不可访问"), errCode(err))
		return
	}
	httpx.OK(w, map[string]any{"success": true, "itemCount": itemCount})
}

func (s *Server) handleCreateWebDAVMount(w http.ResponseWriter, r *http.Request) {
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
	params := body.params(serverURL, nil)
	if _, err := testConnectivity(r.Context(), params); err != nil {
		failMount(w, http.StatusBadRequest, errText(err, webdavDisplayName+" 不可访问"), errCode(err))
		return
	}

	claims := auth.ClaimsFrom(r.Context())
	requestedDirect := body.DirectLink != nil && *body.DirectLink
	input := store.MountInput{
		UserID:     claims.UserID,
		Type:       webdavMountType,
		Name:       strings.TrimSpace(*body.Name),
		ServerURL:  &params.ServerURL,
		Path:       &params.Path,
		DirectLink: mountutil.ResolveDirectLinkWithInternalCheck(params.ServerURL, requestedDirect),
	}
	if params.Username != "" {
		input.Username = &params.Username
	}
	if params.Password != "" {
		input.Password = &params.Password
	}
	mount, err := s.Mounts.Create(r.Context(), input)
	if err != nil {
		httpx.InternalError(w, "POST /webdav/mounts", err)
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

func (s *Server) handleUpdateWebDAVMount(w http.ResponseWriter, r *http.Request) {
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
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, webdavMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "PUT /webdav/mounts/:id", err)
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

	// 密码未传时沿用已存密码（前端只回显掩码，不会回传真实密码）。
	passwordOverride := mount.Password
	if body.Password != nil {
		if *body.Password == "" {
			passwordOverride = nil
		} else {
			passwordOverride = body.Password
		}
	}
	params := body.params(serverURL, passwordOverride)
	if _, err := testConnectivity(r.Context(), params); err != nil {
		failMount(w, http.StatusBadRequest, errText(err, webdavDisplayName+" 不可访问"), errCode(err))
		return
	}

	httpsDirect := mount.HttpsDirect
	// serverUrl 变更时重置探测结果（旧值对应旧地址）
	if mount.ServerURL == nil || *mount.ServerURL != params.ServerURL {
		httpsDirect = nil
	}
	requestedDirect := body.DirectLink != nil && *body.DirectLink
	patch := store.MountPatch{
		Name:      strings.TrimSpace(*body.Name),
		ServerURL: &params.ServerURL,
		// WebDAV 不用端口：带上现值，避免覆盖时被清空
		Port: mount.Port,
		Path: &params.Path,
		// WebDAV 不用 apiKey / embyUserId：同样带现值，避免覆盖时被清空
		APIKey:      mount.APIKey,
		EmbyUserID:  mount.EmbyUserID,
		DirectLink:  mountutil.ResolveDirectLinkWithInternalCheck(params.ServerURL, requestedDirect),
		HttpsDirect: httpsDirect,
	}
	if params.Username != "" {
		patch.Username = &params.Username
	}
	patch.Password = passwordOverride

	if err := s.Mounts.Update(r.Context(), mountID, claims.UserID, webdavMountType, patch); err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "PUT /webdav/mounts/:id", err)
		return
	}
	s.InvalidateMount(mountID)

	updated, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, webdavMountType)
	if err != nil {
		httpx.InternalError(w, "PUT /webdav/mounts/:id", err)
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

func (s *Server) handleDeleteWebDAVMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	err := s.Mounts.Delete(r.Context(), mountID, claims.UserID, webdavMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "DELETE /webdav/mounts/:id", err)
		return
	}
	s.InvalidateMount(mountID)
	httpx.OK(w, map[string]any{"success": true})
}

// resolveSaveWarning 保存挂载后的提示优先级：内网强制中转 > HTTPS 能力警告。
func resolveSaveWarning(mount *store.Mount, requestedDirectLink bool, httpsWarning string) string {
	if mount.DirectLink != requestedDirectLink {
		return "检测到内网地址，已强制使用服务器中转模式"
	}
	return httpsWarning
}

// ==================== 浏览 / 解析 ====================

func (s *Server) handleBrowseWebDAVMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	mount, params, ok := s.requireOwnedWebDAVMount(w, r, mountID)
	if !ok {
		return
	}
	browsePath := r.URL.Query().Get("path")
	entries, err := webdav.ListDirCached(r.Context(), params, mount.ID, browsePath, s.webdavDirs)
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, "浏览 "+webdavDisplayName+" 失败"), errCode(err))
		return
	}
	httpx.OK(w, map[string]any{"success": true, "entries": toEntryDTOs(entries)})
}

// entryDTO 与 Node 的目录项一致：size / lastModified 缺失时不下发。
type entryDTO struct {
	Name         string  `json:"name"`
	Path         string  `json:"path"`
	Type         string  `json:"type"`
	Size         *int64  `json:"size,omitempty"`
	LastModified *string `json:"lastModified"`
}

func toEntryDTOs(entries []webdav.Entry) []entryDTO {
	out := make([]entryDTO, 0, len(entries))
	for _, e := range entries {
		item := entryDTO{Name: e.Name, Path: e.Path, Type: e.Type, Size: e.Size}
		if !e.LastModified.IsZero() {
			value := e.LastModified.UTC().Format("2006-01-02T15:04:05.000Z")
			item.LastModified = &value
		}
		out = append(out, item)
	}
	return out
}

// requireOwnedWebDAVMount 取当前用户拥有的挂载并组装连接参数。
func (s *Server) requireOwnedWebDAVMount(
	w http.ResponseWriter, r *http.Request, mountID int64,
) (*store.Mount, webdav.Params, bool) {
	claims := auth.ClaimsFrom(r.Context())
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, webdavMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return nil, webdav.Params{}, false
		}
		httpx.InternalError(w, "GET /webdav", err)
		return nil, webdav.Params{}, false
	}
	if mount.ServerURL == nil || *mount.ServerURL == "" {
		failMount(w, http.StatusBadRequest, "该挂载未配置服务器地址", "")
		return nil, webdav.Params{}, false
	}
	return mount, mountParams(mount, derefOr(mount.Path, "/")), true
}

// mountParams 用挂载记录组装连接参数。
func mountParams(mount *store.Mount, path string) webdav.Params {
	params := webdav.Params{ServerURL: derefOr(mount.ServerURL, ""), Path: path}
	if mount.Username != nil {
		params.Username = *mount.Username
	}
	if mount.Password != nil {
		params.Password = *mount.Password
	}
	return params
}

func derefOr(v *string, fallback string) string {
	if v == nil || *v == "" {
		return fallback
	}
	return *v
}

func (s *Server) handleResolveWebDAVFile(w http.ResponseWriter, r *http.Request) {
	mountID, targetPath, ok := s.parseResolveParams(w, r)
	if !ok {
		return
	}
	_, params, ok := s.requireOwnedWebDAVMount(w, r, mountID)
	if !ok {
		return
	}
	statParams := params
	statParams.Path = targetPath
	info, err := webdav.Stat(r.Context(), statParams)
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, "解析 "+webdavDisplayName+" 文件失败"), errCode(err))
		return
	}
	name := info.Name
	if name == "" {
		name = targetPath
	}
	httpx.OK(w, map[string]any{
		"success": true,
		"title":   name,
		"videoUrl": webdavProxyPrefix + "/proxy?mountId=" + strconv.FormatInt(mountID, 10) +
			"&path=" + urlQueryEscape(targetPath),
		"format":   string(proxy.DetectMediaFormat(name)),
		"duration": 0,
	})
}

// parseResolveParams 解析 /resolve 与 /direct-url 的 mountId + path。
func (s *Server) parseResolveParams(w http.ResponseWriter, r *http.Request) (int64, string, bool) {
	query := r.URL.Query()
	if query.Get("mountId") == "" || query.Get("path") == "" {
		// 注意：mountId 传空串与完全没传在这里等价处理，
		// 因为两者都会走到 fs 层报「缺少参数」，没必要区分。
		if _, ok := query["mountId"]; !ok {
			failMount(w, http.StatusBadRequest, "缺少 mountId 或 path 参数", "INVALID_PARAMS")
			return 0, "", false
		}
		if _, ok := query["path"]; !ok {
			failMount(w, http.StatusBadRequest, "缺少 mountId 或 path 参数", "INVALID_PARAMS")
			return 0, "", false
		}
	}
	id, err := strconv.ParseInt(query.Get("mountId"), 10, 64)
	if err != nil {
		failMount(w, http.StatusBadRequest, "mountId 不正确", "INVALID_PARAMS")
		return 0, "", false
	}
	targetPath := strings.TrimSpace(query.Get("path"))
	if targetPath == "" {
		failMount(w, http.StatusBadRequest, "path 不能为空", "INVALID_PARAMS")
		return 0, "", false
	}
	return id, targetPath, true
}

// urlQueryEscape 复刻 encodeURIComponent（用于拼接 query 参数）。
func urlQueryEscape(raw string) string {
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// ==================== 代理流 ====================

func (s *Server) handleWebDAVProxy(w http.ResponseWriter, r *http.Request) {
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
	_, params, ok := s.requireOwnedWebDAVMount(w, r, mountID)
	if !ok {
		return
	}
	params.Path = targetPath

	stream, err := webdav.OpenRangeStream(r.Context(), params, r.Header.Get("Range"), s.webdavStats)
	if err != nil {
		failMount(w, proxyErrorStatus(err, http.StatusBadRequest), errText(err, "打开 WebDAV 流失败"), errCode(err))
		return
	}
	proxy.PipeRangeStream(w, r, proxy.PipeRangeStreamOptions{
		Stream:      stream.Body,
		ContentType: preferUpstreamContentType(stream.ContentType, targetPath),
		FileSize:    &stream.FileSize,
		Start:       &stream.Start,
		End:         &stream.End,
		// 用实际语义而非客户端请求头：退化全量 GET 时必须回 200，
		// 否则 206 + 错误的 Content-Range 会直接挂掉播放
		Ranged:       stream.Ranged,
		LogTag:       "webdav",
		ErrorMessage: webdavDisplayName + " 代理流错误",
		ErrorCode:    webdav.CodeUnreachable,
	})
}

func (s *Server) handleWebDAVDirectURL(w http.ResponseWriter, r *http.Request) {
	mountID, targetPath, ok := s.parseResolveParams(w, r)
	if !ok {
		return
	}
	mount, _, ok := s.requireOwnedWebDAVMount(w, r, mountID)
	if !ok {
		return
	}
	serverURL := *mount.ServerURL

	// 内网地址拒绝返回直链（浏览器无法访问内网服务器）
	if netutil.IsInternalServerURL(serverURL) {
		failMount(w, http.StatusBadRequest,
			"该挂载为内网地址，无法使用直链模式，请使用服务器转发", "INTERNAL_NETWORK_FORBIDDEN")
		return
	}

	// 优先用 AList API 拿带签名的真实直链：很多用户把 AList 以 WebDAV
	// 类型挂载（AList 同时支持 WebDAV 与 HTTP API）。
	if info, err := s.OpenList.FetchFileInfo(
		r.Context(), openlist.ToAPIBaseURL(serverURL),
		derefOr(mount.Username, ""), derefOr(mount.Password, ""), targetPath,
	); err == nil && info.RawURL != "" {
		httpx.OK(w, map[string]any{
			"success":   true,
			"directUrl": mountutil.UpgradeDirectURLValidated(r.Context(), s.Mounts, mount, info.RawURL),
		})
		return
	} else if err != nil {
		code := errCode(err)
		// 明确是 AList 服务器但路径/凭证有问题：直接报错，不回退拼接
		if code == openlist.CodeNotFound || code == openlist.CodeAuthFailed {
			failMount(w, webdav.StatusForCode(code, http.StatusNotFound),
				errText(err, "获取 WebDAV 直链失败"), code)
			return
		}
		// UNREACHABLE 等错误：可能根本不是 AList，回退到 WebDAV 拼接
	}

	// WebDAV 协议不支持生成真实直链，只能拼接 serverUrl+path
	rawDirectURL := webdav.DirectURL(serverURL, targetPath)
	httpx.OK(w, map[string]any{
		"success":   true,
		"directUrl": mountutil.UpgradeDirectURLValidated(r.Context(), s.Mounts, mount, rawDirectURL),
	})
}

func (s *Server) handleWebDAVStream(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("movieId") == "" {
		failMount(w, http.StatusBadRequest, "缺少 movieId 参数", "")
		return
	}
	if _, ok := s.requireMovieReadAccess(w, r); !ok {
		return
	}
	movieID, err := proxy.MovieIDFromRequest(r)
	if err != nil {
		failMount(w, http.StatusBadRequest, "movieId 不正确", "")
		return
	}
	resolved, err := s.Stream.Resolve(r.Context(), movieID, webdavMountType, &proxy.ResolveOptions{
		NormalizeServerURL: normalizeWebDAVServerURL,
	})
	if err != nil {
		sendStreamError(w, "webdav", err)
		return
	}
	movie := resolved.Movie
	params := webdav.Params{
		ServerURL: normalizeWebDAVServerURL(derefOr(movie.ServerURL, "")),
		Path:      derefOr(movie.Path, ""),
		Username:  resolved.Username,
		Password:  resolved.Password,
	}
	stream, err := webdav.OpenRangeStream(r.Context(), params, r.Header.Get("Range"), s.webdavStats)
	if err != nil {
		status := proxyErrorStatus(err, http.StatusBadRequest)
		httpx.FailWithCode(w, status, errText(err, "打开 WebDAV 流失败"), errCode(err))
		return
	}
	name := params.Path
	proxy.PipeRangeStream(w, r, proxy.PipeRangeStreamOptions{
		Stream:       stream.Body,
		ContentType:  preferUpstreamContentType(stream.ContentType, name),
		FileSize:     &stream.FileSize,
		Start:        &stream.Start,
		End:          &stream.End,
		Ranged:       stream.Ranged,
		LogTag:       "webdav-stream",
		ErrorMessage: webdavDisplayName + " 影片流错误",
		ErrorCode:    webdav.CodeUnreachable,
	})
}

// preferUpstreamContentType 优先用源站的 Content-Type。
//
// Node 侧 webdav-client 底层是 request 库，把流 pipe 给响应时它会用
// pipeDest 把上游响应头整份照抄到下游，Content-Type 因此由源站决定
// （见 webdav.Stream#ContentType 的注释）。这里必须同样优先上游，
// 否则同一台 NAS 上「Node 播得动、Go 播不动」这种差异永远查不出来。
func preferUpstreamContentType(upstream, filename string) string {
	if trimmed := strings.TrimSpace(upstream); trimmed != "" {
		return trimmed
	}
	return proxy.ContentTypeForFormat(proxy.DetectMediaFormat(filename))
}

// normalizeWebDAVServerURL 归一化 WebDAV 挂载地址：去空白、去末尾斜杠。
//
// 与 Node 的 normalizeServerUrl 一致——补 /dav 是 OpenList 的事，
// WebDAV 挂载的 path 前缀由用户自己填在 serverUrl 里。
func normalizeWebDAVServerURL(raw string) string {
	normalized := strings.TrimSpace(raw)
	for strings.HasSuffix(normalized, "/") {
		normalized = normalized[:len(normalized)-1]
	}
	return normalized
}

// proxyErrorStatus 把挂载错误码映射为流端点的状态码（fallback 400）。
func proxyErrorStatus(err error, fallback int) int {
	return webdav.StatusForCode(errCode(err), fallback)
}

// InvalidateMount 清掉影片流解析缓存。
//
// Node 侧按 (userId, type, mountId) 精确失效挂载缓存；Go 的 StreamResolver
// 是按 movieId 缓存的，无法反查「哪些影片用了这个挂载」，所以整表清空。
// 代价只是下一轮请求多几次 DB 查询（30s 缓存很快重建），换来的是
// 「改了挂载密码仍用旧凭证」这类难查问题彻底消失。
func (s *Server) InvalidateMount(mountID int64) {
	_ = mountID
	if s.Stream != nil {
		s.Stream.Clear()
	}
}

// parseMountIDParam 解析挂载 ID 路径参数，文案与 Node 一致。
func parseMountIDParam(w http.ResponseWriter, raw string) (int64, bool) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		failMount(w, http.StatusBadRequest, "挂载 ID 不正确", "")
		return 0, false
	}
	return id, true
}
