package bilibili

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// ErrNoPermission 表示该清晰度/内容无权播放。
var ErrNoPermission = errors.New("无权限播放，可能需要登录或大会员")

// DashMediaTrack 是一条 DASH 轨道。
type DashMediaTrack struct {
	BaseURL   string   `json:"baseUrl"`
	BackupURL []string `json:"backupUrl,omitempty"`
	Bandwidth int64    `json:"bandwidth"`
	Codecs    string   `json:"codecs"`
	ID        int      `json:"id"`
	// Codecid：7=AVC / 12=HEVC / 13=AV1 / 0=音频。
	Codecid   int    `json:"codecid,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	FrameRate string `json:"frameRate,omitempty"`
}

// DurlSegment 是 MP4 直链的一个分段。
type DurlSegment struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	Length int64  `json:"length"`
}

// HDR 类型取值。
const (
	HdrHLG         = "hlg"
	HdrDolbyVision = "dolby-vision"
)

// PlayURLResult 是一次 playurl 解析的归一化结果。
type PlayURLResult struct {
	Format        string           `json:"format"` // dash | mp4
	Video         []DashMediaTrack `json:"video,omitempty"`
	Audio         []DashMediaTrack `json:"audio,omitempty"`
	Durl          []DurlSegment    `json:"durl,omitempty"`
	BestVideo     *DashMediaTrack  `json:"bestVideo,omitempty"`
	BestAudio     *DashMediaTrack  `json:"bestAudio,omitempty"`
	CurrentQn     int              `json:"currentQn,omitempty"`
	AcceptQuality []Quality        `json:"acceptQuality,omitempty"`
	IsHDR         bool             `json:"isHdr,omitempty"`
	HdrType       string           `json:"hdrType,omitempty"`
	VideoCodecid  int              `json:"videoCodecid,omitempty"`
	DolbyAudio    *DashMediaTrack  `json:"dolbyAudio,omitempty"`
}

// rawDashMedia 对应 B站 的轨道结构（兼容 camelCase 与 snake_case）。
type rawDashMedia struct {
	BaseURL    string   `json:"baseUrl"`
	BaseURLAlt string   `json:"base_url"`
	BackupURL  []string `json:"backupUrl"`
	BackupAlt  []string `json:"backup_url"`
	ID         int      `json:"id"`
	Codecs     string   `json:"codecs"`
	Bandwidth  int64    `json:"bandwidth"`
	Codecid    int      `json:"codecid"`
	Width      int      `json:"width"`
	Height     int      `json:"height"`
	FrameRate  string   `json:"frameRate"`
	FrameAlt   string   `json:"frame_rate"`
}

// rawPlayURLData 是 playurl 接口的 data 载荷。
type rawPlayURLData struct {
	Durl []struct {
		URL    string `json:"url"`
		Size   int64  `json:"size"`
		Length int64  `json:"length"`
	} `json:"durl"`
	Dash *struct {
		Video []rawDashMedia `json:"video"`
		Audio []rawDashMedia `json:"audio"`
		Dolby *struct {
			Type  int            `json:"type"`
			Audio []rawDashMedia `json:"audio"`
		} `json:"dolby"`
		Flac *struct {
			Display bool           `json:"display"`
			Audio   []rawDashMedia `json:"audio"`
		} `json:"flac"`
	} `json:"dash"`
	// Quality 用指针：语义是「B站 实际返回的清晰度」，
	// 缺失与 0 是两回事，用零值会把缺失误当成 0。
	Quality       *int  `json:"quality"`
	AcceptQuality []int `json:"accept_quality"`
	// AcceptDescription 实测是**字符串数组**（如 ["高清 1080P+","高清 1080P",...]），
	// 与 accept_quality 按位置一一对应，不是 {qn,desc} 对象数组。
	//
	// Node 版把它声明成对象数组，于是 `d.qn` 恒为 undefined、descMap 从不命中，
	// label 实际一直走 QN_QUALITY_MAP 兜底。Go 版为保持输出逐字段一致，
	// 同样不启用它（见 buildAcceptQuality 注释）；解析上留 RawMessage 以便将来启用。
	AcceptDescription json.RawMessage    `json:"accept_description"`
	SupportFormats    []rawSupportFormat `json:"support_formats"`
}

type rawSupportFormat struct {
	Quality     int      `json:"quality"`
	DisplayDesc string   `json:"display_desc"`
	Superscript string   `json:"superscript"`
	Codecs      []string `json:"codecs"`
}

// GetPlayURLOptions 对应 GetPlayUrlOptions。
type GetPlayURLOptions struct {
	Qn       int
	Codec    string
	IsVip    bool
	Fnval    int // >0 时强制使用（MP4 降级用 fnval=1）
	Platform string
}

// isAvcCodec / isHevcCodec / isAv1Codec 判定编码串前缀。
func isAvcCodec(codecs string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(codecs)), "avc")
}

func isHevcCodec(codecs string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(codecs))
	return strings.HasPrefix(trimmed, "hvc") || strings.HasPrefix(trimmed, "hev")
}

func isAv1Codec(codecs string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(codecs)), "av01")
}

func detectCodec(codecs string) string {
	switch {
	case isAvcCodec(codecs):
		return "avc"
	case isHevcCodec(codecs):
		return "hevc"
	case isAv1Codec(codecs):
		return "av1"
	default:
		return "unknown"
	}
}

func sortByBandwidthDesc(tracks []DashMediaTrack) []DashMediaTrack {
	out := make([]DashMediaTrack, len(tracks))
	copy(out, tracks)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Bandwidth > out[j].Bandwidth })
	return out
}

// sortDashTracks 按编码偏好重排轨道。
//
// auto 时默认优先 H.264：浏览器 / 桌面壳的解码器对 AVC 兼容性最好，
// 选到 HEVC 或 AV1 会出现「有声音没画面」。
func sortDashTracks(tracks []DashMediaTrack, codec string) []DashMediaTrack {
	sorted := sortByBandwidthDesc(tracks)
	if len(sorted) == 0 {
		return sorted
	}
	preferred := codec
	if preferred == "" || preferred == "auto" {
		preferred = "avc"
	}
	matched := make([]DashMediaTrack, 0, len(sorted))
	for _, t := range sorted {
		if detectCodec(t.Codecs) == preferred {
			matched = append(matched, t)
		}
	}
	if len(matched) > 0 {
		return matched
	}
	return sorted
}

// rewriteMcdnPort 去掉 mcdn P2P CDN 的 8082 端口。
// 部分网络环境封 8082，去掉后走默认 443，连通率明显提升。
func rewriteMcdnPort(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if strings.HasSuffix(strings.ToLower(parsed.Hostname()), ".mcdn.bilivideo.cn") && parsed.Port() == "8082" {
		parsed.Host = parsed.Hostname()
		return parsed.String()
	}
	return raw
}

func normalizeDashMedia(track rawDashMedia) DashMediaTrack {
	base := track.BaseURL
	if base == "" {
		base = track.BaseURLAlt
	}
	backups := track.BackupURL
	if len(backups) == 0 {
		backups = track.BackupAlt
	}
	frameRate := track.FrameRate
	if frameRate == "" {
		frameRate = track.FrameAlt
	}
	out := DashMediaTrack{
		BaseURL:   rewriteMcdnPort(base),
		Bandwidth: track.Bandwidth,
		Codecs:    track.Codecs,
		ID:        track.ID,
		Codecid:   track.Codecid,
		Width:     track.Width,
		Height:    track.Height,
		FrameRate: frameRate,
	}
	if len(backups) > 0 {
		out.BackupURL = make([]string, 0, len(backups))
		for _, b := range backups {
			out.BackupURL = append(out.BackupURL, rewriteMcdnPort(b))
		}
	}
	return out
}

// detectHDRType 推断视频轨的 HDR 类型。
func detectHDRType(track *DashMediaTrack, qn int, formats []rawSupportFormat) string {
	if track == nil {
		return ""
	}
	codecs := strings.ToLower(strings.TrimSpace(track.Codecs))
	if qn == QnDolbyVision || strings.HasPrefix(codecs, "dvh") || strings.HasPrefix(codecs, "dva") {
		return HdrDolbyVision
	}
	if qn == QnHDR {
		return HdrHLG
	}
	for _, f := range formats {
		if f.Quality == qn && strings.Contains(strings.ToLower(f.DisplayDesc), "hdr") {
			return HdrHLG
		}
	}
	return ""
}

// buildAcceptQuality 构造清晰度列表。
//
// label 来源刻意保持与 Node 版一致：只用 QN_QUALITY_MAP（"1080P"），
// 不用 accept_description 里的 B站 官方文案（"高清 1080P"）。
// Node 侧因为类型声明写错从未用上那份文案，若 Go 这里"顺手修好"，
// 前端显示的清晰度名会整体变化——迁移期不求改进，先求逐字段可比。
//
// qns 的兜底顺序比 Node 略稳：accept_quality 缺失时用 support_formats，
// 再缺失才用 [currentQn]。Node 那条路径会产出 undefined，属实际不可达的 bug。
func buildAcceptQuality(acceptQuality []int, supportFormats []rawSupportFormat, currentQn int) []Quality {
	var qns []int
	switch {
	case len(acceptQuality) > 0:
		qns = acceptQuality
	case len(supportFormats) > 0:
		qns = make([]int, 0, len(supportFormats))
		for _, f := range supportFormats {
			qns = append(qns, f.Quality)
		}
	default:
		qns = []int{currentQn}
	}

	out := make([]Quality, 0, len(qns))
	for _, qn := range qns {
		fallback, ok := qnQualityMap[qn]
		label := fallback.Label
		if !ok || label == "" {
			label = strconv.Itoa(qn)
		}
		out = append(out, Quality{ID: qn, Label: label, Resolution: fallback.Resolution})
	}
	return out
}

// NormalizePlayURLData 把 playurl 原始载荷归一化为 PlayURLResult。
//
// 三条不能省的规则：
//  1. 用 data.quality（B站 实际返回值）而非请求 qn——B站 会按权限/平台静默降级；
//  2. dash.video 一次性返回所有清晰度，必须按 qn 过滤，否则永远选到最高档；
//  3. currentQn 必须反映实际选中的轨道——低权限时 quality 可能高于真实轨道。
func NormalizePlayURLData(data *rawPlayURLData, requestedQn int, codec string) (*PlayURLResult, error) {
	if data == nil {
		return nil, nil
	}

	qn := DefaultQn
	if data.Quality != nil {
		qn = *data.Quality
	} else if requestedQn > 0 {
		qn = requestedQn
	}

	acceptQuality := buildAcceptQuality(data.AcceptQuality, data.SupportFormats, qn)

	if data.Dash != nil && len(data.Dash.Video) > 0 {
		allTracks := make([]DashMediaTrack, 0, len(data.Dash.Video))
		for _, raw := range data.Dash.Video {
			allTracks = append(allTracks, normalizeDashMedia(raw))
		}
		matched := make([]DashMediaTrack, 0, len(allTracks))
		for _, t := range allTracks {
			if t.ID == qn {
				matched = append(matched, t)
			}
		}
		toSort := allTracks
		if len(matched) > 0 {
			toSort = matched
		}

		video := sortDashTracks(toSort, codec)
		audio := make([]DashMediaTrack, 0, len(data.Dash.Audio))
		if len(data.Dash.Audio) > 0 {
			normalized := make([]DashMediaTrack, 0, len(data.Dash.Audio))
			for _, raw := range data.Dash.Audio {
				normalized = append(normalized, normalizeDashMedia(raw))
			}
			audio = sortByBandwidthDesc(normalized)
		}

		effectiveQn := qn
		if len(matched) == 0 && len(video) > 0 {
			effectiveQn = video[0].ID
		}

		var bestVideo *DashMediaTrack
		if len(video) > 0 {
			bestVideo = &video[0]
		}
		hdrType := detectHDRType(bestVideo, effectiveQn, data.SupportFormats)

		result := &PlayURLResult{
			Format:        "dash",
			Video:         video,
			Audio:         audio,
			BestVideo:     bestVideo,
			CurrentQn:     effectiveQn,
			AcceptQuality: acceptQuality,
			IsHDR:         hdrType != "",
			HdrType:       hdrType,
		}
		if len(audio) > 0 {
			result.BestAudio = &audio[0]
		}
		if bestVideo != nil {
			result.VideoCodecid = bestVideo.Codecid
		}
		if data.Dash.Dolby != nil && len(data.Dash.Dolby.Audio) > 0 {
			dolby := normalizeDashMedia(data.Dash.Dolby.Audio[0])
			result.DolbyAudio = &dolby
		}
		log.Printf("[bilibili-playurl] 请求 qn=%d, B站实际 quality=%d, %d 条轨道, 选定 id=%d codecs=%s",
			requestedQn, qn, len(allTracks), effectiveQn, codecsOf(bestVideo))
		return result, nil
	}

	if len(data.Durl) > 0 {
		segments := make([]DurlSegment, 0, len(data.Durl))
		for _, d := range data.Durl {
			segments = append(segments, DurlSegment{URL: d.URL, Size: d.Size, Length: d.Length})
		}
		return &PlayURLResult{
			Format:        "mp4",
			Durl:          segments,
			CurrentQn:     qn,
			AcceptQuality: acceptQuality,
		}, nil
	}

	return nil, ErrNoPermission
}

func codecsOf(track *DashMediaTrack) string {
	if track == nil {
		return "none"
	}
	return track.Codecs
}

// GetPlayURL 获取播放地址，WBI 接口失败时降级到未签名接口。
func (s *Service) GetPlayURL(ctx context.Context, bvid string, cid int64, cookie string, opts GetPlayURLOptions) (*PlayURLResult, error) {
	result, err := s.getPlayURLWBI(ctx, bvid, cid, cookie, opts)
	if err == nil {
		return result, nil
	}
	if isPermissionError(err) {
		return nil, ErrNoPermission
	}
	log.Printf("[bilibili] WBI playurl 失败，降级到未签名接口: %v", err)
	s.WBI.ClearCache()
	result, legacyErr := s.getPlayURLLegacy(ctx, bvid, cid, cookie, opts)
	if legacyErr != nil {
		if isPermissionError(legacyErr) {
			return nil, ErrNoPermission
		}
		return nil, legacyErr
	}
	return result, nil
}

func (s *Service) playURLParams(bvid string, cid int64, opts GetPlayURLOptions) *Params {
	qn := opts.Qn
	if qn == 0 {
		qn = DefaultQn
	}
	fnval := opts.Fnval
	if fnval <= 0 {
		fnval = ComputeFnval(opts.IsVip, qn, opts.Codec, false)
	}
	params := NewParams().
		Set("bvid", bvid).
		Set("cid", strconv.FormatInt(cid, 10)).
		Set("qn", strconv.Itoa(qn)).
		Set("fnver", "0").
		Set("fnval", strconv.Itoa(fnval)).
		Set("fourk", "1")
	if opts.Platform == "html5" {
		// high_quality=1 配合 platform=html5 请求高画质；
		// try_look=1 是 B站 官方参数，允许未登录用户拉到更高清晰度。
		params.Set("platform", "html5").Set("high_quality", "1").Set("try_look", "1")
	}
	return params
}

func (s *Service) getPlayURLWBI(ctx context.Context, bvid string, cid int64, cookie string, opts GetPlayURLOptions) (*PlayURLResult, error) {
	imgKey, subKey, err := s.WBI.Keys(ctx, cookie)
	if err != nil {
		return nil, err
	}
	qn := opts.Qn
	if qn == 0 {
		qn = DefaultQn
	}
	signed := SignParams(s.playURLParams(bvid, cid, opts), imgKey, subKey)
	env, err := s.Client.Fetch(ctx, "https://api.bilibili.com/x/player/wbi/playurl?"+signed.Encode(),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var data rawPlayURLData
	if _, err := DecodeDataInto(env, &data); err != nil {
		return nil, err
	}
	return NormalizePlayURLData(&data, qn, opts.Codec)
}

func (s *Service) getPlayURLLegacy(ctx context.Context, bvid string, cid int64, cookie string, opts GetPlayURLOptions) (*PlayURLResult, error) {
	qn := opts.Qn
	if qn == 0 {
		qn = DefaultQn
	}
	env, err := s.Client.Fetch(ctx, "https://api.bilibili.com/x/player/playurl?"+s.playURLParams(bvid, cid, opts).Encode(),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var data rawPlayURLData
	if _, err := DecodeDataInto(env, &data); err != nil {
		return nil, err
	}
	return NormalizePlayURLData(&data, qn, opts.Codec)
}

// isPermissionError 判断错误是否属于「权限不足」而非「接口失败」。
//
// -101（账号未登录）必须排除：未登录仍可看 480P 及以下，
// 若误判成权限错误就不会降级到未签名接口，未登录用户彻底无法解析。
func isPermissionError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrNoPermission) {
		return true
	}
	msg := err.Error()
	if strings.Contains(msg, "-101") || strings.Contains(msg, "账号未登录") {
		return false
	}
	for _, keyword := range []string{"大会员", "付费", "无权限", "购买", "权限"} {
		if strings.Contains(msg, keyword) {
			return true
		}
	}
	return strings.Contains(msg, "-10403")
}
