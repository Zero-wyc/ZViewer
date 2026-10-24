package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/ftp"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/store"
)

const (
	// ftpMountType 是 UserMount.type 的一个取值。
	ftpMountType = "ftp"
	// ftpDisplayName 用于拼错误文案（"FTP 不可访问"）。
	ftpDisplayName = "FTP"
	// ftpProxyPrefix 是 /resolve 返回给前端的相对路径前缀。
	ftpProxyPrefix = "/api/ftp"
)

// registerFTPRoutes 注册 FTP 挂载/流代理端点（对应 routes/ftp.ts
// 与 routes/stream/ftp.ts）。
func (s *Server) registerFTPRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/ftp/mounts", s.Auth.Require(s.handleListFTPMounts))
	mux.HandleFunc("POST /api/ftp/mounts/test", s.Auth.Require(s.handleTestFTPMount))
	mux.HandleFunc("POST /api/ftp/mounts", s.Auth.Require(s.handleCreateFTPMount))
	mux.HandleFunc("PUT /api/ftp/mounts/{id}", s.Auth.Require(s.handleUpdateFTPMount))
	mux.HandleFunc("DELETE /api/ftp/mounts/{id}", s.Auth.Require(s.handleDeleteFTPMount))
	mux.HandleFunc("GET /api/ftp/mounts/{id}/browse", s.Auth.Require(s.handleBrowseFTPMount))
	mux.HandleFunc("GET /api/ftp/resolve", s.Auth.Require(s.handleResolveFTPFile))
	mux.HandleFunc("GET /api/ftp/proxy", s.Auth.Require(s.handleFTPProxy))
	mux.HandleFunc("GET /api/ftp/stream", s.Auth.Require(s.handleFTPStream))
	// 未保存挂载的临时连接（前端的「直接填 FTP 地址添加影片」）。
	// 凭证不进播放 URL：resolve 换一张服务端票据，proxy 凭票取参。
	mux.HandleFunc("GET /api/stream/resolve-ftp", s.Auth.Require(s.handleResolveFTPDirect))
	mux.HandleFunc("GET /api/stream/proxy-ftp", s.Auth.Require(s.handleProxyFTPDirect))
}

// ==================== 入参 ====================

// ftpMountBody 是 FTP 挂载的请求体。
//
// port 用 RawMessage 是因为 Node 侧接受 number 与数字字符串两种形态，
// 且区分「没传 / null」与「传了非法值」。
type ftpMountBody struct {
	Name      *string         `json:"name"`
	ServerURL *string         `json:"serverUrl"`
	Port      json.RawMessage `json:"port"`
	Path      *string         `json:"path"`
	Username  *string         `json:"username"`
	Password  *string         `json:"password"`
}

// portValue 复刻 Node 的端口解析：
//
//	typeof port === 'number' ? port
//	  : (typeof port === 'string' && port.trim() ? Number(port) : null)
//
// 返回 (nil, "") 表示「没有端口」；(nil, msg) 表示校验失败。
func (b ftpMountBody) portValue() (*int64, string) {
	raw := strings.TrimSpace(string(b.Port))
	if raw == "" || raw == "null" {
		return nil, ""
	}
	text := raw
	if strings.HasPrefix(raw, `"`) {
		// 字符串形态：去掉引号；空串等价于没传
		unquoted, err := strconv.Unquote(raw)
		if err != nil {
			return nil, "端口必须在 1-65535 范围内"
		}
		text = strings.TrimSpace(unquoted)
		if text == "" {
			return nil, ""
		}
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil || number < 1 || number > 65535 {
		return nil, "端口必须在 1-65535 范围内"
	}
	value := int64(number)
	return &value, ""
}

// path 取挂载路径（缺省 '/'）。
func (b ftpMountBody) path() string {
	if b.Path != nil && strings.TrimSpace(*b.Path) != "" {
		return strings.TrimSpace(*b.Path)
	}
	return "/"
}

// params 构造连接参数（挂载路径已按 Node 的 mountToParams 归一化）。
func (b ftpMountBody) params(serverURL string, port *int64, password *string) ftp.Params {
	params := ftp.Params{
		ServerURL: serverURL,
		Path:      b.path(),
	}
	if port != nil {
		params.Port = int(*port)
	}
	if b.Username != nil && *b.Username != "" {
		params.Username = *b.Username
	}
	if password != nil {
		params.Password = *password
	}
	return params
}

// ==================== 挂载 CRUD ====================

func (s *Server) handleListFTPMounts(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	mounts, err := s.Mounts.ListByUserType(r.Context(), claims.UserID, ftpMountType)
	if err != nil {
		httpx.InternalError(w, "GET /ftp/mounts", err)
		return
	}
	out := make([]mountDTO, 0, len(mounts))
	for _, m := range mounts {
		out = append(out, toMountDTO(m))
	}
	httpx.OK(w, map[string]any{"success": true, "mounts": out})
}

func (s *Server) handleTestFTPMount(w http.ResponseWriter, r *http.Request) {
	var body ftpMountBody
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	serverURL, msg := ftpServerURL(body)
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, "")
		return
	}
	port, msg := body.portValue()
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, "")
		return
	}
	params := body.params(serverURL, port, body.Password)
	// mounts/test 不缓存：陈旧缓存会把「连不上」测成通过
	entries, err := ftp.ListDir(r.Context(), params, "")
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, ftpDisplayName+" 不可访问"), "")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "itemCount": len(entries)})
}

func (s *Server) handleCreateFTPMount(w http.ResponseWriter, r *http.Request) {
	var body ftpMountBody
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	if body.Name == nil || strings.TrimSpace(*body.Name) == "" {
		failMount(w, http.StatusBadRequest, "挂载名称不能为空", "")
		return
	}
	serverURL, msg := ftpServerURL(body)
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, "")
		return
	}
	port, msg := body.portValue()
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, "")
		return
	}

	params := body.params(serverURL, port, body.Password)
	if _, err := ftp.ListDir(r.Context(), params, ""); err != nil {
		failMount(w, http.StatusBadRequest, errText(err, ftpDisplayName+" 不可访问"), "")
		return
	}

	claims := auth.ClaimsFrom(r.Context())
	// 落库前补前导斜杠：无前导 / 的路径会被 FTP 的 cd 当成「相对登录目录」
	storePath := ftp.NormalizeMountPath(params.Path)
	input := store.MountInput{
		UserID:    claims.UserID,
		Type:      ftpMountType,
		Name:      strings.TrimSpace(*body.Name),
		ServerURL: &params.ServerURL,
		Port:      port,
		Path:      &storePath,
		// FTP 永远不支持直链（浏览器不能直接播 ftp://）
		DirectLink: false,
	}
	if params.Username != "" {
		input.Username = &params.Username
	}
	if params.Password != "" {
		input.Password = &params.Password
	}
	mount, err := s.Mounts.Create(r.Context(), input)
	if err != nil {
		httpx.InternalError(w, "POST /ftp/mounts", err)
		return
	}
	s.InvalidateMount(mount.ID)
	httpx.JSON(w, http.StatusCreated, map[string]any{"success": true, "mount": toMountDTO(mount)})
}

func (s *Server) handleUpdateFTPMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	var body ftpMountBody
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, ftpMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "PUT /ftp/mounts/:id", err)
		return
	}
	if body.Name == nil || strings.TrimSpace(*body.Name) == "" {
		failMount(w, http.StatusBadRequest, "挂载名称不能为空", "")
		return
	}
	serverURL, msg := ftpServerURL(body)
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, "")
		return
	}
	port, msg := body.portValue()
	if msg != "" {
		failMount(w, http.StatusBadRequest, msg, "")
		return
	}

	// 连通性测试用的密码：请求体给了就用请求体的，否则沿用已存的。
	// 注意 Node 的写法是 `(typeof password === 'string' && password) || mount.password`
	// ——传空串时**测试仍用旧密码**，但落库会把密码清空（见下面的赋值）。
	testPassword := mount.Password
	if body.Password != nil && *body.Password != "" {
		testPassword = body.Password
	}
	params := body.params(serverURL, port, testPassword)
	if _, err := ftp.ListDir(r.Context(), params, ""); err != nil {
		failMount(w, http.StatusBadRequest, errText(err, ftpDisplayName+" 不可访问"), "")
		return
	}

	storePath := ftp.NormalizeMountPath(params.Path)
	patch := store.MountPatch{
		Name:      strings.TrimSpace(*body.Name),
		ServerURL: &params.ServerURL,
		Port:      port,
		Path:      &storePath,
		// FTP 不用 apiKey / embyUserId：带现值，避免按列覆盖时被清空
		APIKey:     mount.APIKey,
		EmbyUserID: mount.EmbyUserID,
		// FTP 挂载天然不支持直链；沿用库里的状态，避免改名把它改脏
		DirectLink:  mount.DirectLink,
		HttpsDirect: mount.HttpsDirect,
	}
	if params.Username != "" {
		patch.Username = &params.Username
	}
	patch.Password = mount.Password
	if body.Password != nil {
		// 显式传了 password（含空串）就按传入值覆盖，空串等于清空
		if *body.Password == "" {
			patch.Password = nil
		} else {
			patch.Password = body.Password
		}
	}

	if err := s.Mounts.Update(r.Context(), mountID, claims.UserID, ftpMountType, patch); err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "PUT /ftp/mounts/:id", err)
		return
	}
	s.InvalidateMount(mountID)

	updated, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, ftpMountType)
	if err != nil {
		httpx.InternalError(w, "PUT /ftp/mounts/:id", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "mount": toMountDTO(updated)})
}

func (s *Server) handleDeleteFTPMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	err := s.Mounts.Delete(r.Context(), mountID, claims.UserID, ftpMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return
		}
		httpx.InternalError(w, "DELETE /ftp/mounts/:id", err)
		return
	}
	s.InvalidateMount(mountID)
	httpx.OK(w, map[string]any{"success": true})
}

// ftpServerURL 取并校验请求体里的 serverUrl。
func ftpServerURL(body ftpMountBody) (string, string) {
	if body.ServerURL == nil || strings.TrimSpace(*body.ServerURL) == "" {
		return "", "服务器地址不能为空"
	}
	return strings.TrimSpace(*body.ServerURL), ""
}

// ==================== 浏览 / 解析 ====================

func (s *Server) handleBrowseFTPMount(w http.ResponseWriter, r *http.Request) {
	mountID, ok := parseMountIDParam(w, r.PathValue("id"))
	if !ok {
		return
	}
	mount, ok := s.requireOwnedFTPMount(w, r, mountID)
	if !ok {
		return
	}
	// 空串等价于「看挂载根目录」，缓存 key 也跟着用挂载 path
	browsePath := r.URL.Query().Get("path")
	params := ftpParamsOf(mount, ftp.NormalizeMountPath(derefOr(mount.Path, "/")))
	entries, err := ftp.ListDirCached(r.Context(), params, browsePath, s.ftpDirs)
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, "浏览 "+ftpDisplayName+" 失败"), "")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "entries": toFTPEntryDTOs(entries)})
}

// ftpEntryDTO 与 Node 的目录项一致：size 恒有值，时间缺失时**不下发该字段**
// （老式 LIST 无法可靠解析时间，Node 那边是 undefined 被 JSON.stringify 丢掉）。
type ftpEntryDTO struct {
	Name         string  `json:"name"`
	Path         string  `json:"path"`
	Type         string  `json:"type"`
	Size         int64   `json:"size"`
	LastModified *string `json:"lastModified,omitempty"`
}

func toFTPEntryDTOs(entries []ftp.Entry) []ftpEntryDTO {
	out := make([]ftpEntryDTO, 0, len(entries))
	for _, e := range entries {
		item := ftpEntryDTO{Name: e.Name, Path: e.Path, Type: e.Type, Size: e.Size}
		if !e.LastModified.IsZero() {
			value := e.LastModified.UTC().Format("2006-01-02T15:04:05.000Z")
			item.LastModified = &value
		}
		out = append(out, item)
	}
	return out
}

// requireOwnedFTPMount 取当前用户拥有的 FTP 挂载。
func (s *Server) requireOwnedFTPMount(
	w http.ResponseWriter, r *http.Request, mountID int64,
) (*store.Mount, bool) {
	claims := auth.ClaimsFrom(r.Context())
	mount, err := s.Mounts.FindOwned(r.Context(), mountID, claims.UserID, ftpMountType)
	if err != nil {
		if errors.Is(err, store.ErrMountNotFound) {
			failMount(w, http.StatusNotFound, "挂载不存在或无权限", "")
			return nil, false
		}
		httpx.InternalError(w, "GET /ftp", err)
		return nil, false
	}
	if mount.ServerURL == nil || *mount.ServerURL == "" {
		failMount(w, http.StatusBadRequest, "该挂载未配置服务器地址", "")
		return nil, false
	}
	return mount, true
}

// ftpParamsOf 用挂载记录组装连接参数。
func ftpParamsOf(mount *store.Mount, path string) ftp.Params {
	params := ftp.Params{
		ServerURL: derefOr(mount.ServerURL, ""),
		Path:      path,
		Username:  derefOr(mount.Username, ""),
		Password:  derefOr(mount.Password, ""),
	}
	if mount.Port != nil {
		params.Port = int(*mount.Port)
	}
	return params
}

func (s *Server) handleResolveFTPFile(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if _, hasMount := query["mountId"]; !hasMount {
		failMount(w, http.StatusBadRequest, "缺少 mountId 或 path 参数", "")
		return
	}
	if _, hasPath := query["path"]; !hasPath {
		failMount(w, http.StatusBadRequest, "缺少 mountId 或 path 参数", "")
		return
	}
	mountID, err := strconv.ParseInt(query.Get("mountId"), 10, 64)
	if err != nil {
		failMount(w, http.StatusBadRequest, "mountId 不正确", "")
		return
	}
	targetPath := query.Get("path")
	if strings.TrimSpace(targetPath) == "" {
		failMount(w, http.StatusBadRequest, "path 不能为空", "")
		return
	}
	mount, ok := s.requireOwnedFTPMount(w, r, mountID)
	if !ok {
		return
	}
	params := ftpParamsOf(mount, targetPath)
	info, err := ftp.Stat(r.Context(), params)
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, "解析 "+ftpDisplayName+" 文件失败"), "")
		return
	}
	name := info.Name
	if name == "" {
		name = targetPath
	}
	httpx.OK(w, map[string]any{
		"success": true,
		"title":   info.Name,
		"videoUrl": ftpProxyPrefix + "/proxy?mountId=" + strconv.FormatInt(mountID, 10) +
			"&path=" + urlQueryEscape(targetPath),
		"format":   string(proxy.DetectMediaFormat(name)),
		"duration": 0,
		"size":     info.Size,
	})
}

// ==================== 流代理 ====================

func (s *Server) handleFTPProxy(w http.ResponseWriter, r *http.Request) {
	mountID, targetPath, ok := parseFTPStreamParams(w, r)
	if !ok {
		return
	}
	mount, ok := s.requireOwnedFTPMount(w, r, mountID)
	if !ok {
		return
	}
	params := ftpParamsOf(mount, targetPath)

	info, err := ftp.StatCached(r.Context(), params, s.ftpStats)
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, "代理 "+ftpDisplayName+" 流失败"), "")
		return
	}
	s.serveFTPStream(w, r, params, info.Size, targetPath, "ftp", "流传输失败")
}

func (s *Server) handleFTPStream(w http.ResponseWriter, r *http.Request) {
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
	// FTP 的 serverUrl 不做归一化（与 Node 一致：传 nil 选项）
	resolved, err := s.Stream.Resolve(r.Context(), movieID, ftpMountType, nil)
	if err != nil {
		sendStreamError(w, "ftp", err)
		return
	}
	params := ftp.Params{
		ServerURL: derefOr(resolved.Movie.ServerURL, ""),
		Path:      derefOr(resolved.Movie.Path, ""),
		Username:  resolved.Username,
		Password:  resolved.Password,
	}
	if resolved.Mount != nil && resolved.Mount.Port != nil {
		params.Port = int(*resolved.Mount.Port)
	}

	info, err := ftp.StatCached(r.Context(), params, s.ftpStats)
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, "代理 "+ftpDisplayName+" 影片流失败"), "")
		return
	}
	s.serveFTPStream(w, r, params, info.Size, params.Path, "ftp-stream", ftpDisplayName+" 影片流错误")
}

// parseFTPStreamParams 解析 /proxy 的 mountId + path（文案与 Node 一致）。
func parseFTPStreamParams(w http.ResponseWriter, r *http.Request) (int64, string, bool) {
	query := r.URL.Query()
	if _, ok := query["mountId"]; !ok {
		failMount(w, http.StatusBadRequest, "缺少 mountId 参数", "")
		return 0, "", false
	}
	mountID, err := strconv.ParseInt(query.Get("mountId"), 10, 64)
	if err != nil {
		failMount(w, http.StatusBadRequest, "mountId 不正确", "")
		return 0, "", false
	}
	targetPath := strings.TrimSpace(query.Get("path"))
	if targetPath == "" {
		failMount(w, http.StatusBadRequest, "缺少 path 参数", "")
		return 0, "", false
	}
	return mountID, targetPath, true
}

// serveFTPStream 落地一次「stat 成功之后」的字节输出。
func (s *Server) serveFTPStream(
	w http.ResponseWriter, r *http.Request, params ftp.Params,
	fileSize int64, name, logTag, errorMessage string,
) {
	start, end, ranged := ftpRangeOf(r.Header.Get("Range"), fileSize)
	body, err := ftp.OpenStream(r.Context(), params, start)
	if err != nil {
		failMount(w, http.StatusBadRequest, errText(err, errorMessage), "")
		return
	}
	proxy.PipeRangeStream(w, r, proxy.PipeRangeStreamOptions{
		Stream:       limitFTPRange(body, ranged, start, end),
		ContentType:  proxy.ContentTypeForFormat(proxy.DetectMediaFormat(name)),
		FileSize:     &fileSize,
		Start:        &start,
		End:          &end,
		Ranged:       ranged,
		LogTag:       logTag,
		ErrorMessage: errorMessage,
	})
}

// ftpRangeOf 解析 Range。
//
// 与 Node 的一处刻意差异：Node 在 Range 非法时仍然按 206 输出**整个文件**
// （start=0，end=fileSize-1，但 ranged 取「有没有 Range 头」），于是
// Content-Range 与实际字节数对不上。这里保持同样的状态码与区间，
// 但由 limitFTPRange 保证写出的字节数不超过 Content-Range 声明。
func ftpRangeOf(rangeHeader string, fileSize int64) (int64, int64, bool) {
	if strings.TrimSpace(rangeHeader) == "" {
		return 0, fileSize - 1, false
	}
	parsed, err := proxy.ParseRangeHeader(rangeHeader, fileSize, proxy.MaxRangeChunkBytes)
	if err == nil && parsed != nil {
		return parsed.Start, parsed.End, true
	}
	return 0, fileSize - 1, true
}

// limitFTPRange 把流截断到 Content-Range 声明的长度。
//
// 为什么必须截：FTP 的 REST 只能指定起点，服务端会一直发到文件尾。
// 不截断就会写出比 Content-Length 更多的字节，HTTP 客户端会把多出来的
// 部分当成下一个响应（Node 侧就是这个行为，实测 curl 会报
// "Excess found in a read"）。这里按声明长度收敛，是修 bug 而非改协议。
func limitFTPRange(body io.ReadCloser, ranged bool, start, end int64) io.ReadCloser {
	if !ranged {
		return body
	}
	length := end - start + 1
	if length <= 0 {
		return body
	}
	return &limitedReadCloser{reader: io.LimitReader(body, length), closer: body}
}

type limitedReadCloser struct {
	reader io.Reader
	closer io.Closer
}

func (l *limitedReadCloser) Read(p []byte) (int, error) { return l.reader.Read(p) }
func (l *limitedReadCloser) Close() error               { return l.closer.Close() }

// ==================== 临时连接（票据） ====================

// ftpTicket 是临时 FTP 连接的播放票据载荷。
type ftpTicket struct {
	params ftp.Params
	userID int64
}

// ftpTickets 是票据表：30min 滑动续期（播放期间每次使用即续期）。
type ftpTickets struct {
	mu    sync.Mutex
	items map[string]ftpTicketEntry
	order []string
}

type ftpTicketEntry struct {
	payload ftpTicket
	at      time.Time
}

const (
	ftpTicketTTL = 30 * time.Minute
	ftpTicketCap = 500
)

func newFTPTickets() *ftpTickets {
	return &ftpTickets{items: make(map[string]ftpTicketEntry, 16)}
}

func (t *ftpTickets) get(key string) (ftpTicket, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.items[key]
	if !ok {
		return ftpTicket{}, false
	}
	if time.Since(entry.at) >= ftpTicketTTL {
		delete(t.items, key)
		return ftpTicket{}, false
	}
	return entry.payload, true
}

// set 写入并刷新活跃时间（滑动续期）。
func (t *ftpTickets) set(key string, payload ftpTicket) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, exists := t.items[key]; !exists {
		t.order = append(t.order, key)
	}
	t.items[key] = ftpTicketEntry{payload: payload, at: time.Now()}
	for len(t.items) > ftpTicketCap && len(t.order) > 0 {
		oldest := t.order[0]
		t.order = t.order[1:]
		delete(t.items, oldest)
	}
}

// newTicketID 生成 UUID v4（对应 Node 的 crypto.randomUUID()）。
func newTicketID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// 极端情况下退回时间戳：票据只需在进程内唯一
		return "t" + strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buf[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" +
		encoded[16:20] + "-" + encoded[20:32]
}

// readFTPDirectParams 读取临时连接的 query 参数。
func readFTPDirectParams(r *http.Request) (ftp.Params, bool) {
	query := r.URL.Query()
	serverURL := strings.TrimSpace(query.Get("serverUrl"))
	path := strings.TrimSpace(query.Get("path"))
	if serverURL == "" || path == "" {
		return ftp.Params{}, false
	}
	params := ftp.Params{ServerURL: serverURL, Path: path}
	if username := query.Get("username"); username != "" {
		params.Username = username
	}
	if password := query.Get("password"); password != "" {
		params.Password = password
	}
	if raw := strings.TrimSpace(query.Get("port")); raw != "" {
		if port, err := strconv.Atoi(raw); err == nil {
			params.Port = port
		}
	}
	return params, true
}

func (s *Server) handleResolveFTPDirect(w http.ResponseWriter, r *http.Request) {
	params, ok := readFTPDirectParams(r)
	if !ok {
		failMount(w, http.StatusBadRequest, "缺少服务器地址或路径", "")
		return
	}
	info, err := ftp.Stat(r.Context(), params)
	if err != nil {
		// Node 这条链路统一 500（不带业务码），文案取错误原文
		failMount(w, http.StatusInternalServerError, errText(err, "解析 FTP 文件失败"), "")
		return
	}
	ticket := newTicketID()
	s.ftpTickets.set(ticket, ftpTicket{params: params, userID: auth.ClaimsFrom(r.Context()).UserID})
	httpx.OK(w, map[string]any{
		"success":  true,
		"title":    info.Name,
		"videoUrl": "/api/stream/proxy-ftp?ticket=" + ticket,
		// Node 这里把 format 写死 mp4（临时连接不做格式判定）
		"format":   "mp4",
		"duration": 0,
	})
}

func (s *Server) handleProxyFTPDirect(w http.ResponseWriter, r *http.Request) {
	ticketKey := r.URL.Query().Get("ticket")
	var payload ftpTicket
	ok := false
	if ticketKey != "" {
		payload, ok = s.ftpTickets.get(ticketKey)
	}
	if !ok {
		failMount(w, http.StatusForbidden, "FTP 播放票据无效或已过期，请重新解析", "")
		return
	}
	if payload.userID != auth.ClaimsFrom(r.Context()).UserID {
		failMount(w, http.StatusForbidden, "FTP 播放票据归属校验失败", "")
		return
	}
	// 滑动续期：活跃播放持续续期，闲置 30min 后回收
	s.ftpTickets.set(ticketKey, payload)

	body, err := ftp.OpenStream(r.Context(), payload.params, 0)
	if err != nil {
		failMount(w, http.StatusBadGateway, errText(err, "FTP 代理失败"), "")
		return
	}
	proxy.PipeRangeStream(w, r, proxy.PipeRangeStreamOptions{
		Stream: body,
		// 历史行为：固定 video/mp4，且不做 Range
		ContentType:  "video/mp4",
		Ranged:       false,
		CORS:         proxy.CORSGlobal,
		LogTag:       "stream",
		ErrorMessage: "FTP 代理失败",
	})
}
