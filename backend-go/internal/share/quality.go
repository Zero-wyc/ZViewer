package share

import "time"

// 观众侧质量证据：**唯一一个「观众说自己卡」的通道**。
//
// 为什么必须由观众上报：房主侧的 `remote-inbound-rtp` 只有 RTCP 回传的
// 丢包/抖动/RTT，它不知道观众解出多少帧、冻结了多久、解码花了多少毫秒。
// 而「画面在动吗」只有接收端的 `inbound-rtp` 说得清（Piik
// `media/viewer-quality-evidence.ts` 就是为了这一条才存在的）。
//
// 与 Piik 的差别：Piik 的证据用来驱动 `route/quality.go` 里那套机会账本
// （候选排序、copy-budget 过渡、单边升级 SFU）。ZViewer 只取其中一条最直接
// 的因果：**这条边持续坏 + 有别的上游可选 → 换一个上游**。判据本身逐条对应
// Piik 的字段与阈值取向（冻结、丢包、解码耗时、帧率）。

const (
	// 一个采样窗口的合法范围，与 Piik `qualityEvidenceWindowFromMetrics` 一致。
	QualityMinWindowMs = 1_000
	QualityMaxWindowMs = 5_000

	// qualityDegradedWindows 是「持续」的门槛：两个连续窗口才算，单窗口抖动
	// 直接换父会让每次网络抽动都触发一次重连（Piik persistentDegradedWindows）。
	qualityDegradedWindows = 2
	// qualitySwitchCooldown 是两次质量换父之间的最小间隔。
	qualitySwitchCooldown = 15 * time.Second
	// qualityMaxSwitches 是一条边因质量换父的上限。超过就不再动：再换下去
	// 只是把「画质差」换成「一直重连」，更糟。
	qualityMaxSwitches = 2
	// qualityParentPenalty 是「这个上游最近被投诉过」的保留时长。它是软信号：
	// 只影响选父排序，绝不排除（Piik 的 clearPeers / remainingPeers 两段式）。
	qualityParentPenalty = 30 * time.Second
	// qualityEvidenceTTL 之后没有新窗口就把累计清零：进程停摆/页面切后台
	// 留下的旧计数不能算到下一次上。
	qualityEvidenceTTL = 8 * time.Second

	// 判据阈值。改之前先说清依据：
	//  - 冻结占比 >12% 或一个窗口冻两次：肉眼已经能看出「卡住了」；
	//  - 丢包 >8%：视频开始花屏/跳帧（Opus 靠 FEC 能撑，视频撑不住）；
	//  - 抖包延迟 >80ms：抖动缓冲已经要靠丢帧换平滑；
	//  - 解码 >22ms/帧：单线程软解 1080p 的临界，30fps 只有 33ms 预算。
	qualityFreezeShare = 0.12
	qualityFreezeCount = 2
	qualityLossShare   = 0.08
	qualityJitterMs    = 80.0
	qualityDecodeMs    = 22.0
)

// QualityWindow 是一位观众上报的一个采样窗口（线上形态，见 QualityMessage）。
//
// 全部指标都可能缺席：浏览器不同版本给的字段不一样，缺了就不下结论，
// 不拿默认值瞎判（Piik 同样全程用 `?:` 处理可选字段）。
type QualityWindow struct {
	WindowMs         int64    `json:"windowMs"`
	FramesPerSecond  *float64 `json:"framesPerSecond,omitempty"`
	FramesDropped    *float64 `json:"framesDropped,omitempty"`
	FreezeCount      *int     `json:"freezeCount,omitempty"`
	FreezeDurationMs *float64 `json:"freezeDurationMs,omitempty"`
	PacketLossRate   *float64 `json:"packetLossRate,omitempty"`
	RttMs            *float64 `json:"rttMs,omitempty"`
	JitterMs         *float64 `json:"jitterMs,omitempty"`
	DecodeMsPerFrame *float64 `json:"decodeMsPerFrame,omitempty"`
	BitrateKbps      *float64 `json:"bitrateKbps,omitempty"`
	FrameWidth       *int     `json:"width,omitempty"`
	FrameHeight      *int     `json:"height,omitempty"`
	Codec            *string  `json:"codec,omitempty"`
}

// QualityState 是一个窗口的判定结果。
type QualityState string

const (
	// QualityUnknown 表示这一窗**不能下结论**（缺字段、或问题不在边上）。
	QualityUnknown QualityState = "unknown"
	QualityHealthy QualityState = "healthy"
	// QualityDegraded 表示这条边（上游 → 我）坏了，换父有意义。
	QualityDegraded QualityState = "degraded"
	// QualityViewerLimited 表示是**我自己**解不动（解码耗时高）。
	// 换上游不会有任何改善，所以明确不做换父决策。
	QualityViewerLimited QualityState = "viewer-limited"
)

// routeQuality 是一条边的质量累计。
type routeQuality struct {
	connectionID string
	// degradedWindows 是连续降级窗口数，健康窗口会清零。
	degradedWindows int
	switches        int
	lastSwitchAt    time.Time
	lastWindowAt    time.Time
	lastState       QualityState
	lastReason      string
	// viewerLimitedWindows 只用于诊断：有多少窗口是「观众自己解不动」。
	viewerLimitedWindows int
}

// classifyQualityWindow 判一个窗口。
//
// 判定顺序是有意为之：**先排掉不可能是边的问题的成因，再判边**。
// 帧率低但没有任何网络证据时归 unknown 而不是 degraded —— 那种情况多半是
// 源端出帧不足（房主降档、暂停、或上游 CPU 限流），换上游只是白重连一次。
func classifyQualityWindow(window QualityWindow, targetFPS int) (QualityState, string) {
	if window.WindowMs < QualityMinWindowMs || window.WindowMs > QualityMaxWindowMs {
		return QualityUnknown, "window"
	}
	// 冻结是最硬的证据：这一窗里画面根本没动。没有这两项就没法判。
	if window.FreezeCount == nil || window.FreezeDurationMs == nil {
		return QualityUnknown, "no-freeze-stats"
	}
	if *window.FreezeDurationMs > float64(window.WindowMs)*qualityFreezeShare ||
		*window.FreezeCount >= qualityFreezeCount {
		return QualityDegraded, "freeze"
	}
	loss := 0.0
	if window.PacketLossRate != nil {
		loss = *window.PacketLossRate
	}
	if loss > qualityLossShare {
		return QualityDegraded, "loss"
	}
	fps := 0.0
	if window.FramesPerSecond != nil {
		fps = *window.FramesPerSecond
	}
	if targetFPS > 0 && window.FramesPerSecond != nil && fps < float64(targetFPS)*0.5 {
		// 帧率掉到目标的一半以下：先分清是「解不动」还是「收不到」。
		if window.DecodeMsPerFrame != nil && *window.DecodeMsPerFrame > qualityDecodeMs {
			return QualityViewerLimited, "decode"
		}
		jitter := 0.0
		if window.JitterMs != nil {
			jitter = *window.JitterMs
		}
		if jitter > qualityJitterMs || loss > 0.02 {
			return QualityDegraded, "stall"
		}
		return QualityUnknown, "source"
	}
	return QualityHealthy, ""
}

// sanitizeQualityWindow 把客户端给的数字夹到合理区间。
//
// 证据是**尽力而为**的输入：夹住而不是拒绝，否则一个字段超范围会让整个
// 窗口作废，等于这个观众永远不上报（Piik 的 bounded* 系列同一思路）。
func sanitizeQualityWindow(window QualityWindow) QualityWindow {
	window.FramesPerSecond = boundQualityNumber(window.FramesPerSecond, 240)
	window.FramesDropped = boundQualityNumber(window.FramesDropped, 100_000)
	window.FreezeDurationMs = boundQualityNumber(window.FreezeDurationMs, 60_000)
	// 丢包率是比例，超过 1 的一律按 1 算（100% 丢包）。
	window.PacketLossRate = boundQualityNumber(window.PacketLossRate, 1)
	window.RttMs = boundQualityNumber(window.RttMs, 60_000)
	window.JitterMs = boundQualityNumber(window.JitterMs, 60_000)
	window.DecodeMsPerFrame = boundQualityNumber(window.DecodeMsPerFrame, 10_000)
	window.BitrateKbps = boundQualityNumber(window.BitrateKbps, 1_000_000)
	if window.FreezeCount != nil {
		value := *window.FreezeCount
		if value < 0 {
			value = 0
		}
		if value > 10_000 {
			value = 10_000
		}
		window.FreezeCount = &value
	}
	window.FrameWidth = boundQualityInt(window.FrameWidth, 16_384)
	window.FrameHeight = boundQualityInt(window.FrameHeight, 16_384)
	return window
}

func boundQualityNumber(value *float64, maximum float64) *float64 {
	if value == nil {
		return nil
	}
	clamped := *value
	if clamped < 0 || !(clamped == clamped) {
		// NaN 与负数都不是合法指标；负数在差分回退时会短暂出现。
		clamped = 0
	}
	if clamped > maximum {
		clamped = maximum
	}
	return &clamped
}

func boundQualityInt(value *int, maximum int) *int {
	if value == nil {
		return nil
	}
	clamped := *value
	if clamped < 0 {
		clamped = 0
	}
	if clamped > maximum {
		clamped = maximum
	}
	return &clamped
}

// qualityForLocked 取（或新建）某位观众的质量累计。调用方必须持有 mu。
//
// 换了连接身份就重置：新的一条 PC 上，旧窗口的累计毫无意义。
func (s *Session) qualityForLocked(peerID, connectionID string) *routeQuality {
	report, ok := s.qualityReports[peerID]
	if !ok || report.connectionID != connectionID {
		report = &routeQuality{connectionID: connectionID}
		s.qualityReports[peerID] = report
	}
	return report
}

// ObserveQuality 收下一个观众侧质量窗口，必要时给这位观众换一个上游。
//
// 返回需要下发的 plans（换了父才有内容）。**不返回错误也不回报错**：证据是
// 尽力而为的输入，写错字段、版本过期、边已不存在的唯一处理就是忽略。
//
// 决策链（每一步都必须成立才会换父）：
//  1. 这是本代际、本连接、已提交的边（prepare 阶段还没有画面，谈不上质量）；
//  2. 连续 qualityDegradedWindows 个窗口判「边坏了」；
//  3. 距上次换父超过 qualitySwitchCooldown，且换过的次数没用完；
//  4. 存在另一个**可用的**上游（`selectParentExceptLocked`）。
func (s *Session) ObserveQuality(peerID string, revision int64, connectionID string, window QualityWindow) []RoutePlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.sharing || revision != s.revision || connectionID == "" {
		return nil
	}
	// 中继模式下观众订的是 SFU 的发布，不是某个 peer：换 P2P 上游没有任何
	// 意义，只会白白铸一个新 connectionId、让观众重订一次流。
	if s.relay {
		return nil
	}
	route, ok := s.routes[peerID]
	if !ok || route.ConnectionID != connectionID || route.Phase != PhaseActive {
		return nil
	}
	window = sanitizeQualityWindow(window)
	state, reason := classifyQualityWindow(window, s.quality.FrameRate)

	now := time.Now()
	report := s.qualityForLocked(peerID, connectionID)
	// 证据断了很久再回来：之前的累计不能续上（进程停摆、页面切后台）。
	if !report.lastWindowAt.IsZero() && now.Sub(report.lastWindowAt) > qualityEvidenceTTL {
		report.degradedWindows = 0
	}
	report.lastWindowAt = now
	report.lastState = state
	report.lastReason = reason

	switch state {
	case QualityDegraded:
		report.degradedWindows++
		// 这位上游被投诉了：下次给别人选父时排到最后（软信号，不排除）。
		if route.ParentPeerID != "" {
			s.parentPenalty[route.ParentPeerID] = now
		}
	case QualityHealthy:
		report.degradedWindows = 0
	case QualityViewerLimited:
		// 自己解不动：换上游不会有任何改善，也不清降级计数（边可能同时是坏的）。
		report.viewerLimitedWindows++
	}
	if report.degradedWindows < qualityDegradedWindows {
		return nil
	}
	if !report.lastSwitchAt.IsZero() && now.Sub(report.lastSwitchAt) < qualitySwitchCooldown {
		return nil
	}
	if report.switches >= qualityMaxSwitches {
		return nil
	}
	next := s.selectParentExceptLocked(peerID, route.ParentPeerID)
	if next == "" || next == route.ParentPeerID {
		// 没有别的上游可选：留在原地。质量差也好过断流。
		return nil
	}
	// 换父 = 换一条 PC：connectionId 必须重铸，旧的一端立刻作废。
	route.ParentPeerID = next
	route.ConnectionID = newConnectionID()
	route.Phase = PhasePrepare
	route.Connected = false
	report.connectionID = route.ConnectionID
	report.degradedWindows = 0
	report.switches++
	report.lastSwitchAt = now
	// 注意：**不动** MediaReady。这位观众只断一两秒，画面马上回来；而它若
	// 正在给下游转发，把上游整棵子树拆掉重挂的代价远大于这一两秒的重协商。
	s.bumpLocked()
	route.Revision = s.revision
	plans := s.plansLocked([]*Route{route})
	return append(plans, s.refreshPrepareLocked(route)...)
}

// QualityReport 返回某位观众最近一次的判定（诊断/测试用）。
func (s *Session) QualityReport(peerID string) (state QualityState, reason string, switches int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	report, ok := s.qualityReports[peerID]
	if !ok {
		return QualityUnknown, "", 0
	}
	return report.lastState, report.lastReason, report.switches
}

// parentPenalizedLocked 报告某个节点是否还在「被投诉」的保留期内。
func (s *Session) parentPenalizedLocked(peerID string, now time.Time) bool {
	at, ok := s.parentPenalty[peerID]
	if !ok {
		return false
	}
	if now.Sub(at) > qualityParentPenalty {
		delete(s.parentPenalty, peerID)
		return false
	}
	return true
}
