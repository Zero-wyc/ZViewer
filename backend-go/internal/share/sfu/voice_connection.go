package sfu

import (
	"errors"
	"slices"
	"strings"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/rtcerr"
	"zviewer/backend/internal/share/forwarding"
)

var voiceCodec = webrtc.RTPCodecCapability{
	MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	SDPFmtpLine: "minptime=10;useinbandfec=1;maxaveragebitrate=510000",
}

type voiceReceiveSlot struct {
	transceiver *webrtc.RTPTransceiver
	publication VoicePublication
	rtcp        bool
}

type voiceSendSlot struct {
	mu          sync.Mutex
	publication VoicePublication
	transceiver *webrtc.RTPTransceiver
	track       *webrtc.TrackLocalStaticRTP
	active      bool
}

func (s *voiceSendSlot) disable() {
	s.mu.Lock()
	s.active = false
	s.mu.Unlock()
}

func (s *voiceSendSlot) source() VoicePublication {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publication
}

func (s *voiceSendSlot) write(publication VoicePublication, packet *rtp.Packet) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active && s.publication == publication {
		// A failed subscriber write belongs to that connection, not the source.
		_ = s.track.WriteRTP(packet)
	}
}

type voiceOffer struct {
	description VoiceDescription
	version     uint64
	incoming    map[string]VoicePublication
}

type voiceConnection struct {
	owner *voiceMedia
	key   voiceKey
	pc    *webrtc.PeerConnection
	// The owner mutex protects plans and the packet-forwarding view.
	plan     VoiceConnectionPlan
	version  uint64
	emit     func(VoiceMediaEvent)
	outgoing map[string]*voiceSendSlot
	remote   map[string]VoicePublication
	bindings map[string]*webrtc.TrackRemote
	closed   bool
	readers  sync.WaitGroup
	// SDP mutations are serialized independently of room signaling and RTP.
	signaling         sync.Mutex
	receiveSlots      []*voiceReceiveSlot
	sendSlots         []*voiceSendSlot
	pending           *voiceOffer
	sequence          uint64
	negotiatedVersion uint64
	renegotiate       bool
	candidates        []webrtc.ICECandidateInit
	events            chan VoiceMediaEvent
	stop              chan struct{}
	closeOnce         sync.Once
	closeErr          error
	failureOnce       sync.Once
}

func newVoiceConnection(owner *voiceMedia, plan VoiceConnectionPlan, emit func(VoiceMediaEvent)) (*voiceConnection, error) {
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: voiceCodec, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		return nil, err
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(owner.settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	c := &voiceConnection{owner: owner, key: plan.key(), pc: pc, emit: emit,
		outgoing: make(map[string]*voiceSendSlot), remote: make(map[string]VoicePublication), bindings: make(map[string]*webrtc.TrackRemote),
		events: make(chan VoiceMediaEvent, 128), stop: make(chan struct{})}
	// A silent room still negotiates its admitted transport. The empty receive
	// slot is reused by a later authorized publication; it emits no audio.
	idle, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	c.receiveSlots = []*voiceReceiveSlot{{transceiver: idle}}
	pc.OnDataChannel(func(channel *webrtc.DataChannel) { _ = channel.Close() })
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			value := candidate.ToJSON()
			c.queue(VoiceMediaEvent{Candidate: &value})
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) { c.queue(VoiceMediaEvent{State: state}) })
	pc.OnTrack(c.consume)
	go c.deliver()
	return c, nil
}

// The bounded emitter lets authority call Configure while holding its own lock.
// No supplied callback runs under adapter locks or on Pion's close stack.
func (c *voiceConnection) queue(event VoiceMediaEvent) {
	select {
	case <-c.stop:
		return
	default:
	}
	select {
	case c.events <- event:
	case <-c.stop:
	default:
		c.failureOnce.Do(func() {
			go func() {
				c.dispatch(VoiceMediaEvent{State: webrtc.PeerConnectionStateFailed})
				_ = c.close()
			}()
		})
	}
}

func (c *voiceConnection) dispatch(event VoiceMediaEvent) {
	c.owner.mu.Lock()
	current := !c.closed && c.owner.connections[c.key] == c
	emit := c.emit
	c.owner.mu.Unlock()
	if current {
		event.RoomID, event.PeerID, event.SessionID, event.ConnectionID = c.key.room, c.key.peer, c.key.session, c.key.connection
		state := event.State
		event.IsCurrentState = func() bool {
			c.owner.mu.Lock()
			defer c.owner.mu.Unlock()
			return !c.closed && c.owner.connections[c.key] == c && c.pc.ConnectionState() == state
		}
		emit(event)
	}
}

func (c *voiceConnection) deliver() {
	for {
		select {
		case <-c.stop:
			return
		default:
		}
		select {
		case event := <-c.events:
			c.dispatch(event)
		case <-c.stop:
			return
		}
	}
}

func (c *voiceConnection) snapshotPlan() (VoiceConnectionPlan, uint64, error) {
	c.owner.mu.Lock()
	defer c.owner.mu.Unlock()
	if c.closed || c.owner.connections[c.key] != c {
		return VoiceConnectionPlan{}, 0, errors.New("voice connection is no longer current")
	}
	return c.plan, c.version, nil
}

func (c *voiceConnection) negotiate(force bool) error {
	c.signaling.Lock()
	defer c.signaling.Unlock()
	return c.offer(force)
}

// offer runs only under signaling. Changes arriving while an answer is pending
// update RTP authorization immediately and coalesce into the next offer.
func (c *voiceConnection) offer(force bool) error {
	plan, version, err := c.snapshotPlan()
	if err != nil {
		return err
	}
	c.renegotiate = c.renegotiate || force
	if c.pending != nil || c.sequence != 0 && version == c.negotiatedVersion && !c.renegotiate {
		return nil
	}
	if err = c.syncSlots(plan); err != nil {
		return err
	}
	offer, err := c.pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err = c.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	c.sequence++
	description := VoiceDescription{Revision: c.sequence, SDP: *c.pc.LocalDescription(), Tracks: []VoiceTrack{}}
	incoming := make(map[string]VoicePublication)
	for _, slot := range c.receiveSlots {
		if slot.publication.ID != "" {
			mid := slot.transceiver.Mid()
			description.Tracks = append(description.Tracks, VoiceTrack{MID: mid, PublicationID: slot.publication.ID})
			incoming[mid] = slot.publication
		}
	}
	for _, slot := range c.sendSlots {
		if slot.publication.ID != "" {
			description.Tracks = append(description.Tracks, VoiceTrack{MID: slot.transceiver.Mid(), PublicationID: slot.publication.ID})
		}
	}
	c.pending = &voiceOffer{description: description, incoming: incoming, version: version}
	c.renegotiate = false
	c.queue(VoiceMediaEvent{Description: &description})
	return nil
}

func (c *voiceConnection) syncSlots(plan VoiceConnectionPlan) error {
	for _, slot := range c.receiveSlots {
		if !slices.Contains(plan.Publish, slot.publication) {
			slot.publication = VoicePublication{}
		}
	}
	for _, pub := range plan.Publish {
		if slices.ContainsFunc(c.receiveSlots, func(slot *voiceReceiveSlot) bool { return slot.publication == pub }) {
			continue
		}
		index := slices.IndexFunc(c.receiveSlots, func(slot *voiceReceiveSlot) bool { return slot.publication.ID == "" })
		if index < 0 {
			transceiver, err := c.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
			if err != nil {
				return err
			}
			c.receiveSlots = append(c.receiveSlots, &voiceReceiveSlot{transceiver: transceiver})
			index = len(c.receiveSlots) - 1
		}
		c.receiveSlots[index].publication = pub
	}
	for _, slot := range c.receiveSlots {
		if !slot.rtcp {
			slot.rtcp = true
			if c.startReader() {
				go func(receiver *webrtc.RTPReceiver) {
					defer c.readers.Done()
					for {
						if _, _, err := receiver.ReadRTCP(); err != nil {
							return
						}
					}
				}(slot.transceiver.Receiver())
			}
		}
	}
	for _, slot := range c.sendSlots {
		if slot.publication.ID != "" && !slices.Contains(plan.Subscribe, slot.publication) {
			slot.disable()
			if err := slot.transceiver.Sender().ReplaceTrack(nil); err != nil {
				return err
			}
			slot.mu.Lock()
			slot.publication, slot.track = VoicePublication{}, nil
			slot.mu.Unlock()
		}
	}
	for _, pub := range plan.Subscribe {
		if index := slices.IndexFunc(c.sendSlots, func(slot *voiceSendSlot) bool { return slot.publication == pub }); index >= 0 {
			c.authorizeOutput(c.sendSlots[index], pub)
			continue
		}
		track, err := webrtc.NewTrackLocalStaticRTP(voiceCodec, pub.ID, pub.PeerID)
		if err != nil {
			return err
		}
		index := slices.IndexFunc(c.sendSlots, func(slot *voiceSendSlot) bool { return slot.publication.ID == "" })
		if index < 0 {
			transceiver, err := c.pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
			if err != nil {
				return err
			}
			c.sendSlots = append(c.sendSlots, &voiceSendSlot{transceiver: transceiver})
			index = len(c.sendSlots) - 1
			c.readRTCP(transceiver.Sender())
		} else if err = c.sendSlots[index].transceiver.Sender().ReplaceTrack(track); err != nil {
			return err
		}
		slot := c.sendSlots[index]
		slot.mu.Lock()
		slot.publication, slot.track = pub, track
		slot.mu.Unlock()
		c.authorizeOutput(slot, pub)
	}
	return nil
}

func (c *voiceConnection) authorizeOutput(slot *voiceSendSlot, pub VoicePublication) {
	c.owner.mu.Lock()
	defer c.owner.mu.Unlock()
	slot.mu.Lock()
	slot.active = !c.closed && slices.Contains(c.plan.Subscribe, pub)
	if slot.active {
		c.outgoing[pub.ID] = slot
	}
	slot.mu.Unlock()
}

func (c *voiceConnection) signal(signal VoiceSignal) error {
	c.signaling.Lock()
	defer c.signaling.Unlock()
	if _, _, err := c.snapshotPlan(); err != nil {
		return err
	}
	count := 0
	if signal.Description != nil {
		count++
	}
	if signal.Candidate != nil {
		count++
	}
	if signal.Renegotiate {
		count++
	}
	if count != 1 {
		return errors.New("one voice signal is required")
	}
	if signal.Renegotiate {
		return c.offer(true)
	}
	if signal.Candidate != nil {
		if c.pc.RemoteDescription() == nil {
			if len(c.candidates) >= 64 {
				return nil
			}
			c.candidates = append(c.candidates, *signal.Candidate)
			return nil
		}
		return c.addCandidate(*signal.Candidate)
	}
	answer := signal.Description
	if c.pending == nil || answer.Revision != c.pending.description.Revision || answer.SDP.Type != webrtc.SDPTypeAnswer ||
		len(answer.Tracks) > c.owner.capacity || len(answer.SDP.SDP) > 128*1024 {
		return errors.New("voice answer is stale or invalid")
	}
	remote := make(map[string]VoicePublication)
	seen := make(map[string]bool)
	for _, track := range answer.Tracks {
		pub, ok := c.pending.incoming[track.MID]
		if !ok || pub.ID != track.PublicationID || remote[track.MID].ID != "" || seen[pub.ID] {
			return errors.New("voice publication is not authorized for this media section")
		}
		remote[track.MID], seen[pub.ID] = pub, true
	}
	if err := c.pc.SetRemoteDescription(answer.SDP); err != nil {
		return err
	}
	c.owner.mu.Lock()
	c.remote = remote
	c.owner.mu.Unlock()
	for _, candidate := range c.candidates {
		// Candidates are disposable input, not the SDP transaction. A rejected
		// candidate must not strand an already-applied answer in pending.
		if err := c.addCandidate(candidate); err != nil {
			return err
		}
	}
	c.candidates = nil
	c.negotiatedVersion = c.pending.version
	c.pending = nil
	return c.offer(false)
}

func (c *voiceConnection) addCandidate(candidate webrtc.ICECandidateInit) error {
	err := forwarding.AddICECandidate(c.pc, candidate)
	var candidateError *rtcerr.OperationError
	if errors.As(err, &candidateError) {
		return nil
	}
	return err
}

func (c *voiceConnection) startReader() bool {
	c.owner.mu.Lock()
	defer c.owner.mu.Unlock()
	if c.closed {
		return false
	}
	c.readers.Add(1)
	return true
}

func (c *voiceConnection) readRTCP(sender *webrtc.RTPSender) {
	if !c.startReader() {
		return
	}
	go func() {
		defer c.readers.Done()
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
}

func (c *voiceConnection) consume(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) || track.Codec().ClockRate != 48_000 {
		return
	}
	mid := ""
	for _, transceiver := range c.pc.GetTransceivers() {
		if transceiver.Receiver() == receiver {
			mid = transceiver.Mid()
			break
		}
	}
	if mid == "" {
		return
	}
	c.owner.mu.Lock()
	if c.closed || c.bindings[mid] != nil || len(c.bindings) >= c.owner.capacity {
		c.owner.mu.Unlock()
		return
	}
	c.bindings[mid] = track
	c.readers.Add(1)
	c.owner.mu.Unlock()
	defer func() {
		c.owner.mu.Lock()
		delete(c.bindings, mid)
		c.owner.mu.Unlock()
		c.readers.Done()
	}()
	for {
		packet, _, err := forwarding.ReadRTP(track)
		if err != nil {
			return
		}
		c.owner.mu.Lock()
		pub := c.remote[mid]
		var outputs []*voiceSendSlot
		if !c.closed && pub.ID != "" && slices.Contains(c.plan.Publish, pub) {
			for _, other := range c.owner.connections {
				if other != c && !other.closed && other.key.room == c.key.room {
					if out := other.outgoing[pub.ID]; out != nil && slices.Contains(other.plan.Subscribe, pub) {
						outputs = append(outputs, out)
					}
				}
			}
		}
		c.owner.mu.Unlock()
		// Destination transports own their negotiated extensions and RTCP.
		packet.Extension, packet.ExtensionProfile, packet.Extensions = false, 0, nil
		for _, out := range outputs {
			out.write(pub, packet)
		}
	}
}

// retireLocked revokes packet delivery before physical close can block.
func (c *voiceConnection) retireLocked() {
	c.closed = true
	for _, out := range c.outgoing {
		out.disable()
	}
}

func (c *voiceConnection) close() error {
	c.closeOnce.Do(func() {
		c.owner.mu.Lock()
		c.retireLocked()
		c.owner.mu.Unlock()
		close(c.stop)
		c.closeErr = c.pc.Close()
		c.readers.Wait()
		c.owner.mu.Lock()
		if c.owner.connections[c.key] == c {
			delete(c.owner.connections, c.key)
		}
		c.owner.mu.Unlock()
	})
	return c.closeErr
}
