// Package emby 是 Emby 挂载的协议适配层。
//
// 传输管线、wire DTO 与播放载荷构建都在 internal/mediaapi；这里只声明
// Emby 的协议差异（/emby 前缀、X-Emby-Token、用户级 Items/Views 路径），
// 与 internal/jellyfin 是互不依赖的兄弟包。
package emby

import (
	"context"
	"strconv"

	"zviewer/backend/internal/mediaapi"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/store"
)

// Protocol 是 Emby 的协议描述。
var Protocol = mediaapi.Protocol{
	Name:       "emby",
	Label:      "Emby",
	PathPrefix: "/emby",
	TokenQuery: "api_key",
	AuthStyle:  mediaapi.AuthEmby,
	Routes: mediaapi.Routes{
		Login: "/Users/authenticatebyname",
		// Emby 没有 /Users/Me：它把路径里的 "Me" 当 GUID 解析，回
		// `500 Unrecognized Guid format.`。留空表示「不要试」，Me() 会
		// 直接走 /Users 回退（这是 API Key 且库里没有 userId 时的兜底）。
		Me:    "",
		Users: "/Users",
		Views: func(userID string) (string, []mediaapi.Query) {
			return "/Users/" + netutil.EncodeURIComponent(userID) + "/Views", nil
		},
		Items: func(userID string) (string, []mediaapi.Query) {
			return "/Users/" + netutil.EncodeURIComponent(userID) + "/Items", nil
		},
		Image: func(itemID string) string {
			return "/Items/" + netutil.EncodeURIComponent(itemID) + "/Images/Primary"
		},
		PlaybackInfo: func(itemID string) string {
			return "/Items/" + netutil.EncodeURIComponent(itemID) + "/PlaybackInfo"
		},
		Subtitles: func(itemID, mediaSourceID string, index int, ext string) string {
			suffix := ""
			if ext != "" {
				suffix = "." + ext
			}
			return "/Videos/" + netutil.EncodeURIComponent(itemID) + "/" +
				netutil.EncodeURIComponent(mediaSourceID) + "/Subtitles/" +
				strconv.Itoa(index) + "/Stream" + suffix
		},
		HLSManifest: "main.m3u8",
	},
}

// 类型别名：调用方不需要在两个协议之间分辨 wire DTO。
type (
	Client        = mediaapi.Client
	Session       = mediaapi.Session
	Error         = mediaapi.Error
	Item          = mediaapi.Item
	MediaSource   = mediaapi.MediaSource
	MediaStream   = mediaapi.MediaStream
	ImageTags     = mediaapi.ImageTags
	ImageResult   = mediaapi.ImageResult
	ResolveParams = mediaapi.ResolveParams
	LoginResult   = mediaapi.LoginResult
	UserInfo      = mediaapi.UserInfo
)

// 旧名别名（历史调用点仍按 Emby 命名引用这些 DTO）。
type (
	EmbyItem        = mediaapi.Item
	EmbyMediaSrc    = mediaapi.MediaSource
	EmbyMediaStream = mediaapi.MediaStream
	EmbyImageTags   = mediaapi.ImageTags
)

// CodeNoMediaSource 表示上游没有可用媒体源。
const CodeNoMediaSource = mediaapi.CodeNoMediaSource

// NewClient 构造 Emby 客户端。
func NewClient(serverURL, token string) *Client {
	return mediaapi.NewClientWithProtocol(serverURL, token, Protocol)
}

// NewFromMount 按挂载记录构造 Emby 客户端。
func NewFromMount(mount *store.Mount) (*Client, error) {
	return mediaapi.NewFromMountWithProtocol(mount, Protocol)
}

// Login 账号密码登录（24h 缓存 + 并发单飞）。
func Login(ctx context.Context, serverURL, username, password string) (*LoginResult, error) {
	return mediaapi.LoginWithProtocol(ctx, Protocol, serverURL, username, password)
}

// ResolveSession 解析挂载会话（token + userId）。
func ResolveSession(ctx context.Context, mount *store.Mount) (*Session, error) {
	return mediaapi.ResolveSessionWithProtocol(ctx, mount, Protocol)
}

// BuildResolvePayload 构建 resolve / movie-source 的统一响应。
func BuildResolvePayload(ctx context.Context, params ResolveParams) (map[string]any, error) {
	return mediaapi.BuildResolvePayload(ctx, params)
}
