package bilibili

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// 字幕获取的常量，与 subtitle.ts 一一对应。
const (
	// subtitleMaxAttempts 尝试次数。
	//
	// B站 `x/player/v2` 会**随机返回别的视频的字幕**，而字幕 JSON 里没有任何
	// 视频标识（无 cid / 无 aid），没法自证。只能多次采样 + 投票。
	subtitleMaxAttempts = 6
	// subtitleAttemptInterval 每次尝试之间的间隔，给服务端留出变化窗口。
	subtitleAttemptInterval = 180 * time.Millisecond
	// subtitleSuccessTTL 成功结果缓存（二次播放不再掷骰子）。
	subtitleSuccessTTL = 10 * time.Minute
	// subtitleFailureTTL 失败负缓存（避免抖动期高频重试打爆接口）。
	subtitleFailureTTL = 60 * time.Second
	// subtitleMetaTTL 视频元数据缓存。
	subtitleMetaTTL = 5 * time.Minute
	// subtitleMetaMaxDur 时长合理性上限（防止把 ms 当 s）。
	subtitleMetaMaxDur = 86400
)

// SubtitleLine 是一条字幕（前端歌词行直接消费）。
type SubtitleLine struct {
	From    float64 `json:"from"`
	To      float64 `json:"to"`
	Content string  `json:"content"`
}

// SubtitleOutcome 是字幕获取结果。
//
// 失败时 Lines 为空、Reason 非空——调用方据此显示「无歌词」，
// **绝不返回可疑字幕**（宁可没有，也不要歌词和视频对不上）。
type SubtitleOutcome struct {
	Lines  []SubtitleLine
	Source string
	Reason string
}

func (o SubtitleOutcome) OK() bool { return len(o.Lines) > 0 }

// subtitleCacheEntry 是成功缓存的载荷。
type subtitleCacheEntry struct {
	Lines  []SubtitleLine
	Source string
}

// subtitleMeta 是带外/带内校验所需的元数据。
type subtitleMeta struct {
	aid         int64
	durationSec int // 0 表示未知
}

// subtitleTrack 是一条字幕轨道。
type subtitleTrack struct {
	Lan         string `json:"lan"`
	SubtitleURL string `json:"subtitle_url"`
}

// durationTolerance 字幕时间轴终点与视频时长的容差：max(10s, 时长 × 8%)。
func durationTolerance(durationSec float64) float64 {
	if v := durationSec * 0.08; v > 10 {
		return v
	}
	return 10
}

// FetchSubtitle 获取 B站 视频字幕（严格校验，绝不返回可疑结果）。
//
// bvid 是 BV 号，cid 是分集 cid，durationSec<=0 表示未知（用官方时长兜底）。
func (s *Service) FetchSubtitle(
	ctx context.Context,
	bvid string,
	cid int64,
	cookie string,
	durationSec int,
) SubtitleOutcome {
	key := bvid + ":" + strconv.FormatInt(cid, 10)

	// 命中成功缓存：直接返回，二次播放不再重掷骰子。
	if hit, ok := s.Caches.GetSubtitle(key); ok {
		return SubtitleOutcome{Lines: hit.Lines, Source: "cache"}
	}
	// 命中失败负缓存：抖动期内不再重试。
	if reason, ok := s.Caches.GetSubtitleFailure(key); ok {
		return SubtitleOutcome{Lines: []SubtitleLine{}, Reason: reason}
	}

	meta := s.resolveVideoMeta(ctx, bvid, cookie)
	duration := 0
	if durationSec > 0 && durationSec < subtitleMetaMaxDur {
		duration = durationSec
	} else {
		duration = meta.durationSec
	}

	// votes 按插入序保存：票数相同时取**先插入**的那份（见下方选优注释）。
	type vote struct {
		fp     string
		lines  []SubtitleLine
		source string
		count  int
	}
	votes := make([]*vote, 0, subtitleMaxAttempts)
	index := make(map[string]*vote, subtitleMaxAttempts)

	sawTrack := false
	for attempt := 0; attempt < subtitleMaxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(subtitleAttemptInterval):
			case <-ctx.Done():
				return SubtitleOutcome{Lines: []SubtitleLine{}, Reason: "已取消"}
			}
		}
		if ctx.Err() != nil {
			return SubtitleOutcome{Lines: []SubtitleLine{}, Reason: "已取消"}
		}

		tracks, source, ok := s.listSubtitleTracks(ctx, bvid, cid, cookie)
		if !ok {
			continue
		}
		sawTrack = true
		track := pickSubtitleTrack(tracks)
		if track.SubtitleURL == "" {
			continue
		}
		// 带外校验：subtitle_url 的 oid 参数必须等于视频 aid，
		// 否则说明这条轨道是别人视频的（错拿 URL 的典型症状）。
		if oid, hasOid := extractSubtitleOid(track.SubtitleURL); hasOid && meta.aid != 0 && oid != meta.aid {
			continue
		}
		lines := s.fetchSubtitleFile(ctx, track.SubtitleURL)
		if len(lines) == 0 {
			continue
		}
		// 带内校验：时间轴终点应贴合视频时长。
		if duration > 0 {
			var endTo float64
			for _, l := range lines {
				if l.To > endTo {
					endTo = l.To
				}
			}
			if absFloat(endTo-float64(duration)) > durationTolerance(float64(duration)) {
				continue
			}
		}
		fp := subtitleFingerprint(lines)
		if v, exists := index[fp]; exists {
			v.count++
		} else {
			v = &vote{fp: fp, lines: lines, source: source, count: 1}
			index[fp] = v
			votes = append(votes, v)
		}
		// 两次采样一致即确认（同一视频的字幕应稳定复现）。
		if index[fp].count >= 2 {
			break
		}
	}

	// 选出票数最高的通过校验结果。
	//
	// 注意：subtitle.ts 的文档说「票数相同取 wbi」，但它的实际实现是严格大于
	// （`v.count > bestCount`），平票时保留**先插入**的那份。这里照实现走，
	// 因为首次尝试优先走 WBI 通道，通常情况下两者结论一致。
	var best *vote
	for _, v := range votes {
		if best == nil || v.count > best.count {
			best = v
		}
	}
	if best != nil {
		s.Caches.SetSubtitle(key, subtitleCacheEntry{Lines: best.lines, Source: best.source})
		return SubtitleOutcome{Lines: best.lines, Source: best.source}
	}

	reason := "未能验证字幕归属（B站 接口返回异常），暂不显示歌词"
	if !sawTrack {
		reason = "该视频无字幕轨道（或需登录 B站 才能获取 AI 字幕）"
	}
	s.Caches.SetSubtitleFailure(key, reason)
	return SubtitleOutcome{Lines: []SubtitleLine{}, Reason: reason}
}

// resolveVideoMeta 取 aid 与官方时长，失败时返回零值（退化为无校验）。
func (s *Service) resolveVideoMeta(ctx context.Context, bvid, cookie string) subtitleMeta {
	if cached, ok := s.Caches.GetSubtitleMeta(bvid); ok {
		return cached
	}
	var meta subtitleMeta
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/view?bvid="+bvid,
		FetchOptions{Cookie: cookie})
	if err == nil {
		var v struct {
			Aid      int64   `json:"aid"`
			Duration float64 `json:"duration"`
		}
		if _, err := DecodeDataInto(env, &v); err == nil {
			meta.aid = v.Aid
			if v.Duration > 0 && v.Duration < subtitleMetaMaxDur {
				meta.durationSec = int(v.Duration)
			}
		}
	}
	s.Caches.SetSubtitleMeta(bvid, meta)
	return meta
}

// listSubtitleTracks 拉字幕轨道列表：WBI 签名接口优先，失败退化未签名接口。
func (s *Service) listSubtitleTracks(
	ctx context.Context,
	bvid string,
	cid int64,
	cookie string,
) ([]subtitleTrack, string, bool) {
	// 1) WBI 签名接口
	if imgKey, subKey, err := s.WBI.Keys(ctx, cookie); err == nil {
		signed := SignParams(
			NewParams().Set("bvid", bvid).Set("cid", strconv.FormatInt(cid, 10)),
			imgKey, subKey,
		)
		url := "https://api.bilibili.com/x/player/wbi/v2?" + signed.Encode()
		if tracks, ok := s.fetchSubtitleTrackList(ctx, url, cookie); ok {
			return tracks, "wbi", true
		}
	}
	// 2) 未签名接口
	url := fmt.Sprintf("https://api.bilibili.com/x/player/v2?bvid=%s&cid=%d",
		encodeComponent(bvid), cid)
	if tracks, ok := s.fetchSubtitleTrackList(ctx, url, cookie); ok {
		return tracks, "legacy", true
	}
	return nil, "", false
}

func (s *Service) fetchSubtitleTrackList(
	ctx context.Context,
	url string,
	cookie string,
) ([]subtitleTrack, bool) {
	env, err := s.Client.Fetch(ctx, url, FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, false
	}
	var data struct {
		Subtitle struct {
			Subtitles []subtitleTrack `json:"subtitles"`
		} `json:"subtitle"`
	}
	if _, err := DecodeDataInto(env, &data); err != nil {
		return nil, false
	}
	if len(data.Subtitle.Subtitles) == 0 {
		return nil, false
	}
	return data.Subtitle.Subtitles, true
}

// pickSubtitleTrack 按语言优先级挑轨道：AI 中文 → 中文 → 首条。
func pickSubtitleTrack(tracks []subtitleTrack) subtitleTrack {
	for _, t := range tracks {
		if t.Lan == "ai-zh" {
			return t
		}
	}
	for _, t := range tracks {
		if strings.HasPrefix(t.Lan, "zh") {
			return t
		}
	}
	if len(tracks) > 0 {
		return tracks[0]
	}
	return subtitleTrack{}
}

// extractSubtitleOid 取 subtitle_url 的 oid 参数；URL 里没有该参数时 ok=false。
func extractSubtitleOid(raw string) (int64, bool) {
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return 0, false
	}
	q := u.Query()
	if !q.Has("oid") {
		return 0, false
	}
	v, err := strconv.ParseInt(q.Get("oid"), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// fetchSubtitleFile 下载并解析字幕 JSON 文件。
func (s *Service) fetchSubtitleFile(ctx context.Context, subtitleURL string) []SubtitleLine {
	raw := subtitleURL
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	body, _, err := s.Client.FetchRaw(ctx, raw, FetchOptions{})
	if err != nil {
		return nil
	}
	var payload struct {
		Body []struct {
			From    float64 `json:"from"`
			To      float64 `json:"to"`
			Content string  `json:"content"`
		} `json:"body"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		// 字幕文件是裸 JSON，不带 B站 外壳；解析失败就当没有。
		return nil
	}
	lines := make([]SubtitleLine, 0, len(payload.Body))
	for _, l := range payload.Body {
		content := strings.TrimSpace(l.Content)
		if content == "" {
			continue
		}
		lines = append(lines, SubtitleLine{From: l.From, To: l.To, Content: content})
	}
	if len(lines) == 0 {
		return nil
	}
	return lines
}

// subtitleFingerprint 是内容指纹，用于一致性投票。
func subtitleFingerprint(lines []SubtitleLine) string {
	if len(lines) == 0 {
		return "0::0"
	}
	return strconv.Itoa(len(lines)) + ":" + lines[0].Content + ":" +
		strconv.FormatFloat(lines[len(lines)-1].To, 'f', -1, 64)
}

func absFloat(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
