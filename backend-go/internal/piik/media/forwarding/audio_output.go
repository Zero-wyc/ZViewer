package forwarding

import (
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/protocol/livekit"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/diagnostics"
)

// ConfigureAudioForwarding installs callback-driven RTCP only for DownTracks.
// Incoming tracks retain ordinary Pion buffers and their ReadRTCP reader. Call
// this instead of registering another sender/receiver report interceptor pair.
func ConfigureAudioForwarding(settings *webrtc.SettingEngine, registry *interceptor.Registry,
	lookup func(uint32) *sfu.DownTrack,
) (*buffer.Factory, error) {
	factory := buffer.NewFactoryOfBufferFactory(buffer.InitPacketBufferSizeVideo, buffer.InitPacketBufferSizeAudio).CreateBufferFactory()
	settings.BufferFactory = packetBufferFactory(factory)
	if err := configureRTCPReports(registry, lookup); err != nil {
		return nil, err
	}
	return factory, nil
}

type AudioOutputOptions struct {
	ID, StreamID  string
	Codec         webrtc.RTPCodecParameters
	BufferFactory *buffer.Factory
	RTCPWriter    func([]rtcp.Packet) error
}

// AudioOutput retains one negotiated sender's clock across input publications.
// Its caller owns subscription authority; detaching synchronously fences input
// callbacks without retiring the reusable sender or adding an SDP media section.
type AudioOutput struct {
	mu       sync.Mutex
	track    *sfu.DownTrack
	idle     *audioReceiver
	receiver *audioReceiver
}

func NewAudioOutput(options AudioOutputOptions) (*AudioOutput, error) {
	if !strings.EqualFold(options.Codec.MimeType, webrtc.MimeTypeOpus) || options.BufferFactory == nil || options.RTCPWriter == nil {
		return nil, errors.New("forwarded audio output is invalid")
	}
	idle, err := NewSource(SourceOptions{ID: options.ID, StreamID: options.StreamID, Codec: options.Codec})
	if err != nil {
		return nil, err
	}
	output := &AudioOutput{}
	output.idle = &audioReceiver{Source: idle, output: output}
	output.receiver = output.idle
	log := diagnostics.MediaLogger("audio-output").WithValues("trackId", diagnostics.ID(options.ID))
	output.track, err = sfu.NewDownTrack(sfu.DownTrackParams{
		Codecs: []webrtc.RTPCodecParameters{options.Codec}, Receiver: output.idle,
		Source: livekit.TrackSource_MICROPHONE, StreamID: options.StreamID,
		SubID: livekit.ParticipantID(options.ID), BufferFactory: options.BufferFactory,
		MaxTrack: buffer.InitPacketBufferSizeAudio, Pacer: pacer.NewPassThrough(log, nil),
		Logger: log, Listener: output, RTCPWriter: options.RTCPWriter,
		DisableSenderReportPassThrough: true,
	})
	if err != nil {
		idle.Close()
		return nil, err
	}
	return output, nil
}

func (output *AudioOutput) Track() webrtc.TrackLocal                { return output.track }
func (output *AudioOutput) DownTrack() *sfu.DownTrack               { return output.track }
func (output *AudioOutput) SetTransceiver(t *webrtc.RTPTransceiver) { output.track.SetTransceiver(t) }
func (output *AudioOutput) SetConnected()                           { output.track.SetConnected() }

func (output *AudioOutput) ReplaceSource(next *Source) error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.track.IsClosed() {
		return io.ErrClosedPipe
	}
	if next == nil {
		return errors.New("replacement audio source is absent")
	}
	next.mu.Lock()
	defer next.mu.Unlock()
	if next.closed || next.IsClosed() {
		return io.ErrClosedPipe
	}
	before, after := output.idle.Codec(), next.Codec()
	if next.Kind() != webrtc.RTPCodecTypeAudio || before.MimeType != after.MimeType ||
		before.ClockRate != after.ClockRate || before.Channels != after.Channels {
		return errors.New("replacement audio source changed its codec")
	}
	if output.receiver.Source == next {
		return nil
	}
	output.track.ReceiverRestart(output.receiver)
	output.receiver = &audioReceiver{Source: next, output: output, attached: true}
	output.track.SetReceiver(output.receiver)
	// AddDownTrack's live reports take mu. Replay the current accepted clock
	// here, outside its synchronous registration callback, with the same fence.
	if report := next.currentSenderReport(0); report != nil {
		_ = output.track.HandleRTCPSenderReportData(after.PayloadType, 0, report)
	}
	return nil
}

func (output *AudioOutput) DetachSource() {
	output.mu.Lock()
	defer output.mu.Unlock()
	output.detachLocked()
}

func (output *AudioOutput) detachLocked() {
	if output.track.IsClosed() || output.receiver == output.idle {
		return
	}
	output.receiver = output.idle
	output.track.SetReceiver(output.idle)
}

func (output *AudioOutput) Close() {
	output.mu.Lock()
	output.detachLocked()
	output.track.CloseWithFlush(false, true)
	output.mu.Unlock()
	output.idle.Source.Close()
}

// The empty receiver keeps an idle slot bound. Each real receiver registers a
// source-specific sender so detached broadcasts cannot enter its replacement.
type audioReceiver struct {
	*Source
	output   *AudioOutput
	attached bool
}

func (receiver *audioReceiver) AddDownTrack(sfu.TrackSender) error {
	if !receiver.attached {
		return nil
	}
	return receiver.Source.ReceiverBase.AddDownTrack(&audioSourceSender{
		DownTrack: receiver.output.track, receiver: receiver,
	})
}

type audioSourceSender struct {
	*sfu.DownTrack
	receiver *audioReceiver
}

func (sender *audioSourceSender) WriteRTP(packet *buffer.ExtPacket, layer int32) int32 {
	output := sender.receiver.output
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.receiver != sender.receiver {
		return 0
	}
	return output.track.WriteRTP(packet, layer)
}

func (sender *audioSourceSender) Close() {
	output := sender.receiver.output
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.receiver == sender.receiver {
		output.detachLocked()
	}
}

func (sender *audioSourceSender) ReceiverRestart(receiver sfu.TrackReceiver) {
	output := sender.receiver.output
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.receiver == sender.receiver {
		output.track.ReceiverRestart(receiver)
	}
}

func (sender *audioSourceSender) HandleRTCPSenderReportData(payloadType webrtc.PayloadType, layer int32, _ *livekit.RTCPSenderReportState) error {
	output := sender.receiver.output
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.receiver != sender.receiver {
		return nil
	}
	if report := sender.receiver.currentSenderReport(layer); report != nil {
		return output.track.HandleRTCPSenderReportData(payloadType, layer, report)
	}
	return nil
}

func (*AudioOutput) OnBindAndConnected()                         {}
func (*AudioOutput) OnStatsUpdate(*livekit.AnalyticsStat)        {}
func (*AudioOutput) OnMaxSubscribedLayerChanged(int32)           {}
func (*AudioOutput) OnRttUpdate(uint32)                          {}
func (*AudioOutput) OnCodecNegotiated(webrtc.RTPCodecCapability) {}
func (*AudioOutput) OnDownTrackClose(bool)                       {}
func (*AudioOutput) OnStreamStarted(time.Duration)               {}
