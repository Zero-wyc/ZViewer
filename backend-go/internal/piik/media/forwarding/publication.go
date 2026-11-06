package forwarding

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/livekit-server/pkg/sfu/streamallocator"
	"github.com/livekit/protocol/livekit"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/diagnostics"
	"zviewer/backend/internal/thirdparty/livekit/sendsidebwe"
)

const publicationRIDExtension = "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"
const publicationRepairRIDExtension = "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id"

// Publication sends existing representations over one simulcast connection.
// LiveKit's allocator owns all track allocations and probes on the shared BWE.
type Publication struct {
	PC          *webrtc.PeerConnection
	source      *Source
	tracks      []*sfu.DownTrack
	counters    []publicationCounters
	audioBytes  atomic.Uint64
	allocator   *streamallocator.StreamAllocator
	bandwidth   *publicationBWE
	pacer       *publicationPacer
	mu          sync.Mutex
	writeMu     sync.Mutex
	attached    bool
	closed      bool
	activeCount int
	readers     sync.WaitGroup
	closeOnce   sync.Once
	closeErr    error
}

func NewPublication(options TransportOptions) (_ *Publication, err error) {
	if options.Source == nil || options.ConnectionID == "" || options.InitialBitrate <= 0 {
		return nil, errors.New("publication options are invalid")
	}
	publication := &Publication{source: options.Source, activeCount: len(options.Source.TrackInfo().Layers)}
	publication.counters = make([]publicationCounters, publication.activeCount)
	defer func() {
		if err != nil {
			_ = publication.Close()
		}
	}()
	log := diagnostics.MediaLogger("publication").WithValues("connectionId", diagnostics.ID(options.ConnectionID))
	publication.bandwidth = &publicationBWE{SendSideBWE: sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: log,
	})}
	publication.bandwidth.target.Store(int64(options.InitialBitrate))
	publication.pacer = &publicationPacer{headers: make(map[uint32]publicationHeaders), boundedPacer: newPacedQueue(
		log, options.Source.maxPackets, options.InitialBitrate,
	)}
	publication.bandwidth.pacer = publication.pacer.boundedPacer
	publication.pacer.sender = pacer.NewBase(log, publication.bandwidth)
	publication.allocator = streamallocator.NewStreamAllocator(streamallocator.StreamAllocatorParams{
		Config: streamallocator.DefaultStreamAllocatorConfig, BWE: publication.bandwidth,
		// AdditionalProbeDemand 是 Piik 所用 livekit-server 版本才有的字段，
		// ZViewer 固定在上游 v1.13.11，这里去掉。影响仅是探测略保守，
		// 详见 internal/piik/README.md。
		Pacer: publication.pacer, Logger: log,
	}, true, true)
	publication.allocator.Start()
	media := &webrtc.MediaEngine{}
	codec := options.Source.Codec()
	if err = registerVideoCodec(media, codec); err != nil {
		return nil, err
	}
	for _, uri := range []string{
		"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
		"urn:ietf:params:rtp-hdrext:sdes:mid", publicationRIDExtension, publicationRepairRIDExtension,
	} {
		if err = media.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: uri}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
	}
	if options.Audio != nil {
		audio, ok := options.Audio.(interface {
			Codec() webrtc.RTPCodecCapability
		})
		if !ok {
			return nil, errors.New("publication audio codec is unavailable")
		}
		if err = media.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: audio.Codec(), PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
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
	if err = configureRTCPReports(registry, func(ssrc uint32) *sfu.DownTrack {
		for _, track := range publication.tracks {
			if track.SSRC() == ssrc {
				return track
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	publication.PC, err = webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	var transceiver *webrtc.RTPTransceiver
	// Pion's diagnostic PC.ID is clock-based and can repeat. Source membership
	// needs a unique physical owner even when signaling reuses a connection ID.
	subscriberID := rand.Text()
	for index := range options.Source.TrackInfo().Layers {
		receiver := &publicationLayer{Source: options.Source, layer: int32(index), publication: publication}
		track, trackErr := sfu.NewDownTrack(sfu.DownTrackParams{
			Codecs: []webrtc.RTPCodecParameters{codec}, Source: livekit.TrackSource_SCREEN_SHARE,
			Receiver: receiver, BufferFactory: factory,
			SubID:    livekit.ParticipantID(subscriberID + "_" + strconv.Itoa(index)),
			StreamID: options.Source.StreamID(), MaxTrack: options.Source.maxPackets,
			Pacer: publication.pacer, Logger: log, Listener: publication,
			RTCPWriter: publication.PC.WriteRTCP, DisableSenderReportPassThrough: true,
			EnableStartAtDesiredQuality: true,
		})
		if trackErr != nil {
			return nil, trackErr
		}
		publication.tracks = append(publication.tracks, track)
		track.SetMaxSpatialLayer(int32(index))
		local := &publicationTrack{DownTrack: track, id: options.Source.TrackID(), rid: PublicationRID(index, publication.activeCount), pacer: publication.pacer, counters: &publication.counters[index]}
		if transceiver == nil {
			transceiver, err = publication.PC.AddTransceiverFromTrack(local, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		} else {
			err = transceiver.Sender().AddEncoding(local)
		}
		if err != nil {
			return nil, err
		}
		local.transceiver = transceiver
		track.SetTransceiver(transceiver)
		publication.allocator.AddTrack(track, streamallocator.AddTrackParams{
			Source: livekit.TrackSource_SCREEN_SHARE, IsMultiLayered: true,
			PublisherID: livekit.ParticipantID(options.Source.StreamID()),
		})
	}
	if options.Audio != nil {
		sender, audioErr := publication.PC.AddTrack(&publicationAudio{TrackLocal: options.Audio, bytes: &publication.audioBytes})
		if audioErr != nil {
			return nil, audioErr
		}
		publication.readers.Add(1)
		go func() {
			defer publication.readers.Done()
			for {
				if _, _, readErr := sender.ReadRTCP(); readErr != nil {
					return
				}
			}
		}()
	}
	return publication, nil
}

func PublicationRID(layer, count int) string {
	if count == 1 {
		return ""
	}
	return []string{"q", "h", "f"}[layer]
}

func (publication *Publication) SetConnected() error {
	publication.mu.Lock()
	defer publication.mu.Unlock()
	if publication.closed {
		return io.ErrClosedPipe
	}
	if publication.attached {
		return nil
	}
	for _, track := range publication.tracks {
		receiver := track.Receiver().(*publicationLayer)
		receiver.attached = true
		if err := receiver.AddDownTrack(track); err != nil {
			receiver.attached = false
			return err
		}
		track.SetConnected()
	}
	publication.attached = true
	return nil
}

func (publication *Publication) CurrentSource() *Source {
	publication.mu.Lock()
	defer publication.mu.Unlock()
	return publication.source
}

// ReplaceSource keeps every RID, allocator, counter and sender on this PC.
func (publication *Publication) ReplaceSource(next *Source) error {
	recovery := false
	// Source feedback may retire this publication; release all locks first.
	defer func() {
		if recovery {
			for layer := range next.TrackInfo().Layers {
				next.SendPLI(int32(layer), true)
			}
		}
	}()
	publication.mu.Lock()
	defer publication.mu.Unlock()
	if publication.closed {
		return io.ErrClosedPipe
	}
	if next == nil {
		return errors.New("replacement publication source is absent")
	}
	next.mu.Lock()
	defer next.mu.Unlock()
	if err := validateReplacement(publication.source, next); err != nil {
		return err
	}
	if next == publication.source {
		return nil
	}
	publication.writeMu.Lock()
	defer publication.writeMu.Unlock()
	for _, track := range publication.tracks {
		if track.IsClosed() {
			return io.ErrClosedPipe
		}
	}
	for index, track := range publication.tracks {
		receiver := &publicationLayer{Source: next, layer: int32(index), publication: publication, attached: publication.attached}
		track.ReceiverRestart(track.Receiver())
		track.SetReceiver(receiver)
		// The subscribed max layer did not change, so SetReceiver's layer
		// notification alone does not wake the allocator for this fresh input.
		publication.allocator.OnSubscriptionChanged(track)
	}
	publication.source = next
	recovery = publication.attached
	return nil
}

func (publication *Publication) SetActiveCount(count int) error {
	publication.mu.Lock()
	defer publication.mu.Unlock()
	if publication.closed {
		return io.ErrClosedPipe
	}
	if count < 0 || count > len(publication.tracks) {
		return errors.New("publication layer demand is invalid")
	}
	publication.activeCount = count
	for index, track := range publication.tracks {
		// Publisher demand is authoritative even while allocation is paused;
		// subscription visibility mute may be ignored by the framework then.
		track.PubMute(index >= count)
	}
	return nil
}

func (publication *Publication) RequiredActiveCount() int {
	publication.mu.Lock()
	defer publication.mu.Unlock()
	if publication.closed || !publication.attached {
		return 0
	}
	// The allocator still needs actual input for requested encodings when it
	// probes recovery. This is codec demand, not affordable or delivered upload.
	return publication.activeCount
}

func (publication *Publication) VideoBudget() int64 {
	return publication.bandwidth.target.Load()
}
func (publication *Publication) LowestLayerBudget() int64 {
	remaining := publication.VideoBudget()
	for _, track := range publication.tracks[1:] {
		remaining -= track.BandwidthRequested()
	}
	return max(remaining, 0)
}

// A local encoder can need more bandwidth without another spatial layer.
// Keep desired output separate from measured source bitrate and capacity;
// the allocator remains the only owner of probe timing and recovery.
func (publication *Publication) encoderProbeDemand() int64 {
	publication.mu.Lock()
	defer publication.mu.Unlock()
	if publication.closed || !publication.attached || publication.activeCount == 0 {
		return 0
	}
	ceiling := controlledLayerCeiling(publication.source, 0)
	if ceiling <= publication.LowestLayerBudget() {
		return 0
	}
	return max(ceiling-publication.tracks[0].BandwidthRequested(), 0)
}

type PublicationCounters struct {
	Frames                 []uint64
	VideoBytes, AudioBytes uint64
	TargetBitrate          int64
	Observed, Limited      bool
}

func (publication *Publication) Counters() PublicationCounters {
	publication.mu.Lock()
	defer publication.mu.Unlock()
	stats := PublicationCounters{Frames: make([]uint64, len(publication.counters)),
		AudioBytes: publication.audioBytes.Load(), TargetBitrate: publication.bandwidth.target.Load(),
		Observed: publication.bandwidth.observed.Load(), Limited: !publication.bandwidth.probing.Load() &&
			publication.bandwidth.CongestionState() == bwe.CongestionStateCongested}
	if publication.activeCount > 0 && controlledLayerCeiling(publication.source, 0) > publication.LowestLayerBudget() {
		stats.Limited = true
	}
	for index := range publication.counters {
		stats.Frames[index] = publication.counters[index].frames.Load()
		stats.VideoBytes += publication.counters[index].bytes.Load()
		if index < publication.activeCount && publication.tracks[index].IsDeficient() {
			stats.Limited = true
		}
	}
	return stats
}

func (publication *Publication) Close() error {
	publication.closeOnce.Do(func() {
		publication.mu.Lock()
		publication.closed = true
		publication.mu.Unlock()
		if publication.PC != nil {
			publication.closeErr = publication.PC.Close()
		}
		if publication.allocator != nil {
			publication.allocator.Stop()
		}
		for _, track := range publication.tracks {
			publication.source.DeleteDownTrack(track.SubscriberID())
			track.Close()
		}
		if publication.pacer != nil {
			publication.pacer.Stop()
		}
		publication.readers.Wait()
	})
	return publication.closeErr
}

func (*Publication) OnBindAndConnected() {}
func (publication *Publication) OnStatsUpdate(stats *livekit.AnalyticsStat) {
	if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
		slog.Debug("media-stats", "scope", "publication", "rtcPeerId", diagnostics.ID(publication.PC.ID()),
			"rtp", stats, "egress", publication.pacer.stats(), "targetBitrate", publication.bandwidth.target.Load(),
			"pendingPackets", publication.pacer.pendingCount(), "packetCapacity", publication.pacer.limit)
	}
}
func (*Publication) OnMaxSubscribedLayerChanged(int32) {}
func (publication *Publication) OnRttUpdate(rtt uint32) {
	publication.bandwidth.UpdateRTT(float64(rtt) / 1000)
}
func (*Publication) OnCodecNegotiated(webrtc.RTPCodecCapability) {}
func (*Publication) OnDownTrackClose(bool)                       {}
func (*Publication) OnStreamStarted(time.Duration)               {}

// Each RID exposes precisely one existing layer to the allocator; another RID
// can never substitute the same lower output and charge it twice.
type publicationLayer struct {
	*Source
	layer       int32
	publication *Publication
	attached    bool
}

func (layer *publicationLayer) AddDownTrack(sender sfu.TrackSender) error {
	if !layer.attached {
		return nil
	}
	filtered := &publicationLayerSender{
		DownTrack: sender.(*sfu.DownTrack), layer: layer.layer, receiver: layer,
	}
	filtered.registering.Store(true)
	err := layer.Source.AddDownTrack(filtered)
	filtered.reportMu.Lock()
	filtered.registering.Store(false)
	filtered.reportMu.Unlock()
	return err
}

func (layer *publicationLayer) TrackID() livekit.TrackID {
	return livekit.TrackID(string(layer.Source.TrackID()) + "_" + strconv.Itoa(int(layer.layer)))
}
func (layer *publicationLayer) GetLayeredBitrate() ([]int32, sfu.Bitrates) {
	available, rates := layer.Source.GetLayeredBitrate()
	return onlyPublicationLayer(layer.layer, available, rates)
}
func (*publicationLayer) SetMaxExpectedSpatialLayer(int32) {}

func onlyPublicationLayer(layer int32, available []int32, rates sfu.Bitrates) ([]int32, sfu.Bitrates) {
	var selected sfu.Bitrates
	selected[layer] = rates[layer]
	for _, index := range available {
		if index == layer {
			return []int32{layer}, selected
		}
	}
	return nil, selected
}

type publicationLayerSender struct {
	*sfu.DownTrack
	layer       int32
	receiver    *publicationLayer
	registering atomic.Bool
	reportMu    sync.Mutex
}

func (sender *publicationLayerSender) UpTrackBitrateReport(available []int32, rates sfu.Bitrates) {
	sender.withReceiver(func() {
		available, rates = onlyPublicationLayer(sender.layer, available, rates)
		sender.DownTrack.UpTrackBitrateReport(available, rates)
	})
}
func (sender *publicationLayerSender) WriteRTP(packet *buffer.ExtPacket, layer int32) int32 {
	sender.receiver.publication.writeMu.Lock()
	defer sender.receiver.publication.writeMu.Unlock()
	if sender.Receiver() != sender.receiver {
		return 0
	}
	if layer != sender.layer {
		return 0
	}
	return sender.DownTrack.WriteRTP(packet, layer)
}

func (sender *publicationLayerSender) Close() {
	sender.withReceiver(sender.DownTrack.Close)
}

func (sender *publicationLayerSender) withReceiver(fn func()) {
	if !sender.registering.Load() {
		sender.receiver.publication.writeMu.Lock()
		defer sender.receiver.publication.writeMu.Unlock()
	}
	if sender.Receiver() == sender.receiver {
		fn()
	}
}

func (sender *publicationLayerSender) ReceiverRestart(receiver sfu.TrackReceiver) {
	sender.withReceiver(func() { sender.DownTrack.ReceiverRestart(receiver) })
}

func (sender *publicationLayerSender) UpTrackLayersChange() {
	sender.withReceiver(sender.DownTrack.UpTrackLayersChange)
}

func (sender *publicationLayerSender) UpTrackBitrateAvailabilityChange() {
	sender.withReceiver(sender.DownTrack.UpTrackBitrateAvailabilityChange)
}

func (sender *publicationLayerSender) UpTrackMaxPublishedLayerChange(layer int32) {
	sender.withReceiver(func() { sender.DownTrack.UpTrackMaxPublishedLayerChange(layer) })
}

func (sender *publicationLayerSender) UpTrackMaxTemporalLayerSeenChange(layer int32) {
	sender.withReceiver(func() { sender.DownTrack.UpTrackMaxTemporalLayerSeenChange(layer) })
}

func (sender *publicationLayerSender) HandleRTCPSenderReportData(payloadType webrtc.PayloadType, layer int32, _ *livekit.RTCPSenderReportState) error {
	apply := func() error {
		if sender.Receiver() != sender.receiver {
			return nil
		}
		current := sender.receiver.currentSenderReport(layer)
		if current == nil {
			return nil
		}
		return sender.DownTrack.HandleRTCPSenderReportData(payloadType, layer, current)
	}
	sender.reportMu.Lock()
	if sender.registering.Load() {
		defer sender.reportMu.Unlock()
		return apply()
	}
	sender.reportMu.Unlock()
	sender.receiver.publication.writeMu.Lock()
	defer sender.receiver.publication.writeMu.Unlock()
	return apply()
}

type publicationTrack struct {
	*sfu.DownTrack
	id          livekit.TrackID
	rid         string
	transceiver *webrtc.RTPTransceiver
	pacer       *publicationPacer
	counters    *publicationCounters
}

func (track *publicationTrack) ID() string  { return string(track.id) }
func (track *publicationTrack) RID() string { return track.rid }
func (track *publicationTrack) Bind(context webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	var extension, repairExtension, midExtension uint8
	for _, header := range context.HeaderExtensions() {
		if header.URI == publicationRIDExtension {
			extension = uint8(header.ID)
		}
		if header.URI == publicationRepairRIDExtension {
			repairExtension = uint8(header.ID)
		}
		if header.URI == "urn:ietf:params:rtp-hdrext:sdes:mid" {
			midExtension = uint8(header.ID)
		}
	}
	if track.rid != "" && extension == 0 {
		return webrtc.RTPCodecParameters{}, errors.New("publication RID was not negotiated")
	}
	track.pacer.headersMu.Lock()
	track.pacer.headers[uint32(context.SSRC())] = publicationHeaders{rid: track.rid, extension: extension,
		mid: track.transceiver.Mid(), midExtension: midExtension, counters: track.counters}
	if ssrc := context.SSRCRetransmission(); ssrc != 0 {
		track.pacer.headers[uint32(ssrc)] = publicationHeaders{rid: track.rid, extension: repairExtension,
			mid: track.transceiver.Mid(), midExtension: midExtension, counters: track.counters}
	}
	track.pacer.headersMu.Unlock()
	return track.DownTrack.Bind(context)
}

type publicationHeaders struct {
	rid, mid                string
	extension, midExtension uint8
	counters                *publicationCounters
}

type publicationCounters struct{ frames, bytes atomic.Uint64 }

type publicationWriter struct {
	webrtc.TrackLocalWriter
	bytes   *atomic.Uint64
	frames  *atomic.Uint64
	primary bool
}

func (writer *publicationWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	written, err := writer.TrackLocalWriter.WriteRTP(header, payload)
	if err == nil && written > 0 {
		size := header.MarshalSize() + len(payload)
		if header.Padding {
			size += int(header.PaddingSize)
		}
		writer.bytes.Add(uint64(size))
		if writer.frames != nil && writer.primary && header.Marker && len(payload) > 0 {
			writer.frames.Add(1)
		}
	}
	return written, err
}

type publicationAudio struct {
	webrtc.TrackLocal
	bytes *atomic.Uint64
}

func (audio *publicationAudio) Bind(context webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	return audio.TrackLocal.Bind(publicationAudioContext{TrackLocalContext: context,
		writer: &publicationWriter{TrackLocalWriter: context.WriteStream(), bytes: audio.bytes}})
}

type publicationAudioContext struct {
	webrtc.TrackLocalContext
	writer webrtc.TrackLocalWriter
}

func (context publicationAudioContext) WriteStream() webrtc.TrackLocalWriter { return context.writer }

// TWCC measures video and its probes. Audio shares the path but is not counted
// in this estimate; subtracting it here would understate the video budget.
type publicationBWE struct {
	*sendsidebwe.SendSideBWE
	pacer    *boundedPacer
	listener bwe.BWEListener
	target   atomic.Int64
	observed atomic.Bool
	probing  atomic.Bool
}

func (bandwidth *publicationBWE) HandleTWCCFeedback(report *rtcp.TransportLayerCC) {
	bandwidth.observed.Store(true)
	bandwidth.SendSideBWE.HandleTWCCFeedback(report)
}

func (bandwidth *publicationBWE) SetBWEListener(listener bwe.BWEListener) {
	bandwidth.listener = listener
	bandwidth.SendSideBWE.SetBWEListener(bandwidth)
}

func (bandwidth *publicationBWE) ProbeClusterStarting(info ccutils.ProbeClusterInfo) {
	bandwidth.probing.Store(true)
	bandwidth.SendSideBWE.ProbeClusterStarting(info)
}

func (bandwidth *publicationBWE) Reset() {
	bandwidth.SendSideBWE.Reset()
	bandwidth.probing.Store(false)
}

func (bandwidth *publicationBWE) OnCongestionStateChange(from, to bwe.CongestionState, capacity int64) {
	// As for an individual Transport, only a completed non-congesting probe
	// can raise capacity. The allocator ignores congestion during a probe; the
	// encoder-facing budget must retain that same value through settling.
	if !bandwidth.probing.Load() && to == bwe.CongestionStateCongested && capacity > 0 && capacity < bandwidth.target.Load() {
		bandwidth.target.Store(capacity)
		if bandwidth.pacer != nil {
			bandwidth.pacer.SetBitrate(int(capacity))
		}
	}
	bandwidth.listener.OnCongestionStateChange(from, to, bandwidth.target.Load())
}
func (bandwidth *publicationBWE) ProbeClusterFinalize() (ccutils.ProbeSignal, int64, bool) {
	signal, capacity, done := bandwidth.SendSideBWE.ProbeClusterFinalize()
	if done && signal == ccutils.ProbeSignalNotCongesting && capacity > bandwidth.target.Load() {
		bandwidth.target.Store(capacity)
		if bandwidth.pacer != nil {
			bandwidth.pacer.SetBitrate(int(capacity))
		}
	}
	if done {
		bandwidth.probing.Store(false)
	}
	return signal, bandwidth.target.Load(), done
}

type publicationPacer struct {
	*boundedPacer
	headersMu sync.Mutex
	headers   map[uint32]publicationHeaders
}

func (queue *publicationPacer) Enqueue(packet *pacer.Packet) {
	queue.headersMu.Lock()
	headers := queue.headers[packet.Header.SSRC]
	queue.headersMu.Unlock()
	if headers.extension != 0 && headers.rid != "" {
		_ = packet.Header.SetExtension(headers.extension, []byte(headers.rid))
	}
	if headers.midExtension != 0 {
		_ = packet.Header.SetExtension(headers.midExtension, []byte(headers.mid))
	}
	packet.HeaderSize = packet.Header.MarshalSize()
	if headers.counters != nil {
		packet.WriteStream = &publicationWriter{TrackLocalWriter: packet.WriteStream,
			bytes: &headers.counters.bytes, frames: &headers.counters.frames, primary: !packet.IsRTX && !packet.IsProbe}
	}
	queue.boundedPacer.Enqueue(packet)
}
func (queue *publicationPacer) EndProbeCluster(id ccutils.ProbeClusterId) ccutils.ProbeClusterInfo {
	info := queue.boundedPacer.EndProbeCluster(id)
	queue.cancelProbes(id)
	return info
}
