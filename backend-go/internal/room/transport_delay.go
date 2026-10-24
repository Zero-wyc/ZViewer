package room

import "time"

// 写侧传输延迟补偿。
//
// 房主上报的 currentTime 是「客户端发出时刻」的进度，到达服务器时若仍在
// 播放，实际进度已前进了 (now - clientTs) × playbackRate。把这段在途时间
// 补回再写入基线，服务器记录的进度才锚定在服务器时间轴上——这是「观众
// 进度统一读服务器推算值」的前提。缺了这步，观众每次请求状态都会比房主
// 慢半个 RTT，越播越明显。
//
// 两个钳位与 Node 版一致：
//   - 客户端时钟快于服务器时 (now - clientTs) < 0，钳为 0（不回拨进度）；
//   - 网络异常导致延迟虚高时上限 1.5s，防止大跳变。

// TransportDelayCompensationMaxSec 是补偿上限（秒）。
const TransportDelayCompensationMaxSec = 1.5

// TransportDelayParams 是补偿入参。
type TransportDelayParams struct {
	// CurrentTime 客户端上报的进度（秒）。
	CurrentTime float64
	// ClientTs 客户端发送时刻（Unix 毫秒）；0 表示没传，不补偿。
	ClientTs int64
	// PlaybackRate 播放倍速。
	PlaybackRate float64
	// IsPlaying 是否正在播放（暂停态进度凝固，不补偿）。
	IsPlaying bool
	// Now 服务器当前时刻（毫秒），0 表示取当前时间；测试可注入。
	Now int64
}

// CompensateTransportDelay 返回补偿后的进度（秒）。
func CompensateTransportDelay(p TransportDelayParams) float64 {
	if p.ClientTs <= 0 {
		return p.CurrentTime
	}
	// 暂停态：客户端发出与服务器收到之间进度不变。
	if !p.IsPlaying {
		return p.CurrentTime
	}
	if p.PlaybackRate <= 0 {
		return p.CurrentTime
	}
	now := p.Now
	if now <= 0 {
		now = nowMillis()
	}
	delay := float64(now-p.ClientTs) / 1000
	// 客户端时钟快于服务器（或同刻到达）：钳为 0，不回拨。
	if delay <= 0 {
		return p.CurrentTime
	}
	if delay > TransportDelayCompensationMaxSec {
		delay = TransportDelayCompensationMaxSec
	}
	return p.CurrentTime + delay*p.PlaybackRate
}

// CheckStatusToleranceSec 是观众自检的进度容差（秒）。
//
// 这个通道是「服务器心跳丢失时的兜底自愈」，不是主校正路径，容差必须
// 显著大于主路径阈值，否则两条通道互相触发，观众端会持续小幅抖动。
const CheckStatusToleranceSec = 10

// NeedsProgressSyncParams 是自检判定入参。
type NeedsProgressSyncParams struct {
	ClientCurrentTime  float64
	ClientIsPlaying    bool
	ClientPlaybackRate float64
	ClientTs           int64
	ServerCurrentTime  float64
	ServerIsPlaying    bool
	Now                int64
}

// NeedsProgressSync 判断客户端状态是否分歧到需要下发纠偏。
// 判定：isPlaying 不一致，或补偿后的客户端进度与服务器推算值偏差超容差。
// **不比对 playbackRate**——观众端软同步追赶会临时 +0.1 倍速，比对倍速
// 会在追赶期误触发纠偏、打断收敛。
func NeedsProgressSync(p NeedsProgressSyncParams) bool {
	if p.ClientIsPlaying != p.ServerIsPlaying {
		return true
	}
	rate := p.ClientPlaybackRate
	if rate <= 0 {
		rate = 1
	}
	compensated := CompensateTransportDelay(TransportDelayParams{
		CurrentTime:  p.ClientCurrentTime,
		ClientTs:     p.ClientTs,
		PlaybackRate: rate,
		IsPlaying:    p.ClientIsPlaying,
		Now:          p.Now,
	})
	diff := compensated - p.ServerCurrentTime
	if diff < 0 {
		diff = -diff
	}
	return diff > CheckStatusToleranceSec
}

// nowMillis 把「取当前毫秒」收成一处，便于统一替换成可注入时钟。
func nowMillis() int64 { return time.Now().UnixMilli() }
