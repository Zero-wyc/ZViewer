package ncm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// Result 是一次网易云接口调用的结果。
type Result struct {
	// Body 是解析后的 JSON（上游返回空时为 nil）。
	Body any
	// Cookies 是原始 Set-Cookie 列表，供凭证落库。
	Cookies []string
}

// apiError 是带 HTTP 状态码的调用错误（路由层据此决定响应码）。
type apiError struct {
	Status  int
	Code    any
	Message string
}

func (e *apiError) Error() string { return e.Message }

// unknownPathError 表示这个路径没有对应的网易云接口。
var unknownPathError = errors.New("接口不存在")

// caller 执行一次真实上游调用（单测替换成固定响应桩）。
type caller interface {
	Do(ctx context.Context, call Call) (*upstreamResult, error)
}

// api 是网易云接口分发器：把对外 REST 路径翻成真实上游调用。
//
// 它是 NeteaseCloudMusicApi 那套 HTTP 方言的进程内等价物——路径、参数、响应
// 形状都保持一致，所以前端那 44 条调用与业务编排层都不用感知上游实现。
type api struct {
	client caller
	// nos 只用于云盘上传：文件本体传到网易对象存储（不走 music.163.com），
	// 需要更长的超时与独立的连接池。
	nos *http.Client
}

// newAPI 构造分发器。
func newAPI() *api { return &api{client: NewClient(), nos: newNOSClient()} }

// newAPIWith 用自定义上游调用器构造（单测用）。
func newAPIWith(client caller) *api { return &api{client: client, nos: newNOSClient()} }

// newNOSClient 是传文件用的客户端：不设整体超时（由请求 context 控制），
// 但连接与响应头必须有上限。
func newNOSClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	transport.TLSHandshakeTimeout = 15 * time.Second
	return &http.Client{Transport: transport}
}

// call 执行一次路径分发。
//
// 少数接口不是「拼个上游路径」那么简单（扫码二维码本地生成、歌单曲目两段式
// 取数），先在这里拦下来，其余全部交给路由表。
func (a *api) call(ctx context.Context, path string, p params, cookie string) (*Result, error) {
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		return &Result{Body: map[string]any{"code": 200}}, nil
	}
	switch path {
	case "/login/qr/key":
		return a.qrKey(ctx, p, cookie)
	case "/login/qr/create":
		return qrCreate(p), nil
	case "/playlist/track/all":
		return a.playlistTrackAll(ctx, p, cookie)
	}

	spec, ok := routes[path]
	if !ok {
		// 老 SDK 会拼 `_302` 后缀要重定向端点，去掉后按同名路由处理。
		if trimmed := strings.TrimSuffix(path, "_302"); trimmed != path {
			spec, ok = routes[trimmed]
		}
	}
	if !ok {
		log.Printf("[ncm] 未知接口路径: %s", path)
		return nil, unknownPathError
	}
	apiPath, data := spec.build(p)
	return a.forward(ctx, spec.crypto, apiPath, data, cookie)
}

// forward 调一次上游并解析成 JSON。
func (a *api) forward(ctx context.Context, mode crypto, apiPath string, data map[string]any, cookie string) (*Result, error) {
	result, err := a.client.Do(ctx, Call{Path: apiPath, Crypto: mode, Data: data, Cookie: cookie})
	if err != nil {
		return nil, err
	}
	return decodeResult(result)
}

// decodeResult 把上游原始字节解成 JSON（空响应视为 null）。
func decodeResult(result *upstreamResult) (*Result, error) {
	out := &Result{Cookies: result.Cookies}
	if len(result.Body) == 0 {
		return out, nil
	}
	var parsed any
	if err := json.Unmarshal(result.Body, &parsed); err != nil {
		return nil, errors.New("上游返回了无法解析的响应")
	}
	out.Body = parsed
	return out, nil
}

// qrKey 申请扫码 key，并按历史 Node 服务的形状包一层 data。
//
// 上游回的是 {code, unikey}，前端同时兼容顶层与 data 包裹两种形态；这里保留
// 包裹形态是为了与跑过的 Node 服务一致，便于排障时对照。
func (a *api) qrKey(ctx context.Context, p params, cookie string) (*Result, error) {
	spec := routes["/login/qr/key"]
	apiPath, data := spec.build(p)
	result, err := a.forward(ctx, spec.crypto, apiPath, data, cookie)
	if err != nil {
		return nil, err
	}
	inner := result.Body
	if inner == nil {
		inner = map[string]any{"code": 200}
	}
	return &Result{
		Body:    map[string]any{"code": 200, "data": inner},
		Cookies: result.Cookies,
	}, nil
}

// qrCreate 生成扫码登录用的二维码（本地生成，不请求上游）。
//
// 与 Node 版一致：qrurl 是网易云登录页地址，qrimg 是 PNG 的 data URL
// （qrimg 为真时才生成，省掉无谓的编码开销）。
func qrCreate(p params) *Result {
	key := p.S("key")
	if key == "" {
		return &Result{Body: map[string]any{"code": 400, "message": "缺少 key"}}
	}
	qrURL := "https://music.163.com/login?codekey=" + key
	if p.S("platform") == "web" {
		qrURL += "&chainId=" + key
	}
	image := ""
	if p.B("qrimg", false) {
		encoded, err := qrcode.Encode(qrURL, qrcode.Medium, 300)
		if err != nil {
			log.Printf("[ncm] 二维码生成失败: %v", err)
		} else {
			image = "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded)
		}
	}
	return &Result{Body: map[string]any{
		"code": 200,
		"data": map[string]any{"qrurl": qrURL, "qrimg": image},
	}}
}

// playlistTrackAll 是两段式接口：先取歌单里的 trackIds，再批量取歌曲详情。
//
// 不能只返回 trackIds：前端要的是完整曲目（名字/封面/时长），而网易云的
// 歌单详情为了省带宽只给 id 列表。
func (a *api) playlistTrackAll(ctx context.Context, p params, cookie string) (*Result, error) {
	id := p.S("id")
	if id == "" {
		return &Result{Body: map[string]any{"code": 400, "message": "缺少 id"}}, nil
	}
	detail, err := a.forward(ctx, cryptoEapi, "/api/v6/playlist/detail", map[string]any{
		"id": id,
		"n":  100000,
		"s":  p.I("s", 8),
	}, cookie)
	if err != nil {
		return nil, err
	}
	ids := playlistTrackIDs(detail.Body)
	offset := p.I("offset", 0)
	limit := p.I("limit", 1000)
	if offset >= len(ids) {
		ids = nil
	} else {
		ids = ids[offset:]
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}
	if len(ids) == 0 {
		return &Result{Body: map[string]any{"code": 200, "songs": []any{}}}, nil
	}
	songs, err := a.forward(ctx, cryptoWeapi, "/api/v3/song/detail", map[string]any{
		"c": songDetailC(strings.Join(ids, ",")),
	}, cookie)
	if err != nil {
		return nil, err
	}
	songs.Cookies = append(detail.Cookies, songs.Cookies...)
	return songs, nil
}

// playlistTrackIDs 从歌单详情响应里抽出 trackIds（保持原顺序）。
func playlistTrackIDs(body any) []string {
	root, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	playlist, ok := root["playlist"].(map[string]any)
	if !ok {
		return nil
	}
	raw, ok := playlist["trackIds"].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		switch value := entry["id"].(type) {
		case float64:
			out = append(out, fmt.Sprintf("%.0f", value))
		case string:
			out = append(out, value)
		}
	}
	return out
}
