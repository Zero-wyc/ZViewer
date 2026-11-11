package bilibili

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// B站 直播解析。
//
// 与点播解析（resolver.go / playurl.go）完全分开：直播没有 cid / 分 P / 清晰度
// qn 之外的元数据，取流走 api.live.bilibili.com，响应结构也另成一套。
//
// 关键差异（实测 2026-11）：
//   - 直播间地址是 live.bilibili.com/<room_id>（另有 /blanc/、/h5/ 前缀）；
//   - 房间信息 /room/v1/Room/get_info 给出标题、主播 uid、开播状态、封面；
//   - 取流 /xlive/web-room/v2/index/getRoomPlayInfo 同时给 http_stream(flv) 与
//     http_hls(ts/fmp4) 两套，同一清晰度可能只有 HEVC 轨道；
//   - 直播 CDN 强制校验 Referer 为 live.bilibili.com，浏览器直连拿不到数据，
//     必须走服务器代理（前端按 format=flv/hls + bilivideo.com 域名自动走代理）。

// liveAPIBase 是直播开放接口域名。
const liveAPIBase = "https://api.live.bilibili.com"

// liveReferer 是直播接口/CDN 要求的 Referer。
const liveReferer = "https://live.bilibili.com"

// liveRoomPattern 匹配直播间路径。
//
// 只认「路径首段就是房间号」以及 /blanc/、/h5/、/blackboard/ 三个已知前缀。
// 不做「任意数字」兜底：那样 www.bilibili.com/video/123 之类会被误判成直播间。
var liveRoomPattern = regexp.MustCompile(`(?i)^/(?:(?:blanc|h5|blackboard)/)?(\d{1,10})(?:/|$)`)

// LiveRoomID 从直播间链接中提取房间号，无法识别返回 0。
func LiveRoomID(input string) int64 {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return 0
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return 0
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "live.bilibili.com" && !strings.HasSuffix(host, ".live.bilibili.com") {
		return 0
	}
	m := liveRoomPattern.FindStringSubmatch(parsed.Path)
	if len(m) != 2 {
		return 0
	}
	id, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || id <= 0 {
		return 0
	}
	return id
}

// LiveRoomURL 是房间号对应的规范链接。
func LiveRoomURL(roomID int64) string {
	return fmt.Sprintf("https://live.bilibili.com/%d", roomID)
}

// LiveRoom 是直播间基础信息。
type LiveRoom struct {
	RoomID     int64  `json:"roomId"`
	ShortID    int64  `json:"shortId,omitempty"`
	UID        int64  `json:"uid"`
	Title      string `json:"title"`
	Uname      string `json:"uname,omitempty"`
	Cover      string `json:"cover,omitempty"`
	Keyframe   string `json:"keyframe,omitempty"`
	Area       string `json:"area,omitempty"`
	ParentArea string `json:"parentArea,omitempty"`
	// LiveStatus：0=未开播，1=直播中，2=轮播。
	LiveStatus int    `json:"liveStatus"`
	LiveTime   string `json:"liveTime,omitempty"`
	Online     int64  `json:"online,omitempty"`
	Notice     string `json:"notice,omitempty"`
}

// LiveQuality 是一条可用清晰度。
type LiveQuality struct {
	ID    int    `json:"id"`
	Label string `json:"label"`
}

// LiveResolveResult 是一次直播解析结果。
//
// VideoURL 是可直接拉流的地址（FLV 为长连接、HLS 为 m3u8），带 expires
// 签名；未开播时为空。Format 取值 flv / hls，与前端播放引擎选择对齐。
type LiveResolveResult struct {
	Room *LiveRoom
	// Format：flv | hls。
	Format string
	// Protocol：http_stream | http_hls（原始协议名，排障用）。
	Protocol string
	// Codec：avc | hevc（决定浏览器能否硬解）。
	Codec     string
	VideoURL  string
	CurrentQn int
	Qualities []LiveQuality
	// ExpiresAt 是签名过期时间（Unix 秒），解析不到时为 0。
	ExpiresAt int64
}

// 直播响应结构。字段名与接口逐字对应，未使用的字段一律不声明。
type rawLiveRoomInfo struct {
	RoomID      int64  `json:"room_id"`
	ShortID     int64  `json:"short_id"`
	UID         int64  `json:"uid"`
	Title       string `json:"title"`
	LiveStatus  int    `json:"live_status"`
	LiveTime    string `json:"live_time"`
	UserCover   string `json:"user_cover"`
	Keyframe    string `json:"keyframe"`
	Online      int64  `json:"online"`
	AreaName    string `json:"area_name"`
	ParentArea  string `json:"parent_area_name"`
	Description string `json:"description"`
}

type rawLiveMasterInfo struct {
	Info struct {
		UID   int64  `json:"uid"`
		Uname string `json:"uname"`
	} `json:"info"`
}

type rawLivePlayURL struct {
	PlayurlInfo *struct {
		Playurl *struct {
			CurrentQn int64 `json:"current_qn"`
			GQnDesc   []struct {
				Qn   int64  `json:"qn"`
				Desc string `json:"desc"`
			} `json:"g_qn_desc"`
			Stream []struct {
				ProtocolName string `json:"protocol_name"`
				Format       []struct {
					FormatName string `json:"format_name"`
					Codec      []struct {
						CodecName string  `json:"codec_name"`
						CurrentQn int64   `json:"current_qn"`
						AcceptQn  []int64 `json:"accept_qn"`
						BaseURL   string  `json:"base_url"`
						URLInfo   []struct {
							Host  string `json:"host"`
							Extra string `json:"extra"`
						} `json:"url_info"`
					} `json:"codec"`
				} `json:"format"`
			} `json:"stream"`
		} `json:"playurl"`
	} `json:"playurl_info"`
}

// GetLiveRoom 取直播间基础信息（含主播昵称，昵称取不到时回退 uid）。
func (s *Service) GetLiveRoom(ctx context.Context, roomID int64, cookie string) (*LiveRoom, error) {
	apiURL := fmt.Sprintf("%s/room/v1/Room/get_info?room_id=%d", liveAPIBase, roomID)
	env, err := s.Client.Fetch(ctx, apiURL, FetchOptions{
		Cookie:       cookie,
		ExtraHeaders: map[string]string{"Referer": liveReferer},
	})
	if err != nil {
		return nil, fmt.Errorf("获取直播间信息失败: %w", err)
	}
	var raw rawLiveRoomInfo
	if _, err := DecodeDataInto(env, &raw); err != nil {
		return nil, err
	}
	if raw.RoomID == 0 {
		return nil, newResolveError("直播间不存在", "LIVE_ROOM_NOT_FOUND")
	}

	room := &LiveRoom{
		RoomID:     raw.RoomID,
		ShortID:    raw.ShortID,
		UID:        raw.UID,
		Title:      strings.TrimSpace(raw.Title),
		Cover:      raw.UserCover,
		Keyframe:   raw.Keyframe,
		Area:       raw.AreaName,
		ParentArea: raw.ParentArea,
		LiveStatus: raw.LiveStatus,
		LiveTime:   raw.LiveTime,
		Online:     raw.Online,
		Notice:     raw.Description,
	}
	room.Uname = s.liveUname(ctx, raw.UID, cookie)
	return room, nil
}

// liveUname 取主播昵称；失败不影响主流程（标题里已有人能看懂的信息）。
func (s *Service) liveUname(ctx context.Context, uid int64, cookie string) string {
	if uid <= 0 {
		return ""
	}
	apiURL := fmt.Sprintf("%s/live_user/v1/Master/info?uid=%d", liveAPIBase, uid)
	env, err := s.Client.Fetch(ctx, apiURL, FetchOptions{
		Cookie:       cookie,
		ExtraHeaders: map[string]string{"Referer": liveReferer},
	})
	if err != nil {
		return ""
	}
	var raw rawLiveMasterInfo
	if _, err := DecodeDataInto(env, &raw); err != nil {
		return ""
	}
	return strings.TrimSpace(raw.Info.Uname)
}

// liveCandidate 是一条可选流。
type liveCandidate struct {
	protocol string
	format   string
	codec    string
	qn       int
	url      string
}

// liveCandidateRank 越小越优先。
//
// 排序把「浏览器能不能放」放在「清晰度高低」之前：
// FLV+AVC 是唯一在全部桌面浏览器都稳定可播的组合；HEVC 依赖设备解码能力，
// 只能在没有 AVC 轨时兜底（B站 部分直播间只推 HEVC）。
func liveCandidateRank(c liveCandidate) int {
	switch {
	case c.protocol == "http_stream" && c.format == "flv" && c.codec == "avc":
		return 0
	case c.protocol == "http_hls" && c.format == "fmp4" && c.codec == "avc":
		return 1
	case c.protocol == "http_hls" && c.format == "ts" && c.codec == "avc":
		return 2
	case c.codec == "avc":
		return 3
	case c.protocol == "http_stream" && c.format == "flv":
		return 4
	default:
		return 5
	}
}

// ResolveLive 解析直播间取流地址。
//
// qn 为期望清晰度（0 表示交给服务端给最优）；B站 会把超出账号权限的请求
// 降级到允许的最高档，因此实际值以响应里的 current_qn 为准。
func (s *Service) ResolveLive(ctx context.Context, roomID int64, qn int, cookie string) (*LiveResolveResult, error) {
	room, err := s.GetLiveRoom(ctx, roomID, cookie)
	if err != nil {
		return nil, err
	}
	result := &LiveResolveResult{Room: room}
	if room.LiveStatus != 1 {
		// 未开播：不取流（接口此时也只会给空 playurl）。调用方据此提示。
		return result, nil
	}

	playURL, err := s.livePlayURL(ctx, roomID, qn, cookie)
	if err != nil {
		return result, err
	}

	result.Qualities = liveQualityOptions(playURL)
	candidates := liveCandidates(playURL)
	if len(candidates) == 0 {
		return result, newResolveError("直播间暂无可用的播放地址", "LIVE_NO_STREAM")
	}

	best := candidates[0]
	for _, c := range candidates[1:] {
		if liveCandidateRank(c) < liveCandidateRank(best) {
			best = c
			continue
		}
		// 同优先级时取清晰度更高的（qn 已经过降序排列，这里只兜底）。
		if liveCandidateRank(c) == liveCandidateRank(best) && c.qn > best.qn {
			best = c
		}
	}

	result.Format = "hls"
	if best.protocol == "http_stream" && best.format == "flv" {
		result.Format = "flv"
	}
	result.Protocol = best.protocol
	result.Codec = best.codec
	result.VideoURL = best.url
	result.CurrentQn = best.qn
	result.ExpiresAt = liveURLExpiresAt(best.url)
	return result, nil
}

// livePlayURL 请求一次取流接口。
func (s *Service) livePlayURL(ctx context.Context, roomID int64, qn int, cookie string) (*rawLivePlayURL, error) {
	if qn <= 0 {
		qn = 10000
	}
	apiURL := fmt.Sprintf(
		"%s/xlive/web-room/v2/index/getRoomPlayInfo?room_id=%d&protocol=0,1&format=0,1,2&codec=0,1&qn=%d&platform=web&ptype=8",
		liveAPIBase, roomID, qn,
	)
	env, err := s.Client.Fetch(ctx, apiURL, FetchOptions{
		Cookie:       cookie,
		ExtraHeaders: map[string]string{"Referer": liveReferer},
	})
	if err != nil {
		return nil, fmt.Errorf("获取直播流失败: %w", err)
	}
	var raw rawLivePlayURL
	if _, err := DecodeDataInto(env, &raw); err != nil {
		return nil, err
	}
	return &raw, nil
}

// liveQualityOptions 汇总可用清晰度（去重后按 qn 降序）。
func liveQualityOptions(raw *rawLivePlayURL) []LiveQuality {
	if raw == nil || raw.PlayurlInfo == nil || raw.PlayurlInfo.Playurl == nil {
		return nil
	}
	playurl := raw.PlayurlInfo.Playurl
	labels := make(map[int]string, len(playurl.GQnDesc))
	for _, q := range playurl.GQnDesc {
		labels[int(q.Qn)] = strings.TrimSpace(q.Desc)
	}
	accepted := make(map[int]bool)
	for _, stream := range playurl.Stream {
		for _, format := range stream.Format {
			for _, codec := range format.Codec {
				for _, qn := range codec.AcceptQn {
					accepted[int(qn)] = true
				}
				if codec.CurrentQn > 0 {
					accepted[int(codec.CurrentQn)] = true
				}
			}
		}
	}
	out := make([]LiveQuality, 0, len(accepted))
	for qn := range accepted {
		label := labels[qn]
		if label == "" {
			label = fmt.Sprintf("清晰度 %d", qn)
		}
		out = append(out, LiveQuality{ID: qn, Label: label})
	}
	// 降序：原画在前
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID > out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// liveCandidates 展开全部可用流（按 qn 降序）。
func liveCandidates(raw *rawLivePlayURL) []liveCandidate {
	if raw == nil || raw.PlayurlInfo == nil || raw.PlayurlInfo.Playurl == nil {
		return nil
	}
	var out []liveCandidate
	seen := make(map[string]bool)
	for _, stream := range raw.PlayurlInfo.Playurl.Stream {
		for _, format := range stream.Format {
			for _, codec := range format.Codec {
				var full string
				for _, info := range codec.URLInfo {
					if strings.TrimSpace(info.Host) == "" {
						continue
					}
					full = info.Host + codec.BaseURL + info.Extra
					break
				}
				if full == "" {
					continue
				}
				key := stream.ProtocolName + "|" + format.FormatName + "|" + codec.CodecName + "|" + strconv.Itoa(int(codec.CurrentQn))
				if seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, liveCandidate{
					protocol: stream.ProtocolName,
					format:   format.FormatName,
					codec:    codec.CodecName,
					qn:       int(codec.CurrentQn),
					url:      full,
				})
			}
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].qn > out[j-1].qn; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// liveURLExpiresAt 解析签名过期时间（expires / deadline 参数，Unix 秒）。
func liveURLExpiresAt(raw string) int64 {
	parsed, err := url.Parse(raw)
	if err != nil {
		return 0
	}
	query := parsed.Query()
	for _, key := range []string{"expires", "deadline"} {
		if v := query.Get(key); v != "" {
			if ts, err := strconv.ParseInt(v, 10, 64); err == nil && ts > 0 {
				return ts
			}
		}
	}
	return 0
}

// LiveExpired 判断取流地址是否已过期（留 60s 余量，避免播出中途失效）。
func LiveExpired(expiresAt int64, now time.Time) bool {
	if expiresAt <= 0 {
		return false
	}
	return now.Add(60*time.Second).Unix() >= expiresAt
}
