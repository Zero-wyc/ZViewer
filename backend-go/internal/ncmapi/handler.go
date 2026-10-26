package ncmapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// Caller 是上游调用器接口（测试时替换成固定响应桩）。
type Caller interface {
	Do(ctx context.Context, call Call) (*Result, error)
}

// Handler 是 NeteaseCloudMusicApi 的进程内替代实现。
//
// 它被挂在回环 HTTP 上，充当 internal/ncm 的「上游」：路径、参数、响应形状都
// 与那个 Node 服务一致，所以 internal/ncm 的凭证注入、cookie 落库、音质降级、
// 直链缓存全部原样复用。
type Handler struct {
	caller Caller
}

// NewHandler 用真实上游构造 Handler。
func NewHandler() *Handler { return &Handler{caller: NewClient()} }

// NewHandlerWith 用自定义调用器构造（单测用）。
func NewHandlerWith(caller Caller) *Handler { return &Handler{caller: caller} }

// ServeHTTP 实现 http.Handler。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"code": 405, "message": "仅支持 GET/POST"})
		return
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	if path == "" {
		// internal/ncm 的可用性探测打的根路径，必须 200，否则整个音乐域被判离线。
		writeJSON(w, http.StatusOK, map[string]any{"code": 200})
		return
	}

	switch path {
	case "/login/qr/create":
		h.qrCreate(w, r)
		return
	case "/login/qr/key":
		h.qrKey(w, r)
		return
	case "/playlist/track/all":
		h.playlistTrackAll(w, r)
		return
	}

	spec, ok := routes[path]
	if !ok {
		// 兼容 _302 之类的别名（老 SDK 会拼这种后缀要重定向端点）。
		if trimmed := strings.TrimSuffix(path, "_302"); trimmed != path {
			if alias, found := routes[trimmed]; found {
				spec, ok = alias, true
			}
		}
	}
	if !ok {
		log.Printf("[ncmapi] 未知路径: %s", path)
		writeJSON(w, http.StatusNotFound, map[string]any{"code": 404, "message": "接口不存在"})
		return
	}

	apiPath, data := spec.build(newParams(r))
	h.forward(w, r, spec.crypto, apiPath, data)
}

// forward 调一次上游并把结果原样写回（含 Set-Cookie）。
func (h *Handler) forward(w http.ResponseWriter, r *http.Request, mode crypto, apiPath string, data map[string]any) {
	result, err := h.caller.Do(r.Context(), Call{
		Path:   apiPath,
		Crypto: mode,
		Data:   data,
		Cookie: r.Header.Get("Cookie"),
	})
	if err != nil {
		log.Printf("[ncmapi] 上游请求失败 %s: %v", apiPath, err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "message": "上游请求失败"})
		return
	}
	for _, cookie := range result.Cookies {
		w.Header().Add("Set-Cookie", cookie)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if len(result.Body) == 0 {
		_, _ = w.Write([]byte("null"))
		return
	}
	_, _ = w.Write(result.Body)
}

// qrKey 申请扫码 key，并按 Node 版的结构包一层 data。
//
// 上游回的是 {code, unikey}，前端同时兼容顶层与 data 包裹两种形态；这里保留
// 包裹形态是为了与历史上跑过的 Node 服务逐字节一致，便于对拍排障。
func (h *Handler) qrKey(w http.ResponseWriter, r *http.Request) {
	spec := routes["/login/qr/key"]
	apiPath, data := spec.build(newParams(r))
	result, err := h.caller.Do(r.Context(), Call{
		Path:   apiPath,
		Crypto: spec.crypto,
		Data:   data,
		Cookie: r.Header.Get("Cookie"),
	})
	if err != nil {
		log.Printf("[ncmapi] 扫码 key 申请失败: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "message": "上游请求失败"})
		return
	}
	for _, cookie := range result.Cookies {
		w.Header().Add("Set-Cookie", cookie)
	}
	var inner any
	if err := json.Unmarshal(result.Body, &inner); err != nil {
		inner = map[string]any{"code": 200}
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": 200, "data": inner})
}

// qrCreate 生成扫码登录用的二维码（本地生成，不需要上游）。
//
// 与 Node 版一致：qrurl 是网易云登录页地址，qrimg 是 PNG 的 data URL
// （qrimg 参数为真时才生成，省掉无谓的编码开销）。
func (h *Handler) qrCreate(w http.ResponseWriter, r *http.Request) {
	params := newParams(r)
	key := params.S("key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"code": 400, "message": "缺少 key"})
		return
	}
	qrURL := "https://music.163.com/login?codekey=" + key
	if params.S("platform") == "web" {
		qrURL += "&chainId=" + key
	}
	image := ""
	if params.B("qrimg", false) {
		encoded, err := qrcode.Encode(qrURL, qrcode.Medium, 300)
		if err != nil {
			log.Printf("[ncmapi] 二维码生成失败: %v", err)
		} else {
			image = "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 200,
		"data": map[string]any{"qrurl": qrURL, "qrimg": image},
	})
}

// playlistTrackAll 是两段式接口：先取歌单里的 trackIds，再批量取歌曲详情。
//
// 不能只返回 trackIds：前端要的是完整曲目（名字/封面/时长），而网易云的
// 歌单详情为了省带宽只给 id 列表。
func (h *Handler) playlistTrackAll(w http.ResponseWriter, r *http.Request) {
	params := newParams(r)
	id := params.S("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"code": 400, "message": "缺少 id"})
		return
	}
	limit := params.I("limit", 1000)
	offset := params.I("offset", 0)
	cookie := r.Header.Get("Cookie")

	detail, err := h.caller.Do(r.Context(), Call{
		Path:   "/api/v6/playlist/detail",
		Crypto: cryptoEapi,
		Data:   map[string]any{"id": id, "n": 100000, "s": params.I("s", 8)},
		Cookie: cookie,
	})
	if err != nil {
		log.Printf("[ncmapi] 歌单详情失败 %s: %v", id, err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "message": "上游请求失败"})
		return
	}
	ids := playlistTrackIDs(detail.Body)
	if offset >= len(ids) {
		ids = nil
	} else {
		ids = ids[offset:]
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"code": 200, "songs": []any{}})
		return
	}

	result, err := h.caller.Do(r.Context(), Call{
		Path:   "/api/v3/song/detail",
		Crypto: cryptoWeapi,
		Data:   map[string]any{"c": songDetailC(strings.Join(ids, ","))},
		Cookie: cookie,
	})
	if err != nil {
		log.Printf("[ncmapi] 歌单曲目详情失败 %s: %v", id, err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "message": "上游请求失败"})
		return
	}
	for _, value := range result.Cookies {
		w.Header().Add("Set-Cookie", value)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Body)
}

// playlistTrackIDs 从歌单详情响应里抽出 trackIds（保持原顺序）。
func playlistTrackIDs(raw []byte) []string {
	var parsed struct {
		Playlist struct {
			TrackIDs []struct {
				ID json.Number `json:"id"`
			} `json:"trackIds"`
		} `json:"playlist"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	out := make([]string, 0, len(parsed.Playlist.TrackIDs))
	for _, item := range parsed.Playlist.TrackIDs {
		out = append(out, item.ID.String())
	}
	return out
}

// writeJSON 统一输出 JSON。
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("[ncmapi] 响应写入失败: %v", err)
	}
}
