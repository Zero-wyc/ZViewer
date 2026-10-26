package api

import (
	"bytes"
	"errors"
	"fmt"
	_ "golang.org/x/image/webp"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// 头像上传约束，与 Node 版 multer 配置逐项对齐。
const (
	avatarFieldName = "avatar"
	avatarMaxBytes  = 5 * 1024 * 1024
)

// avatarAllowedTypes 是允许的 MIME。
//
// 上传按图片解码器校验实际内容；此 MIME 表用于静态资源的防嗅探输出。
var avatarAllowedTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// avatarExtPattern 从原始文件名里取扩展名时的白名单。
//
// Node 版直接用 path.extname().toLowerCase()，理论上能塞进奇怪字符
// （文件落在服务端磁盘上，这是条真实的写入路径）。Go 侧收紧成字母数字，
// 合法输入的结果与 Node 完全一致。
var avatarExtPattern = regexp.MustCompile(`^\.[a-z0-9]{1,8}$`)

func (s *Server) registerProfileRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PATCH /api/auth/password", s.Auth.Require(s.handleChangePassword))
	mux.HandleFunc("PATCH /api/auth/username", s.Auth.Require(s.handleChangeUsername))
	mux.HandleFunc("POST /api/auth/avatar", s.Auth.Require(s.handleUploadAvatar))
	mux.HandleFunc("DELETE /api/auth/avatar", s.Auth.Require(s.handleDeleteAvatar))
}

// handleChangePassword 复刻 routes/auth.ts#PATCH /password。
//
// 顺序不能动：限流 → 游客拦截 → 参数校验 → 原密码校验 → 改密 → 吊销旧令牌。
// 吊销排在改密之后，否则中间那段时间旧 token 仍可用的窗口就被白送了。
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}

	// 每用户 1 分钟最多 3 次。游客共享 pw:0 桶，与 Node 版 keyGenerator 行为一致。
	key := "pw:" + strconv.FormatInt(claims.UserID, 10)
	if res := s.passwordLimiter.Allow(key); !res.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(res.RetryAfter.Seconds())+1))
		httpx.Fail(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
		return
	}

	if claims.IsGuest() {
		httpx.Forbidden(w, "游客无法修改密码")
		return
	}

	var req struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.BadRequest(w, "原密码或新密码格式不正确，新密码至少 4 位")
		return
	}
	if req.OldPassword == "" || len([]rune(req.NewPassword)) < 4 {
		httpx.BadRequest(w, "原密码或新密码格式不正确，新密码至少 4 位")
		return
	}

	ctx := r.Context()
	user, err := s.Users.FindByID(ctx, claims.UserID)
	if errors.Is(err, store.ErrUserNotFound) {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "change-password", err)
		return
	}

	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.OldPassword)) != nil {
		httpx.Unauthorized(w, "原密码错误")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		httpx.InternalError(w, "change-password/bcrypt", err)
		return
	}
	if err := s.Users.UpdatePassword(ctx, user.ID, string(hash)); err != nil {
		httpx.InternalError(w, "change-password/save", err)
		return
	}
	// 失败也要继续往下走：密码已经改成功，吊销失败最多是旧 token 多活一会儿，
	// 但不该让用户看到"修改失败"然后拿新密码登不上。
	if err := s.Users.InvalidateTokens(ctx, user.ID); err != nil {
		logAuditError(err)
	}

	s.writeAudit(ctx, store.AuditEntry{
		ActorUserID:   &user.ID,
		ActorUsername: user.Username,
		ActorRole:     user.Role,
		Action:        "password_changed",
		IP:            clientIP(r),
		Success:       true,
	})

	payload := map[string]any{
		"success": true,
		"message": "密码修改成功，请重新登录",
	}
	if hint := passwordStrengthHint(req.NewPassword); hint != "" {
		payload["passwordHint"] = hint
	}
	httpx.OK(w, payload)
}

// handleChangeUsername 复刻 routes/auth.ts#PATCH /username（仅 root）。
//
// Node 版这里只校验"非空"，不复用注册时的 2–24 位格式规则。
// 这是历史行为：root 改名走的是独立入口，前端也只做 trim 后非空判断。
// 为了不出现"网页能改、桌面端不能改"，Go 侧保持一致，不额外加校验。
func (s *Server) handleChangeUsername(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	if claims.Role != auth.RoleRoot {
		httpx.Forbidden(w, "仅 root 可修改用户名")
		return
	}

	var req struct {
		Username string `json:"username"`
	}
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.BadRequest(w, "用户名不能为空")
		return
	}
	trimmed := strings.TrimSpace(req.Username)
	if trimmed == "" {
		httpx.BadRequest(w, "用户名不能为空")
		return
	}

	ctx := r.Context()
	existing, err := s.Users.FindByUsername(ctx, trimmed)
	if err != nil && !errors.Is(err, store.ErrUserNotFound) {
		httpx.InternalError(w, "change-username/lookup", err)
		return
	}
	if existing != nil && existing.ID != claims.UserID {
		httpx.Fail(w, http.StatusConflict, "用户名已存在")
		return
	}

	user, err := s.Users.UpdateUsername(ctx, claims.UserID, trimmed)
	if errors.Is(err, store.ErrUserNotFound) {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		// 并发下两个请求可能同时通过查重，唯一索引兜底后翻译成 409
		if strings.Contains(strings.ToUpper(err.Error()), "UNIQUE") {
			httpx.Fail(w, http.StatusConflict, "用户名已存在")
			return
		}
		httpx.InternalError(w, "change-username/save", err)
		return
	}

	s.writeAudit(ctx, store.AuditEntry{
		ActorUserID:   &user.ID,
		ActorUsername: user.Username,
		ActorRole:     user.Role,
		Action:        "username_changed",
		IP:            clientIP(r),
		Success:       true,
	})

	httpx.OK(w, map[string]any{
		"success": true,
		"message": "用户名修改成功",
		"user":    toUserView(user),
	})
}

// handleUploadAvatar 复刻 routes/auth.ts#POST /avatar。
//
// 文件名格式 `<userId>-<毫秒时间戳><ext>` 必须保持：旧头像清理逻辑
// 靠 /uploads/avatars/ 前缀 + 目录内 basename 定位，改了命名规则不影响功能，
// 但会让"同一秒内多次上传"更容易撞名，保持原样更省事。
func (s *Server) handleUploadAvatar(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	if claims.IsGuest() {
		httpx.Forbidden(w, "游客无法设置头像")
		return
	}

	// MaxBytesReader 要略大于文件上限：multipart 边界与其它字段也占字节，
	// 卡在 5MB 整会把"刚好 5MB 的文件"判成超限。
	r.Body = http.MaxBytesReader(w, r.Body, avatarMaxBytes+1<<20)
	if err := r.ParseMultipartForm(avatarMaxBytes); err != nil {
		httpx.BadRequest(w, "头像上传失败："+multipartErrorText(err))
		return
	}
	file, _, err := r.FormFile(avatarFieldName)
	if err != nil {
		httpx.BadRequest(w, "未接收到头像文件")
		return
	}
	defer file.Close()

	defer r.MultipartForm.RemoveAll()
	data, err := io.ReadAll(io.LimitReader(file, avatarMaxBytes+1))
	if err != nil {
		httpx.BadRequest(w, "头像读取失败")
		return
	}
	if len(data) > avatarMaxBytes {
		httpx.BadRequest(w, "头像文件不能超过 5MB")
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	ext := map[string]string{"jpeg": ".jpg", "png": ".png", "gif": ".gif", "webp": ".webp"}[format]
	if err != nil || ext == "" || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		httpx.BadRequest(w, "仅支持有效的 JPG / PNG / GIF / WEBP 图片")
		return
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		httpx.BadRequest(w, "图片内容损坏")
		return
	}

	user, err := s.Users.FindByID(r.Context(), claims.UserID)
	if errors.Is(err, store.ErrUserNotFound) {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "upload-avatar/lookup", err)
		return
	}

	if err := os.MkdirAll(s.Cfg.AvatarsDir, 0o755); err != nil {
		httpx.InternalError(w, "upload-avatar/mkdir", err)
		return
	}

	filename := fmt.Sprintf("%d-%d%s", user.ID, time.Now().UnixMilli(), ext)
	dstPath := filepath.Join(s.Cfg.AvatarsDir, filename)
	dst, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		httpx.InternalError(w, "upload-avatar/create", err)
		return
	}
	written, copyErr := io.Copy(dst, bytes.NewReader(data))
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(dstPath)
		httpx.InternalError(w, "upload-avatar/write", errors.Join(copyErr, closeErr))
		return
	}
	if written > avatarMaxBytes {
		_ = os.Remove(dstPath)
		httpx.BadRequest(w, "头像文件不能超过 5MB")
		return
	}

	// 新文件已落盘再删旧文件：反过来一旦新文件写失败，用户就没有头像了。
	s.removeAvatarFile(user.Avatar)

	avatarURL := "/uploads/avatars/" + filename
	updated, err := s.Users.UpdateAvatar(r.Context(), user.ID, &avatarURL)
	if err != nil {
		httpx.InternalError(w, "upload-avatar/save", err)
		return
	}

	httpx.OK(w, map[string]any{
		"success": true,
		"message": "头像更新成功",
		"user":    toUserView(updated),
	})
}

// handleDeleteAvatar 复刻 routes/auth.ts#DELETE /avatar：删文件并置空。
func (s *Server) handleDeleteAvatar(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	if claims.IsGuest() {
		httpx.Forbidden(w, "游客无头像")
		return
	}

	user, err := s.Users.FindByID(r.Context(), claims.UserID)
	if errors.Is(err, store.ErrUserNotFound) {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "delete-avatar/lookup", err)
		return
	}

	s.removeAvatarFile(user.Avatar)

	updated, err := s.Users.UpdateAvatar(r.Context(), user.ID, nil)
	if err != nil {
		httpx.InternalError(w, "delete-avatar/save", err)
		return
	}

	httpx.OK(w, map[string]any{
		"success": true,
		"message": "头像已删除",
		"user":    toUserView(updated),
	})
}

// removeAvatarFile 删除自定义头像文件。
//
// 只处理 /uploads/avatars/ 前缀的路径：root 的默认头像是前端常量
// （/root-avatar.jpg 之类），一旦误删就得靠重装恢复。删除失败不阻断流程。
func (s *Server) removeAvatarFile(avatar *string) {
	if avatar == nil || !strings.HasPrefix(*avatar, "/uploads/avatars/") {
		return
	}
	name := filepath.Base(*avatar)
	if name == "." || name == ".." || name == string(filepath.Separator) {
		return
	}
	_ = os.Remove(filepath.Join(s.Cfg.AvatarsDir, name))
}

// avatarExt 取原始文件名的扩展名，缺失或不合规时退回 .png（与 Node 版一致）。
func avatarExt(originalName string) string {
	ext := strings.ToLower(filepath.Ext(originalName))
	if avatarExtPattern.MatchString(ext) {
		return ext
	}
	return ".png"
}

// passwordStrengthHint 复刻 routes/auth.ts#passwordStrengthHint。
//
// 软提示，不阻断。评分维度：长度 ≥8 / ≥12、小写、大写、数字、特殊字符。
func passwordStrengthHint(password string) string {
	score := 0
	runeLen := len([]rune(password))
	if runeLen >= 8 {
		score++
	}
	if runeLen >= 12 {
		score++
	}
	var lower, upper, digit, special bool
	for _, c := range password {
		switch {
		case c >= 'a' && c <= 'z':
			lower = true
		case c >= 'A' && c <= 'Z':
			upper = true
		case c >= '0' && c <= '9':
			digit = true
		default:
			special = true
		}
	}
	for _, ok := range []bool{lower, upper, digit, special} {
		if ok {
			score++
		}
	}

	switch {
	case score <= 2:
		return "密码强度较弱：建议至少 8 位并混合大小写字母、数字和特殊字符"
	case score == 3:
		return "密码强度一般：加入更多字符类型可提高安全性"
	default:
		return ""
	}
}

// multipartErrorText 把解析错误翻译成用户能看懂的文案。
func multipartErrorText(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "request body too large"):
		return "头像文件不能超过 5MB"
	case strings.Contains(msg, "no multipart boundary"):
		return "请求格式不正确"
	default:
		return "请求格式不正确"
	}
}
