package ncm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// qrLoginPaths 是扫码登录的三个接口。
//
// 它们**必须在无 cookie 的干净上下文里调用**：网易云以请求携带的 cookie
// 判定当前登录态，注入旧凭据（尤其是已过期的 MUSIC_U）会让二维码轮询异常
// （800 循环）导致扫码无效。check 成功（803）响应的 Set-Cookie 仍会正常落库。
var qrLoginPaths = map[string]struct{}{
	"/login/qr/key":    {},
	"/login/qr/create": {},
	"/login/qr/check":  {},
}

// Forward 是 `/api/music/ncm/*` 的通用入口。
//
// rest 是去掉 `/api/music/ncm` 前缀后的剩余路径（含 query，以 "/" 开头）。
// userID 是可选鉴权解出的当前用户（游客为 0）。
func (s *Service) Forward(w http.ResponseWriter, r *http.Request, rest string, userID int64) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		httpx.JSON(w, http.StatusMethodNotAllowed, map[string]any{
			"code": "METHOD_NOT_ALLOWED", "message": "仅支持 GET/POST 转发",
		})
		return
	}

	ncmPath, rawQuery := rest, ""
	if index := strings.IndexByte(rest, '?'); index >= 0 {
		ncmPath, rawQuery = rest[:index], rest[index+1:]
	}
	if !strings.HasPrefix(ncmPath, "/") {
		ncmPath = "/" + ncmPath
	}

	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		query = url.Values{}
	}
	// 客户端传的登录态一律丢弃：cookie 只能由服务端按凭证注入。
	query.Del("cookie")
	query.Del("noCookie")
	p := paramsFromQuery(query)

	if body := readRequestBody(r); body != nil {
		p.mergeBody(body)
	}

	cookieHeader := ""
	var credential *store.NcmCredential
	if _, isQRLogin := qrLoginPaths[ncmPath]; !isQRLogin {
		cred, loadErr := s.LoadCredential(r.Context(), userID)
		if loadErr != nil {
			log.Printf("[ncm] 读取凭证失败: %v", loadErr)
		}
		credential = cred
		cookieHeader = CookieHeaderFor(cred)
	}

	result, err := s.api.call(r.Context(), ncmPath, p, cookieHeader)
	if err != nil {
		writeInvokeError(w, ncmPath, err)
		return
	}

	// 登录态 cookie 变化时持久化（仅正式用户；游客 userId=0 不落库）
	if userID > 0 && len(result.Cookies) > 0 && HasLoginCookies(result.Cookies) {
		existing := []string(nil)
		if credential != nil {
			existing = ParseStoredCookies(credential.Cookies)
		}
		if err := s.persistCookies(r.Context(), userID, MergeCookies(existing, result.Cookies), result.Body); err != nil {
			log.Printf("[ncm] 凭证落库失败: %v", err)
			httpx.JSON(w, http.StatusBadGateway, map[string]any{
				"code": "UPSTREAM_ERROR", "message": "NCM 请求失败",
			})
			return
		}
	}

	httpx.JSON(w, http.StatusOK, result.Body)
}

// CloudUpload 是 `/api/music/cloud/upload`：把 multipart 文件流交给云盘上传链。
func (s *Service) CloudUpload(w http.ResponseWriter, r *http.Request, userID int64) {
	credential, err := s.LoadCredential(r.Context(), userID)
	if err != nil {
		log.Printf("[ncm] 读取凭证失败: %v", err)
	}
	if credential == nil {
		httpx.JSON(w, http.StatusUnauthorized, map[string]any{
			"code": "NCM_NOT_LOGGED_IN", "message": "请先登录网易云账号",
		})
		return
	}
	contentType := r.Header.Get("Content-Type")
	if !strings.Contains(contentType, "multipart/form-data") {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"code": "BAD_REQUEST", "message": "需要 multipart/form-data 上传请求",
		})
		return
	}

	result, err := s.api.upload(r.Context(), CookieHeaderFor(credential), contentType, r.Body)
	if err != nil {
		writeInvokeError(w, "/cloud", err)
		return
	}

	// 上传链路可能刷新登录态 cookie，与通用入口同样落库
	if userID > 0 && len(result.Cookies) > 0 && HasLoginCookies(result.Cookies) {
		existing := ParseStoredCookies(credential.Cookies)
		if err := s.persistCookies(r.Context(), userID, MergeCookies(existing, result.Cookies), result.Body); err != nil {
			log.Printf("[ncm] 凭证落库失败: %v", err)
			httpx.JSON(w, http.StatusBadGateway, map[string]any{
				"code": "UPSTREAM_ERROR", "message": "云盘上传失败",
			})
			return
		}
	}

	httpx.JSON(w, http.StatusOK, result.Body)
}

// Call 按对外路径调一次网易云接口（业务编排层用，如登录状态、音质解析）。
func (s *Service) Call(ctx context.Context, path, cookieHeader string) (*Result, error) {
	ncmPath, p := parseQueryPath(path)
	return s.api.call(ctx, ncmPath, p, cookieHeader)
}

// writeInvokeError 把调用错误翻成对前端稳定的响应形状。
//
// 前端对这三类是有分支的：未知接口看到 404 会走降级、未登录的 401 会提示扫码、
// 其余一律按「网易云不可用」重试，所以码值和文案都要固定。
func writeInvokeError(w http.ResponseWriter, path string, err error) {
	var detail *apiError
	switch {
	case errors.Is(err, unknownPathError):
		httpx.JSON(w, http.StatusNotFound, map[string]any{"code": 404, "message": "接口不存在"})
	case errors.As(err, &detail):
		httpx.JSON(w, detail.Status, map[string]any{"code": detail.Code, "msg": detail.Message})
	default:
		log.Printf("[ncm] 接口调用失败 %s: %v", path, err)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "NCM 请求失败",
		})
	}
}

// PersistCredential 落库凭证并同步账号资料缓存（供 cookie 登录端点复用）。
func (s *Service) PersistCredential(ctx context.Context, userID int64, cookies []string, body any) error {
	return s.persistCookies(ctx, userID, cookies, body)
}

// persistCookies 落库凭证并同步账号资料缓存。
func (s *Service) persistCookies(ctx context.Context, userID int64, cookies []string, body any) error {
	encoded, err := json.Marshal(cookies)
	if err != nil {
		return err
	}
	return s.Creds.Save(ctx, userID, string(encoded), ProfilePatch(ExtractProfile(body)))
}

// ProfilePatch 把 profile 转成落库补丁（nil 字段表示「不改」）。
func ProfilePatch(profile *Profile) store.NcmProfilePatch {
	if profile == nil {
		return store.NcmProfilePatch{}
	}
	return store.NcmProfilePatch{
		Nickname:  profile.Nickname,
		AvatarURL: profile.AvatarURL,
		VIPType:   profile.VIPType,
		VIPStatus: profile.VIPStatus,
	}
}

// readRequestBody 读出 POST body 里的键值（超过 1 MB 的部分截断）。
//
// 只有 POST 才有 body；解析失败或非对象返回 nil，由上游按缺参报错。
func readRequestBody(r *http.Request) map[string]any {
	if r.Method != http.MethodPost || r.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil
	}
	return bodyParams(r.Header.Get("Content-Type"), raw)
}
