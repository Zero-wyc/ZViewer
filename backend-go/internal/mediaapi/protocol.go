package mediaapi

import (
	"net/http"
	"strings"

	"zviewer/backend/internal/netutil"
)

// AuthStyle 决定令牌放在哪个请求头上。
type AuthStyle int

const (
	// AuthEmby 是 Emby 的旧式双头：X-Emby-Authorization 描述客户端标识，
	// X-Emby-Token 单独携带令牌。
	AuthEmby AuthStyle = iota
	// AuthMediaBrowser 是 Jellyfin 12 起唯一受支持的方式：客户端标识与令牌
	// 合并进 Authorization: MediaBrowser 头。X-Emby-Token / X-Emby-Authorization
	// 在 12.0 上会被判 401（legacy authorization 默认关闭）。
	AuthMediaBrowser
)

// Query 是一次请求里的有序 query 参数。
//
// 刻意用切片而不是 url.Values：旧实现的书写顺序被对拍用例逐字节固定，
// 例如 api_key 固定在末尾、static 参数在令牌之前，顺序变了会被判成差异。
type Query struct {
	Key   string
	Value string
}

// Routes 是同一套 wire DTO 下、各协议不同的路径拼装规则。
//
// Jellyfin 12 删掉了 /emby 前缀，同时把 /Users/{id}/Items、/Users/{id}/Views
// 换成了 /Items?userId=… 与 /UserViews?userId=…，所以路径不能靠加前缀解决，
// 必须由各协议自己给出。返回的相对路径由 Protocol.Path 统一补前缀。
type Routes struct {
	Login        string
	Me           string
	Users        string
	Views        func(userID string) (string, []Query)
	Items        func(userID string) (string, []Query)
	Image        func(itemID string) string
	PlaybackInfo func(itemID string) string
	Subtitles    func(itemID, mediaSourceID string, index int, ext string) string
	// HLSManifest 是服务端转码播放列表的文件名（Emby main.m3u8 / Jellyfin master.m3u8）。
	HLSManifest string
}

// Protocol 是一套上游服务的完整协议描述。
//
// 值类型而不是接口：协议差异只有「前缀 + 鉴权 + 路径」三件事，用结构体
// 描述可以让 Emby / Jellyfin 两个适配器互不 import，也不复制请求管线。
type Protocol struct {
	Name       string
	Label      string
	PathPrefix string
	// TokenQuery 是 URL 里携带令牌的参数名（Emby api_key / Jellyfin ApiKey）。
	TokenQuery string
	AuthStyle  AuthStyle
	Routes     Routes
}

// label 是错误文案里的显示名。
func (p Protocol) label() string {
	if p.Label == "" {
		return "Emby"
	}
	return p.Label
}

// Path 给相对路径补上协议前缀。
func (p Protocol) Path(rel string) string {
	return p.PathPrefix + rel
}

// SetAuth 按协议写入鉴权头。token 为空时只写客户端标识（登录请求）。
func (p Protocol) SetAuth(req *http.Request, token string) {
	switch p.AuthStyle {
	case AuthMediaBrowser:
		req.Header.Set("Authorization", authHeaderValue(token))
	default:
		req.Header.Set("X-Emby-Authorization", clientIdentity)
		if token != "" {
			req.Header.Set("X-Emby-Token", token)
		}
	}
}

// UpstreamHeaders 返回代理回源时要带的鉴权头。
//
// 播放代理不走 Client.do，必须把同一套鉴权语义单独给出去，否则 Jellyfin 12
// 会因为只有 X-Emby-Token 而拒绝代理请求。
func (p Protocol) UpstreamHeaders(token string) map[string]string {
	if p.AuthStyle == AuthMediaBrowser {
		return map[string]string{"Authorization": authHeaderValue(token)}
	}
	return map[string]string{"X-Emby-Token": token}
}

// DirectURL 拼「浏览器直连上游」的播放地址。
//
// 直链由 <video>/HLS 引擎直接请求，带不了自定义头，令牌只能走 query，
// 所以这里的参数名必须跟着协议走（api_key 在 Jellyfin 12 上已 401）。
func (p Protocol) DirectURL(
	baseURL, token, itemID string,
	audioTranscode bool,
	extraQuery string,
) string {
	encoded := netutil.EncodeURIComponent(itemID)
	if audioTranscode {
		return baseURL + p.Path("/Videos/"+encoded+"/"+p.Routes.HLSManifest) +
			"?" + p.TokenQuery + "=" + token +
			"&AudioCodec=aac&TranscodingMaxAudioChannels=2" +
			"&VideoBitrate=8000000&AudioBitrate=192000" + extraQuery
	}
	return baseURL + p.Path("/Videos/"+encoded+"/stream") +
		"?static=true&" + p.TokenQuery + "=" + token + extraQuery
}

// authHeaderValue 构造 MediaBrowser 鉴权头值。
//
// Jellyfin 用同一张头承载标识与令牌：Token 段只在有令牌时追加，
// 登录请求必须留空，否则会被当成「拿着无效令牌登录」。
func authHeaderValue(token string) string {
	if token == "" {
		return clientIdentity
	}
	return clientIdentity + `, Token="` + strings.ReplaceAll(token, `"`, "") + `"`
}
