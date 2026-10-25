package bilibili

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MP4MaxQn 是 B站 MP4 直链能达到的最高清晰度（720P）。
//
// 实测：无论是否会员、**是否登录**，fnval=1 + platform=html5 最高只给 720P；
// 1080P+/4K/HDR/8K 仅 DASH 支持。这是服务端硬限制，无法用参数绕过。
// 注意「未登录也能到 720P」——所以匿名场景绝不能沿用 DASH 的上限 32（480P）：
// 目标视频没有 480P 档时，要 qn=32 会直接落到 360P。取值统一走 Mp4TargetQn。
const MP4MaxQn = 64

// ResolveProgress 是一条解析进度事件。
type ResolveProgress struct {
	Status  string `json:"status"`
	Step    string `json:"step,omitempty"`
	Message string `json:"message,omitempty"`
}

// ResolveOptions 对应 resolver.ts 的 ResolveOptions。
type ResolveOptions struct {
	URL string
	// Cookie 由上层从 credential 取出后传入，本包不直接查库（除非用 ResolveForUser）。
	Cookie string
	Qn     int
	Codec  string
	// OnProgress 为进度回调，供 NDJSON 流式输出。
	OnProgress   func(ResolveProgress)
	PreferMp4    bool
	Page         int
	Cid          int64
	SkipCdnCheck bool
	ForceDash    bool
}

// ResolvePageInfo 是给前端的分集信息。
type ResolvePageInfo struct {
	Page     int    `json:"page"`
	Cid      int64  `json:"cid"`
	Part     string `json:"part"`
	Duration int    `json:"duration"`
	// EpID / Badge 仅 PGC 有；切集时必须按 ep 链接重解析。
	EpID  int64  `json:"epId,omitempty"`
	Badge string `json:"badge,omitempty"`
}

// ResolveResult 是最终解析结果，字段名与前端约定逐字对齐。
type ResolveResult struct {
	Title         string            `json:"title"`
	Duration      int               `json:"duration"`
	Cid           int64             `json:"cid"`
	VideoURL      string            `json:"videoUrl"`
	AudioURL      string            `json:"audioUrl,omitempty"`
	VideoCodec    string            `json:"videoCodec,omitempty"`
	AudioCodec    string            `json:"audioCodec,omitempty"`
	Format        string            `json:"format"`
	LoggedIn      bool              `json:"loggedIn"`
	VipStatus     int               `json:"vipStatus"`
	CurrentQn     int               `json:"currentQn,omitempty"`
	AcceptQuality []Quality         `json:"acceptQuality,omitempty"`
	IsHDR         bool              `json:"isHdr,omitempty"`
	HdrType       string            `json:"hdrType,omitempty"`
	VideoCodecid  int               `json:"videoCodecid,omitempty"`
	Pages         []ResolvePageInfo `json:"pages,omitempty"`
	CurrentPage   int               `json:"currentPage,omitempty"`
	ResolvedURL   string            `json:"resolvedUrl"`
	EpID          int64             `json:"epId,omitempty"`
	SeasonID      int64             `json:"seasonId,omitempty"`
	SeasonTitle   string            `json:"seasonTitle,omitempty"`
	Preview       bool              `json:"preview,omitempty"`
}

// ResolveError 是归一化的解析错误，Code 供前端分流提示文案。
type ResolveError struct {
	Code    string
	Message string
}

func (e *ResolveError) Error() string { return e.Message }

func newResolveError(message, code string) *ResolveError {
	return &ResolveError{Code: code, Message: message}
}

// 识别 BV / av 号的正则。
var (
	bvPattern   = regexp.MustCompile(`BV[0-9A-Za-z]{10}`)
	avPattern   = regexp.MustCompile(`(?i)av(\d+)`)
	avAnywhere  = regexp.MustCompile(`(?i)av\d+`)
	bangumiPath = regexp.MustCompile(`(?i)bangumi/play/(ep|ss)(\d+)`)
	bareEp      = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])ep(\d+)`)
	bareSs      = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])ss(\d+)`)
)

// ExtractBvid 从任意输入提取 BV 号；av 号返回其数字部分。
func ExtractBvid(input string) string {
	if m := bvPattern.FindString(input); m != "" {
		return m
	}
	if m := avPattern.FindStringSubmatch(input); len(m) == 2 {
		return m[1]
	}
	return ""
}

// BangumiID 是番剧标识（ep 集号或 ss 季号）。
type BangumiID struct {
	EpID     int64
	SeasonID int64
}

// ExtractBangumiID 提取番剧/影视标识。
//
// 识别顺序固定：先 BV/av，再 ep/ss。反过来的话，标题里带 "ep1" 的普通视频
// 会被当番剧解析。裸 ep/ss 还要求前面不是字母数字，排除 step1 / sleep2 这类误匹配。
func ExtractBangumiID(input string) *BangumiID {
	if m := bangumiPath.FindStringSubmatch(input); len(m) == 3 {
		id, _ := strconv.ParseInt(m[2], 10, 64)
		if strings.EqualFold(m[1], "ep") {
			return &BangumiID{EpID: id}
		}
		return &BangumiID{SeasonID: id}
	}
	if ExtractBvid(input) != "" || avAnywhere.MatchString(input) {
		return nil
	}
	if m := bareEp.FindStringSubmatch(input); len(m) == 2 {
		id, _ := strconv.ParseInt(m[1], 10, 64)
		return &BangumiID{EpID: id}
	}
	if m := bareSs.FindStringSubmatch(input); len(m) == 2 {
		id, _ := strconv.ParseInt(m[1], 10, 64)
		return &BangumiID{SeasonID: id}
	}
	return nil
}

// shortLinkHosts 是 B站 短链域名（host 精确匹配）。
var shortLinkHosts = map[string]bool{"b23.tv": true, "bili2233.cn": true}

// shortLinkClient 专门用于短链展开，带 8s 上限。
var shortLinkClient = &http.Client{Timeout: 8 * time.Second}

// ExpandShortLink 把 b23.tv 等短链展开为完整视频地址。
//
// 展开失败一律原样返回：短链服务抖动不该把一次正常解析放大成失败，
// 后续流程会按原始地址报出更准确的错误。
func ExpandShortLink(ctx context.Context, input string) string {
	parsed, err := url.Parse(input)
	if err != nil {
		return input
	}
	if !shortLinkHosts[strings.ToLower(parsed.Hostname())] {
		return input
	}

	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return input
	}
	req.Header.Set("User-Agent", defaultUserAgent)

	resp, err := shortLinkClient.Do(req)
	if err != nil {
		log.Printf("[bilibili-resolver] 短链展开失败，使用原地址继续: %v", err)
		return input
	}
	// 只关心重定向后的最终地址，立刻释放响应体（不需要页面内容）。
	resp.Body.Close()

	final := resp.Request.URL.String()
	if strings.HasPrefix(final, "http://") || strings.HasPrefix(final, "https://") {
		log.Printf("[bilibili-resolver] 短链已展开: %s -> %s", input, final)
		return final
	}
	return input
}

// emit 构造进度回调（UGC / PGC 共用同一事件结构）。
func (o *ResolveOptions) emit(step, message string) {
	if o.OnProgress != nil {
		o.OnProgress(ResolveProgress{Status: "parsing", Step: step, Message: message})
	}
}

// fetchVideoInfo 取视频信息（带 2 分钟缓存），并把业务错误转成友好文案。
func (s *Service) fetchVideoInfo(ctx context.Context, bvid, cookie string) (*VideoInfo, error) {
	if cached, ok := s.Caches.GetVideoInfo(bvid); ok {
		log.Printf("[bilibili-resolver] video info served from cache: %s", bvid)
		return &cached, nil
	}
	info, err := s.GetVideoInfo(ctx, bvid, cookie)
	if err != nil {
		msg := err.Error()
		switch {
		case strings.Contains(msg, "[-404]"):
			return nil, newResolveError(
				fmt.Sprintf("视频不存在或已被删除（%s），请检查 BV 号是否正确", bvid),
				"VIDEO_NOT_FOUND")
		case strings.Contains(msg, "[-101]"):
			return nil, newResolveError("B站账号未登录或登录已过期，请重新扫码登录", "NOT_LOGGED_IN")
		case strings.Contains(msg, "[-403]"), strings.Contains(msg, "[-514]"):
			return nil, newResolveError("无权限访问该视频，可能为会员专享或地区限制", "NO_PERMISSION")
		default:
			return nil, newResolveError("获取视频信息失败: "+msg, "INFO_FAILED")
		}
	}
	if info == nil {
		return nil, newResolveError("获取视频信息失败", "INFO_FAILED")
	}
	s.Caches.SetVideoInfo(bvid, *info)
	return info, nil
}

// currentPageDuration 返回当前播放分集的时长。
//
// 多 P 视频的 info.duration 是「所有 P 的总时长」，用它会让 MPD 的
// mediaPresentationDuration 远超实际文件，dash.js seek 到超出范围的位置
// 永远拿不到 segment。
func currentPageDuration(info *VideoInfo, cid int64) int {
	if len(info.Pages) == 0 {
		return info.Duration
	}
	target := cid
	if target == 0 {
		target = info.Cid
	}
	for _, p := range info.Pages {
		if p.Cid == target {
			return p.Duration
		}
	}
	return info.Pages[0].Duration
}

// narrowAcceptQualityForMP4 把清晰度列表收窄到 MP4 能给的档位。
func narrowAcceptQualityForMP4(list []Quality) []Quality {
	filtered := make([]Quality, 0, len(list))
	for _, q := range list {
		if q.ID <= MP4MaxQn {
			filtered = append(filtered, q)
		}
	}
	if len(filtered) > 0 {
		return filtered
	}
	// 兜底：MP4 至少支持 480P/360P
	return []Quality{
		{ID: 32, Label: qnQualityMap[32].Label, Resolution: "854x480"},
		{ID: 16, Label: qnQualityMap[16].Label, Resolution: "640x360"},
	}
}

// selectDashSources 为音视频轨选可达地址。
func selectDashSources(ctx context.Context, playURL *PlayURLResult, skipCdnCheck bool) (videoURL, audioURL string) {
	if playURL.BestVideo == nil {
		return "", ""
	}
	if skipCdnCheck {
		videoURL = UpgradeURLToHTTPS(playURL.BestVideo.BaseURL)
		if playURL.BestAudio != nil {
			audioURL = UpgradeURLToHTTPS(playURL.BestAudio.BaseURL)
		}
		return videoURL, audioURL
	}

	type probe struct {
		kind string
		url  string
		ok   bool
	}
	ch := make(chan probe, 2)
	go func() {
		u, ok := FindReachableMediaURL(ctx, MediaTrackCandidate{
			BaseURL: playURL.BestVideo.BaseURL, BackupURL: playURL.BestVideo.BackupURL})
		ch <- probe{kind: "video", url: u, ok: ok}
	}()
	if playURL.BestAudio != nil {
		go func() {
			u, ok := FindReachableMediaURL(ctx, MediaTrackCandidate{
				BaseURL: playURL.BestAudio.BaseURL, BackupURL: playURL.BestAudio.BackupURL})
			ch <- probe{kind: "audio", url: u, ok: ok}
		}()
	} else {
		ch <- probe{kind: "audio"}
	}

	for i := 0; i < 2; i++ {
		res := <-ch
		if res.kind == "video" {
			videoURL = res.url
			if !res.ok {
				videoURL = ""
			}
		} else {
			audioURL = res.url
		}
	}
	return videoURL, audioURL
}

// cdnUnreachable 是「所有媒体 CDN 都连不上」的统一错误。
func cdnUnreachable() *ResolveError {
	return newResolveError("当前网络无法访问 B站 媒体服务器，请稍后重试", "CDN_UNREACHABLE")
}

// fallbackToMP4 用 HTML5 播放器接口取无防盗链 MP4 直链（DASH 全不可达时的退路）。
func (s *Service) fallbackToMP4(
	ctx context.Context, bvid string, cid int64, cookie string,
	qn int, isVip, skipCdnCheck bool,
) (*PlayURLResult, string, error) {
	mp4, err := s.GetPlayURL(ctx, bvid, cid, cookie, GetPlayURLOptions{
		Qn:       qn,
		Fnval:    fnvalMP4,
		IsVip:    isVip,
		Platform: "html5",
	})
	if err != nil {
		return nil, "", err
	}
	if mp4 == nil || mp4.Format != "mp4" || len(mp4.Durl) == 0 || mp4.Durl[0].URL == "" {
		return nil, "", nil
	}
	httpsURL := UpgradeURLToHTTPS(mp4.Durl[0].URL)
	if skipCdnCheck {
		return mp4, httpsURL, nil
	}
	if reachable, ok := FindReachableMediaURL(ctx, MediaTrackCandidate{BaseURL: mp4.Durl[0].URL}); ok {
		return mp4, reachable, nil
	}
	// HEAD 全失败仍回退原 URL：部分 CDN 对 HEAD 返回 403 但对 GET 正常，
	// 此时不该拒绝解析——让浏览器自己试，比直接报错更合理。
	log.Printf("[bilibili-mp4] HEAD 检测全部失败，回退到原始 URL: %s", httpsURL)
	return mp4, httpsURL, nil
}

// Resolve 编排完整解析流程（UGC + PGC）。
func (s *Service) Resolve(ctx context.Context, opts ResolveOptions) (*ResolveResult, error) {
	expanded := ExpandShortLink(ctx, opts.URL)

	bvid := ExtractBvid(expanded)
	var bangumiID *BangumiID
	if bvid == "" {
		bangumiID = ExtractBangumiID(expanded)
	}
	if bvid == "" && bangumiID == nil {
		return nil, newResolveError("无法解析 B站 视频/番剧链接", "INVALID_INPUT")
	}
	if bangumiID != nil {
		return s.resolvePGC(ctx, opts, *bangumiID, expanded)
	}
	return s.resolveUGC(ctx, opts, bvid, expanded)
}

// ==================== UGC 解析 ====================

func (s *Service) resolveUGC(ctx context.Context, opts ResolveOptions, bvid, expandedURL string) (*ResolveResult, error) {
	// 短链 / 分享链接常带 ?p=N，未显式指定 page 时作为默认分集。
	effectivePage := opts.Page
	if parsed, err := url.Parse(expandedURL); err == nil {
		if p, err := strconv.Atoi(parsed.Query().Get("p")); err == nil && p > 0 && effectivePage == 0 {
			effectivePage = p
		}
	}

	if opts.Cookie == "" {
		opts.emit("vip", "正在准备匿名会话...")
		s.Client.EnsureAnonymousSession(ctx)
	}

	// VIP 校验与视频信息并行：两者无依赖，串行等于白送一个 RTT。
	opts.emit("vip", "正在检查大会员状态...")
	type infoResult struct {
		info *VideoInfo
		err  error
	}
	infoCh := make(chan infoResult, 1)
	go func() {
		opts.emit("info", "正在解析视频信息...")
		info, err := s.fetchVideoInfo(ctx, bvid, opts.Cookie)
		infoCh <- infoResult{info: info, err: err}
	}()
	isVip := s.GetVipStatus(ctx, opts.Cookie)
	infoRes := <-infoCh
	if infoRes.err != nil {
		return nil, infoRes.err
	}
	info := infoRes.info

	effectiveCid := info.Cid
	currentPage := 1
	switch {
	case effectivePage > 0 && len(info.Pages) > 0:
		idx := effectivePage - 1
		if idx >= len(info.Pages) {
			idx = len(info.Pages) - 1
		}
		if info.Pages[idx].Cid != 0 {
			effectiveCid = info.Pages[idx].Cid
			currentPage = info.Pages[idx].Page
		}
	case opts.Cid != 0 && len(info.Pages) > 0:
		for _, p := range info.Pages {
			if p.Cid == opts.Cid {
				effectiveCid = p.Cid
				currentPage = p.Page
				break
			}
		}
	case len(info.Pages) > 0:
		for _, p := range info.Pages {
			if p.Cid == info.Cid {
				currentPage = p.Page
				break
			}
		}
	}

	var pagesInfo []ResolvePageInfo
	if len(info.Pages) > 0 {
		pagesInfo = make([]ResolvePageInfo, 0, len(info.Pages))
		for _, p := range info.Pages {
			pagesInfo = append(pagesInfo, ResolvePageInfo{
				Page: p.Page, Cid: p.Cid, Part: p.Part, Duration: p.Duration,
			})
		}
	}

	hasCookie := opts.Cookie != ""
	requestedQn := opts.Qn
	if requestedQn == 0 {
		requestedQn = GetDefaultQn(isVip, hasCookie)
	}
	base := func() ResolveResult {
		return ResolveResult{
			Title:       info.Title,
			Duration:    currentPageDuration(info, effectiveCid),
			Cid:         effectiveCid,
			Format:      "mp4",
			LoggedIn:    hasCookie,
			VipStatus:   boolToInt(isVip),
			Pages:       pagesInfo,
			CurrentPage: currentPage,
			ResolvedURL: expandedURL,
		}
	}

	// preferMp4 直连模式：只请求 MP4 单流，失败即报错、不回退 DASH。
	// 用户明确选了 MP4，再悄悄切回 DASH 属于违背预期。
	if opts.PreferMp4 {
		opts.emit("cdn", "正在获取 MP4 直链（直连模式）...")
		// 用 opts.Qn 而不是已按登录态兜过的 requestedQn：匿名默认值 32 是 DASH
		// 的上限（480P），套到 MP4 上会白白丢掉 720P，还可能落到 360P。
		qn := Mp4TargetQn(opts.Qn, isVip, hasCookie)
		mp4, mp4URL, err := s.fallbackToMP4(ctx, bvid, effectiveCid, opts.Cookie, qn, isVip, opts.SkipCdnCheck)
		if err != nil {
			return nil, err
		}
		if mp4 == nil {
			return nil, newResolveError("该视频不支持 MP4 直链播放，请切换到 DASH 高清模式", "MP4_NOT_AVAILABLE")
		}
		result := base()
		result.VideoURL = mp4URL
		result.CurrentQn = minInt(mp4.CurrentQn, MP4MaxQn)
		result.AcceptQuality = narrowAcceptQualityForMP4(mp4.AcceptQuality)
		return &result, nil
	}

	opts.emit("playurl", "正在获取播放地址...")
	playURL, err := s.GetPlayURL(ctx, bvid, effectiveCid, opts.Cookie, GetPlayURLOptions{
		Qn: requestedQn, Codec: opts.Codec, IsVip: isVip,
	})
	if err != nil {
		if errors.Is(err, ErrNoPermission) {
			// 权限不足逐级降级：会员 4K 失败 → 480P；未登录 480P 失败 → 360P。
			fallbackQn := 16
			if requestedQn > AnonymousMaxQn {
				fallbackQn = AnonymousMaxQn
			}
			if fallbackQn == requestedQn {
				return nil, err
			}
			label := "360P"
			if fallbackQn == AnonymousMaxQn {
				label = "480P"
			}
			opts.emit("playurl", "当前清晰度无权限，降级到 "+label+"...")
			playURL, err = s.GetPlayURL(ctx, bvid, effectiveCid, opts.Cookie, GetPlayURLOptions{
				Qn: fallbackQn, Codec: opts.Codec, IsVip: isVip,
			})
			if err != nil {
				if errors.Is(err, ErrNoPermission) {
					return nil, newResolveError("无权限播放，可能需要登录或大会员", "NO_PERMISSION")
				}
				return nil, err
			}
		} else {
			return nil, err
		}
	}
	if playURL == nil {
		return nil, newResolveError("无法获取播放地址，可能需要登录或大会员", "NO_PERMISSION")
	}

	acceptQuality := FilterQualitiesByVip(playURL.AcceptQuality, isVip, hasCookie)
	effectiveQn := playURL.CurrentQn
	if effectiveQn != 0 && !containsQuality(acceptQuality, effectiveQn) {
		if len(acceptQuality) > 0 {
			effectiveQn = acceptQuality[0].ID
		}
	}
	if effectiveQn != 0 && effectiveQn != playURL.CurrentQn {
		opts.emit("quality", "正在匹配可用清晰度...")
		refetched, refetchErr := s.GetPlayURL(ctx, bvid, effectiveCid, opts.Cookie, GetPlayURLOptions{
			Qn: effectiveQn, Codec: opts.Codec, IsVip: isVip,
		})
		if refetchErr != nil {
			if !errors.Is(refetchErr, ErrNoPermission) {
				return nil, refetchErr
			}
			// 权限错误时保持当前清晰度，不中断解析。
			log.Printf("[bilibili-resolver] 清晰度匹配权限错误，保持当前清晰度: %d", effectiveQn)
		} else if refetched != nil {
			playURL = refetched
			acceptQuality = FilterQualitiesByVip(playURL.AcceptQuality, isVip, hasCookie)
		}
	}

	opts.emit("finish", "解析完成，正在加载播放器...")

	if playURL.Format == "dash" && playURL.BestVideo != nil {
		opts.emit("cdn", "正在选择可用 CDN...")
		videoURL, audioURL := selectDashSources(ctx, playURL, opts.SkipCdnCheck)
		if videoURL == "" {
			if opts.ForceDash {
				return nil, cdnUnreachable()
			}
			opts.emit("fallback", "DASH 地址不可用，尝试 MP4 直链...")
			// 退路同样按 MP4 的能力请求：这里如果用 effectiveQn（DASH 的匿名档
			// 只有 480P），退回去的 MP4 也会被一并压到 480P/360P。
			qn := Mp4TargetQn(opts.Qn, isVip, hasCookie)
			mp4, mp4URL, mp4Err := s.fallbackToMP4(ctx, bvid, effectiveCid, opts.Cookie, qn, isVip, opts.SkipCdnCheck)
			if mp4Err == nil && mp4 != nil {
				result := base()
				result.VideoURL = mp4URL
				mp4Qn := mp4.CurrentQn
				if mp4Qn == 0 {
					mp4Qn = MP4MaxQn
				}
				result.CurrentQn = minInt(mp4Qn, MP4MaxQn)
				source := mp4.AcceptQuality
				if len(source) == 0 {
					source = acceptQuality
				}
				result.AcceptQuality = narrowAcceptQualityForMP4(source)
				return &result, nil
			}
			return nil, cdnUnreachable()
		}

		result := base()
		result.Format = "dash"
		result.VideoURL = videoURL
		result.AudioURL = audioURL
		result.VideoCodec = playURL.BestVideo.Codecs
		if playURL.BestAudio != nil {
			result.AudioCodec = playURL.BestAudio.Codecs
		}
		result.CurrentQn = playURL.CurrentQn
		result.AcceptQuality = acceptQuality
		result.IsHDR = playURL.IsHDR
		result.HdrType = playURL.HdrType
		result.VideoCodecid = playURL.VideoCodecid
		return &result, nil
	}

	// 请求 DASH 却返回 MP4 的边缘场景。
	if playURL.Format == "mp4" && len(playURL.Durl) > 0 {
		if opts.ForceDash {
			return nil, newResolveError("该视频不支持 DASH 高清播放", "DASH_NOT_AVAILABLE")
		}
		opts.emit("cdn", "正在选择可用 CDN...")
		mp4URL := ""
		if opts.SkipCdnCheck {
			mp4URL = UpgradeURLToHTTPS(playURL.Durl[0].URL)
		} else if reachable, ok := FindReachableMediaURL(ctx, MediaTrackCandidate{BaseURL: playURL.Durl[0].URL}); ok {
			mp4URL = reachable
		}
		if mp4URL == "" {
			return nil, cdnUnreachable()
		}
		result := base()
		result.VideoURL = mp4URL
		result.CurrentQn = playURL.CurrentQn
		result.AcceptQuality = narrowAcceptQualityForMP4(acceptQuality)
		return &result, nil
	}

	return nil, newResolveError("未找到可用播放地址", "NO_PLAYURL")
}

// ==================== PGC 解析 ====================

func (s *Service) resolvePGC(ctx context.Context, opts ResolveOptions, id BangumiID, expandedURL string) (*ResolveResult, error) {
	if opts.Cookie == "" {
		opts.emit("vip", "正在准备匿名会话...")
		s.Client.EnsureAnonymousSession(ctx)
	}

	opts.emit("vip", "正在检查大会员状态...")
	isVip := s.GetVipStatus(ctx, opts.Cookie)

	opts.emit("info", "正在解析番剧信息...")
	var season *PgcSeasonInfo
	var err error
	if id.EpID > 0 {
		season, err = s.FetchSeasonByEpID(ctx, id.EpID, opts.Cookie)
	} else {
		season, err = s.FetchSeasonBySeasonID(ctx, id.SeasonID, opts.Cookie)
	}
	if err != nil {
		return nil, toResolveError(err)
	}
	if len(season.Episodes) == 0 {
		return nil, newResolveError("该番剧暂无可用分集", "EP_NOT_FOUND")
	}

	// 定位目标集：cid 匹配（切集/CLI）→ 链接 ep_id → page 序号 → 第一集。
	target := season.Episodes[0]
	if opts.Cid != 0 {
		for _, ep := range season.Episodes {
			if ep.Cid == opts.Cid {
				target = ep
				break
			}
		}
	} else if id.EpID > 0 {
		for _, ep := range season.Episodes {
			if ep.EpID == id.EpID {
				target = ep
				break
			}
		}
	} else if opts.Page > 0 {
		idx := opts.Page - 1
		if idx >= len(season.Episodes) {
			idx = len(season.Episodes) - 1
		}
		target = season.Episodes[idx]
	}

	// 注：不按 status 硬拦截。实测 status 语义是 2=免费可看 / 13=会员可看，
	// 不是「未开播」；真正不可播由 playurl 的业务码判定。
	preview := target.Badge != "" && !isVip

	currentPage := 1
	for i, ep := range season.Episodes {
		if ep.EpID == target.EpID {
			currentPage = i + 1
			break
		}
	}

	pagesInfo := make([]ResolvePageInfo, 0, len(season.Episodes))
	for i, ep := range season.Episodes {
		part := ep.LongTitle
		if part == "" {
			part = ep.Title
		}
		pagesInfo = append(pagesInfo, ResolvePageInfo{
			Page: i + 1, Cid: ep.Cid, Part: part, Duration: ep.DurationSec,
			EpID: ep.EpID, Badge: ep.Badge,
		})
	}

	title := strings.TrimSpace(target.LongTitle)
	if title == "" {
		title = target.Title
	}
	if season.Title != "" {
		title = strings.TrimSpace(season.Title + " " + title)
	}
	resolvedURL := "https://www.bilibili.com/bangumi/play/ep" + strconv.FormatInt(target.EpID, 10)

	hasCookie := opts.Cookie != ""
	requestedQn := opts.Qn
	if requestedQn == 0 {
		requestedQn = GetDefaultQn(isVip, hasCookie)
	}

	log.Printf("[bilibili-pgc] resolve ep=%d cid=%d badge=%s preview=%t qn=%d cookie=%t",
		target.EpID, target.Cid, target.Badge, preview, requestedQn, hasCookie)

	base := func() ResolveResult {
		return ResolveResult{
			Title:       title,
			Duration:    target.DurationSec,
			Cid:         target.Cid,
			Pages:       pagesInfo,
			CurrentPage: currentPage,
			ResolvedURL: resolvedURL,
			LoggedIn:    hasCookie,
			VipStatus:   boolToInt(isVip),
			EpID:        target.EpID,
			SeasonID:    season.SeasonID,
			SeasonTitle: season.Title,
			Preview:     preview,
		}
	}

	// fetchPgcMP4 取 PGC 的 MP4 直链（fnval=1）。
	fetchPgcMP4 := func(qn int) (*PlayURLResult, error) {
		mp4, err := s.GetPgcPlayURL(ctx, target.EpID, target.Cid, opts.Cookie, qn, fnvalMP4, opts.Codec)
		if err != nil {
			return nil, err
		}
		if mp4 == nil || mp4.Format != "mp4" || len(mp4.Durl) == 0 || mp4.Durl[0].URL == "" {
			return nil, nil
		}
		return mp4, nil
	}

	// resolveMp4URL 选 MP4 可达地址，全失败回退原 URL（与 UGC 同策略）。
	resolveMp4URL := func(mp4 *PlayURLResult) string {
		raw := mp4.Durl[0].URL
		if opts.SkipCdnCheck {
			return UpgradeURLToHTTPS(raw)
		}
		if reachable, ok := FindReachableMediaURL(ctx, MediaTrackCandidate{BaseURL: raw}); ok {
			return reachable
		}
		return UpgradeURLToHTTPS(raw)
	}

	// buildMp4Result 构造 MP4 结果。
	//
	// 试看流时长必须以 durl[0].length 为准：B站 对试看集虚报 timelength 为
	// 完整时长，用它会显示成「1 小时」，实际只能放 3 分钟。
	buildMp4Result := func(mp4 *PlayURLResult, mp4URL string) *ResolveResult {
		durlLenSec := 0
		if len(mp4.Durl) > 0 && mp4.Durl[0].Length > 0 {
			durlLenSec = int((mp4.Durl[0].Length + 500) / 1000)
			if durlLenSec > target.DurationSec {
				durlLenSec = target.DurationSec
			}
		}
		result := base()
		result.Format = "mp4"
		result.VideoURL = mp4URL
		if preview && durlLenSec > 0 {
			result.Duration = durlLenSec
		}
		mp4Qn := mp4.CurrentQn
		if mp4Qn == 0 {
			mp4Qn = MP4MaxQn
		}
		result.CurrentQn = minInt(mp4Qn, MP4MaxQn)
		result.AcceptQuality = narrowAcceptQualityForMP4(mp4.AcceptQuality)
		return &result
	}

	// 试看集强制 MP4：B站 试看只发 durl。forceDash 时不拦截——
	// 试看场景本来就没有 DASH 可用。
	if preview || opts.PreferMp4 {
		message := "正在获取 MP4 直链（直连模式）..."
		if preview {
			message = "该集为会员专享，正在获取试看片段..."
		}
		opts.emit("playurl", message)
		// 与 UGC 同一套取值：匿名也要按 MP4 的 720P 上限请求，
		// 否则番剧的 MP4 模式同样会被 DASH 的匿名上限（480P）带低。
		qn := Mp4TargetQn(opts.Qn, isVip, hasCookie)
		mp4, err := fetchPgcMP4(qn)
		if err != nil {
			return nil, toResolveError(err)
		}
		if mp4 == nil {
			return nil, newResolveError("该集不支持 MP4 直链播放，请切换到 DASH 高清模式", "MP4_NOT_AVAILABLE")
		}
		opts.emit("cdn", "正在选择可用 CDN...")
		return buildMp4Result(mp4, resolveMp4URL(mp4)), nil
	}

	opts.emit("playurl", "正在获取播放地址...")
	playURL, err := s.GetPgcPlayURL(ctx, target.EpID, target.Cid, opts.Cookie,
		requestedQn, ComputeFnval(isVip, requestedQn, opts.Codec, false), opts.Codec)
	if err != nil {
		var pgcErr *PgcError
		if errors.As(err, &pgcErr) {
			return nil, newResolveError(pgcErr.Message, pgcErr.Code)
		}
		if errors.Is(err, ErrNoPermission) {
			fallbackQn := 16
			if requestedQn > AnonymousMaxQn {
				fallbackQn = AnonymousMaxQn
			}
			if fallbackQn == requestedQn {
				return nil, toResolveError(err)
			}
			label := "360P"
			if fallbackQn == AnonymousMaxQn {
				label = "480P"
			}
			opts.emit("playurl", "当前清晰度无权限，降级到 "+label+"...")
			playURL, err = s.GetPgcPlayURL(ctx, target.EpID, target.Cid, opts.Cookie,
				fallbackQn, ComputeFnval(isVip, fallbackQn, opts.Codec, false), opts.Codec)
			if err != nil {
				return nil, toResolveError(err)
			}
		} else {
			return nil, toResolveError(err)
		}
	}
	if playURL == nil {
		return nil, newResolveError("无法获取播放地址，可能需要登录或大会员", "NO_PERMISSION")
	}

	acceptQuality := FilterQualitiesByVip(playURL.AcceptQuality, isVip, hasCookie)
	effectiveQn := playURL.CurrentQn
	if effectiveQn != 0 && !containsQuality(acceptQuality, effectiveQn) {
		if len(acceptQuality) > 0 {
			effectiveQn = acceptQuality[0].ID
		}
	}
	if effectiveQn != 0 && effectiveQn != playURL.CurrentQn {
		opts.emit("quality", "正在匹配可用清晰度...")
		refetched, refetchErr := s.GetPgcPlayURL(ctx, target.EpID, target.Cid, opts.Cookie,
			effectiveQn, ComputeFnval(isVip, effectiveQn, opts.Codec, false), opts.Codec)
		if refetchErr != nil {
			if !errors.Is(refetchErr, ErrNoPermission) {
				return nil, toResolveError(refetchErr)
			}
			log.Printf("[bilibili-pgc] 清晰度匹配权限错误，保持当前清晰度: %d", effectiveQn)
		} else if refetched != nil {
			playURL = refetched
			acceptQuality = FilterQualitiesByVip(playURL.AcceptQuality, isVip, hasCookie)
		}
	}

	opts.emit("finish", "解析完成，正在加载播放器...")

	if playURL.Format == "dash" && playURL.BestVideo != nil {
		opts.emit("cdn", "正在选择可用 CDN...")
		videoURL, audioURL := selectDashSources(ctx, playURL, opts.SkipCdnCheck)
		if videoURL == "" {
			if opts.ForceDash {
				return nil, cdnUnreachable()
			}
			opts.emit("fallback", "DASH 地址不可用，尝试 MP4 直链...")
			qn := Mp4TargetQn(opts.Qn, isVip, hasCookie)
			mp4, mp4Err := fetchPgcMP4(qn)
			if mp4Err == nil && mp4 != nil {
				return buildMp4Result(mp4, resolveMp4URL(mp4)), nil
			}
			return nil, cdnUnreachable()
		}

		result := base()
		result.Format = "dash"
		result.VideoURL = videoURL
		result.AudioURL = audioURL
		result.VideoCodec = playURL.BestVideo.Codecs
		if playURL.BestAudio != nil {
			result.AudioCodec = playURL.BestAudio.Codecs
		}
		result.CurrentQn = playURL.CurrentQn
		result.AcceptQuality = acceptQuality
		result.IsHDR = playURL.IsHDR
		result.HdrType = playURL.HdrType
		result.VideoCodecid = playURL.VideoCodecid
		return &result, nil
	}

	// 请求 DASH 却返回 MP4（PGC 偶发）。
	if playURL.Format == "mp4" && len(playURL.Durl) > 0 {
		if opts.ForceDash {
			return nil, newResolveError("该集不支持 DASH 高清播放", "DASH_NOT_AVAILABLE")
		}
		opts.emit("cdn", "正在选择可用 CDN...")
		return buildMp4Result(playURL, resolveMp4URL(playURL)), nil
	}

	return nil, newResolveError("未找到可用播放地址", "NO_PLAYURL")
}

// ==================== 工具 ====================

// toResolveError 把底层异常归一化为 ResolveError（PGC 业务码原样保留）。
func toResolveError(err error) error {
	if err == nil {
		return nil
	}
	var pgcErr *PgcError
	if errors.As(err, &pgcErr) {
		return newResolveError(pgcErr.Message, pgcErr.Code)
	}
	var resolveErr *ResolveError
	if errors.As(err, &resolveErr) {
		return resolveErr
	}
	if errors.Is(err, ErrNoPermission) {
		return newResolveError(ErrNoPermission.Error(), "NO_PERMISSION")
	}
	return newResolveError(err.Error(), "RESOLVE_FAILED")
}

// NormalizeResolveError 供 API 层统一取错误码与文案。
func NormalizeResolveError(err error) (code, message string) {
	if err == nil {
		return "", ""
	}
	var resolveErr *ResolveError
	if errors.As(err, &resolveErr) {
		return resolveErr.Code, resolveErr.Message
	}
	if errors.Is(err, ErrNoPermission) {
		return "NO_PERMISSION", ErrNoPermission.Error()
	}
	return "RESOLVE_FAILED", err.Error()
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func containsQuality(list []Quality, id int) bool {
	for _, q := range list {
		if q.ID == id {
			return true
		}
	}
	return false
}
