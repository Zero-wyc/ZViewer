package sfu

import (
	"errors"
	"slices"
	"sort"
	"sync"

	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/server/protocol"
)

const maxVoicePublications = protocol.MaxViewersPerRoomLimit + 1

// VoicePublication is an already-authorized source, including one relayed by a peer.
type VoicePublication struct {
	ID     string `json:"id"`
	PeerID string `json:"peerId"`
}

// VoiceConnectionPlan supplies physical work for one junction of the room graph.
// The caller owns admission, publication authority, routing and eventual retirement.
type VoiceConnectionPlan struct {
	RoomID, PeerID, SessionID, ConnectionID string
	Publish, Subscribe                      []VoicePublication
}

type VoiceTrack struct {
	MID           string `json:"mid"`
	PublicationID string `json:"publicationId"`
}

// Offers name both directions; answers name only tracks the peer actually sends.
// Revision fences an answer from earlier negotiation on the same connection.
type VoiceDescription struct {
	Revision uint64                    `json:"revision"`
	SDP      webrtc.SessionDescription `json:"sdp"`
	Tracks   []VoiceTrack              `json:"tracks"`
}

type VoiceSignal struct {
	Description *VoiceDescription        `json:"description,omitempty"`
	Candidate   *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	Renegotiate bool                     `json:"renegotiate,omitempty"`
}

type VoiceMediaEvent struct {
	RoomID, PeerID, SessionID, ConnectionID string
	Description                             *VoiceDescription
	Candidate                               *webrtc.ICECandidateInit
	State                                   webrtc.PeerConnectionState
	// Recheck transport evidence after the receiver acquires its authority lock.
	IsCurrentState func() bool
}

// VoiceRuntime commits plans and retirement synchronously. The returned work
// performs SDP or physical close outside the caller's authority mutex.
type VoiceRuntime interface {
	ConfigureVoice(VoiceConnectionPlan, func(VoiceMediaEvent)) (func() error, error)
	SignalVoice(room, peer, session, connection string, signal VoiceSignal) error
	CloseVoice(room, peer, session, connection string) func() error
}

type voiceKey struct{ room, peer, session, connection string }

func (p VoiceConnectionPlan) key() voiceKey {
	return voiceKey{p.RoomID, p.PeerID, p.SessionID, p.ConnectionID}
}

type voiceMedia struct {
	mu          sync.Mutex
	settings    func() webrtc.SettingEngine
	connections map[voiceKey]*voiceConnection
	closed      bool
}

func newVoiceMedia(settings func() webrtc.SettingEngine) *voiceMedia {
	return &voiceMedia{settings: settings, connections: make(map[voiceKey]*voiceConnection)}
}

func normalizeVoicePlan(plan VoiceConnectionPlan) (VoiceConnectionPlan, error) {
	for _, id := range []string{plan.RoomID, plan.PeerID, plan.SessionID, plan.ConnectionID} {
		if id == "" || len(id) > 128 {
			return plan, errors.New("voice connection identity is invalid")
		}
	}
	if len(plan.Publish) > maxVoicePublications || len(plan.Subscribe) > maxVoicePublications {
		return plan, errors.New("voice publication count is invalid")
	}
	seen := make(map[string]bool)
	for _, list := range [][]VoicePublication{plan.Publish, plan.Subscribe} {
		for _, pub := range list {
			if pub.ID == "" || len(pub.ID) > 128 || pub.PeerID == "" || len(pub.PeerID) > 128 || seen[pub.ID] {
				return plan, errors.New("voice publication identity is invalid")
			}
			seen[pub.ID] = true
		}
	}
	plan.Publish, plan.Subscribe = slices.Clone(plan.Publish), slices.Clone(plan.Subscribe)
	for _, list := range [][]VoicePublication{plan.Publish, plan.Subscribe} {
		sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	}
	return plan, nil
}

// ConfigureVoice commits publication authority before returning SDP work. The
// caller runs that work outside its authority lock; it uses the current plan.
func (media *Media) ConfigureVoice(plan VoiceConnectionPlan, emit func(VoiceMediaEvent)) (func() error, error) {
	plan, err := normalizeVoicePlan(plan)
	if err != nil {
		return nil, err
	}
	if emit == nil {
		return nil, errors.New("voice callback is required")
	}
	v := media.voice
	v.mu.Lock()
	if v.closed {
		v.mu.Unlock()
		return nil, errors.New("voice media is closed")
	}
	c := v.connections[plan.key()]
	if c != nil && c.closed {
		v.mu.Unlock()
		return nil, errors.New("voice connection is retiring")
	}
	if c == nil {
		// One committed connection per member. The room's one transition may
		// replace both the Host junction and its first child connection.
		roomCount := 0
		for key := range v.connections {
			if key.room == plan.RoomID {
				roomCount++
			}
		}
		if roomCount >= maxVoicePublications+2 {
			v.mu.Unlock()
			return nil, errors.New("voice connection capacity is exhausted")
		}
		c, err = newVoiceConnection(v, plan, emit)
		if err != nil {
			v.mu.Unlock()
			return nil, err
		}
		v.connections[plan.key()] = c
	}
	c.emit = emit
	changed := !slices.Equal(c.plan.Publish, plan.Publish) || !slices.Equal(c.plan.Subscribe, plan.Subscribe)
	c.plan = plan
	if changed {
		c.version++
	}
	// RTP authorization changes before any deferred SDP work. A removed sender
	// cannot continue delivering packets while an older answer remains pending.
	for id, out := range c.outgoing {
		if !slices.Contains(plan.Subscribe, out.source()) {
			out.disable()
			delete(c.outgoing, id)
		}
	}
	for _, input := range c.bindings {
		if !slices.Contains(plan.Publish, input.publication) {
			c.detachInputLocked(input.source)
		}
	}
	v.mu.Unlock()
	return func() error { return c.negotiate(false) }, nil
}

func (media *Media) SignalVoice(room, peer, session, connection string, signal VoiceSignal) error {
	v := media.voice
	v.mu.Lock()
	c := v.connections[voiceKey{room, peer, session, connection}]
	v.mu.Unlock()
	if c == nil {
		return errors.New("voice connection is no longer current")
	}
	return c.signal(signal)
}

// CloseVoice synchronously revokes delivery, retaining the capacity charge until
// the caller runs the returned physical close and reader join outside authority.
func (media *Media) CloseVoice(room, peer, session, connection string) func() error {
	v := media.voice
	v.mu.Lock()
	c := v.connections[voiceKey{room, peer, session, connection}]
	if c != nil {
		c.retireLocked()
	}
	v.mu.Unlock()
	if c == nil {
		return nil
	}
	return c.close
}

func (v *voiceMedia) close() error {
	v.mu.Lock()
	v.closed = true
	connections := v.connections
	for _, c := range connections {
		c.retireLocked()
	}
	v.connections = make(map[voiceKey]*voiceConnection)
	v.mu.Unlock()
	var err error
	for _, c := range connections {
		err = errors.Join(err, c.close())
	}
	return err
}
