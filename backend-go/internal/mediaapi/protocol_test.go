package mediaapi

import (
	"strconv"

	"zviewer/backend/internal/netutil"
)

// testProtocol 是测试用的 Emby 协议快照。
//
// 真实协议常量在 internal/emby 里；mediaapi 不能反向 import 它（会成环），
// 所以测试里留一份形状相同的定义，用来校验请求管线本身。
var testProtocol = Protocol{
	Name:       "emby-test",
	Label:      "Emby",
	PathPrefix: "/emby",
	TokenQuery: "api_key",
	AuthStyle:  AuthEmby,
	Routes: Routes{
		Login: "/Users/authenticatebyname",
		Me:    "/Users/Me",
		Users: "/Users",
		Views: func(userID string) (string, []Query) {
			return "/Users/" + netutil.EncodeURIComponent(userID) + "/Views", nil
		},
		Items: func(userID string) (string, []Query) {
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
