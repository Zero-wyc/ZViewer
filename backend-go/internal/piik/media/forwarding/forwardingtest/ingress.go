// Package forwardingtest exercises shared media boundaries through real Pion peers.
package forwardingtest

import (
	"bytes"
	"context"
	"encoding/binary"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/media/forwarding"
)

type repairLoss struct {
	interceptor.NoOp
	allowRepair atomic.Bool
	repairs     atomic.Uint32
}

func (loss *repairLoss) NewInterceptor(string) (interceptor.Interceptor, error) { return loss, nil }

func (loss *repairLoss) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if header.SSRC == info.SSRC && header.SequenceNumber == 17 {
			return header.MarshalSize() + len(payload), nil
		}
		if header.SSRC == info.SSRCRetransmission && len(payload) >= 2 && binary.BigEndian.Uint16(payload) == 17 {
			if !loss.allowRepair.Load() {
				return header.MarshalSize() + len(payload), nil
			}
			loss.repairs.Add(1)
		}
		return writer.Write(header, payload, attributes)
	})
}

// IngressRepair checks the actual receiving owner, not a standalone NACK log.
// The callback installs a normal Native receiver or SFU publication and returns
// its physical connection and admitted primary source.
func IngressRepair(t *testing.T, receive func(webrtc.SessionDescription, webrtc.SettingEngine) (*webrtc.PeerConnection, func() *forwarding.Source)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 7*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wait := func(done <-chan struct{}) {
		t.Helper()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	media := &webrtc.MediaEngine{}
	check(media.RegisterDefaultCodecs())
	registry := &interceptor.Registry{}
	loss := &repairLoss{}
	// Drop after the stock responder has cached the original packet.
	registry.Add(loss)
	check(webrtc.RegisterDefaultInterceptors(media, registry))
	check(webrtc.ConfigureTWCCHeaderExtensionSender(media, registry))
	sender, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer sender.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000}, "screen", "repair")
	check(err)
	videoSender, err := sender.AddTrack(track)
	check(err)
	var nacks, reports, feedback atomic.Uint32
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			packets, _, err := videoSender.ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				switch packet := packet.(type) {
				case *rtcp.TransportLayerNack:
					for _, pair := range packet.Nacks {
						for _, sequence := range pair.PacketList() {
							if sequence == 17 {
								nacks.Add(1)
							}
						}
					}
				case *rtcp.ReceiverReport:
					reports.Add(1)
				case *rtcp.TransportLayerCC:
					feedback.Add(1)
				}
			}
		}
	}()
	defer func() { _ = sender.Close(); <-readDone }()
	offer, err := sender.CreateOffer(nil)
	check(err)
	gathered := webrtc.GatheringCompletePromise(sender)
	check(sender.SetLocalDescription(offer))
	wait(gathered)
	receiver, source := receive(*sender.LocalDescription(), settings)
	wait(webrtc.GatheringCompletePromise(receiver))
	check(sender.SetRemoteDescription(*receiver.LocalDescription()))
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	payload := append([]byte{0x10}, sfu.VP8KeyFrame8x8...)
	sequence := uint16(1)
	var repairedAt time.Time
	var settledNACKs uint32
	var settledAt time.Time
	for {
		select {
		case <-ctx.Done():
			t.Fatalf("repair did not settle: NACK=%d RTX=%d RR=%d TWCC=%d", nacks.Load(), loss.repairs.Load(), reports.Load(), feedback.Load())
		case <-ticker.C:
		}
		check(track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, Marker: true,
			SequenceNumber: sequence, Timestamp: uint32(sequence) * 1800}, Payload: payload}))
		sequence++
		// Keep the real hole open through several feedback opportunities.
		if nacks.Load() >= 3 {
			loss.allowRepair.Store(true)
		}
		if repairedAt.IsZero() && loss.repairs.Load() > 0 && source() != nil {
			raw := make([]byte, 1500)
			n, err := source().ReadRTP(raw, 0, 17)
			if err == nil {
				packet := &rtp.Packet{}
				check(packet.Unmarshal(raw[:n]))
				primaryRaw := make([]byte, 1500)
				n, err = source().ReadRTP(primaryRaw, 0, 16)
				check(err)
				primary := &rtp.Packet{}
				check(primary.Unmarshal(primaryRaw[:n]))
				if packet.SequenceNumber != 17 || packet.Timestamp != 17*1800 ||
					packet.SSRC != primary.SSRC || packet.PayloadType != uint8(source().Codec().PayloadType) ||
					!bytes.Equal(packet.Payload, payload) {
					t.Fatal("repair did not restore the admitted primary packet")
				}
				repairedAt = time.Now()
			}
		}
		if !repairedAt.IsZero() && time.Since(repairedAt) >= 150*time.Millisecond && settledAt.IsZero() {
			settledNACKs, settledAt = nacks.Load(), time.Now()
		}
		if !settledAt.IsZero() && time.Since(settledAt) >= 700*time.Millisecond {
			if got := nacks.Load(); got != settledNACKs {
				t.Fatalf("repaired primary still NACKed: before=%d after=%d", settledNACKs, got)
			}
			if reports.Load() > 0 && feedback.Load() > 0 {
				t.Logf("unrepaired hole retried; cached primary repaired; NACK=%d RTX=%d RR=%d TWCC=%d", nacks.Load(), loss.repairs.Load(), reports.Load(), feedback.Load())
				return
			}
		}
	}
}
