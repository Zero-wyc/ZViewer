package forwarding

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/livekit-server/pkg/sfu/streamallocator"
	packetpacer "github.com/livekit/mediatransportutil/pkg/pacer"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/diagnostics"
	"zviewer/backend/internal/thirdparty/livekit/sendsidebwe"
)

type TransportOptions struct {
	Source         *Source
	Settings       webrtc.SettingEngine
	ConnectionID   string
	InitialBitrate int
	Audio          webrtc.TrackLocal
	// OnDemandChanged must only signal its owner without blocking or reentering
	// Transport. Callers can coalesce signals in their existing bounded owner.
	OnDemandChanged func()
}

// Transport is outgoing-only. Its caller owns signaling, ICE events and the
// shared UDP mux. Video RTCP is callback-driven; never read VideoSender's RTCP.
type Transport struct {
	PC           *webrtc.PeerConnection
	Output       *Output
	VideoSender  *webrtc.RTPSender
	AudioSender  *webrtc.RTPSender
	source       *Source
	estimator    *sendsidebwe.SendSideBWE
	prober       *ccutils.Prober
	probe        ccutils.ProbeClusterInfo
	target       atomic.Int64
	pacer        *boundedPacer
	observed     atomic.Bool
	mu           sync.Mutex
	attached     bool
	closed       bool
	paddingReady bool
	closeOnce    sync.Once
	closeErr     error
	readers      sync.WaitGroup
}

func NewTransport(options TransportOptions) (_ *Transport, err error) {
	if options.Source == nil || options.ConnectionID == "" || options.InitialBitrate <= 0 {
		return nil, errors.New("forwarding transport options are invalid")
	}
	transport := &Transport{source: options.Source}
	transport.target.Store(int64(options.InitialBitrate))
	defer func() {
		if err != nil {
			_ = transport.Close()
		}
	}()
	codec := options.Source.Codec()
	media := &webrtc.MediaEngine{}
	if err = registerVideoCodec(media, codec); err != nil {
		return nil, err
	}
	if options.Audio != nil {
		audio, ok := options.Audio.(interface {
			Codec() webrtc.RTPCodecCapability
		})
		if !ok {
			return nil, errors.New("forwarding audio codec is unavailable")
		}
		if err = media.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: audio.Codec(), PayloadType: 111,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, err
		}
	}
	factory := buffer.NewFactoryOfBufferFactory(options.Source.maxPackets, buffer.InitPacketBufferSizeAudio).CreateBufferFactory()
	settings := options.Settings
	if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
		settings.LoggerFactory = diagnostics.PionLoggerFactory("connectionId", diagnostics.ID(options.ConnectionID))
	}
	settings.BufferFactory = packetBufferFactory(factory)
	registry := &interceptor.Registry{}
	// LiveKit records actual paced sends and owns this extension's sequence space.
	if err = media.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{
		URI: "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	// DownTrack owns video retransmission; registering default NACK interceptors
	// here would create a second responder. Pion schedules reports, while the
	// DownTrack supplies its projected video clock and matching RTT state.
	if err = configureRTCPReports(registry, func(ssrc uint32) *sfu.DownTrack {
		if transport.Output.SSRC() == ssrc {
			return transport.Output.DownTrack
		}
		return nil
	}); err != nil {
		return nil, err
	}
	transport.PC, err = webrtc.NewAPI(webrtc.WithMediaEngine(media),
		webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	log := diagnostics.MediaLogger("transport").WithValues("connectionId", diagnostics.ID(options.ConnectionID))
	log.Debugw("transport-created", "rtcPeerId", diagnostics.ID(transport.PC.ID()), "codec", codec.MimeType,
		"initialBitrate", options.InitialBitrate, "packetCapacity", options.Source.maxPackets)
	transport.estimator = sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: log,
	})
	transport.estimator.SetBWEListener(transport)
	transport.prober = ccutils.NewProber(ccutils.ProberParams{Listener: transport, Logger: log})
	transport.pacer = newPacedQueue(log, options.Source.maxPackets, options.InitialBitrate)
	transport.pacer.sender = pacer.NewBase(log, transport.estimator)
	transport.pacer.SetPacerProbeObserverListener(transport)
	track, err := sfu.NewDownTrack(sfu.DownTrackParams{
		Codecs: []webrtc.RTPCodecParameters{codec}, Source: livekit.TrackSource_SCREEN_SHARE,
		Receiver: &outputReceiver{Source: options.Source}, BufferFactory: factory, SubID: livekit.ParticipantID(options.ConnectionID),
		StreamID: options.Source.StreamID(), MaxTrack: options.Source.maxPackets,
		Pacer: transport.pacer, Logger: log, Listener: transport,
		RTCPWriter: transport.PC.WriteRTCP, DisableSenderReportPassThrough: true,
		EnableStartAtDesiredQuality: true,
	})
	if err != nil {
		return nil, err
	}
	transport.Output = NewOutput(track, int64(options.InitialBitrate))
	transport.Output.feedbackObserved = transport.observed.Load
	transport.Output.congestionState = transport.estimator.CongestionState
	track.Receiver().(*outputReceiver).output = transport.Output
	transport.Output.onActivity = transport.mediaActivity
	transport.Output.onDemandChanged = options.OnDemandChanged
	track.SetStreamAllocatorListener(transport)
	track.AddReceiverReportListener(func(*sfu.DownTrack, *rtcp.ReceiverReport) {
		transport.mu.Lock()
		defer transport.mu.Unlock()
		if !transport.closed {
			transport.paddingReady = true
			transport.driveProbeLocked()
		}
	})
	transport.Output.SetMaxSpatialLayer(int32(len(options.Source.TrackInfo().Layers) - 1))
	transceiver, err := transport.PC.AddTransceiverFromTrack(track,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return nil, err
	}
	track.SetTransceiver(transceiver)
	transport.VideoSender = transceiver.Sender()
	if options.Audio != nil {
		transport.AudioSender, err = transport.PC.AddTrack(options.Audio)
		if err != nil {
			return nil, err
		}
		transport.readers.Add(1)
		go func() {
			defer transport.readers.Done()
			for {
				if _, _, readErr := transport.AudioSender.ReadRTCP(); readErr != nil {
					return
				}
			}
		}()
	}
	return transport, nil
}

func (transport *Transport) SetConnected() error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.closed {
		return io.ErrClosedPipe
	}
	if transport.attached {
		return nil
	}
	receiver := transport.Output.Receiver().(*outputReceiver)
	receiver.attached = true
	if err := receiver.AddDownTrack(transport.Output); err != nil {
		receiver.attached = false
		return err
	}
	transport.attached = true
	transport.Output.SetConnected()
	transport.Output.Reconcile()
	return nil
}

func (transport *Transport) CurrentSource() *Source {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.source
}

// ReplaceSource retains the connection and its congestion state. The caller
// prepares recovery in next and serializes group lifetime with this handoff.
func (transport *Transport) ReplaceSource(next *Source) error {
	recovery := false
	// Register first so feedback runs after every lock below has been released.
	defer func() {
		if recovery {
			for layer := range next.TrackInfo().Layers {
				next.SendPLI(int32(layer), true)
			}
		}
	}()
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.closed || transport.Output.IsClosed() {
		return io.ErrClosedPipe
	}
	if next == nil {
		return errors.New("replacement video source is absent")
	}
	next.mu.Lock()
	defer next.mu.Unlock()
	if err := validateReplacement(transport.source, next); err != nil {
		return err
	}
	if next == transport.source {
		return nil
	}
	receiver := &outputReceiver{Source: next, output: transport.Output, attached: transport.attached}
	if err := transport.Output.replaceReceiver(receiver); err != nil {
		return err
	}
	transport.source = next
	recovery = transport.attached
	return nil
}

// next.mu prevents source closure between validation and receiver attachment.
func validateReplacement(current, next *Source) error {
	if next.closed || next.IsClosed() {
		return io.ErrClosedPipe
	}
	before, after := current.Codec(), next.Codec()
	if before.PayloadType != after.PayloadType || before.MimeType != after.MimeType ||
		before.ClockRate != after.ClockRate || before.Channels != after.Channels ||
		before.SDPFmtpLine != after.SDPFmtpLine || !slices.Equal(before.RTCPFeedback, after.RTCPFeedback) ||
		current.TrackID() != next.TrackID() || current.StreamID() != next.StreamID() ||
		current.VideoLayerMode() != next.VideoLayerMode() || current.maxPackets != next.maxPackets ||
		len(current.TrackInfo().Layers) != len(next.TrackInfo().Layers) ||
		!slices.Equal(current.HeaderExtensions(), next.HeaderExtensions()) {
		return errors.New("replacement video source changed its transport contract")
	}
	return nil
}

// TargetBitrate reports capacity for TWCC-tracked video, not total link capacity.
func (transport *Transport) TargetBitrate() (int, bool) {
	return int(transport.target.Load()), transport.observed.Load()
}

func (transport *Transport) BandwidthLimited() bool {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.Output.BandwidthLimited() || (transport.probe.Id == ccutils.ProbeClusterIdInvalid &&
		transport.estimator.CongestionState() == bwe.CongestionStateCongested)
}

func (transport *Transport) RequiredActiveCount() int {
	state := transport.Output.State()
	highest := state.Target
	if !state.Paused {
		highest = max(highest, state.Current)
	}
	if transport.observed.Load() {
		highest = max(highest, state.Prepare)
	}
	if highest < 0 && !state.Paused {
		highest = transport.Output.MaxLayer().Spatial
	}
	return int(highest + 1)
}

// Egress counts successful RTP writes, including headers but excluding SRTP/UDP
// overhead. It is local delivery to Pion, not proof of remote receipt or decode.
func (transport *Transport) Egress() EgressStats {
	return transport.pacer.stats()
}

func (transport *Transport) refreshBudgetLocked() {
	if transport.probe.Id == ccutils.ProbeClusterIdInvalid || transport.probe.Result.EndTime != 0 {
		transport.pacer.SetBitrate(int(transport.target.Load()))
	}
	transport.Output.SetBudget(transport.target.Load())
}

func (transport *Transport) Close() error {
	transport.closeOnce.Do(func() {
		transport.mu.Lock()
		transport.closed = true
		attached := transport.attached
		transport.stopProbeLocked()
		transport.mu.Unlock()
		if transport.PC != nil {
			transport.closeErr = transport.PC.Close()
		}
		if transport.Output != nil {
			if attached {
				transport.source.DeleteDownTrack(transport.Output.SubscriberID())
			}
			transport.Output.Close()
		}
		if transport.pacer != nil {
			transport.pacer.Stop()
		}
		transport.readers.Wait()
	})
	return transport.closeErr
}

// LiveKit delivers feedback without a ReadRTCP loop on its callback reader.
func (transport *Transport) OnTransportCCFeedback(_ *sfu.DownTrack, packet *rtcp.TransportLayerCC) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if !transport.closed {
		transport.estimator.HandleTWCCFeedback(packet)
		transport.observed.Store(true)
		transport.refreshBudgetLocked()
		transport.driveProbeLocked()
	}
}

// HandleTWCCFeedback invokes this synchronously under the transport's event
// lock. Like LiveKit's allocator, retain committed capacity while a recovery
// probe is sending or settling; its congestion ends exploration in driveProbeLocked.
// Outside that probe, congestion can reduce capacity; only a valid completed
// probe can increase it. Warning/clear transitions are not capacity measurements.
func (transport *Transport) OnCongestionStateChange(_, state bwe.CongestionState, capacity int64) {
	if transport.probe.Id == ccutils.ProbeClusterIdInvalid &&
		state == bwe.CongestionStateCongested && capacity > 0 && capacity < transport.target.Load() {
		transport.target.Store(capacity)
	}
}

func (*Transport) OnREMB(*sfu.DownTrack, *rtcp.ReceiverEstimatedMaximumBitrate) {}
func (*Transport) OnAvailableLayersChanged(*sfu.DownTrack)                      {}
func (*Transport) OnBitrateAvailabilityChanged(*sfu.DownTrack)                  {}
func (*Transport) OnMaxPublishedSpatialChanged(*sfu.DownTrack)                  {}
func (*Transport) OnMaxPublishedTemporalChanged(*sfu.DownTrack)                 {}
func (*Transport) OnSubscribedLayerChanged(*sfu.DownTrack, buffer.VideoLayer)   {}
func (*Transport) OnResume(*sfu.DownTrack)                                      {}
func (*Transport) IsBWEEnabled(*sfu.DownTrack) bool                             { return true }
func (*Transport) BWEType() bwe.BWEType                                         { return bwe.BWETypeSendSide }
func (*Transport) IsSubscribeMutable(*sfu.DownTrack) bool                       { return true }
func (transport *Transport) OnSubscriptionChanged(*sfu.DownTrack)               { transport.Output.Reconcile() }
func (*Transport) OnBindAndConnected()                                          {}
func (transport *Transport) OnStatsUpdate(stats *livekit.AnalyticsStat) {
	if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
		slog.Debug("media-stats", "scope", "forwarding", "rtcPeerId", diagnostics.ID(transport.PC.ID()),
			"rtp", stats, "egress", transport.Egress(), "targetBitrate", transport.target.Load(),
			"pendingPackets", transport.pacer.pendingCount(), "packetCapacity", transport.pacer.limit)
	}
}
func (*Transport) OnMaxSubscribedLayerChanged(int32) {}
func (transport *Transport) OnRttUpdate(rtt uint32) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if !transport.closed {
		transport.estimator.UpdateRTT(float64(rtt) / 1000)
	}
}
func (*Transport) OnCodecNegotiated(webrtc.RTPCodecCapability) {}
func (*Transport) OnDownTrackClose(bool)                       {}
func (*Transport) OnStreamStarted(time.Duration)               {}

// Probe orchestration below adapts the single-track flow from LiveKit v1.13.6:
// https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/streamallocator/streamallocator.go
// Copyright 2023 LiveKit, Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software distributed
// under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
// CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.

func (transport *Transport) mediaActivity() {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.driveProbeLocked()
}

func (transport *Transport) driveProbeLocked() {
	if transport.closed || !transport.attached || transport.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		transport.paddingReady = false
		transport.stopProbeLocked()
		return
	}
	if transport.probe.Id != ccutils.ProbeClusterIdInvalid {
		demand, _ := transport.Output.probeDemand()
		if transport.probe.Result.EndTime == 0 && (!transport.paddingReady || demand <= 0 ||
			transport.estimator.CongestionState() != bwe.CongestionStateNone || transport.estimator.ProbeClusterIsGoalReached() ||
			time.Since(transport.probe.CreatedAt) >= transport.probe.Goal.Duration) {
			transport.stopProbeLocked()
		}
		if transport.probe.Result.EndTime != 0 {
			if signal, capacity, finalized := transport.estimator.ProbeClusterFinalize(); finalized {
				if signal == ccutils.ProbeSignalNotCongesting && capacity > transport.target.Load() {
					transport.target.Store(capacity)
				}
				transport.probe = ccutils.ProbeClusterInfoInvalid
				transport.refreshBudgetLocked()
			}
		}
	}
	config := streamallocator.DefaultStreamAllocatorConfig
	if transport.Output.State().Paused && transport.estimator.CongestionState() != bwe.CongestionStateNone &&
		transport.pacer.TimeSinceLastSentPacket() > config.PausedMinWait {
		transport.stopProbeLocked()
		transport.estimator.Reset()
		transport.probe = ccutils.ProbeClusterInfoInvalid
	}
	if transport.probe.Id != ccutils.ProbeClusterIdInvalid || !transport.paddingReady ||
		!transport.observed.Load() || !transport.estimator.CanProbe() {
		return
	}
	delta, usage := transport.Output.probeDemand()
	if delta <= 0 {
		return
	}
	goal := ccutils.ProbeClusterGoal{AvailableBandwidthBps: int(transport.target.Load()),
		ExpectedUsageBps: int(usage), DesiredBps: int(usage + max(delta*config.ProbeOveragePct/100, config.ProbeMinBps)),
		Duration: transport.estimator.ProbeDuration()}
	transport.probe = transport.prober.AddCluster(ccutils.ProbeClusterModeUniform, goal)
	transport.estimator.ProbeClusterStarting(transport.probe)
	transport.pacer.StartProbeCluster(transport.probe)
	transport.Output.SetProbeClusterId(transport.probe.Id)
}

func (transport *Transport) stopProbeLocked() {
	if transport.probe.Id == ccutils.ProbeClusterIdInvalid || transport.probe.Result.EndTime != 0 {
		return
	}
	transport.probe = transport.pacer.EndProbeCluster(transport.probe.Id)
	transport.Output.SwapProbeClusterId(transport.probe.Id, ccutils.ProbeClusterIdInvalid)
	transport.estimator.ProbeClusterDone(transport.probe)
	transport.prober.Reset(transport.probe)
	transport.pacer.cancelProbes(transport.probe.Id)
}

// AddCluster returns the exact cluster synchronously. Initializing it there
// avoids reentering the Prober while its own cluster-start mutex is held.
func (*Transport) OnProbeClusterSwitch(ccutils.ProbeClusterInfo) {}

func (transport *Transport) OnSendProbe(bytesToSend int) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.driveProbeLocked()
	if transport.probe.Id == ccutils.ProbeClusterIdInvalid || transport.probe.Result.EndTime != 0 {
		return
	}
	written := transport.Output.WriteProbePackets(bytesToSend, true)
	transport.prober.ProbesSent(written)
	// Zero can be a temporary non-frame-boundary. The library-supplied cluster
	// duration bounds retries; only connection/RR authority controls readiness.
}

func (transport *Transport) OnPacerProbeObserverClusterComplete(id ccutils.ProbeClusterId) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.probe.Id == id {
		transport.stopProbeLocked()
	}
}

type EgressStats struct {
	// Drops include canceled probe padding and queued packets retired at close.
	Packets, RTPBytes, DroppedPackets uint64
}

// The SDK owns packet timing; bounded tickets keep original packet ownership
// here until a ticket sends or Stop retires it. SFU's unpaced writer assumes
// already-paced input, which does not hold for locally encoded whole frames.
type boundedPacer struct {
	packetpacer.Pacer
	sender  *pacer.Base
	recycle *pacer.Base
	bitrate atomic.Int64
	mu      sync.Mutex
	pending map[*pacedPacket]struct{}
	limit   int
	closed  bool
	packets atomic.Uint64
	bytes   atomic.Uint64
	dropped atomic.Uint64
	last    atomic.Int64
}

func newPacedQueue(log logger.Logger, limit, bitrate int) *boundedPacer {
	// A 3 ms service interval spreads native frame bursts across shallow network
	// queues; retain Pion's 1.5 pacing headroom. The SDK's 200 ms drain target
	// prevents a stale low estimate from trapping already encoded frames for
	// seconds; this is not a network latency promise.
	queue := newBoundedPacer(packetpacer.NewPacerLeakyBucket(3*time.Millisecond,
		int(float64(bitrate)*1.5), 200*time.Millisecond, log), log, limit)
	queue.bitrate.Store(int64(bitrate))
	return queue
}

func newBoundedPacer(packetPacer packetpacer.Pacer, log logger.Logger, limit int) *boundedPacer {
	packetPacer.Start()
	return &boundedPacer{Pacer: packetPacer, sender: pacer.NewBase(log, nil), recycle: pacer.NewBase(log, nil),
		pending: make(map[*pacedPacket]struct{}), limit: limit}
}

func (queue *boundedPacer) SetBitrate(bitrate int) {
	queue.bitrate.Store(int64(bitrate))
	queue.Pacer.SetBitrate(int(float64(bitrate) * 1.5))
}

func (queue *boundedPacer) Enqueue(packet *pacer.Packet) {
	queue.mu.Lock()
	if queue.closed || len(queue.pending) >= queue.limit {
		queue.mu.Unlock()
		queue.dropped.Add(1)
		queue.discard(packet)
		return
	}
	ticket := &pacedPacket{owner: queue, packet: packet}
	queue.pending[ticket] = struct{}{}
	// The SDK reads the cloned header and payload length, then writes through the
	// ticket. Only our sender reads payload bytes or assigns TWCC identity;
	// cancellation can release its pools before the scheduling ticket is visited.
	header := packet.Header.Clone()
	proxy := &packetpacer.Packet{Header: &header, Payload: packet.Payload, Writer: ticket.WriteRTP}
	// The SDK counts header and payload, but omits RTP padding. This proxy is
	// only a scheduling ticket; the original packet owns serialization below.
	if header.PaddingSize > 0 {
		proxy.Payload = make([]byte, len(packet.Payload)+int(header.PaddingSize))
	}
	queue.mu.Unlock()
	queue.Pacer.Enqueue(proxy)
}

func (queue *boundedPacer) discard(packet *pacer.Packet) {
	packet.WriteStream = closedPacketWriter{}
	// Base owns all header/payload/packet pool returns, including failed writes.
	_, _ = queue.recycle.SendPacket(packet)
}

func (queue *boundedPacer) cancelProbes(id ccutils.ProbeClusterId) {
	queue.mu.Lock()
	var packets []*pacer.Packet
	for ticket := range queue.pending {
		if ticket.packet != nil && ticket.packet.IsProbe && ticket.packet.ProbeClusterId == id {
			packets = append(packets, ticket.packet)
			ticket.packet = nil
			// The scheduling proxy still occupies the library queue. Keep its
			// admission slot charged until that proxy is actually dequeued.
		}
	}
	queue.mu.Unlock()
	for _, packet := range packets {
		queue.dropped.Add(1)
		queue.discard(packet)
	}
}

func (queue *boundedPacer) SetPacerProbeObserverListener(listener pacer.PacerProbeObserverListener) {
	queue.sender.SetPacerProbeObserverListener(listener)
}

func (queue *boundedPacer) StartProbeCluster(info ccutils.ProbeClusterInfo) {
	queue.sender.StartProbeCluster(info)
	queue.Pacer.SetBitrate(int(float64(info.Goal.DesiredBps) * 1.5))
}

func (queue *boundedPacer) EndProbeCluster(id ccutils.ProbeClusterId) ccutils.ProbeClusterInfo {
	queue.Pacer.SetBitrate(int(float64(queue.bitrate.Load()) * 1.5))
	return queue.sender.EndProbeCluster(id)
}

func (queue *boundedPacer) Stop() {
	queue.mu.Lock()
	if queue.closed {
		queue.mu.Unlock()
		return
	}
	queue.closed = true
	packets := make([]*pacer.Packet, 0, len(queue.pending))
	for ticket := range queue.pending {
		if ticket.packet != nil {
			packets = append(packets, ticket.packet)
		}
		ticket.packet = nil
	}
	clear(queue.pending)
	queue.Pacer.Stop()
	queue.mu.Unlock()
	for _, packet := range packets {
		queue.dropped.Add(1)
		queue.discard(packet)
	}
}

func (queue *boundedPacer) TimeSinceLastSentPacket() time.Duration {
	return time.Since(time.Unix(0, queue.last.Load()))
}

func (queue *boundedPacer) stats() EgressStats {
	return EgressStats{Packets: queue.packets.Load(), RTPBytes: queue.bytes.Load(), DroppedPackets: queue.dropped.Load()}
}

func (queue *boundedPacer) pendingCount() int {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	return len(queue.pending)
}

type pacedPacket struct {
	owner  *boundedPacer
	packet *pacer.Packet
}

func (ticket *pacedPacket) WriteRTP(*rtp.Header, []byte) (int, error) {
	queue := ticket.owner
	queue.mu.Lock()
	packet := ticket.packet
	ticket.packet = nil
	delete(queue.pending, ticket)
	queue.mu.Unlock()
	if packet == nil {
		return 0, io.ErrClosedPipe
	}
	written, err := queue.sender.SendPacket(packet)
	if err == nil && written > 0 {
		queue.packets.Add(1)
		queue.bytes.Add(uint64(written))
		queue.last.Store(time.Now().UnixNano())
	}
	return written, err
}

func (*pacedPacket) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

type closedPacketWriter struct{}

func (closedPacketWriter) WriteRTP(*rtp.Header, []byte) (int, error) { return 0, io.ErrClosedPipe }
func (closedPacketWriter) Write([]byte) (int, error)                 { return 0, io.ErrClosedPipe }
