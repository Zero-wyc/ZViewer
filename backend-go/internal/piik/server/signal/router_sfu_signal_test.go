package signal

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	livekitsfu "github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	diagnostic "zviewer/backend/internal/diagnostics"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/sfu"
)

func TestEmbeddedSfuSignalsRequireExactAdmittedConnectionAndCurrentSession(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host, first, second := h.establishSfuRoom(created)
	h.settle()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		publication := rm.controller.Publication()
		edge := h.doMustEdge(created.RoomID, first.peerID)
		message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "candidate", Revision: protocol.Int(edge.revision), PublicationGeneration: publication.Generation, ConnectionID: edge.connectionID}
		if _, ok := h.router.sfuSignalAuthorized(first, message); !ok {
			t.Fatal("current subscriber was rejected")
		}
		if _, ok := h.router.sfuSignalAuthorized(second, message); ok {
			t.Fatal("another viewer could signal the subscription")
		}
		stale := first
		stale.sessionID = "stale_session_12345678"
		if _, ok := h.router.sfuSignalAuthorized(stale, message); ok {
			t.Fatal("replaced control session retained authority")
		}
		forged := message
		forged.Revision += 100
		if _, ok := h.router.sfuSignalAuthorized(first, forged); ok {
			t.Fatal("future route revision was accepted")
		}
		forged = message
		forged.PublicationGeneration = "unowned_publication_12345678"
		if _, ok := h.router.sfuSignalAuthorized(first, forged); ok {
			t.Fatal("unowned publication was accepted")
		}
		message.ConnectionID = publication.ConnectionID
		if _, ok := h.router.sfuSignalAuthorized(first, message); ok {
			t.Fatal("viewer could signal Host ingress")
		}
		message.Kind = "description"
		message.Description = &protocol.SessionDescription{Type: "offer", SDP: "test-offer"}
		message.Media = &protocol.SfuMedia{Codec: "vp8", Layers: []protocol.SfuLayer{{RID: "", Width: 640, Height: 360, Bitrate: 500_000}}}
		h.router.handleSfuSignal(host, message)
		if len(h.media.Created()) != 1 {
			t.Fatal("authorized publisher did not create media")
		}
		message.ConnectionID = "stale_connection_12345678"
		h.router.handleSfuSignal(host, message)
		if len(h.media.Created()) != 1 {
			t.Fatal("stale publisher created another physical handle")
		}
	})
}

func TestEmbeddedSfuAuthenticatedWebSocketCarriesActualRTP(t *testing.T) {
	diagnostics := captureRouteDebug(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
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
	var signaling atomic.Pointer[Server]
	service := sfu.NewMedia(sfu.MediaOptions{Settings: func() webrtc.SettingEngine { return settings }, Events: func(event sfu.MediaEvent) {
		if server := signaling.Load(); server != nil {
			server.HandleSfuMediaEvent(event)
		}
	}})
	defer service.Close()
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: service,
		Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 2})}})
	signaling.Store(h.server)
	defer h.close()
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "embedded_host_12345678", 1, "", presenceOptions{})
	authenticate(t, viewer, h.room, protocol.RoleViewer, "embedded_viewer_12345678", 1, "", presenceOptions{})
	direct := nextPreparedRoute(t, viewer)
	viewer.sendJSON(map[string]any{"type": "route-failed", "revision": direct.Revision, "phase": "prepare", "connectionId": direct.Candidate.ConnectionID})
	var hostConfig, viewerConfig protocol.SfuConfigMessage
	check(json.Unmarshal(host.next("sfu-config").raw, &hostConfig))
	check(json.Unmarshal(viewer.next("sfu-config").raw, &viewerConfig))
	if hostConfig.PublicationGeneration != viewerConfig.PublicationGeneration || hostConfig.ConnectionID == viewerConfig.ConnectionID {
		t.Fatal("publication and subscription fences were not distinct")
	}
	newPeer := func() *webrtc.PeerConnection {
		pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
		check(err)
		t.Cleanup(func() { _ = pc.Close() })
		return pc
	}
	gather := func(pc *webrtc.PeerConnection, description webrtc.SessionDescription) webrtc.SessionDescription {
		done := webrtc.GatheringCompletePromise(pc)
		check(pc.SetLocalDescription(description))
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		return *pc.LocalDescription()
	}
	sendDescription := func(client *testClient, configuration protocol.SfuConfigMessage, description webrtc.SessionDescription, declaration *protocol.SfuMedia) {
		message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "description", Revision: configuration.Revision,
			PublicationGeneration: configuration.PublicationGeneration, ConnectionID: configuration.ConnectionID,
			Description: &protocol.SessionDescription{Type: description.Type.String(), SDP: description.SDP}, Media: declaration}
		encoded, err := json.Marshal(message)
		check(err)
		client.sendText(string(encoded))
	}
	remoteCandidates := make(map[*webrtc.PeerConnection]int)
	applyRemote := func(client *testClient, pc *webrtc.PeerConnection, configuration protocol.SfuConfigMessage, untilConnected bool) {
		var candidates []webrtc.ICECandidateInit
		for {
			if ctx.Err() != nil {
				t.Fatal(ctx.Err())
			}
			if untilConnected && pc.ConnectionState() == webrtc.PeerConnectionStateConnected && remoteCandidates[pc] > 0 {
				return
			}
			incoming, ok := client.tryNext("sfu-signal", 20*time.Millisecond)
			if !ok {
				continue
			}
			var message protocol.SfuSignalMessage
			check(json.Unmarshal(incoming.raw, &message))
			if message.ConnectionID != configuration.ConnectionID || message.PublicationGeneration != configuration.PublicationGeneration || message.Revision != configuration.Revision {
				t.Fatal("media signal lost its fence")
			}
			if message.Kind == "layers" {
				continue
			}
			if message.Kind == "candidate" {
				candidate := webrtc.ICECandidateInit{}
				if message.Candidate != nil {
					remoteCandidates[pc]++
					raw, err := json.Marshal(message.Candidate)
					check(err)
					check(json.Unmarshal(raw, &candidate))
				}
				if pc.RemoteDescription() == nil {
					candidates = append(candidates, candidate)
				} else {
					check(pc.AddICECandidate(candidate))
				}
				continue
			}
			check(pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.NewSDPType(message.Description.Type), SDP: message.Description.SDP}))
			for _, candidate := range candidates {
				check(pc.AddICECandidate(candidate))
			}
			candidates = nil
			if !untilConnected {
				return
			}
		}
	}
	publisher := newPeer()
	video, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000}, "video", "stream")
	check(err)
	_, err = publisher.AddTrack(video)
	check(err)
	offer, err := publisher.CreateOffer(nil)
	check(err)
	sendDescription(host, hostConfig, gather(publisher, offer), &protocol.SfuMedia{Codec: "vp8", Layers: []protocol.SfuLayer{{RID: "", Width: 8, Height: 8, Bitrate: 500_000}}})
	applyRemote(host, publisher, hostConfig, true)
	stopFrames, framesStopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(framesStopped)
		ticker := time.NewTicker(time.Second / 30)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = video.WriteSample(media.Sample{Data: livekitsfu.VP8KeyFrame8x8, Duration: time.Second / 30})
			case <-stopFrames:
				return
			}
		}
	}()
	defer func() { close(stopFrames); <-framesStopped }()
	subscriber := newPeer()
	var received atomic.Uint32
	subscriber.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if track.Kind() == webrtc.RTPCodecTypeVideo && len(packet.Payload) > 0 {
				received.Add(1)
			}
		}
	})
	applyRemote(viewer, subscriber, viewerConfig, false)
	// SFU reserves its audio track for later source/microphone changes. Match
	// the product Viewer's receive preference even while this fixture is silent.
	for _, transceiver := range subscriber.GetTransceivers() {
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
	answer, err := subscriber.CreateAnswer(nil)
	check(err)
	sendDescription(viewer, viewerConfig, gather(subscriber, answer), nil)
	applyRemote(viewer, subscriber, viewerConfig, true)
	if !waitFor(t, 3*time.Second, func() bool { return received.Load() >= 3 }) {
		t.Fatal("authenticated signaling did not produce forwarded video RTP")
	}
	for _, peer := range []struct {
		client *testClient
		pc     *webrtc.PeerConnection
		config protocol.SfuConfigMessage
	}{{host, publisher, hostConfig}, {viewer, subscriber, viewerConfig}} {
		valid := ""
		for _, line := range strings.Split(peer.pc.LocalDescription().SDP, "\n") {
			if strings.HasPrefix(line, "a=candidate:") {
				valid = strings.TrimSpace(strings.TrimPrefix(line, "a:"))
				break
			}
		}
		if valid == "" {
			t.Fatal("positive candidate control is missing")
		}
		for _, candidate := range []string{"candidate:malformed", valid} {
			encoded, err := json.Marshal(protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "candidate",
				Revision: peer.config.Revision, PublicationGeneration: peer.config.PublicationGeneration,
				ConnectionID: peer.config.ConnectionID, Candidate: &protocol.IceCandidate{Candidate: candidate}})
			check(err)
			peer.client.sendText(string(encoded))
		}
	}
	if !waitFor(t, time.Second, func() bool {
		return diagnostics.calledWith(h.room.RoomID, "sfu-signal-failed", map[string]any{"role": "host", "kind": "candidate"}) &&
			diagnostics.calledWith(h.room.RoomID, "sfu-signal-failed", map[string]any{"role": "viewer", "kind": "candidate"})
	}) {
		t.Fatal("candidate rejection was not processed on both physical facets")
	}
	if !waitFor(t, time.Second, func() bool {
		return diagnostics.calledWith(h.room.RoomID, "sfu-transport-state", map[string]any{
			"role": "host", "phase": "prepare", "revision": int64(hostConfig.Revision), "state": "connected",
			"connectionId":          diagnostic.ID(hostConfig.ConnectionID),
			"publicationGeneration": diagnostic.ID(hostConfig.PublicationGeneration),
		}) && diagnostics.calledWith(h.room.RoomID, "sfu-transport-state", map[string]any{
			"role": "viewer", "phase": "prepare", "revision": int64(viewerConfig.Revision), "state": "connected",
			"connectionId":          diagnostic.ID(viewerConfig.ConnectionID),
			"publicationGeneration": diagnostic.ID(viewerConfig.PublicationGeneration),
		})
	}) {
		t.Fatal("SFU diagnostics did not distinguish connected ingress and egress before route commit")
	}
	h.locked(func() {
		room, _ := h.server.router.rooms.Get(h.room.RoomID)
		if room.controller.Operation() == nil {
			t.Fatal("transport/RTP arrival committed without client decoded-frame proof")
		}
		if room.controller.Publication() != nil {
			t.Fatal("preparing media was advertised as a committed Host publication")
		}
	})
	viewer.sendJSON(map[string]any{"type": "route-ready", "revision": viewerConfig.Revision, "phase": "prepare"})
	if !waitFor(t, time.Second, func() bool {
		committed := false
		h.locked(func() {
			room, _ := h.server.router.rooms.Get(h.room.RoomID)
			committed = room.controller.Operation() == nil && room.controller.Publication() != nil
		})
		return committed
	}) {
		t.Fatal("the exact client media-ready proof did not commit")
	}
}

func TestEmbeddedSfuRejectsBadPublisherOfferAtPendingRevision(t *testing.T) {
	diagnostics := captureRouteDebug(t)
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	service := sfu.NewMedia(sfu.MediaOptions{})
	defer service.Close()
	h.router.sfu.media = service
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "candidate_viewer")
	h.complete(host)
	h.complete(viewer)
	direct := h.waitPrepared(viewer.sessionID)
	h.routeFailed(viewer, routeFailedMessage(int64(direct.Revision), "prepare", direct.Candidate.ConnectionID))
	prepared := h.waitPreparedTransport(viewer.sessionID, "sfu")
	var configuration protocol.SfuConfigMessage
	for _, message := range h.messages(host.sessionID) {
		if value, ok := message.(protocol.SfuConfigMessage); ok {
			configuration = value
		}
	}
	h.locked(func() {
		h.router.handleSfuSignal(host, protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "description", Revision: configuration.Revision,
			PublicationGeneration: configuration.PublicationGeneration, ConnectionID: configuration.ConnectionID,
			Description: &protocol.SessionDescription{Type: "offer", SDP: "invalid"},
			Media:       &protocol.SfuMedia{Codec: "vp8", Layers: []protocol.SfuLayer{{RID: "", Width: 640, Height: 360, Bitrate: 500_000}}},
		})
	})
	h.waitUsage(sfu.Usage{})
	if !diagnostics.calledWith(created.RoomID, "sfu-signal-failed", map[string]any{
		"role": "host", "kind": "description",
	}) {
		t.Fatal("failed publisher preparation did not retain diagnostic context")
	}
	if _, ok := h.activeAfter(viewer.sessionID, int64(prepared.Revision)); !ok {
		t.Fatal("failed pending media did not broadcast a newer rollback revision")
	}
}

func TestEmbeddedSfuControlLossKeepsMediaUntilExactTransportFailure(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host, _, _ := h.establishSfuRoom(created)
	h.settle()
	var event sfu.MediaEvent
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		publication := rm.controller.Publication()
		event = sfu.MediaEvent{Fence: resourceFence(publication.Resource), ConnectionID: publication.ConnectionID, State: webrtc.PeerConnectionStateFailed}
		h.doDisconnect(host)
	})
	h.settle()
	if len(h.media.Deleted()) != 0 || h.usage().Ingress != 1 {
		t.Fatal("control loss retired healthy media")
	}
	h.locked(func() {
		stale := event
		stale.ConnectionID = "stale_connection_12345678"
		h.router.handleSfuMediaEvent(stale)
	})
	if len(h.media.Deleted()) != 0 {
		t.Fatal("stale media callback retired the current publication")
	}
	h.locked(func() { h.router.handleSfuMediaEvent(event) })
	h.waitUsage(sfu.Usage{})
	if len(h.media.Deleted()) != 1 {
		t.Fatal("exact physical failure did not retire ingress")
	}
}
