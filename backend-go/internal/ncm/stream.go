package ncm

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/ttlcache"
)

// qualityChain 是音质降级链（从高到低）。
//
// 与 spec 一致：后端默认 exhigh，VIP 可播时向上尝试 lossless。
const (
	qualityLossless = "lossless"
	qualityExhigh   = "exhigh"
	qualityHigher   = "higher"
	qualityStandard = "standard"
)

var qualityChain = []string{qualityLossless, qualityExhigh, qualityHigher, qualityStandard}

// QualityLevels 按请求档位取降级链切片（未知名质从链头开始）。
func QualityLevels(requested string) []string {
	for index, level := range qualityChain {
		if level == requested {
			return qualityChain[index:]
		}
	}
	return qualityChain
}

// levelToBR 是 `/song/url/v1` 不可用时回退老接口 `/song/url` 的音质映射（br 参数制）。
var levelToBR = map[string]int64{
	qualityLossless: 999000,
	qualityExhigh:   320000,
	qualityHigher:   192000,
	qualityStandard: 128000,
}

// ResolveSongURLAlongChain 沿降级链解析歌曲直链数据（`/stream` 与 `/song-quality` 共用）。
//
// v1 路由失败（依赖残缺 404 / 网络抛错）时回退老接口 `/song/url`；
// freeTrialInfo 非空（试听片段）与「不可用」同等对待，继续降级。
// 返回的 lastData 供错误分类用（试听标记 → VIP_REQUIRED）。
func (s *Service) ResolveSongURLAlongChain(
	ctx context.Context,
	songID int64,
	levels []string,
	cookieHeader string,
) (resolved, lastData map[string]any) {
	for _, level := range levels {
		var data map[string]any
		if resp, err := s.Call(ctx, "/song/url/v1?id="+formatInt(songID)+"&level="+level, cookieHeader); err == nil {
			data = extractSongURLData(resp.Body)
		}
		if data == nil {
			data = s.resolveSongURLLegacy(ctx, songID, level, cookieHeader)
		}
		if data == nil {
			continue
		}
		lastData = data
		if audioURL, ok := data["url"].(string); ok && audioURL != "" && data["freeTrialInfo"] == nil {
			resolved = data
			break
		}
	}
	return resolved, lastData
}

// resolveSongURLLegacy 走老接口 `/song/url`（br 参数制）。
//
// 场景：新版 `/song/url/v1` 拿不到可用地址（上游限流、接口调整）时兜底。
// 老接口响应没有 level 字段，按请求档位补写，让调用方的降级链/缓存逻辑与
// v1 响应同构。
func (s *Service) resolveSongURLLegacy(
	ctx context.Context,
	songID int64,
	level, cookieHeader string,
) map[string]any {
	br, ok := levelToBR[level]
	if !ok {
		br = 320000
	}
	resp, err := s.Call(ctx, "/song/url?id="+formatInt(songID)+"&br="+strconv.FormatInt(br, 10), cookieHeader)
	if err != nil {
		return nil
	}
	data := extractSongURLData(resp.Body)
	if data == nil {
		return nil
	}
	if _, hasLevel := data["level"]; !hasLevel {
		data["level"] = level
	}
	return data
}

// extractSongURLData 取 `/song/url*` 响应里的 data[0]。
func extractSongURLData(body any) map[string]any {
	root, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	data, ok := root["data"].([]any)
	if !ok || len(data) == 0 {
		return nil
	}
	first, ok := data[0].(map[string]any)
	if !ok {
		return nil
	}
	return first
}

// 直链缓存 / 音质元数据缓存（15 分钟，500 条）。
//
// 直链签名本身有效期约 20-30 分钟；解析完把 CDN 直链交给 `<audio>` 直连，
// 服务器不再承担音频流量。多条观众的同一首歌共享同一份解析结果
// （解析接口自身有频控）。
const (
	streamCacheTTLMs = 15 * 60 * 1000
	streamCacheMax   = 500
)

// SongQualityMeta 是 `/song-quality` 的元数据。
type SongQualityMeta struct {
	SR    int64  `json:"sr"`
	BR    int64  `json:"br"`
	Type  string `json:"type"`
	Level string `json:"level"`
}

var (
	// DirectURLCache 是「songId+level+凭证归属 → CDN 直链」。
	DirectURLCache = ttlcache.New[string](streamCacheTTLMs, streamCacheMax)
	// QualityMetaCache 是「songId+level+凭证归属 → 音质元数据」。
	QualityMetaCache = ttlcache.New[SongQualityMeta](streamCacheTTLMs, streamCacheMax)
)

// ResolveFlacSampleRate 兜底探测 FLAC 采样率。
//
// 上游 `/song/url/v1` 的 data[0] 未必带 sr 字段；对 flac 解析首部
// STREAMINFO 块（采样率 20 bit）拿真实值。只请求 CDN 首部 64KB，失败静默返回 0。
func ResolveFlacSampleRate(ctx context.Context, audioURL string) int64 {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	target := httpURLToHTTPS(audioURL)
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target, nil)
	if err != nil {
		return 0
	}
	req.Header.Set("Range", "bytes=0-65535")
	req.Header.Set("User-Agent", proxy.DefaultProxyUA)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(resp.Body, 65536))
	if err != nil {
		return 0
	}

	return parseFlacSampleRate(buf)
}

// parseFlacSampleRate 从 FLAC 首部解析采样率（20 bit，大端）。
//
// 布局：'fLaC'(4B) + 块头(4B，块类型 0=STREAMINFO) + 数据；
// STREAMINFO 数据前 10 字节是块/帧尺寸字段，第 10-12 字节是采样率。
func parseFlacSampleRate(buf []byte) int64 {
	if len(buf) < 44 || string(buf[0:4]) != "fLaC" {
		return 0
	}
	if buf[4]&0x7f != 0 {
		return 0
	}
	offset := 8 + 10
	sampleRate := int64(buf[offset])<<12 | int64(buf[offset+1])<<4 | int64(buf[offset+2])>>4
	if sampleRate > 0 {
		return sampleRate
	}
	return 0
}

// IsNcmAudioHost 校验直链是否位于网易云音频 CDN（防 SSRF）。
func IsNcmAudioHost(hostname string) bool {
	host := strings.ToLower(hostname)
	return host == "music.126.net" || strings.HasSuffix(host, ".music.126.net")
}

// httpURLToHTTPS 把 http 直链改写成 https（`<audio>` 在 https 页面上会被 mixed content 拦）。
func httpURLToHTTPS(raw string) string {
	if strings.HasPrefix(strings.ToLower(raw), "http://") {
		return "https://" + raw[len("http://"):]
	}
	return raw
}

// ValidateAudioURL 解析并校验直链，返回改写后的 https 地址。
//
// 域名不在白名单时返回 ok=false（路由层回 502 RESOLVE_FAILED）：
// 直链由上游给，但转发前必须自己核一遍，否则一个被污染的响应就能把服务器
// 变成任意地址的下载器。
func ValidateAudioURL(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	if !IsNcmAudioHost(parsed.Hostname()) {
		log.Printf("[ncm] 拒绝非网易云域名的音频直链: %s", parsed.Hostname())
		return "", false
	}
	return httpURLToHTTPS(raw), true
}

// 音频流转发缓冲区（与 serverFiles 的 STREAM_HIGH_WATER_MARK 一致）。
const audioStreamBuffer = 1024 * 1024

// ProxyAudio 流式转发音频：透传 Range，转发 206/200 与长度类响应头。
func ProxyAudio(w http.ResponseWriter, r *http.Request, audioURL string) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, audioURL, nil)
	if err != nil {
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "音频源请求失败",
		})
		return
	}
	req.Header.Set("User-Agent", proxy.DefaultProxyUA)
	req.Header.Set("Accept", "*/*")
	if rangeValue := r.Header.Get("Range"); rangeValue != "" {
		req.Header.Set("Range", rangeValue)
	}

	upstream, err := http.DefaultClient.Do(req)
	if err != nil {
		if r.Context().Err() != nil {
			// 客户端已断连：不算错误，直接收尾
			return
		}
		log.Printf("[ncm] 音频流上游请求失败: %v", err)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "音频源请求失败",
		})
		return
	}
	defer upstream.Body.Close()

	header := w.Header()
	// 上游非 2xx：透传状态码与长度类头（如 416 的 Content-Range 语义）
	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		for _, name := range []string{"Content-Range", "Accept-Ranges", "Content-Length"} {
			if value := upstream.Header.Get(name); value != "" {
				header.Set(name, value)
			}
		}
		w.WriteHeader(upstream.StatusCode)
		return
	}

	contentType := upstream.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "audio/mpeg"
	}
	header.Set("Content-Type", contentType)
	for _, name := range []string{
		"Content-Length", "Content-Range", "Accept-Ranges", "Etag", "Last-Modified",
	} {
		if value := upstream.Header.Get(name); value != "" {
			header.Set(name, value)
		}
	}
	// 浏览器必须知道支持 Range，否则会整文件下载而不是流式播放
	if header.Get("Accept-Ranges") == "" {
		header.Set("Accept-Ranges", "bytes")
	}
	header.Set("X-Accel-Buffering", "no")
	header.Set("Cache-Control", "no-transform")

	w.WriteHeader(upstream.StatusCode)

	// 大缓冲：音频分片吞吐高，默认 32KB 会让 io.Copy 变成瓶颈
	buf := make([]byte, audioStreamBuffer)
	if _, err := io.CopyBuffer(w, upstream.Body, buf); err != nil {
		if r.Context().Err() == nil {
			log.Printf("[ncm] 音频流转发中断: %v", err)
		}
	}
}
