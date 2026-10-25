package ncm

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

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

// Forward 是 `/api/music/ncm/*` 的通用转发。
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

	base, ok := s.Available(r.Context())
	if !ok {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"code": "NCM_UNAVAILABLE", "message": "NCM 服务未启动",
		})
		return
	}

	// 拆出路径与查询串（Node 读的是挂载前缀之后的 req.url）
	ncmPath, rawQuery := rest, ""
	if index := strings.IndexByte(rest, '?'); index >= 0 {
		ncmPath, rawQuery = rest[:index], rest[index+1:]
	}
	if !strings.HasPrefix(ncmPath, "/") {
		ncmPath = "/" + ncmPath
	}

	params, err := url.ParseQuery(rawQuery)
	if err != nil {
		params = url.Values{}
	}
	params.Del("cookie")
	params.Del("noCookie")
	// 唯一化 URL 绕过内部服务的 apicache（避免不同登录态共享缓存）
	params.Set("timestamp", strconv.FormatInt(time.Now().UnixMilli(), 10))
	target := base + ncmPath + "?" + params.Encode()

	bodyPayload, err := forwardBody(r)
	if err != nil {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"code": "BAD_REQUEST", "message": "请求体解析失败",
		})
		return
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

	contentType := ""
	if bodyPayload != nil {
		contentType = "application/json"
	}
	result, err := s.Client.Do(r.Context(), r.Method, target, bodyPayload, contentType, cookieHeader)
	if err != nil {
		log.Printf("[ncm] ncm 转发失败: %v", err)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "NCM 服务请求失败",
		})
		return
	}

	// 上游重定向（如 /song/url/v1_302）：不跟随音频直链，以 JSON 回传地址
	if result.Status >= 300 && result.Status < 400 {
		var location any
		if result.Location != "" {
			location = result.Location
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"code": "REDIRECT", "location": location})
		return
	}

	if !result.Parsed {
		log.Printf("[ncm] ncm 转发响应非 JSON: %s %s → %d", r.Method, ncmPath, result.Status)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "NCM 服务返回了无法解析的响应",
		})
		return
	}

	// 登录态 cookie 变化时持久化（仅正式用户；游客 userId=0 不落库）
	if userID > 0 && len(result.SetCookies) > 0 && HasLoginCookies(result.SetCookies) {
		existing := []string(nil)
		if credential != nil {
			existing = ParseStoredCookies(credential.Cookies)
		}
		if err := s.persistCookies(r.Context(), userID, MergeCookies(existing, result.SetCookies), result.Body); err != nil {
			log.Printf("[ncm] 凭证落库失败: %v", err)
			httpx.JSON(w, http.StatusBadGateway, map[string]any{
				"code": "UPSTREAM_ERROR", "message": "NCM 服务请求失败",
			})
			return
		}
	}

	httpx.JSON(w, result.Status, result.Body)
}

// CloudUpload 是 `/api/music/cloud/upload`：multipart 原样流式转发到内部 /cloud。
//
// 通用转发把 POST body 当 JSON，承载不了文件；这里保持原始 multipart
// （边界原样透传），并注入当前用户 cookie。
func (s *Service) CloudUpload(w http.ResponseWriter, r *http.Request, userID int64) {
	base, ok := s.Available(r.Context())
	if !ok {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"code": "NCM_UNAVAILABLE", "message": "NCM 服务未启动",
		})
		return
	}
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

	target := base + "/cloud?timestamp=" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, r.Body)
	if err != nil {
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "云盘上传请求失败",
		})
		return
	}
	// 有 Content-Length 就带上：multipart 上游（网易云）对分块传输未必友好
	if r.ContentLength > 0 {
		req.ContentLength = r.ContentLength
	}
	req.Header.Set("Cookie", CookieHeaderFor(credential))
	req.Header.Set("Content-Type", contentType)

	upstream, err := s.Client.HTTP.Do(req)
	if err != nil {
		log.Printf("[ncm] 云盘上传转发失败: %v", err)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "云盘上传请求失败",
		})
		return
	}
	defer upstream.Body.Close()

	result, err := DecodeUpstream(upstream)
	if err != nil {
		log.Printf("[ncm] 云盘上传响应读取失败: %v", err)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "云盘上传请求失败",
		})
		return
	}
	if !result.Parsed {
		log.Printf("[ncm] 云盘上传响应非 JSON: %d", result.Status)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "NCM 服务返回了无法解析的响应",
		})
		return
	}

	// 上传链路可能刷新登录态 cookie，同通用转发逻辑持久化
	if userID > 0 && len(result.SetCookies) > 0 && HasLoginCookies(result.SetCookies) {
		existing := ParseStoredCookies(credential.Cookies)
		if err := s.persistCookies(r.Context(), userID, MergeCookies(existing, result.SetCookies), result.Body); err != nil {
			log.Printf("[ncm] 凭证落库失败: %v", err)
			httpx.JSON(w, http.StatusBadGateway, map[string]any{
				"code": "UPSTREAM_ERROR", "message": "云盘上传请求失败",
			})
			return
		}
	}

	httpx.JSON(w, result.Status, result.Body)
}

// PersistCredential 落库凭证并同步账号资料缓存（供 cookie 登录端点复用）。
func (s *Service) PersistCredential(ctx context.Context, userID int64, cookies []string, body any) error {
	return s.persistCookies(ctx, userID, cookies, body)
}

// persistCookies 落库凭证并同步账号资料缓存。
func (s *Service) persistCookies(ctx context.Context, userID int64, cookies []string, body any) error {
	profile := ExtractProfile(body)
	patch := ProfilePatch(profile)
	encoded, err := json.Marshal(cookies)
	if err != nil {
		return err
	}
	return s.Creds.Save(ctx, userID, string(encoded), patch)
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

// forwardBody 把 POST body 规整成要转发的字节串。
//
// 与 Node 一致：对象形态剥掉 client 传的 cookie/noCookie（否则客户端能用
// body 覆盖服务端注入的登录态）；数组/标量原样透传；空 body 返回 nil（不发）。
func forwardBody(r *http.Request) ([]byte, error) {
	if r.Method != http.MethodPost || r.Body == nil {
		return nil, nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// Node 侧 express.json 会先 400；这里退化成原样透传，由上游决定
		return raw, nil
	}
	object, isObject := parsed.(map[string]any)
	if !isObject {
		return raw, nil
	}
	delete(object, "cookie")
	delete(object, "noCookie")
	return json.Marshal(object)
}
