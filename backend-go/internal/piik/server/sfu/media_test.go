package sfu

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	livekitsfu "github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"zviewer/backend/internal/piik/media/forwarding"
	"zviewer/backend/internal/piik/media/forwarding/forwardingtest"
	"zviewer/backend/internal/piik/media/inputroute"
)

func TestPublicationStopsNACKAfterRTXRepair(t *testing.T) {
	forwardingtest.IngressRepair(t, func(offer webrtc.SessionDescription, settings webrtc.SettingEngine) (*webrtc.PeerConnection, func() *forwarding.Source) {
		service := NewMedia(MediaOptions{Settings: func() webrtc.SettingEngine { return settings }})
		t.Cleanup(func() { _ = service.Close() })
		fence := ResourceFence{RoomID: "1234", ShareGeneration: "share_12345678", PublicationGeneration: "publication_12345678"}
		metadata := PublicationMedia{Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{{Width: 8, Height: 8, Bitrate: 1_000_000}}}
		if err := service.PreparePublication(fence, "publisher_12345678", metadata); err != nil {
			t.Fatal(err)
		}
		if _, err := service.AcceptPublisherOffer(fence, "publisher_12345678", offer); err != nil {
			t.Fatal(err)
		}
		publication, err := service.publication(fence, "publisher_12345678")
		if err != nil {
			t.Fatal(err)
		}
		return publication.pc, func() *forwarding.Source {
			publication.mu.Lock()
			defer publication.mu.Unlock()
			return publication.source
		}
	})
}

func TestMediaOnePublicationTwoSubscribersAndExactRetirement(t *testing.T) {
	for _, codec := range []string{"vp8", "h264"} {
		for _, layerCount := range []int{1, 2} {
			t.Run(fmt.Sprintf("%s/layers=%d", codec, layerCount), func(t *testing.T) {
				runMediaFanout(t, codec, layerCount)
			})
		}
	}
}

func TestUnsupportedPublicationDescriptionDoesNotAllocate(t *testing.T) {
	service := NewMedia(MediaOptions{})
	defer service.Close()
	fence := ResourceFence{RoomID: "1234", ShareGeneration: "share_12345678", PublicationGeneration: "publication_12345678"}
	for _, format := range []forwarding.LayerFormat{
		{Width: 32768, Height: 32768, Bitrate: 5_000_000},
		{Width: 1920, Height: 1080, Bitrate: 240_000_001},
		{Width: 0xffff_ffff, Height: 0xffff_ffff, Bitrate: 0xffff_ffff},
	} {
		metadata := PublicationMedia{Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{format}}
		if err := service.PreparePublication(fence, "publisher_12345678", metadata); err == nil {
			t.Fatal("unsupported format was admitted")
		}
		if service.HasPublication(fence, "publisher_12345678") {
			t.Fatal("unsupported format allocated a publication")
		}
	}
}

func TestPublicationAdmitsSupportedBitrateCeilings(t *testing.T) {
	service := NewMedia(MediaOptions{})
	defer service.Close()
	fence := ResourceFence{RoomID: "1234", ShareGeneration: "share_12345678", PublicationGeneration: "publication_12345678"}
	metadata := PublicationMedia{Codec: "h264", RIDs: []string{""},
		Formats: []forwarding.LayerFormat{{Width: 1920, Height: 1080, Bitrate: 240_000_000}}}
	if err := service.PreparePublication(fence, "publisher_12345678", metadata); err != nil {
		t.Fatalf("prepare supported publisher: %v", err)
	}
	publication, err := service.publication(fence, "publisher_12345678")
	if err != nil {
		t.Fatal(err)
	}
	pc := publication.pc
	if err := service.AddPublisherICE(fence, "publisher_12345678", webrtc.ICECandidateInit{}); !errors.Is(err, webrtc.ErrNoRemoteDescription) {
		t.Fatalf("candidate before remote SDP lost its lifecycle error: %v", err)
	}
	for _, bitrate := range []uint32{5_000_000, 100_000_001, 240_000_000} {
		metadata.Formats[0].Bitrate = bitrate
		if err := service.UpdatePublication(fence, "publisher_12345678", metadata); err != nil {
			t.Fatalf("update supported ceiling %d: %v", bitrate, err)
		}
		if publication.pc != pc || publication.metadata.Formats[0].Bitrate != bitrate {
			t.Fatal("quality update replaced the publication or lost its bitrate ceiling")
		}
	}
	metadata.Formats[0].Bitrate++
	if err := service.UpdatePublication(fence, "publisher_12345678", metadata); err == nil {
		t.Fatal("unsupported update was admitted")
	}
	if publication.pc != pc || publication.metadata.Formats[0].Bitrate != 240_000_000 {
		t.Fatal("rejected update changed the existing publication")
	}
}

func TestMediaDemandBootstrapsWaitingSubscriberAndStopsAfterExactClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	demand := make(chan int, 4)
	service := NewMedia(MediaOptions{Events: func(event MediaEvent) {
		if event.ActiveCount != nil {
			demand <- *event.ActiveCount
		}
	}})
	defer service.Close()
	fence := ResourceFence{RoomID: "1234", ShareGeneration: "share_12345678", PublicationGeneration: "publication_12345678"}
	metadata := PublicationMedia{Codec: "vp8", RIDs: []string{"q", "h"}, Formats: []forwarding.LayerFormat{{Width: 640, Height: 360, Bitrate: 500_000}, {Width: 1280, Height: 720, Bitrate: 2_000_000}}}
	if err := service.PreparePublication(fence, "publisher_12345678", metadata); err != nil {
		t.Fatal(err)
	}
	subscription := SubscriptionFence{ResourceFence: fence, ViewerPeerID: "viewer_12345678", ConnectionID: "connection_12345678"}
	prepared := make(chan error, 1)
	go func() {
		_, err := service.PrepareSubscriber(ctx, subscription, subscription.ConnectionID)
		prepared <- err
	}()
	select {
	case count := <-demand:
		if count != 2 {
			t.Fatalf("bootstrap demand = %d", count)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := service.CloseSubscription(subscription, subscription.ConnectionID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-prepared:
		if err == nil {
			t.Fatal("retired subscriber acquired a later input")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case count := <-demand:
		if count != 0 {
			t.Fatalf("no-subscriber demand = %d", count)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func runMediaFanout(t *testing.T, codec string, layerCount int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	newPeer := func() *webrtc.PeerConnection {
		engine := &webrtc.MediaEngine{}
		check(engine.RegisterDefaultCodecs())
		registry := &interceptor.Registry{}
		check(webrtc.RegisterDefaultInterceptors(engine, registry))
		pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry),
			webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
		check(err)
		t.Cleanup(func() { _ = pc.Close() })
		return pc
	}
	waitGathering := func(pc *webrtc.PeerConnection, description webrtc.SessionDescription) webrtc.SessionDescription {
		gather := webrtc.GatheringCompletePromise(pc)
		check(pc.SetLocalDescription(description))
		select {
		case <-gather:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		return *pc.LocalDescription()
	}
	stateEvents := make(chan MediaEvent, 128)
	service := NewMedia(MediaOptions{Settings: func() webrtc.SettingEngine { return settings }, Events: func(event MediaEvent) {
		select {
		case stateEvents <- event:
		default:
		}
	}})
	defer service.Close()
	fence := ResourceFence{RoomID: "1234", ShareGeneration: "share_123456", PublicationGeneration: "publication_123456"}
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 2})
	if !admission.ReservePublication(fence) {
		t.Fatal("publication admission failed")
	}
	metadata := PublicationMedia{Codec: codec, RIDs: []string{""},
		Formats: []forwarding.LayerFormat{{Width: 8, Height: 8, Bitrate: 1_000_000}},
		Audio:   true, AudioBitrate: 64_000}
	if layerCount == 2 {
		metadata.RIDs = []string{"q", "f"}
		metadata.Formats = []forwarding.LayerFormat{
			{Width: 8, Height: 8, Bitrate: 250_000},
			{Width: 8, Height: 8, Bitrate: 1_000_000},
		}
	}
	check(service.PreparePublication(fence, "publisher_123456", metadata))
	if service.PreparePublication(fence, "replacement_123456", metadata) == nil {
		t.Fatal("duplicate prepare replaced a publication")
	}
	publication, err := service.publication(fence, "publisher_123456")
	check(err)
	waitingFence := SubscriptionFence{ResourceFence: fence, ViewerPeerID: "viewer_123456"}
	if !admission.ReserveSubscription(waitingFence) {
		t.Fatal("waiting subscription admission failed")
	}
	waiting := make(chan error, 1)
	go func() {
		_, err := service.PrepareSubscriber(ctx, waitingFence, "canceled_123456")
		waiting <- err
	}()
	for {
		publication.mu.Lock()
		registered := len(publication.subscribers) == 1
		publication.mu.Unlock()
		if registered {
			break
		}
		select {
		case <-time.After(time.Millisecond):
		case <-ctx.Done():
			t.Fatal("subscription was not reserved before input readiness")
		}
	}
	check(service.CloseSubscription(waitingFence, "canceled_123456"))
	select {
	case err = <-waiting:
		if err == nil {
			t.Fatal("canceled subscription acquired a later source")
		}
	case <-ctx.Done():
		t.Fatal("retired subscription kept waiting for input")
	}
	publisher := newPeer()
	requests := make(chan string, 32)
	inputChannel, err := publisher.CreateDataChannel(inputroute.Label, nil)
	check(err)
	inputChannel.OnMessage(func(message webrtc.DataChannelMessage) { requests <- string(message.Data) })
	capability := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000}
	videoData := livekitsfu.VP8KeyFrame8x8
	if codec == "h264" {
		capability.MimeType = webrtc.MimeTypeH264
		capability.SDPFmtpLine = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
		videoData = nil
		for _, nal := range livekitsfu.H264KeyFrame2x2 {
			videoData = append(videoData, 0, 0, 0, 1)
			videoData = append(videoData, nal...)
		}
	}
	var videos []*webrtc.TrackLocalStaticRTP
	var packetizers []rtp.Packetizer
	for _, rid := range metadata.RIDs {
		video, err := webrtc.NewTrackLocalStaticRTP(capability, "video", "fixture", webrtc.WithRTPStreamID(rid))
		check(err)
		videos = append(videos, video)
		var payloader rtp.Payloader = &codecs.VP8Payloader{EnablePictureID: true}
		if codec == "h264" {
			payloader = &codecs.H264Payloader{}
		}
		packetizers = append(packetizers, rtp.NewPacketizer(1200, 96, uint32(len(videos)),
			payloader, rtp.NewRandomSequencer(), 90_000))
	}
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	}, "audio", "fixture")
	check(err)
	videoSender, err := publisher.AddTrack(videos[0])
	check(err)
	for _, video := range videos[1:] {
		check(videoSender.AddEncoding(video))
	}
	_, err = publisher.AddTrack(audio)
	check(err)
	for _, sender := range publisher.GetSenders() {
		go func() {
			for {
				if _, _, readErr := sender.ReadRTCP(); readErr != nil {
					return
				}
			}
		}()
	}
	offer, err := publisher.CreateOffer(nil)
	check(err)
	_, err = service.AcceptPublisherOffer(fence, "publisher_123456", waitGathering(publisher, offer))
	check(err)
	select {
	case <-webrtc.GatheringCompletePromise(publication.pc):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(publisher.SetRemoteDescription(*publication.pc.LocalDescription()))
	parameters := publication.pc.GetTransceivers()[0].Receiver().GetParameters()
	if len(parameters.Codecs) != 2 || parameters.Codecs[0].MimeType != capability.MimeType ||
		parameters.Codecs[1].MimeType != webrtc.MimeTypeRTX ||
		parameters.Codecs[1].SDPFmtpLine != fmt.Sprintf("apt=%d", parameters.Codecs[0].PayloadType) {
		t.Fatalf("publisher lost its selected codec/repair pair: %v", parameters.Codecs)
	}
	mid := publisher.GetTransceivers()[0].Mid()
	headerExtensions := videoSender.GetParameters().HeaderExtensions
	stopSamples := make(chan struct{})
	var samples sync.WaitGroup
	samples.Add(1)
	go func() {
		defer samples.Done()
		ticker := time.NewTicker(time.Second / 30)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				for index, video := range videos {
					for _, packet := range packetizers[index].Packetize(videoData, 3000) {
						if layerCount > 1 {
							for _, extension := range headerExtensions {
								switch extension.URI {
								case sdp.SDESMidURI:
									_ = packet.SetExtension(uint8(extension.ID), []byte(mid))
								case sdp.SDESRTPStreamIDURI:
									_ = packet.SetExtension(uint8(extension.ID), []byte(metadata.RIDs[index]))
								}
							}
						}
						_ = video.WriteRTP(packet)
					}
				}
				_ = audio.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond})
			case <-stopSamples:
				return
			}
		}
	}()
	defer func() { close(stopSamples); samples.Wait() }()
	var videoPackets, audioPackets [2]atomic.Uint32
	fences := []SubscriptionFence{
		{ResourceFence: fence, ViewerPeerID: "viewer_123456"},
		{ResourceFence: fence, ViewerPeerID: "viewer_abcdef"},
	}
	var transports [2]*forwarding.Transport
	inputStates := make(chan string, 32)
	viewerInput := make(chan *webrtc.DataChannel, 1)
	for index, subscription := range fences {
		if !admission.ReserveSubscription(subscription) {
			t.Fatal("subscription admission failed")
		}
		offer, prepareErr := service.PrepareSubscriber(ctx, subscription, "subscriber_123456")
		check(prepareErr)
		physical, getErr := service.subscriber(subscription, "subscriber_123456")
		check(getErr)
		transports[index] = physical.transport
		select {
		case <-webrtc.GatheringCompletePromise(physical.transport.PC):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		offer = *physical.transport.PC.LocalDescription()
		receiver := newPeer()
		if index == 0 {
			receiver.OnDataChannel(func(channel *webrtc.DataChannel) {
				channel.OnMessage(func(message webrtc.DataChannelMessage) { inputStates <- string(message.Data) })
				viewerInput <- channel
			})
		}
		receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			for {
				packet, _, readErr := track.ReadRTP()
				if readErr != nil {
					return
				}
				if len(packet.Payload) == 0 {
					continue
				}
				if track.Kind() == webrtc.RTPCodecTypeVideo {
					videoPackets[index].Add(1)
				} else {
					audioPackets[index].Add(1)
				}
			}
		})
		check(receiver.SetRemoteDescription(offer))
		for _, transceiver := range receiver.GetTransceivers() {
			if transceiver.Kind() != webrtc.RTPCodecTypeAudio {
				continue
			}
			for _, codec := range transceiver.Receiver().GetParameters().Codecs {
				if codec.MimeType == webrtc.MimeTypeOpus {
					codec.SDPFmtpLine = "stereo=1;maxaveragebitrate=510000"
					check(transceiver.SetCodecPreferences([]webrtc.RTPCodecParameters{codec}))
					break
				}
			}
		}
		answer, answerErr := receiver.CreateAnswer(nil)
		check(answerErr)
		answer = waitGathering(receiver, answer)
		if index == 1 {
			// Admission of one limited receiver must not bind its incompatible
			// audio or disturb the publication and its already-playing sibling.
			limited := answer
			limited.SDP = strings.ReplaceAll(limited.SDP, "maxaveragebitrate=510000", "maxaveragebitrate=192000")
			if limited.SDP == answer.SDP {
				t.Fatal("receiver fixture did not declare its Opus limit")
			}
			if service.ApplySubscriberAnswer(subscription, "subscriber_123456", limited) == nil {
				t.Fatal("shared audio accepted an insufficient receiver limit")
			}
			if physical.transport.PC.RemoteDescription() != nil {
				t.Fatal("rejected answer was applied before admission")
			}
			beforeVideo, beforeAudio := videoPackets[0].Load(), audioPackets[0].Load()
			for videoPackets[0].Load() < beforeVideo+3 || audioPackets[0].Load() < beforeAudio+3 {
				select {
				case <-time.After(10 * time.Millisecond):
				case <-ctx.Done():
					t.Fatal("receiver rejection interrupted its healthy sibling")
				}
			}
		}
		check(service.ApplySubscriberAnswer(subscription, "subscriber_123456", answer))
	}
	for videoPackets[0].Load() < 3 || videoPackets[1].Load() < 3 ||
		audioPackets[0].Load() < 3 || audioPackets[1].Load() < 3 {
		select {
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatalf("missing media: video=%d,%d audio=%d,%d",
				videoPackets[0].Load(), videoPackets[1].Load(), audioPackets[0].Load(), audioPackets[1].Load())
		}
	}
	if len(publisher.GetSenders()) != 2 || len(publication.source.GetDownTracks()) != 2 {
		t.Fatal("one video/audio publication did not share its source")
	}
	if codec == "vp8" && layerCount == 1 {
		waitInput := func(messages <-chan string, wanted string) {
			t.Helper()
			for {
				select {
				case message := <-messages:
					if message == wanted {
						return
					}
				case <-ctx.Done():
					t.Fatalf("missing input message %s", wanted)
				}
			}
		}
		check(inputChannel.SendText(`{"ready":true}`))
		waitInput(inputStates, `{"ready":true}`)
		var viewerChannel *webrtc.DataChannel
		select {
		case viewerChannel = <-viewerInput:
		case <-ctx.Done():
			t.Fatal("viewer input did not open")
		}
		for len(requests) > 0 {
			<-requests
		}
		for len(inputStates) > 0 {
			<-inputStates
		}
		// Pion dispatches PC projections asynchronously. Old projections must
		// not retire input that belongs to this same transport's recovery.
		publication.connectionStateChanged(webrtc.PeerConnectionStateConnecting)
		const reply = `{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","epoch":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","data":"after-publisher-projection"}`
		check(inputChannel.SendText(reply))
		for waiting := true; waiting; {
			select {
			case message := <-inputStates:
				if message == `{"ready":false}` {
					t.Error("late publisher projection retired recovered input")
				}
				waiting = message != reply
			case <-ctx.Done():
				t.Fatal("publisher projection marker did not reach viewer")
			}
		}
		check(inputChannel.SendText(`{"ready":true}`))
		waitInput(inputStates, `{"ready":true}`)
		const request = `{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","epoch":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","data":"current-request"}`
		check(viewerChannel.SendText(request))
		waitInput(requests, request)
		physical, getErr := service.subscriber(fences[0], "subscriber_123456")
		check(getErr)
		publication.subscriberStateChanged(physical, webrtc.PeerConnectionStateDisconnected)
		const next = `{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","epoch":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","data":"after-subscriber-projection"}`
		check(viewerChannel.SendText(next))
		for waiting := true; waiting; {
			select {
			case message := <-requests:
				if strings.Contains(message, `"closed":true`) {
					t.Error("late subscriber projection retired recovered input")
				}
				waiting = message != next
			case <-ctx.Done():
				t.Fatal("subscriber projection marker did not reach publisher")
			}
		}
	}
	publication.mu.Lock()
	bound := 0
	for _, active := range publication.layers {
		if active {
			bound++
		}
	}
	publication.mu.Unlock()
	if bound != layerCount {
		t.Fatalf("negotiated RTP layers = %d, want %d", bound, layerCount)
	}
	originalSource := publication.source
	updated := metadata
	updated.Formats = append([]forwarding.LayerFormat(nil), metadata.Formats...)
	updated.Formats[len(updated.Formats)-1].Bitrate /= 2
	updated.Audio = false
	check(service.UpdatePublication(fence, "publisher_123456", updated))
	if publication.source != originalSource || publication.pc.ConnectionState() != webrtc.PeerConnectionStateConnected ||
		len(publication.source.GetDownTracks()) != 2 {
		t.Fatal("live metadata update replaced physical media")
	}
	updated.Codec = "unsupported"
	if service.UpdatePublication(fence, "publisher_123456", updated) == nil {
		t.Fatal("metadata update changed the publication codec")
	}
	check(service.UpdatePublication(fence, "publisher_123456", metadata))
	check(service.CloseSubscription(fences[0], "stale_connection"))
	if transports[0].PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatal("stale subscription identity closed current media")
	}
	check(service.CloseSubscription(fences[0], "subscriber_123456"))
	if transports[0].PC.ConnectionState() != webrtc.PeerConnectionStateClosed ||
		transports[1].PC.ConnectionState() != webrtc.PeerConnectionStateConnected ||
		len(publication.source.GetDownTracks()) != 1 {
		t.Fatal("subscription retirement disturbed its sibling")
	}
	if service.AddSubscriberICE(fences[0], "subscriber_123456", webrtc.ICECandidateInit{}) == nil {
		t.Fatal("retired media accepted signaling")
	}
	if codec == "vp8" && layerCount == 1 {
		// Hold the existing owner lock across a real Connected -> Closed change.
		// Both Pion callbacks queue behind it; old Connected must not attach a
		// physically closed transport when it eventually acquires the owner.
		offer, err := service.PrepareSubscriber(ctx, fences[0], "delayed_state")
		check(err)
		delayed, err := service.subscriber(fences[0], "delayed_state")
		check(err)
		<-webrtc.GatheringCompletePromise(delayed.transport.PC)
		offer = *delayed.transport.PC.LocalDescription()
		receiver := newPeer()
		check(receiver.SetRemoteDescription(offer))
		answer, err := receiver.CreateAnswer(nil)
		check(err)
		answer = waitGathering(receiver, answer)
		publication.mu.Lock()
		err = delayed.transport.PC.SetRemoteDescription(answer)
		for err == nil && delayed.transport.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
			select {
			case <-time.After(time.Millisecond):
			case <-ctx.Done():
				err = ctx.Err()
			}
		}
		if err == nil {
			err = delayed.transport.PC.Close()
		}
		publication.mu.Unlock()
		check(err)
		closedEvents := 0
		for closedEvents < 3 { // Connecting, Connected and Closed were all held.
			select {
			case event := <-stateEvents:
				if event.ConnectionID != "delayed_state" || event.State == webrtc.PeerConnectionStateUnknown {
					continue
				}
				if event.State == webrtc.PeerConnectionStateConnected {
					t.Fatal("late Connected reactivated a closed SFU subscriber")
				}
				if event.State == webrtc.PeerConnectionStateClosed {
					closedEvents++
				}
			case <-ctx.Done():
				t.Fatal("delayed subscriber callbacks did not settle")
			}
		}
		if len(publication.source.GetDownTracks()) != 1 {
			t.Fatal("closed SFU subscriber acquired source membership")
		}
		check(service.CloseSubscription(fences[0], "delayed_state"))
	}
	check(service.ClosePublication(fence))
	check(service.ClosePublication(fence))
	if publication.pc.ConnectionState() != webrtc.PeerConnectionStateClosed ||
		transports[1].PC.ConnectionState() != webrtc.PeerConnectionStateClosed ||
		!publication.source.IsClosed() {
		t.Fatal("publication did not retire its complete physical resources")
	}
}
