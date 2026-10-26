package ncm

import (
	"encoding/json"
	"strconv"
	"strings"
)

// route 描述一条对外 REST 路径到网易云上游的映射。
//
// crypto 是通道选择（与 Node 版 createOption 的第二个参数一一对应）；
// build 把入站参数翻成上游路径 + 参数表，值是原始类型（bool/数字/字符串），
// 因为 weapi/eapi 的参数是 JSON 编码的，类型错了上游会判成非法参数。
type route struct {
	crypto crypto
	build  func(p params) (string, map[string]any)
}

// routes 是接口路由表。
//
// 键是去掉 /api/music/ncm 前缀后的路径（与 NeteaseCloudMusicApi 的对外路径
// 完全一致）。新增接口只需在这里加一行，转发层与前端都不用动。
var routes = map[string]route{
	// ── 首页 / 推荐 ───────────────────────────────────────
	"/banner": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		clientType := map[string]string{"0": "pc", "1": "android", "2": "iphone", "3": "ipad"}[p.S("type", "0")]
		if clientType == "" {
			clientType = "pc"
		}
		return "/api/v2/banner/get", map[string]any{"clientType": clientType}
	}},
	"/personalized": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/personalized/playlist", map[string]any{
			"limit": p.I("limit", 30),
			"total": true,
			"n":     1000,
		}
	}},
	"/personalized/newsong": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/personalized/newsong", map[string]any{
			"type":   "recommend",
			"limit":  p.I("limit", 10),
			"areaId": p.I("areaId", 0),
		}
	}},
	"/recommend/songs": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/v3/discovery/recommend/songs", map[string]any{"afresh": p.B("afresh", false)}
	}},
	"/history/recommend/songs": {crypto: cryptoWeapi, build: func(params) (string, map[string]any) {
		return "/api/discovery/recommend/songs/history/recent", map[string]any{}
	}},
	"/history/recommend/songs/detail": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/discovery/recommend/songs/history/detail", map[string]any{"date": p.S("date")}
	}},

	// ── 搜索 ─────────────────────────────────────────────
	"/search": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		// type=2000 是「听歌识曲」，走语音检索通道，参数名也不一样。
		if p.S("type") == "2000" {
			return "/api/search/voice/get", map[string]any{
				"keyword": p.S("keywords"),
				"scene":   "normal",
				"limit":   p.I("limit", 30),
				"offset":  p.I("offset", 0),
			}
		}
		return "/api/search/get", map[string]any{
			"s":      p.S("keywords"),
			"type":   p.I("type", 1),
			"limit":  p.I("limit", 30),
			"offset": p.I("offset", 0),
		}
	}},
	"/cloudsearch": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		return "/api/cloudsearch/pc", map[string]any{
			"s":      p.S("keywords"),
			"type":   p.I("type", 1),
			"limit":  p.I("limit", 30),
			"offset": p.I("offset", 0),
			"total":  true,
		}
	}},
	"/search/suggest": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		kind := "web"
		if p.S("type") == "mobile" {
			kind = "keyword"
		}
		return "/api/search/suggest/" + kind, map[string]any{"s": p.S("keywords")}
	}},
	"/search/suggest/pc": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		return "/api/search/pc/suggest/keyword/get", map[string]any{"keyword": p.S("keyword")}
	}},
	"/search/hot/detail": {crypto: cryptoWeapi, build: func(params) (string, map[string]any) {
		return "/api/hotsearchlist/get", map[string]any{}
	}},

	// ── 歌曲 / 歌词 / 音质 ────────────────────────────────
	"/song/detail": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/v3/song/detail", map[string]any{"c": songDetailC(p.S("ids"))}
	}},
	"/song/url/v1": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		data := map[string]any{
			"ids":        "[" + p.S("id") + "]",
			"level":      p.S("level", "exhigh"),
			"encodeType": p.S("encodeType", "flac"),
		}
		if p.S("level") == "sky" {
			data["immerseType"] = p.S("immerseType", "c51")
		}
		return "/api/song/enhance/player/url/v1", data
	}},
	"/song/url": {crypto: cryptoLinuxapi, build: func(p params) (string, map[string]any) {
		return "/api/song/enhance/player/url", map[string]any{
			"ids": "[" + p.S("id") + "]",
			"br":  p.S("br", "320000"),
		}
	}},
	"/lyric": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		return "/api/song/lyric", map[string]any{
			"id":      p.S("id"),
			"tv":      -1,
			"lv":      -1,
			"rv":      -1,
			"kv":      -1,
			"_nmclfl": 1,
		}
	}},

	// ── 歌单 ─────────────────────────────────────────────
	"/playlist/detail": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		return "/api/v6/playlist/detail", map[string]any{
			"id": p.S("id"),
			"n":  100000,
			"s":  p.I("s", 8),
		}
	}},
	"/playlist/create": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/playlist/create", map[string]any{
			"name":    p.S("name"),
			"privacy": p.S("privacy", "0"),
			"type":    p.S("type", "NORMAL"),
		}
	}},
	"/playlist/tracks": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		// tracks 是逗号分隔的歌曲 id，上游要 JSON 数组字符串。
		ids := strings.FieldsFunc(p.S("tracks"), func(r rune) bool { return r == ',' })
		encoded, err := json.Marshal(ids)
		if err != nil {
			encoded = []byte("[]")
		}
		return "/api/playlist/manipulate/tracks", map[string]any{
			"op":       p.S("op"),
			"pid":      p.S("pid"),
			"trackIds": string(encoded),
			"imme":     "true",
		}
	}},

	// ── 专辑 / 歌手 / MV / 电台 ───────────────────────────
	"/album": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/v1/album/" + p.S("id"), map[string]any{}
	}},
	"/album/new": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/album/new", map[string]any{
			"limit":  p.I("limit", 30),
			"offset": p.I("offset", 0),
			"total":  true,
			"area":   p.S("area", "ALL"),
		}
	}},
	"/album/sublist": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/album/sublist", map[string]any{"limit": p.I("limit", 25), "offset": p.I("offset", 0), "total": true}
	}},
	"/artists": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/v1/artist/" + p.S("id"), map[string]any{}
	}},
	"/artist/sublist": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/artist/sublist", map[string]any{"limit": p.I("limit", 25), "offset": p.I("offset", 0), "total": true}
	}},
	"/top/artists": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/artist/top", map[string]any{"limit": p.I("limit", 50), "offset": p.I("offset", 0), "total": true}
	}},
	"/mv/detail": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/v1/mv/detail", map[string]any{"id": p.S("mvid")}
	}},
	"/mv/sublist": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/cloudvideo/allvideo/sublist", map[string]any{"limit": p.I("limit", 25), "offset": p.I("offset", 0), "total": true}
	}},
	"/dj/sublist": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/djradio/get/subed", map[string]any{"limit": p.I("limit", 30), "offset": p.I("offset", 0), "total": true}
	}},
	"/toplist": {crypto: cryptoEapi, build: func(params) (string, map[string]any) {
		return "/api/toplist", map[string]any{}
	}},

	// ── 评论 ─────────────────────────────────────────────
	"/comment": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/v1/resource/comments/R_SO_4_" + p.S("id"), map[string]any{
			"rid":        p.S("id"),
			"limit":      p.I("limit", 20),
			"offset":     p.I("offset", 0),
			"beforeTime": p.I("before", 0),
		}
	}},
	"/comment/new": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		pageSize := p.I("pageSize", 20)
		pageNo := p.I("pageNo", 1)
		sortType := p.I("sortType", 99)
		if sortType == 1 {
			sortType = 99
		}
		// cursor 的取值规则来自 Node 版：推荐/热度按页码重算，时间排序用透传值。
		cursor := ""
		switch sortType {
		case 99:
			cursor = strconv.Itoa((pageNo - 1) * pageSize)
		case 2:
			cursor = "normalHot#" + strconv.Itoa((pageNo-1)*pageSize)
		case 3:
			cursor = p.S("cursor", "0")
		}
		return "/api/v2/resource/comments", map[string]any{
			"threadId":  threadID(p),
			"pageNo":    pageNo,
			"showInner": p.B("showInner", true),
			"pageSize":  pageSize,
			"cursor":    cursor,
			"sortType":  sortType,
		}
	}},
	"/comment/floor": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/resource/comment/floor/get", map[string]any{
			"parentCommentId": p.S("parentCommentId"),
			"threadId":        threadID(p),
			"time":            p.I("time", -1),
			"limit":           p.I("limit", 20),
		}
	}},
	"/comment/like": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		action := "unlike"
		if p.S("t") == "1" {
			action = "like"
		}
		data := map[string]any{
			"threadId":  threadID(p),
			"commentId": p.S("cid"),
		}
		// 动态（A_EV_2_）没有可拼的 id，前端会直接给 threadId。
		if strings.HasPrefix(data["threadId"].(string), "A_EV_2_") && p.Has("threadId") {
			data["threadId"] = p.S("threadId")
		}
		return "/api/v1/comment/" + action, data
	}},

	// ── 用户 ─────────────────────────────────────────────
	"/user/account": {crypto: cryptoWeapi, build: func(params) (string, map[string]any) {
		return "/api/nuser/account/get", map[string]any{}
	}},
	"/user/subcount": {crypto: cryptoWeapi, build: func(params) (string, map[string]any) {
		return "/api/subcount", map[string]any{}
	}},
	"/user/playlist": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/user/playlist", map[string]any{
			"uid":          p.S("uid"),
			"limit":        p.I("limit", 30),
			"offset":       p.I("offset", 0),
			"includeVideo": true,
		}
	}},
	"/user/cloud": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/v1/cloud/get", map[string]any{"limit": p.I("limit", 30), "offset": p.I("offset", 0)}
	}},
	"/user/cloud/del": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/cloud/del", map[string]any{"songIds": []any{p.S("id")}}
	}},
	"/likelist": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		return "/api/song/like/get", map[string]any{"uid": p.S("uid")}
	}},
	"/like": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/radio/like", map[string]any{
			"alg":     "itembased",
			"trackId": p.S("id"),
			"like":    p.B("like", true),
			"time":    "3",
		}
	}},

	// ── 私人 FM ──────────────────────────────────────────
	"/personal_fm": {crypto: cryptoWeapi, build: func(params) (string, map[string]any) {
		return "/api/v1/radio/get", map[string]any{}
	}},
	"/personal/fm/mode": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		return "/api/v1/radio/get", map[string]any{
			"mode":    p.S("mode"),
			"subMode": p.S("submode"),
			"limit":   p.I("limit", 3),
		}
	}},
	"/fm_trash": {crypto: cryptoWeapi, build: func(p params) (string, map[string]any) {
		return "/api/radio/trash/add", map[string]any{
			"songId": p.S("id"),
			"alg":    "RT",
			"time":   p.I("time", 25),
		}
	}},

	// ── 扫码登录 ─────────────────────────────────────────
	"/login/qr/key": {crypto: cryptoEapi, build: func(params) (string, map[string]any) {
		return "/api/login/qrcode/unikey", map[string]any{"type": qrClientType}
	}},
	"/login/qr/check": {crypto: cryptoEapi, build: func(p params) (string, map[string]any) {
		return "/api/login/qrcode/client/login", map[string]any{"key": p.S("key"), "type": qrClientType}
	}},
}
