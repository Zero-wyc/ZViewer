package emby

import (
	"context"
	"math"
	"strconv"
	"strings"

	"zviewer/backend/internal/mountutil"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/store"
)

// VersionInfo 是前端可展示的一个版本（MediaSource）。
type VersionInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// 以下三项在 Node 侧是「有值才出现」（`...(x !== undefined ? {x} : {})`），
	// 所以必须用 omitempty，而不是下发 null。
	Height    *int   `json:"height,omitempty"`
	Size      *int64 `json:"size,omitempty"`
	Container string `json:"container,omitempty"`
}

// jsToFixed1 复刻 JS 的 Number.prototype.toFixed(1)。
//
// 必须自己算，不能直接用 fmt.Sprintf("%.1f")：Go 的小数格式化是「四舍六入
// 五取偶」，1.25 输出 1.2；JS 的 toFixed 在恰好一半时取较大的值，输出 1.3。
// 影片大小经常正好落在 x.x5 GB（1.25 * 2^30 是精确可表示的二进制值），
// 用 Go 的默认格式化会让版本标签与 Node 不一致。
func jsToFixed1(value float64) string {
	rounded := math.Round(value*10) / 10
	return strconv.FormatFloat(rounded, 'f', 1, 64)
}

// FormatSize 复刻版本标签里的体积文案：≥1GB 用 GB 保留 1 位，否则整数 MB。
func FormatSize(size int64) string {
	gb := float64(size) / (1024 * 1024 * 1024)
	if gb >= 1 {
		return jsToFixed1(gb) + "GB"
	}
	return strconv.FormatInt(int64(math.Round(float64(size)/(1024*1024))), 10) + "MB"
}

// BuildVersions 把 MediaSources 转成前端可展示的版本列表。
//
// 标签拼接顺序固定为「版本名 · 分辨率 · 容器 · 体积」，缺一项跳过该段；
// 四段全缺时退化成「版本 N」（N 从 1 开始）。
func BuildVersions(sources []EmbyMediaSrc) []VersionInfo {
	versions := make([]VersionInfo, 0, len(sources))
	for i, source := range sources {
		var height *int
		for _, stream := range source.MediaStreams {
			if stream.Type == "Video" && stream.Height != nil {
				height = stream.Height
				break
			}
		}
		container := ""
		if source.Container != nil {
			container = strings.TrimSpace(*source.Container)
		}
		size := source.Size

		parts := make([]string, 0, 4)
		if source.Name != nil && *source.Name != "" {
			parts = append(parts, *source.Name)
		}
		if height != nil && *height != 0 {
			parts = append(parts, strconv.Itoa(*height)+"P")
		}
		if container != "" {
			parts = append(parts, strings.ToUpper(container))
		}
		if size != nil && *size > 0 {
			parts = append(parts, FormatSize(*size))
		}
		label := "版本 " + strconv.Itoa(i+1)
		if len(parts) > 0 {
			label = strings.Join(parts, " · ")
		}

		info := VersionInfo{ID: source.ID, Label: label}
		if height != nil {
			info.Height = height
		}
		if size != nil {
			info.Size = size
		}
		if container != "" {
			info.Container = container
		}
		versions = append(versions, info)
	}
	return versions
}

// SelectSource 按 mediaSourceId 选版本；未匹配时回退第一个（服务器默认）。
func SelectSource(sources []EmbyMediaSrc, mediaSourceID string) EmbyMediaSrc {
	if mediaSourceID != "" {
		for _, source := range sources {
			if source.ID == mediaSourceID {
				return source
			}
		}
	}
	return sources[0]
}

// browserSupportedAudio 是浏览器原生能解码的音轨编码。
//
// 不在表里的（DTS / EAC3 / TrueHD / AC3…）需要服务器转码成 AAC，
// 否则画面能播、声音全无——用户只会反馈「没声音」。
var browserSupportedAudio = map[string]bool{
	"aac": true, "mp3": true, "flac": true, "opus": true, "vorbis": true,
}

// ResolveParams 是构建 resolve 响应的入参。
type ResolveParams struct {
	Session *Session
	Mount   *store.Mount
	// Mounts 用于直链升级自愈时回写 httpsDirect（可为 nil）。
	Mounts *store.Mounts
	ItemID string
	// MountID 是代理地址里的挂载 ID。
	MountID int64
	// Prefix 是路由前缀（emby / jellyfin），决定代理与流地址。
	Prefix string
	// MediaSourceID 指定版本；空则取第一个。
	MediaSourceID string
	// MovieID 提供时额外返回 streamUrl（观众可访问，不依赖请求者自有挂载）。
	MovieID *int64
	// ResolveDirectRedirects is requested only for actual direct playback.
	ResolveDirectRedirects bool
}

// BuildResolvePayload 构建 resolve / movie-source 的统一响应。
//
// 顺序与 Node 一致：取 PlaybackInfo → 选版本 → 音轨兼容性 → 代理/直链 URL。
// 直链必须走 UpgradeDirectURLValidated：httpsDirect 是配置期的一次性探测缓存，
// 源站拆了反向代理之后它会陈旧，不现场复验就会下发连不上的 https 地址。
func BuildResolvePayload(ctx context.Context, params ResolveParams) (map[string]any, error) {
	sources, err := params.Session.Client.PlaybackInfo(ctx, params.ItemID, params.Session.UserID)
	if err != nil {
		return nil, err
	}
	source := SelectSource(sources, params.MediaSourceID)
	versions := BuildVersions(sources)

	// 音轨兼容性：Node 是 `!!audioStream && !!audioStream.Codec && !supported`，
	// Codec 缺失与空串在 !! 下等价，都算「不需要转码」。
	var audioStream *EmbyMediaStream
	for i := range source.MediaStreams {
		if source.MediaStreams[i].Type == "Audio" {
			audioStream = &source.MediaStreams[i]
			break
		}
	}
	var audioCodec any
	needsAudioTranscode := false
	if audioStream != nil && audioStream.Codec != nil {
		audioCodec = *audioStream.Codec
		if *audioStream.Codec != "" {
			needsAudioTranscode = !browserSupportedAudio[strings.ToLower(*audioStream.Codec)]
		}
	}

	// title 取 Path 的文件名部分；Path 为空/缺失时退化成 item-<id>。
	title := "item-" + params.ItemID
	if source.Path != nil {
		name := *source.Path
		if idx := strings.LastIndexAny(name, "\\/"); idx >= 0 {
			name = name[idx+1:]
		}
		if name != "" {
			title = name
		}
	}

	// format 用的是 `source.Path ?? title`：Path **缺失**时用 title，
	// Path 是空串时原样传给 detectMediaFormat（→ unknown）。
	// 这两种情形必须分开，否则「路径为空」的条目会判成 mp4/mkv。
	formatSource := title
	if source.Path != nil {
		formatSource = *source.Path
	}
	format := string(proxy.DetectMediaFormat(formatSource))
	// Some hosted libraries forbid transcoding and redirect even main.m3u8 to
	// the original file. Keep its container so the browser can handle MKV/DTS.
	transcodingAllowed := source.SupportsTranscoding == nil || *source.SupportsTranscoding
	audioTranscodeDisabled := needsAudioTranscode && !transcodingAllowed
	useAudioTranscode := needsAudioTranscode && !audioTranscodeDisabled
	if useAudioTranscode {
		format = "hls"
	}

	// 多版本时才带选档参数：单版本多带一个 ms 会让 upstream URL 与 Node 不一致。
	msQuery := ""
	upstreamMsQuery := ""
	if len(sources) > 1 {
		msQuery = "&ms=" + netutil.EncodeURIComponent(source.ID)
		upstreamMsQuery = "&MediaSourceId=" + netutil.EncodeURIComponent(source.ID)
	}
	transcodeQuery := ""
	if useAudioTranscode {
		transcodeQuery = "&at=1"
	} else if !transcodingAllowed {
		// Explicitly override legacy movie rows whose persisted format is hls.
		transcodeQuery = "&at=0"
	}

	itemEncoded := netutil.EncodeURIComponent(params.ItemID)
	proxyURL := "/api/" + params.Prefix + "/proxy?mountId=" +
		strconv.FormatInt(params.MountID, 10) + "&path=" + itemEncoded +
		transcodeQuery + msQuery

	var streamURL string
	if params.MovieID != nil {
		streamURL = "/api/" + params.Prefix + "/stream?movieId=" +
			strconv.FormatInt(*params.MovieID, 10) + transcodeQuery + msQuery
	}

	// token 直接拼进 query（Node 没做编码）：令牌是 ASCII 字母数字，
	// 编码与否字节相同，这里保持一致。
	token := params.Session.Token()
	baseURL := params.Session.Client.BaseURL
	var directURLRaw string
	if useAudioTranscode {
		directURLRaw = baseURL + "/emby/Videos/" + itemEncoded +
			"/main.m3u8?api_key=" + token +
			"&AudioCodec=aac&TranscodingMaxAudioChannels=2" +
			"&VideoBitrate=8000000&AudioBitrate=192000" + upstreamMsQuery
	} else {
		directURLRaw = baseURL + "/emby/Videos/" + itemEncoded +
			"/stream?static=true&api_key=" + token + upstreamMsQuery
	}
	directURL := mountutil.UpgradeDirectURLValidated(ctx, params.Mounts, params.Mount, directURLRaw)

	// format 是 'hls' 时前端才会挂 HLS 引擎，写成别的值等于播放不了。
	payload := map[string]any{
		"title":                  title,
		"videoUrl":               proxyURL,
		"directUrl":              directURL,
		"format":                 format,
		"duration":               0,
		"audioCodec":             audioCodec,
		"needsAudioTranscode":    needsAudioTranscode,
		"audioTranscodeDisabled": audioTranscodeDisabled,
		"versions":               versions,
		"mediaSourceId":          source.ID,
		"multiVersion":           len(sources) > 1,
		params.Prefix: map[string]any{
			"itemId":    params.ItemID,
			"container": containerValue(source.Container),
		},
	}
	if params.MovieID != nil {
		payload["streamUrl"] = streamURL
	}
	if params.ResolveDirectRedirects && !useAudioTranscode {
		resolvedDirectURL, err := proxy.ResolveUpstreamURL(ctx, proxy.HTTPOptions{
			URL: directURL,
			Headers: proxy.UpstreamHeaders{Extra: map[string]string{
				"X-Emby-Token": token, "Referer": baseURL,
			}},
		})
		if err != nil {
			return nil, &Error{Message: "解析直连媒体地址失败", Code: CodeUnreachable}
		}
		// Keep directUrl as the stable item/version identity. The signed CDN URL
		// is ephemeral and must never replace movie.url in the database.
		payload["resolvedDirectUrl"] = resolvedDirectURL
	}
	return payload, nil
}

// containerValue 对应 `source.Container ?? ”`（原值，不做 trim）。
func containerValue(container *string) string {
	if container == nil {
		return ""
	}
	return *container
}
