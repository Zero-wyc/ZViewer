package forwarding

import (
	"bytes"
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// The second repair read begins only after Pion has queued the first repair.
// This fences the startup race without sleeping or accessing library internals.
type queuedRepair struct {
	interceptor.NoOp
	queued      chan struct{}
	once        sync.Once
	primary     chan struct{}
	primaryOnce sync.Once
	inject      chan func(*rtp.Packet) error
	localOnce   sync.Once
}

func (observer *queuedRepair) NewInterceptor(string) (interceptor.Interceptor, error) {
	return observer, nil
}

// Raw Pion tracks leave simulcast extensions to their sender. Mirror a Browser's
// repaired RID so the receiver binds the retransmission to the original layer.
func (observer *queuedRepair) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	var rid, repaired uint8
	for _, extension := range info.RTPHeaderExtensions {
		if extension.URI == publicationRIDExtension {
			rid = uint8(extension.ID)
		} else if extension.URI == "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id" {
			repaired = uint8(extension.ID)
		}
	}
	// A valid repair can arrive while the primary SSRC probe still awaits RID.
	// Inject it through the real negotiated SRTP writer to control that ordering.
	observer.localOnce.Do(func() {
		observer.inject <- func(packet *rtp.Packet) error {
			header := packet.Header.Clone()
			header.SSRC, header.PayloadType = info.SSRCRetransmission, info.PayloadTypeRetransmission
			if err := header.DelExtension(rid); err != nil {
				return err
			}
			if err := header.SetExtension(repaired, []byte("q")); err != nil {
				return err
			}
			_, err := writer.Write(&header, append([]byte{0, 1}, packet.Payload...), nil)
			return err
		}
	})
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if header.SSRC == info.SSRCRetransmission && rid != 0 && repaired != 0 {
			repairedHeader := header.Clone()
			value := repairedHeader.GetExtension(rid)
			if err := repairedHeader.DelExtension(rid); err != nil {
				return 0, err
			}
			if err := repairedHeader.SetExtension(repaired, value); err != nil {
				return 0, err
			}
			header = &repairedHeader
		}
		return writer.Write(header, payload, attributes)
	})
}

func (observer *queuedRepair) BindRemoteStream(info *interceptor.StreamInfo, reader interceptor.RTPReader) interceptor.RTPReader {
	if !strings.EqualFold(info.MimeType, webrtc.MimeTypeRTX) {
		return interceptor.RTPReaderFunc(func(data []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
			n, attr, err := reader.Read(data, attributes)
			if err == nil {
				observer.primaryOnce.Do(func() { close(observer.primary) })
			}
			return n, attr, err
		})
	}
	read := false
	return interceptor.RTPReaderFunc(func(data []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		if read {
			observer.once.Do(func() { close(observer.queued) })
		}
		read = true
		return reader.Read(data, attributes)
	})
}

func TestReadRTPEarlySimulcastRepairRetainsNegotiatedIdentity(t *testing.T) {
	for _, beforePrimary := range []bool{false, true} {
		name := "before-first-read"
		if beforePrimary {
			name = "before-primary-admission"
		}
		t.Run(name, func(t *testing.T) { testEarlySimulcastRepair(t, beforePrimary) })
	}
}

func testEarlySimulcastRepair(t *testing.T, beforePrimary bool) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	observer := &queuedRepair{queued: make(chan struct{}), primary: make(chan struct{}), inject: make(chan func(*rtp.Packet) error, 1)}
	newPeer := func() *webrtc.PeerConnection {
		engine := &webrtc.MediaEngine{}
		check(engine.RegisterDefaultCodecs())
		registry := &interceptor.Registry{}
		registry.Add(observer)
		check(webrtc.RegisterDefaultInterceptors(engine, registry))
		settings := webrtc.SettingEngine{}
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
		settings.SetIncludeLoopbackCandidate(true)
		settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
		peer, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry),
			webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
		check(err)
		t.Cleanup(func() { _ = peer.Close() })
		return peer
	}
	publisher, subscriber := newPeer(), newPeer()
	codec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000}
	low, err := webrtc.NewTrackLocalStaticRTP(codec, "screen", "repair", webrtc.WithRTPStreamID("q"))
	check(err)
	high, err := webrtc.NewTrackLocalStaticRTP(codec, "screen", "repair", webrtc.WithRTPStreamID("h"))
	check(err)
	sender, err := publisher.AddTrack(low)
	check(err)
	check(sender.AddEncoding(high))
	go func() {
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	tracks := make(chan *webrtc.TrackRemote, 1)
	var remoteReceiver *webrtc.RTPReceiver
	subscriber.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		remoteReceiver = receiver
		tracks <- track
	})
	negotiate := func(from, to *webrtc.PeerConnection, description webrtc.SessionDescription) {
		gathered := webrtc.GatheringCompletePromise(from)
		check(from.SetLocalDescription(description))
		select {
		case <-gathered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		check(to.SetRemoteDescription(*from.LocalDescription()))
	}
	offer, err := publisher.CreateOffer(nil)
	check(err)
	negotiate(publisher, subscriber, offer)
	answer, err := subscriber.CreateAnswer(nil)
	check(err)
	negotiate(subscriber, publisher, answer)
	packet := &rtp.Packet{Header: rtp.Header{Version: 2, Marker: true, SequenceNumber: 1, Timestamp: 3000}, Payload: []byte{0x10, 0x00}}
	for _, extension := range sender.GetParameters().HeaderExtensions {
		switch extension.URI {
		case "urn:ietf:params:rtp-hdrext:sdes:mid":
			check(packet.SetExtension(uint8(extension.ID), []byte(publisher.GetTransceivers()[0].Mid())))
		case publicationRIDExtension:
			check(packet.SetExtension(uint8(extension.ID), []byte("q")))
		}
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	var remote *webrtc.TrackRemote
	if beforePrimary {
		// Hold primary admission after reading a packet without RID. Repair already
		// carries repaired RID, so Pion queues it before primary SSRC is initialized.
		initial := packet.Clone()
		for _, extension := range sender.GetParameters().HeaderExtensions {
			if extension.URI == publicationRIDExtension {
				check(initial.DelExtension(uint8(extension.ID)))
			}
		}
		waiting := true
		for waiting {
			select {
			case <-observer.primary:
				waiting = false
			case <-ticker.C:
				check(low.WriteRTP(initial))
			case <-ctx.Done():
				t.Fatal("primary probe did not read:", ctx.Err())
			}
		}
		inject := <-observer.inject
		check(inject(packet))
		select {
		case <-observer.queued:
		case <-ctx.Done():
			t.Fatal("early repair was not queued:", ctx.Err())
		}
		packet.SequenceNumber = 2
	}
	for remote == nil {
		select {
		case remote = <-tracks:
		case <-ticker.C:
			check(low.WriteRTP(packet))
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if !beforePrimary {
		check(subscriber.WriteRTCP([]rtcp.Packet{&rtcp.TransportLayerNack{
			MediaSSRC: uint32(remote.SSRC()), Nacks: []rtcp.NackPair{{PacketID: 1}},
		}}))
		select {
		case <-observer.queued:
		case <-ctx.Done():
			t.Fatal("early repair was not queued:", ctx.Err())
		}
	}
	source, err := NewSource(SourceOptions{
		ID: "repair-test", StreamID: "repair-test", Codec: remote.Codec(),
		Formats:          []LayerFormat{{Width: 8, Height: 8, Bitrate: 100_000}},
		HeaderExtensions: remoteReceiver.GetParameters().HeaderExtensions,
	})
	check(err)
	defer source.Close()
	check(source.BindLayer(0, uint32(remote.SSRC()), remoteReceiver.GetParameters()))
	check(remote.SetReadDeadline(time.Now().Add(time.Second)))
	for {
		received, attributes, err := ReadRTP(remote)
		check(err)
		if received.PayloadType != uint8(remote.Codec().PayloadType) || received.SSRC != uint32(remote.SSRC()) ||
			(received.SequenceNumber != 1 && (!beforePrimary || received.SequenceNumber != 2)) || !bytes.Equal(received.Payload, packet.Payload) {
			t.Fatalf("repaired packet lost its negotiated identity: SSRC=%d, primary SSRC=%d, payload type=%d, codec=%d", received.SSRC, remote.SSRC(), received.PayloadType, remote.Codec().PayloadType)
		}
		check(source.WriteRTP(0, received))
		if attributes.Get(webrtc.AttributeRtxPayloadType) != nil {
			break
		}
	}
}
