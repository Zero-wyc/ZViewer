// Package jellyfin 是 Jellyfin 挂载的协议适配层。
//
// Jellyfin 曾是 Emby 的开源分支，但 12.0 起两个协议已经不能靠加/减前缀
// 互转（见 https://jellyfin.org/posts/jellyfin-release-12.0）：
//
//   - 移除了 /emby 与 /mediabrowser 路由前缀；
//   - 默认关闭 legacy authorization：X-Emby-Token / api_key 一律 401，
//     只有 Authorization: MediaBrowser 与 ?ApiKey= 仍受支持；
//   - 媒体库与条目列表改用 /UserViews?userId=…、/Items?userId=…，
//     /Users/{id}/Items 与 /Users/{id}/Views 已不存在。
//
// 所以这里声明的是另一套协议，而不是 Emby 的一个开关。
package jellyfin

import (
	"context"
	"strconv"

	"zviewer/backend/internal/mediaapi"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/store"
)

// Protocol 是 Jellyfin 12+ 的协议描述。
var Protocol = mediaapi.Protocol{
	Name:       "jellyfin",
	Label:      "Jellyfin",
	PathPrefix: "",
	TokenQuery: "ApiKey",
	AuthStyle:  mediaapi.AuthMediaBrowser,
	Routes: mediaapi.Routes{
		Login: "/Users/AuthenticateByName",
		Me:    "/Users/Me",
		Users: "/Users",
		Views: func(userID string) (string, []mediaapi.Query) {
			return "/UserViews", []mediaapi.Query{{Key: "userId", Value: userID}}
		},
		Items: func(userID string) (string, []mediaapi.Query) {
			return "/Items", []mediaapi.Query{{Key: "userId", Value: userID}}
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
		HLSManifest: "master.m3u8",
	},
}

// 类型别名：与 Emby 共用同一套 wire DTO。
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

// CodeNoMediaSource 表示上游没有可用媒体源。
const CodeNoMediaSource = mediaapi.CodeNoMediaSource

// NewClient 构造 Jellyfin 客户端。
func NewClient(serverURL, token string) *Client {
	return mediaapi.NewClientWithProtocol(serverURL, token, Protocol)
}

// NewFromMount 按挂载记录构造 Jellyfin 客户端。
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
