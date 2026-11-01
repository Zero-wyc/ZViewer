package sfu

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/media/forwarding"
)

type voiceFixtureSource struct {
	track    *webrtc.TrackLocalStaticRTP
	active   atomic.Bool
	sequence atomic.Uint32
}

type voiceFixturePeer struct {
	mu       sync.Mutex
	api      *webrtc.API
	pc       *webrtc.PeerConnection
	service  *Media
	plan     VoiceConnectionPlan
	sources  map[string]*voiceFixtureSource
	counts   map[byte]int
	errors   chan error
	held     chan VoiceDescription
	hold     atomic.Bool
	revision uint64
	ice      []webrtc.ICECandidateInit
}

func (p *voiceFixturePeer) report(err error) {
	if err != nil {
		select {
		case p.errors <- err:
		default:
		}
	}
}

func (p *voiceFixturePeer) event(event VoiceMediaEvent) {
	if event.Description != nil {
		if p.hold.Load() {
			p.held <- *event.Description
		} else {
			p.report(p.answer(*event.Description, false))
		}
	} else if event.Candidate != nil {
		p.mu.Lock()
		if p.pc.RemoteDescription() == nil {
			p.ice = append(p.ice, *event.Candidate)
		} else {
			p.report(p.pc.AddICECandidate(*event.Candidate))
		}
		p.mu.Unlock()
	}
}

func (p *voiceFixturePeer) answer(offer VoiceDescription, rejectSpoof bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.pc.SetRemoteDescription(offer.SDP); err != nil {
		return err
	}
	tracks := []VoiceTrack{}
	for _, item := range offer.Tracks {
		source := p.sources[item.PublicationID]
		if source == nil {
			continue
		}
		for _, transceiver := range p.pc.GetTransceivers() {
			if transceiver.Mid() != item.MID {
				continue
			}
			if sender := transceiver.Sender(); sender != nil {
				if err := sender.ReplaceTrack(source.track); err != nil {
					return err
				}
			} else {
				sender, err := p.api.NewRTPSender(source.track, transceiver.Receiver().Transport())
				if err != nil {
					return err
				}
				if err = transceiver.SetSender(sender, source.track); err != nil {
					return err
				}
			}
			tracks = append(tracks, item)
		}
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err = p.pc.SetLocalDescription(answer); err != nil {
		return err
	}
	description := VoiceDescription{Revision: offer.Revision, SDP: *p.pc.LocalDescription(), Tracks: tracks}
	if rejectSpoof {
		spoof := description
		spoof.Tracks = []VoiceTrack{{MID: offer.Tracks[0].MID, PublicationID: "unapproved_publication"}}
		if err = p.service.SignalVoice(p.plan.RoomID, p.plan.PeerID, p.plan.SessionID, p.plan.ConnectionID, VoiceSignal{Description: &spoof}); err == nil {
			return errors.New("unapproved publication was accepted")
		}
	}
	if err = p.service.SignalVoice(p.plan.RoomID, p.plan.PeerID, p.plan.SessionID, p.plan.ConnectionID, VoiceSignal{Description: &description}); err != nil {
		return err
	}
	for _, candidate := range p.ice {
		if err = p.pc.AddICECandidate(candidate); err != nil {
			return err
		}
	}
	p.ice = nil
	p.revision = offer.Revision
	return nil
}

func (p *voiceFixturePeer) count(marker byte) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.counts[marker]
}

func newVoiceFixturePeer(t *testing.T, ctx context.Context, service *Media, settings webrtc.SettingEngine,
	plan VoiceConnectionPlan, markers map[string]byte) *voiceFixturePeer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: voiceCodec, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		t.Fatal(err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	p := &voiceFixturePeer{api: api, pc: pc, service: service, plan: plan,
		sources: make(map[string]*voiceFixtureSource), counts: make(map[byte]int), errors: make(chan error, 8), held: make(chan VoiceDescription, 8)}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			value := candidate.ToJSON()
			p.report(service.SignalVoice(plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID, VoiceSignal{Candidate: &value}))
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if len(packet.Payload) > 0 {
				p.mu.Lock()
				p.counts[packet.Payload[0]]++
				p.mu.Unlock()
			}
		}
	})
	for id, marker := range markers {
		track, err := webrtc.NewTrackLocalStaticRTP(voiceCodec, id, plan.PeerID)
		if err != nil {
			t.Fatal(err)
		}
		source := &voiceFixtureSource{track: track}
		source.active.Store(true)
		p.sources[id] = source
		go func() {
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if source.active.Load() {
						sequence := uint16(source.sequence.Add(1))
						_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(sequence) * 480}, Payload: []byte{marker, 0, 0}})
					}
				}
			}
		}()
	}
	t.Cleanup(func() { _ = pc.Close() })
	return p
}

func TestVoiceJunctionDuplexAuthorizationAndExactRetirement(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	mux := forwarding.NewUDPMux(ice.UDPMuxParams{UDPConn: socket})
	defer mux.Close()
	serverSettings := settings
	serverSettings.SetICEUDPMux(mux)
	service := NewMedia(MediaOptions{Settings: func() webrtc.SettingEngine { return serverSettings }})
	defer service.Close()
	a1, a2, b1 := VoicePublication{"voice_a1", "speaker_a"}, VoicePublication{"voice_a2", "speaker_c"}, VoicePublication{"voice_b1", "speaker_b"}
	aPlan := VoiceConnectionPlan{RoomID: "1234", PeerID: "relay_a", SessionID: "session_a", ConnectionID: "connection_a", Publish: []VoicePublication{a1, a2}, Subscribe: []VoicePublication{b1}}
	bPlan := VoiceConnectionPlan{RoomID: "1234", PeerID: "relay_b", SessionID: "session_b", ConnectionID: "connection_b", Publish: []VoicePublication{b1}, Subscribe: []VoicePublication{a1, a2}}
	a := newVoiceFixturePeer(t, ctx, service, settings, aPlan, map[string]byte{a1.ID: 0xa1, a2.ID: 0xa2})
	b := newVoiceFixturePeer(t, ctx, service, settings, bPlan, map[string]byte{b1.ID: 0xb1})
	wait := func(condition func() bool) {
		t.Helper()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for !condition() {
			select {
			case err := <-a.errors:
				t.Fatal(err)
			case err := <-b.errors:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-ticker.C:
			}
		}
	}
	// Pause the first answer to prove a forged publication cannot consume it.
	a.hold.Store(true)
	connected := make(chan VoiceMediaEvent, 1)
	if err = configureVoiceForTest(service, aPlan, func(event VoiceMediaEvent) {
		if event.State == webrtc.PeerConnectionStateConnected {
			connected <- event
		}
		a.event(event)
	}); err != nil {
		t.Fatal(err)
	}
	var first VoiceDescription
	select {
	case first = <-a.held:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	a.hold.Store(false)
	if err = a.answer(first, true); err != nil {
		t.Fatal(err)
	}
	if err = configureVoiceForTest(service, bPlan, b.event); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { return a.count(0xb1) >= 3 && b.count(0xa1) >= 3 && b.count(0xa2) >= 3 })
	var connectedEvent VoiceMediaEvent
	select {
	case connectedEvent = <-connected:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if connectedEvent.IsCurrentState == nil || !connectedEvent.IsCurrentState() {
		t.Fatal("live voice transport did not provide current connection evidence")
	}
	if a.count(0xa1) != 0 || b.count(0xb1) != 0 {
		t.Fatal("voice was echoed to its incoming connection")
	}

	// A late close from a previous session cannot touch the current physical PC.
	if err = closeVoiceForTest(service, aPlan.RoomID, aPlan.PeerID, "old_session", aPlan.ConnectionID); err != nil {
		t.Fatal(err)
	}
	before := b.count(0xa1)
	wait(func() bool { return b.count(0xa1) >= before+3 })
	if err = service.SignalVoice(aPlan.RoomID, aPlan.PeerID, aPlan.SessionID, aPlan.ConnectionID,
		VoiceSignal{Description: &VoiceDescription{Revision: first.Revision, SDP: webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer}}}); err == nil {
		t.Fatal("old answer was accepted after its negotiation ended")
	}

	// Removing one publication takes effect even while its new answer is withheld.
	a.hold.Store(true)
	revoked := aPlan
	revoked.Publish = []VoicePublication{a2}
	if err = configureVoiceForTest(service, revoked, a.event); err != nil {
		t.Fatal(err)
	}
	var pending VoiceDescription
	select {
	case pending = <-a.held:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// A marker from the surviving source proves the same sender PC keeps flowing.
	beforeA2, beforeB := b.count(0xa2), a.count(0xb1)
	wait(func() bool { return b.count(0xa2) >= beforeA2+3 && a.count(0xb1) >= beforeB+3 })
	stopped := b.count(0xa1)
	beforeA2 = b.count(0xa2)
	wait(func() bool { return b.count(0xa2) >= beforeA2+5 })
	if b.count(0xa1) != stopped {
		t.Fatal("revoked voice continued before SDP acknowledgement")
	}
	a.hold.Store(false)
	if err = a.answer(pending, false); err != nil {
		t.Fatal(err)
	}

	// Reusing a grant must reuse its empty media section, not grow SDP forever.
	for range 2 {
		if err = configureVoiceForTest(service, aPlan, a.event); err != nil {
			t.Fatal(err)
		}
		before = b.count(0xa1)
		wait(func() bool { return b.count(0xa1) >= before+3 })
		if err = configureVoiceForTest(service, revoked, a.event); err != nil {
			t.Fatal(err)
		}
		wait(func() bool {
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.revision >= pending.Revision+2
		})
	}
	service.voice.mu.Lock()
	connection := service.voice.connections[aPlan.key()]
	service.voice.mu.Unlock()
	if len(connection.pc.GetTransceivers()) != 3 {
		t.Fatal("repeated voice grants accumulated media sections")
	}

	// Revoke and regrant a subscription while another answer is pending. The
	// immediate packet gate must reopen when the retained desired set is applied.
	b.hold.Store(true)
	if err = service.SignalVoice(bPlan.RoomID, bPlan.PeerID, bPlan.SessionID, bPlan.ConnectionID, VoiceSignal{Renegotiate: true}); err != nil {
		t.Fatal(err)
	}
	var held VoiceDescription
	select {
	case held = <-b.held:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	withoutA2 := bPlan
	withoutA2.Subscribe = []VoicePublication{a1}
	if err = configureVoiceForTest(service, withoutA2, b.event); err != nil {
		t.Fatal(err)
	}
	beforeB = a.count(0xb1)
	wait(func() bool { return a.count(0xb1) >= beforeB+3 })
	stopped = b.count(0xa2)
	beforeB = a.count(0xb1)
	wait(func() bool { return a.count(0xb1) >= beforeB+3 })
	if b.count(0xa2) != stopped {
		t.Fatal("revoked subscription kept receiving before SDP acknowledgement")
	}
	if err = configureVoiceForTest(service, bPlan, b.event); err != nil {
		t.Fatal(err)
	}
	b.hold.Store(false)
	if err = b.answer(held, false); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { return b.count(0xa2) >= stopped+3 })

	// Capture ending does not retire its relay connection or the other source.
	a.sources[a2.ID].active.Store(false)
	beforeB = a.count(0xb1)
	wait(func() bool { return a.count(0xb1) >= beforeB+3 })
	if err = closeVoiceForTest(service, aPlan.RoomID, aPlan.PeerID, aPlan.SessionID, aPlan.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if connectedEvent.IsCurrentState() {
		t.Fatal("queued connection evidence survived physical voice retirement")
	}
	if err = service.SignalVoice(aPlan.RoomID, aPlan.PeerID, aPlan.SessionID, aPlan.ConnectionID, VoiceSignal{Renegotiate: true}); err == nil {
		t.Fatal("closed connection accepted signaling")
	}
	service.voice.mu.Lock()
	remaining := len(service.voice.connections)
	service.voice.mu.Unlock()
	if remaining != 1 || b.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		t.Fatal("exact close retired a sibling")
	}
}

func TestVoiceSubscriptionReusesSlotAcrossIndependentPacketClocks(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	service := NewMedia(MediaOptions{Settings: func() webrtc.SettingEngine { return settings }})
	t.Cleanup(func() { _ = service.Close() })
	first, next := VoicePublication{"voice_first", "speaker_first"}, VoicePublication{"voice_next", "speaker_next"}
	send := VoiceConnectionPlan{RoomID: "1234", PeerID: "sender", SessionID: "sender_session", ConnectionID: "sender_connection", Publish: []VoicePublication{first, next}}
	receive := VoiceConnectionPlan{RoomID: "1234", PeerID: "listener", SessionID: "listener_session", ConnectionID: "listener_connection", Subscribe: []VoicePublication{first}}
	sender := newVoiceFixturePeer(t, ctx, service, settings, send, map[string]byte{first.ID: 0xa1, next.ID: 0xa2})
	listener := newVoiceFixturePeer(t, ctx, service, settings, receive, nil)
	// Different microphones have independent RTP clocks. Reusing an output
	// section must not make the second source look like old SRTP packets.
	sender.sources[first.ID].sequence.Store(20_000)
	sender.sources[next.ID].sequence.Store(1_000)
	for _, peer := range []*voiceFixturePeer{sender, listener} {
		if err := configureVoiceForTest(service, peer.plan, peer.event); err != nil {
			t.Fatal(err)
		}
	}
	waitForSource := func(marker byte, target int) {
		t.Helper()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for listener.count(marker) < target {
			select {
			case err := <-sender.errors:
				t.Fatal(err)
			case err := <-listener.errors:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatalf("source %x did not reach listener: %v", marker, ctx.Err())
			case <-ticker.C:
			}
		}
	}
	waitForSource(0xa1, 3)
	sections := len(listener.pc.GetTransceivers())
	receive.Subscribe = []VoicePublication{next}
	if err := configureVoiceForTest(service, receive, listener.event); err != nil {
		t.Fatal(err)
	}
	waitForSource(0xa2, 3)
	firstTarget := listener.count(0xa1) + 3
	receive.Subscribe = []VoicePublication{first}
	if err := configureVoiceForTest(service, receive, listener.event); err != nil {
		t.Fatal(err)
	}
	waitForSource(0xa1, firstTarget)
	if len(listener.pc.GetTransceivers()) != sections {
		t.Fatal("source replacement grew the negotiated media sections")
	}
}

func TestVoiceFullRoomAdmitsBothPublicationReplacementFacets(t *testing.T) {
	service := NewMedia(MediaOptions{})
	t.Cleanup(func() {
		if err := service.Close(); err != nil {
			t.Error(err)
		}
	})
	configure := func(peer, connection string) error {
		return configureVoiceForTest(service, VoiceConnectionPlan{
			RoomID: "1234", PeerID: peer, SessionID: "session_" + peer, ConnectionID: connection,
		}, func(VoiceMediaEvent) {})
	}
	if err := configure("host", "committed_host"); err != nil {
		t.Fatal(err)
	}
	for i := range maxVoicePublications - 1 {
		if err := configure(fmt.Sprintf("viewer_%d", i), fmt.Sprintf("committed_%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	// Publication replacement retains the full committed graph while the one
	// route operation connects both a new Host junction and its first child.
	if err := configure("host", "replacement_host"); err != nil {
		t.Fatalf("replacement Host facet was rejected: %v", err)
	}
	if err := configure("viewer_0", "replacement_child"); err != nil {
		t.Fatalf("replacement child facet was rejected: %v", err)
	}
	if err := configure("viewer_1", "excess_transition"); err == nil {
		t.Fatal("room admitted a connection beyond the publication replacement allowance")
	}
}

func TestVoiceQueuedCandidateFailureDoesNotPoisonNegotiation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	service := NewMedia(MediaOptions{})
	t.Cleanup(func() { _ = service.Close() })
	plan := VoiceConnectionPlan{RoomID: "1234", PeerID: "peer", SessionID: "session", ConnectionID: "connection"}
	peer := newVoiceFixturePeer(t, ctx, service, webrtc.SettingEngine{}, plan, nil)
	peer.hold.Store(true)
	if err := configureVoiceForTest(service, plan, peer.event); err != nil {
		t.Fatal(err)
	}
	var first VoiceDescription
	select {
	case first = <-peer.held:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// One disposable candidate must not leave an already-applied SDP answer
	// pending forever or block later changes to this admitted connection.
	if err := service.SignalVoice(plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID,
		VoiceSignal{Candidate: &webrtc.ICECandidateInit{Candidate: "candidate:malformed"}}); err != nil {
		t.Fatal(err)
	}
	// Additional trickle input must not turn a full bounded candidate queue
	// into a transport error while the first 64 candidates remain usable.
	for index := range 64 {
		candidate := webrtc.ICECandidateInit{Candidate: fmt.Sprintf("candidate:queued%d 1 udp 100 127.0.0.1 %d typ host", index, 10000+index)}
		if err := service.SignalVoice(plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID,
			VoiceSignal{Candidate: &candidate}); err != nil {
			t.Fatalf("candidate %d falsely failed the voice transport: %v", index, err)
		}
	}
	connection := service.voice.connections[plan.key()]
	if len(connection.candidates) != 64 || connection.candidates[63].Candidate != "candidate:queued62 1 udp 100 127.0.0.1 10062 typ host" {
		t.Fatal("candidate overflow changed the retained queue or its bound")
	}
	if err := peer.answer(first, false); err != nil {
		t.Fatalf("valid answer was rejected by a queued candidate: %v", err)
	}
	if len(connection.candidates) != 0 || connection.pending != nil {
		t.Fatal("valid answer did not drain retained candidates and finish negotiation")
	}
	for _, candidate := range []string{"candidate:malformed", "candidate:control 1 udp 2122260223 127.0.0.1 9999 typ host"} {
		if err := service.SignalVoice(plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID,
			VoiceSignal{Candidate: &webrtc.ICECandidateInit{Candidate: candidate}}); err != nil {
			t.Fatalf("live candidate prevented continued signaling: %v", err)
		}
	}
	if err := service.SignalVoice(plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID,
		VoiceSignal{Renegotiate: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case next := <-peer.held:
		if next.Revision <= first.Revision {
			t.Fatal("renegotiation did not advance")
		}
		if err := peer.answer(next, false); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("queued candidate blocked later negotiation")
	}
}

func TestVoicePlanBoundsAndMediaShutdown(t *testing.T) {
	service := NewMedia(MediaOptions{})
	plan := VoiceConnectionPlan{RoomID: "1234", PeerID: "peer", SessionID: "session", ConnectionID: "connection"}
	for i := range maxVoicePublications + 1 {
		plan.Publish = append(plan.Publish, VoicePublication{ID: fmt.Sprint("voice_", i), PeerID: "speaker"})
	}
	if err := configureVoiceForTest(service, plan, func(VoiceMediaEvent) {}); err == nil {
		t.Fatal("oversized plan allocated a connection")
	}
	plan.Publish = slices.Clone(plan.Publish[:1])
	plan.Subscribe = slices.Clone(plan.Publish)
	if err := configureVoiceForTest(service, plan, func(VoiceMediaEvent) {}); err == nil {
		t.Fatal("looping publication was admitted in both directions")
	}
	plan.Publish, plan.Subscribe = nil, nil
	closed := make(chan error, 1)
	if err := configureVoiceForTest(service, plan, func(event VoiceMediaEvent) {
		if event.Description != nil {
			closed <- closeVoiceForTest(service, plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID)
		}
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("voice callback could not retire its own connection")
	}
	plan.ConnectionID = "shutdown_connection"
	if err := configureVoiceForTest(service, plan, func(VoiceMediaEvent) {}); err != nil {
		t.Fatal(err)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	if err := configureVoiceForTest(service, plan, func(VoiceMediaEvent) {}); err == nil {
		t.Fatal("closed media admitted voice")
	}
	service.voice.mu.Lock()
	defer service.voice.mu.Unlock()
	if len(service.voice.connections) != 0 {
		t.Fatal("media shutdown retained voice connections")
	}
}

func TestVoiceSilentTransportAcceptsLatePublicationOnSameConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	service := NewMedia(MediaOptions{Settings: func() webrtc.SettingEngine { return settings }})
	defer service.Close()
	pub := VoicePublication{ID: "late_voice", PeerID: "speaker"}
	aPlan := VoiceConnectionPlan{RoomID: "1234", PeerID: "a", SessionID: "session_a", ConnectionID: "connection_a"}
	bPlan := VoiceConnectionPlan{RoomID: "1234", PeerID: "b", SessionID: "session_b", ConnectionID: "connection_b"}
	a := newVoiceFixturePeer(t, ctx, service, settings, aPlan, map[string]byte{pub.ID: 0x71})
	b := newVoiceFixturePeer(t, ctx, service, settings, bPlan, nil)
	for _, peer := range []*voiceFixturePeer{a, b} {
		if err := configureVoiceForTest(service, peer.plan, peer.event); err != nil {
			t.Fatal(err)
		}
	}
	wait := func(condition func() bool) {
		t.Helper()
		for !condition() {
			select {
			case err := <-a.errors:
				t.Fatal(err)
			case err := <-b.errors:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
	wait(func() bool {
		return a.pc.ConnectionState() == webrtc.PeerConnectionStateConnected && b.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
	if a.count(0x71) != 0 || b.count(0x71) != 0 {
		t.Fatal("silent transport sent unauthorized audio")
	}
	service.voice.mu.Lock()
	aConnection := service.voice.connections[aPlan.key()]
	bConnection := service.voice.connections[bPlan.key()]
	service.voice.mu.Unlock()
	if len(aConnection.pc.GetTransceivers()) != 1 || len(bConnection.pc.GetTransceivers()) != 1 {
		t.Fatal("silent transport did not reserve exactly one audio slot")
	}
	aPlan.Publish, bPlan.Subscribe = []VoicePublication{pub}, []VoicePublication{pub}
	if err := configureVoiceForTest(service, aPlan, a.event); err != nil {
		t.Fatal(err)
	}
	if err := configureVoiceForTest(service, bPlan, b.event); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { return b.count(0x71) >= 3 })
	service.voice.mu.Lock()
	retained := service.voice.connections[aPlan.key()] == aConnection && service.voice.connections[bPlan.key()] == bConnection
	service.voice.mu.Unlock()
	if !retained || len(aConnection.pc.GetTransceivers()) != 1 {
		t.Fatal("late microphone replaced the admitted connection or missed its idle slot")
	}
}

func configureVoiceForTest(service *Media, plan VoiceConnectionPlan, emit func(VoiceMediaEvent)) error {
	work, err := service.ConfigureVoice(plan, emit)
	if err == nil && work != nil {
		err = work()
	}
	return err
}
func closeVoiceForTest(service *Media, room, peer, session, connection string) error {
	if work := service.CloseVoice(room, peer, session, connection); work != nil {
		return work()
	}
	return nil
}

func TestVoiceDeferredWorkUsesCurrentPlanAndCannotReviveRetiredConnection(t *testing.T) {
	service := NewMedia(MediaOptions{})
	t.Cleanup(func() { _ = service.Close() })
	plan := VoiceConnectionPlan{RoomID: "room", PeerID: "peer", SessionID: "session", ConnectionID: "connection"}
	emit := func(VoiceMediaEvent) {}
	oldWork, err := service.ConfigureVoice(plan, emit)
	if err != nil {
		t.Fatal(err)
	}
	latest := plan
	latest.Publish = []VoicePublication{{ID: "latest", PeerID: "peer"}}
	newWork, err := service.ConfigureVoice(latest, emit)
	if err != nil {
		t.Fatal(err)
	}
	if err := newWork(); err != nil {
		t.Fatal(err)
	}
	if err := oldWork(); err != nil {
		t.Fatal(err)
	}
	service.voice.mu.Lock()
	c := service.voice.connections[plan.key()]
	if !slices.Equal(c.plan.Publish, latest.Publish) {
		t.Error("old work replaced current publication authority")
	}
	service.voice.mu.Unlock()
	closeOld := service.CloseVoice(plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID)
	if !c.closed {
		t.Fatal("retirement did not revoke delivery synchronously")
	}
	if err := oldWork(); err == nil {
		t.Fatal("retired negotiation succeeded")
	}
	service.voice.mu.Lock()
	if service.voice.connections[plan.key()] != c {
		t.Error("retirement lost its physical capacity charge")
	}
	service.voice.mu.Unlock()
	if _, err := service.ConfigureVoice(latest, emit); err == nil {
		t.Fatal("configuration reused a retiring physical key")
	}
	if err := closeOld(); err != nil {
		t.Fatal(err)
	}
	replacementWork, err := service.ConfigureVoice(latest, emit)
	if err != nil {
		t.Fatal(err)
	}
	if err := closeOld(); err != nil {
		t.Fatal(err)
	}
	if err := replacementWork(); err != nil {
		t.Fatalf("old physical close retired replacement: %v", err)
	}
}

func TestVoiceRetirementKeepsPhysicalCapacityChargedUntilReadersJoin(t *testing.T) {
	service := NewMedia(MediaOptions{})
	var held []*voiceConnection
	defer func() {
		for _, c := range held {
			if c != nil {
				c.readers.Done()
			}
		}
		_ = service.Close()
	}()
	var closeFirst func() error
	for i := range maxVoicePublications + 2 {
		plan := VoiceConnectionPlan{RoomID: "room", PeerID: "peer", SessionID: "session", ConnectionID: fmt.Sprint("connection", i)}
		if _, err := service.ConfigureVoice(plan, func(VoiceMediaEvent) {}); err != nil {
			t.Fatal(err)
		}
		service.voice.mu.Lock()
		c := service.voice.connections[plan.key()]
		c.readers.Add(1) // Hold the existing reader-join boundary of physical close.
		service.voice.mu.Unlock()
		held = append(held, c)
		work := service.CloseVoice(plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID)
		if i == 0 {
			closeFirst = work
		}
	}
	extra := VoiceConnectionPlan{RoomID: "room", PeerID: "peer", SessionID: "session", ConnectionID: "extra"}
	if _, err := service.ConfigureVoice(extra, func(VoiceMediaEvent) {}); err == nil {
		t.Fatal("retiring physical connections escaped room capacity")
	}
	done := make(chan error, 1)
	go func() { done <- closeFirst() }()
	select {
	case err := <-done:
		t.Fatalf("close escaped reader join: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	if _, err := service.ConfigureVoice(extra, func(VoiceMediaEvent) {}); err == nil {
		t.Fatal("incomplete physical close released room capacity")
	}
	held[0].readers.Done()
	held[0] = nil
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("physical close did not settle")
	}
	if _, err := service.ConfigureVoice(extra, func(VoiceMediaEvent) {}); err != nil {
		t.Fatalf("completed close retained room capacity: %v", err)
	}
}
