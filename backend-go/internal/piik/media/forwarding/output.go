// Package forwarding adapts mature RTP forwarding components without owning
// room authority, capture or a second congestion controller.
package forwarding

import (
	"io"
	"slices"
	"sync"
	"sync/atomic"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/protocol/livekit"
	"github.com/pion/webrtc/v4"
)

// Output owns allocation for one video stream on one child connection. Its
// physical owner closes it; budget changes and upstream events do not create
// another scheduler. Do not attach a StreamAllocator to the same DownTrack.
type Output struct {
	*sfu.DownTrack
	mu               sync.Mutex
	writeMu          sync.Mutex
	budget           int64
	current          int32
	allocation       sfu.VideoAllocation
	hasAllocation    bool
	closed           bool
	feedbackObserved func() bool
	congestionState  func() bwe.CongestionState
	onActivity       func()
	onDemandChanged  func()
}

// Snapshot is read by the parent at its input-frame boundary. Current means
// accepted for forwarding, not remotely decoded. Prepare admits codec work,
// not network delivery, from the latest supplied budget (initial or observed).
// Its caller gates observed-only decisions with Transport.TargetBitrate.
// -1 means no selected layer.
type Snapshot struct {
	Prepare, Target, Requested, Current int32
	Paused                              bool
	// VideoBudget is the committed estimate for this connection's tracked video.
	// It is codec input, not a claim that this bitrate is available or delivered.
	VideoBudget int64
}

func NewOutput(track *sfu.DownTrack, budget int64) *Output {
	return &Output{DownTrack: track, budget: max(budget, 0), current: -1}
}

func (output *Output) SetBudget(budget int64) {
	output.mu.Lock()
	defer output.mu.Unlock()
	budget = max(budget, 0)
	reduced := budget < output.budget
	output.budget = budget
	output.reconcileLocked(reduced)
}

func (output *Output) Reconcile() {
	output.mu.Lock()
	defer output.mu.Unlock()
	output.reconcileLocked(false)
}

func (output *Output) reconcileLocked(budgetReduced bool) {
	defer output.notifyDemand()
	if output.closed {
		return
	}
	if output.budget == 0 {
		output.allocation = output.Pause()
		output.hasAllocation = true
		return
	}
	available, rates := output.Receiver().GetLayeredBitrate()
	if len(available) > 0 {
		// Availability can precede LiveKit's asynchronous discovery notification.
		// Apply that observed layer before allocation can invalidate its target.
		output.DownTrack.UpTrackMaxPublishedLayerChange(slices.Max(available))
	}
	measured := false
	for _, layer := range available {
		if rates[layer][0] > 0 {
			measured = true
			break
		}
	}
	congestion := bwe.CongestionStateNone
	if output.congestionState != nil {
		congestion = output.congestionState()
	}
	if (!output.hasAllocation && !measured) || (output.feedbackObserved != nil && !output.feedbackObserved()) {
		if len(available) > 0 {
			// Source history is not this new connection's capacity. Bootstrap
			// through the library until video can establish real feedback;
			// pausing against the initial estimate would prevent that feedback.
			output.allocation = output.AllocateOptimal(false, congestion == bwe.CongestionStateEarlyWarning)
			output.hasAllocation = true
		}
		return
	}
	maximum := output.MaxLayer()
	target := output.allocation.TargetLayer
	targetAllowed := target.IsValid() && target.Spatial <= maximum.Spatial && target.Temporal <= maximum.Temporal &&
		slices.Contains(available, target.Spatial)
	if !measured && targetAllowed {
		return
	}
	if !budgetReduced && output.hasAllocation && congestion != bwe.CongestionStateCongested && targetAllowed &&
		rates[target.Spatial][target.Temporal] == 0 {
		// An active layer's missing rate window does not revoke its allocation.
		// Retain that target rather than optimally allocating a different layer.
		return
	}
	output.ProvisionalAllocatePrepare()
	remaining := output.budget
	retained := buffer.InvalidLayer
	if !budgetReduced && output.hasAllocation && congestion != bwe.CongestionStateCongested {
		// Match the library's cooperative allocation: changed source measurements
		// alone retain a valid target. A lower budget or confirmed congestion
		// constrains it again. Larger outputs still need available headroom.
		transition := output.ProvisionalAllocateGetCooperativeTransition(false)
		if transition.From.IsValid() && transition.From == transition.To {
			retained = transition.To
			remaining -= output.BandwidthRequested()
		} else {
			output.ProvisionalAllocateReset()
		}
	}
	controlled, ok := output.Receiver().(interface{ RateControlled(int32) bool })
	keepLowest := ok && controlled.RateControlled(0) && slices.Contains(available, int32(0))
	for spatial := int32(0); spatial <= maximum.Spatial; spatial++ {
		for temporal := int32(0); temporal <= maximum.Temporal; temporal++ {
			layer := buffer.VideoLayer{Spatial: spatial, Temporal: temporal}
			if retained.IsValid() && !layer.GreaterThan(retained) {
				continue
			}
			_, used := output.ProvisionalAllocate(remaining,
				layer, !(keepLowest && spatial == 0), false)
			remaining -= used
		}
	}
	// Only a live local encoder can follow this child's budget below the current
	// lowest-layer measurement; raw forwarding retains the library pause policy.
	output.allocation = output.ProvisionalAllocateCommit()
	output.hasAllocation = true
}

func (output *Output) State() Snapshot {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.closed {
		return Snapshot{Prepare: -1, Target: -1, Requested: -1, Current: -1, Paused: true}
	}
	prepare := int32(-1)
	receiver := output.Receiver()
	layers := buffer.GetVideoLayersForMimeType(receiver.Mime(), receiver.TrackInfo())
	maximum := output.MaxLayer().Spatial
	lowest := int32(-1)
	for _, layer := range layers {
		if layer.SpatialLayer >= 0 && layer.SpatialLayer < int32(len(layers)) &&
			layer.SpatialLayer <= maximum && layer.Bitrate > 0 {
			if lowest < 0 || layer.SpatialLayer < lowest {
				lowest = layer.SpatialLayer
			}
			if int64(layer.Bitrate) <= output.budget {
				prepare = max(prepare, layer.SpatialLayer)
			}
		}
	}
	// Below the lowest ceiling, keep one codec output eligible for rate control;
	// otherwise pausing would retire the output needed to recover delivery.
	if prepare < 0 && output.budget > 0 {
		prepare = lowest
	}
	if !output.hasAllocation {
		return Snapshot{Prepare: prepare, Target: -1, Requested: -1, Current: output.current, VideoBudget: output.budget}
	}
	return Snapshot{
		Prepare: prepare,
		Target:  output.allocation.TargetLayer.Spatial, Requested: output.allocation.RequestLayerSpatial,
		Current: output.current, Paused: !output.allocation.TargetLayer.IsValid(), VideoBudget: output.budget,
	}
}

func (output *Output) probeDemand() (int64, int64) {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.closed || !output.hasAllocation {
		return 0, 0
	}
	usage := output.BandwidthRequested()
	// A live encoder can adapt below its current logical layer's ceiling. That
	// unmet demand exists even without a higher layer; raw forwarding cannot
	// consume it. Restore it before exploring a larger spatial output.
	if ceiling := controlledLayerCeiling(output.Receiver(), output.allocation.TargetLayer.Spatial); ceiling > output.budget {
		return max(ceiling-usage, 0), usage
	}
	if transition, available := output.GetNextHigherTransition(false); available {
		return transition.BandwidthDelta, usage
	}
	// Dormant ceilings are desired demand only. They never enter the receiver's
	// measured bitrate table or authorize forwarding an unavailable layer.
	next, desired := int32(buffer.DefaultMaxLayerSpatial+1), int64(0)
	layers := buffer.GetVideoLayersForMimeType(output.Receiver().Mime(), output.Receiver().TrackInfo())
	for _, layer := range layers {
		if layer.SpatialLayer > output.allocation.TargetLayer.Spatial && layer.SpatialLayer <= output.MaxLayer().Spatial &&
			layer.SpatialLayer < next && int64(layer.Bitrate) > output.budget {
			next, desired = layer.SpatialLayer, int64(layer.Bitrate)
		}
	}
	return max(desired-usage, 0), usage
}

// BandwidthLimited includes a live encoder restricted inside its current layer.
// Packet-rate variation alone is not an allocation or congestion decision.
func (output *Output) BandwidthLimited() bool {
	output.mu.Lock()
	defer output.mu.Unlock()
	return !output.closed && output.hasAllocation && (output.IsDeficient() ||
		controlledLayerCeiling(output.Receiver(), output.allocation.TargetLayer.Spatial) > output.budget)
}

func controlledLayerCeiling(receiver sfu.TrackReceiver, spatial int32) int64 {
	controlled, ok := receiver.(interface{ RateControlled(int32) bool })
	if !ok || !controlled.RateControlled(spatial) {
		return 0
	}
	for _, layer := range buffer.GetVideoLayersForMimeType(receiver.Mime(), receiver.TrackInfo()) {
		if layer.SpatialLayer == spatial {
			return int64(layer.Bitrate)
		}
	}
	return 0
}

func (output *Output) WriteRTP(packet *buffer.ExtPacket, layer int32) int32 {
	return output.writeRTP(packet, layer, nil)
}

func (output *Output) writeRTP(packet *buffer.ExtPacket, layer int32, receiver sfu.TrackReceiver) int32 {
	if output.onActivity != nil {
		output.onActivity()
	}
	output.writeMu.Lock()
	defer output.writeMu.Unlock()
	if receiver != nil && output.Receiver() != receiver {
		return 0
	}
	output.mu.Lock()
	closed := output.closed
	output.mu.Unlock()
	if closed {
		return 0
	}
	// DownTrack listeners may read State; never hold its mutex during callbacks.
	written := output.DownTrack.WriteRTP(packet, layer)
	if written > 0 && packet.Packet.Marker {
		output.mu.Lock()
		if !output.closed {
			output.current = layer
		}
		output.mu.Unlock()
		output.notifyDemand()
	}
	return written
}

// SetReceiver registers its raw DownTrack; retain the complete output wrapper
// and reject callbacks already in flight from a detached receiver.
type outputReceiver struct {
	*Source
	output   *Output
	attached bool
}

func (receiver *outputReceiver) AddDownTrack(sfu.TrackSender) error {
	if !receiver.attached {
		return nil
	}
	sender := &outputSourceSender{Output: receiver.output, receiver: receiver}
	sender.registering.Store(true)
	err := receiver.Source.AddDownTrack(sender)
	sender.reportMu.Lock()
	sender.registering.Store(false)
	sender.reportMu.Unlock()
	return err
}

type outputSourceSender struct {
	*Output
	receiver    *outputReceiver
	registering atomic.Bool
	reportMu    sync.Mutex
}

func (sender *outputSourceSender) WriteRTP(packet *buffer.ExtPacket, layer int32) int32 {
	return sender.Output.writeRTP(packet, layer, sender.receiver)
}

func (sender *outputSourceSender) Close() {
	sender.withReceiver(sender.Output.Close)
}

func (sender *outputSourceSender) withReceiver(fn func()) {
	// AddDownTrack invokes initial metadata synchronously inside SetReceiver,
	// which already holds writeMu. Later source events take the normal lock.
	if !sender.registering.Load() {
		sender.Output.writeMu.Lock()
		defer sender.Output.writeMu.Unlock()
	}
	if sender.Output.Receiver() == sender.receiver {
		fn()
	}
}

func (sender *outputSourceSender) ReceiverRestart(receiver sfu.TrackReceiver) {
	sender.withReceiver(func() { sender.Output.receiverRestartLocked(receiver) })
}

func (sender *outputSourceSender) UpTrackLayersChange() {
	sender.withReceiver(sender.Output.UpTrackLayersChange)
}

func (sender *outputSourceSender) UpTrackBitrateAvailabilityChange() {
	sender.withReceiver(sender.Output.UpTrackBitrateAvailabilityChange)
}

func (sender *outputSourceSender) UpTrackMaxPublishedLayerChange(layer int32) {
	sender.withReceiver(func() { sender.Output.UpTrackMaxPublishedLayerChange(layer) })
}

func (sender *outputSourceSender) UpTrackMaxTemporalLayerSeenChange(layer int32) {
	sender.withReceiver(func() { sender.Output.UpTrackMaxTemporalLayerSeenChange(layer) })
}

func (sender *outputSourceSender) UpTrackBitrateReport(layers []int32, rates sfu.Bitrates) {
	sender.withReceiver(func() { sender.Output.UpTrackBitrateReport(layers, rates) })
}

func (sender *outputSourceSender) HandleRTCPSenderReportData(payloadType webrtc.PayloadType, layer int32, _ *livekit.RTCPSenderReportState) error {
	// Registration already owns writeMu. Serialize bootstrap callbacks and
	// read accepted state so a queued older snapshot cannot replace a live SR.
	apply := func() error {
		if sender.Output.Receiver() != sender.receiver {
			return nil
		}
		current := sender.receiver.currentSenderReport(layer)
		if current == nil {
			return nil
		}
		return sender.Output.HandleRTCPSenderReportData(payloadType, layer, current)
	}
	sender.reportMu.Lock()
	if sender.registering.Load() {
		defer sender.reportMu.Unlock()
		return apply()
	}
	sender.reportMu.Unlock()
	sender.Output.writeMu.Lock()
	defer sender.Output.writeMu.Unlock()
	return apply()
}

func (output *Output) replaceReceiver(receiver *outputReceiver) error {
	output.writeMu.Lock()
	defer output.writeMu.Unlock()
	if output.IsClosed() {
		return io.ErrClosedPipe
	}
	// A different source has different RTP/NTP references even with the same
	// logical layer SSRCs. Restart clears those references; Resync does not.
	output.DownTrack.ReceiverRestart(output.Receiver())
	output.DownTrack.SetReceiver(receiver)
	output.mu.Lock()
	output.current = -1
	output.hasAllocation = false
	output.reconcileLocked(false)
	output.mu.Unlock()
	return nil
}

// BeginFrame fences a controlled Native input before any of its outputs arrive.
// Raw RTP has no such boundary and keeps DownTrack's ordinary switching path.
func (output *Output) BeginFrame() {
	output.writeMu.Lock()
	defer output.writeMu.Unlock()
	output.mu.Lock()
	switching := !output.closed && output.hasAllocation && output.current >= 0 &&
		output.allocation.TargetLayer.IsValid() && output.current != output.allocation.TargetLayer.Spatial
	output.mu.Unlock()
	if !switching {
		return
	}
	output.DownTrack.Resync()
	output.mu.Lock()
	output.current = -1
	output.mu.Unlock()
}

func (output *Output) Resync() {
	output.writeMu.Lock()
	defer output.writeMu.Unlock()
	output.DownTrack.Resync()
	output.mu.Lock()
	output.current = -1
	output.hasAllocation = false
	output.mu.Unlock()
}

func (output *Output) ReceiverRestart(receiver sfu.TrackReceiver) {
	output.writeMu.Lock()
	defer output.writeMu.Unlock()
	output.receiverRestartLocked(receiver)
}

func (output *Output) receiverRestartLocked(receiver sfu.TrackReceiver) {
	output.DownTrack.ReceiverRestart(receiver)
	output.mu.Lock()
	output.current = -1
	// ReceiverBase updates availability after forwarding a new input. Arm the
	// library's existing acquisition target before that first recovery AU arrives.
	if !output.closed {
		output.allocation = output.AllocateOptimal(false, false)
		output.hasAllocation = true
	}
	output.mu.Unlock()
}

func (output *Output) SetMaxSpatialLayer(layer int32) {
	output.DownTrack.SetMaxSpatialLayer(layer)
	output.Reconcile()
}

func (output *Output) SetMaxTemporalLayer(layer int32) {
	output.DownTrack.SetMaxTemporalLayer(layer)
	output.Reconcile()
}

func (output *Output) UpTrackLayersChange() {
	output.DownTrack.UpTrackLayersChange()
	output.Reconcile()
}

func (output *Output) UpTrackBitrateAvailabilityChange() {
	output.DownTrack.UpTrackBitrateAvailabilityChange()
	output.Reconcile()
}

func (output *Output) UpTrackMaxPublishedLayerChange(layer int32) {
	output.DownTrack.UpTrackMaxPublishedLayerChange(layer)
	output.Reconcile()
}

func (output *Output) UpTrackMaxTemporalLayerSeenChange(layer int32) {
	output.DownTrack.UpTrackMaxTemporalLayerSeenChange(layer)
	output.Reconcile()
}

func (output *Output) UpTrackBitrateReport(layers []int32, rates sfu.Bitrates) {
	output.DownTrack.UpTrackBitrateReport(layers, rates)
	output.Reconcile()
}

func (output *Output) Close() {
	output.mu.Lock()
	output.closed = true
	output.mu.Unlock()
	output.DownTrack.Close()
	output.notifyDemand()
}

func (output *Output) notifyDemand() {
	if output.onDemandChanged != nil {
		output.onDemandChanged()
	}
}
