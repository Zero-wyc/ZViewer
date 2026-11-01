package forwarding

import (
	"bytes"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/mediatransportutil"
	"github.com/livekit/protocol/livekit"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/transport/v5/packetio"
	"github.com/pion/webrtc/v4"
)

// Bind at Pion's public TrackLocal boundary. Source buffers and the LiveKit
// forwarder run unchanged; the writer observes the exact RTP given to SRTP.
type audioTrackContext struct {
	webrtc.TrackLocalContext
	codec   webrtc.RTPCodecParameters
	packets chan *rtp.Packet
}

func (context *audioTrackContext) CodecParameters() []webrtc.RTPCodecParameters {
	return []webrtc.RTPCodecParameters{context.codec}
}
func (*audioTrackContext) SSRC() webrtc.SSRC                            { return 9000 }
func (*audioTrackContext) SSRCRetransmission() webrtc.SSRC              { return 0 }
func (context *audioTrackContext) WriteStream() webrtc.TrackLocalWriter { return context }
func (context *audioTrackContext) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	context.packets <- &rtp.Packet{Header: header.Clone(), Payload: bytes.Clone(payload)}
	return header.MarshalSize() + len(payload), nil
}
func (context *audioTrackContext) Write(data []byte) (int, error) {
	packet := &rtp.Packet{}
	if err := packet.Unmarshal(data); err != nil {
		return 0, err
	}
	return context.WriteRTP(&packet.Header, packet.Payload)
}

func TestAudioOutputRetainsClockAcrossInputLifetimeAndPacketLoss(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	codec := webrtc.RTPCodecParameters{PayloadType: 111, RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1",
	}}
	settings, registry := webrtc.SettingEngine{}, &interceptor.Registry{}
	factory, err := ConfigureAudioForwarding(&settings, registry, func(uint32) *sfu.DownTrack { return nil })
	check(err)
	output, err := NewAudioOutput(AudioOutputOptions{ID: "slot", StreamID: "room", Codec: codec,
		BufferFactory: factory, RTCPWriter: func([]rtcp.Packet) error { return nil },
	})
	check(err)
	t.Cleanup(output.Close)
	context := &audioTrackContext{codec: codec, packets: make(chan *rtp.Packet, 32)}
	_, err = output.Track().Bind(context)
	check(err)
	output.SetConnected()
	makeSource := func(id string, ssrc uint32) *Source {
		t.Helper()
		source, err := NewSource(SourceOptions{ID: id, StreamID: id, Codec: codec})
		check(err)
		t.Cleanup(source.Close)
		check(source.BindLayer(0, ssrc, webrtc.RTPParameters{Codecs: []webrtc.RTPCodecParameters{codec}}))
		if info := source.TrackInfo(); info.Type != livekit.TrackType_AUDIO || len(info.Layers) != 0 {
			t.Fatalf("audio acquired video allocation metadata: %+v", info)
		}
		return source
	}
	write := func(source *Source, ssrc uint32, sequence uint16, timestamp uint32) *rtp.Packet {
		t.Helper()
		check(source.WriteRTP(0, &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111,
			SSRC: ssrc, SequenceNumber: sequence, Timestamp: timestamp}, Payload: []byte{0xf8, 0xff, 0xfe}}))
		select {
		case packet := <-context.packets:
			return packet
		case <-time.After(time.Second):
			t.Fatal("audio did not reach the bound output")
			return nil
		}
	}
	first := makeSource("first", 1000)
	check(output.ReplaceSource(first))
	stale := first.GetDownTracks()[0]
	a := write(first, 1000, 20_000, 9_600_000)
	b := write(first, 1000, 20_001, 9_600_960)
	if b.SequenceNumber-a.SequenceNumber != 1 || b.Timestamp-a.Timestamp != 960 {
		t.Fatal("ordinary audio timing changed")
	}
	// Preserve a lost packet's sequence/timestamp space and a later DTX gap.
	c := write(first, 1000, 20_003, 9_602_880)
	late := write(first, 1000, 20_002, 9_601_920)
	d := write(first, 1000, 20_004, 9_607_680)
	if c.SequenceNumber-b.SequenceNumber != 2 || c.Timestamp-b.Timestamp != 1920 ||
		late.SequenceNumber-b.SequenceNumber != 1 || late.Timestamp-b.Timestamp != 960 ||
		d.SequenceNumber-c.SequenceNumber != 1 || d.Timestamp-c.Timestamp != 4800 {
		t.Fatal("loss or DTX was compressed out of the output timeline")
	}
	check(first.SenderReport(0, &rtcp.SenderReport{SSRC: 1000, RTPTime: 9_607_680,
		NTPTime: uint64(mediatransportutil.ToNtpTime(time.Now())), PacketCount: 4, OctetCount: 12}))
	if report := output.DownTrack().CreateSenderReport(); report == nil || report.SSRC != a.SSRC {
		t.Fatal("output did not retain its own sender report identity")
	}
	next := makeSource("next", 2000)
	check(output.ReplaceSource(next))
	// A detached source's already queued close/report cannot retire or re-clock
	// the reusable slot. The source itself may close after the new one attaches.
	stale.Close()
	check(stale.HandleRTCPSenderReportData(111, 0, nil))
	if stale.WriteRTP(&buffer.ExtPacket{Packet: &rtp.Packet{}}, 0) != 0 {
		t.Fatal("a detached broadcast wrote into the replacement")
	}
	first.Close()
	e := write(next, 2000, 1000, 480_000)
	if e.SSRC != d.SSRC || e.SequenceNumber-d.SequenceNumber != 1 || int32(e.Timestamp-d.Timestamp) <= 0 {
		t.Fatalf("independent input clock escaped into the reused slot: before=%+v after=%+v", d.Header, e.Header)
	}
	// Closing the current input detaches it, while the same output remains usable
	// for a later publication, including one which reuses its predecessor's SSRC.
	next.Close()
	if output.DownTrack().IsClosed() || output.receiver != output.idle {
		t.Fatal("input retirement destroyed the reusable output slot")
	}
	last := makeSource("last", 2000)
	check(output.ReplaceSource(last))
	f := write(last, 2000, 100, 48_000)
	if f.SSRC != e.SSRC || f.SequenceNumber-e.SequenceNumber != 1 || int32(f.Timestamp-e.Timestamp) <= 0 {
		t.Fatal("a later input could not resume the existing output clock")
	}
	output.DetachSource()
	if len(last.GetDownTracks()) != 0 || output.DownTrack().IsClosed() {
		t.Fatal("subscription removal did not detach the live input")
	}
	// The shared factory claims only outgoing DownTrack RTCP; ingress reports
	// must still be readable by the receiving connection's ordinary RTCP loop.
	input := settings.BufferFactory(packetio.RTCPBufferPacket, 1234)
	defer input.Close()
	report, err := (&rtcp.SenderReport{SSRC: 1234}).Marshal()
	check(err)
	_, err = input.Write(report)
	check(err)
	read := make([]byte, 1500)
	n, err := input.Read(read)
	check(err)
	if !bytes.Equal(read[:n], report) {
		t.Fatal("incoming RTCP was consumed by an output callback")
	}
}
