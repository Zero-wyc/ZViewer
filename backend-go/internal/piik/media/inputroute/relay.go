// Package inputroute carries opaque attended-input packets over the existing
// media tree. It owns no PeerConnections, route selection or permissions.
package inputroute

import (
	"encoding/json"
	"sync"

	"github.com/pion/webrtc/v4"
)

const Label = "piik-remote-input-prototype-v1"

// 2 KiB of text, JSON escaping, authenticated encryption and the relay envelope.
const MaxPacket = 6144

// Allow route overlap for the room's 20 endpoints while bounding retirement
// metadata. Epochs remain opaque here; only the Host knows which is authorized.
const maxTrackedEpochs = 128

// Packet data is authenticated and encrypted between the Viewer and Host App.
// Relays only learn endpoint IDs. Small Host state replies fan out along the
// existing tree; only the named endpoint can read them.
type Packet struct {
	ID     string `json:"id,omitempty"`
	Epoch  string `json:"epoch,omitempty"`
	Data   string `json:"data,omitempty"`
	Closed bool   `json:"closed,omitempty"`
	Ready  *bool  `json:"ready,omitempty"`
}

type leg struct {
	channel   *webrtc.DataChannel
	endpoints map[string]map[string]struct{}
}

type Relay struct {
	mu     sync.Mutex
	up     *webrtc.DataChannel
	down   map[string]*leg
	ready  bool
	closed bool
	// Root callbacks run outside mu. The root checks the delivery binding while
	// holding its permission lock, so retirement can invalidate an already-read packet.
	receive func(edgeID string, packet Packet, current func() bool)
}

func New(receive func(string, Packet, func() bool)) *Relay {
	return &Relay{down: make(map[string]*leg), receive: receive, ready: receive != nil}
}

func decode(message webrtc.DataChannelMessage) (Packet, bool) {
	var p Packet
	if !message.IsString || len(message.Data) > MaxPacket || json.Unmarshal(message.Data, &p) != nil {
		return p, false
	}
	return p, p.Ready != nil || len(p.ID) == 32 && len(p.Epoch) == 32 && (p.Closed || p.Data != "")
}

func send(channel *webrtc.DataChannel, p Packet) {
	if channel == nil || channel.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	if channel.BufferedAmount() > 8192 {
		go channel.Close()
		return
	}
	data, _ := json.Marshal(p)
	_ = channel.SendText(string(data))
}

func (r *Relay) AttachUp(channel *webrtc.DataChannel) {
	r.mu.Lock()
	if r.closed || r.up != nil || channel.Label() != Label {
		r.mu.Unlock()
		_ = channel.Close()
		return
	}
	r.up = channel
	r.mu.Unlock()
	channel.OnOpen(func() { send(channel, Packet{Ready: boolPointer(true)}) })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		p, ok := decode(message)
		if !ok {
			return
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.closed || r.up != channel {
			return
		}
		if p.Ready != nil && p.ID == "" {
			r.ready = *p.Ready
		}
		for _, child := range r.down {
			send(child.channel, p)
		}
	})
	channel.OnClose(func() { r.SetUpAvailable(false) })
}

// ICE loss releases all descendant input even if SCTP has not closed yet.
func (r *Relay) SetUpAvailable(available bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if available {
		send(r.up, Packet{Ready: boolPointer(true)})
		return
	}
	r.ready = false
	for _, child := range r.down {
		send(child.channel, Packet{Ready: &r.ready})
	}
}

// AttachDown returns transient-loss cleanup tied to this exact physical channel.
func (r *Relay) AttachDown(edgeID string, channel *webrtc.DataChannel) func() {
	r.mu.Lock()
	// SCTP can close before its OnClose callback retires the old binding.
	if old := r.down[edgeID]; !r.closed && old != nil && old.channel.ReadyState() == webrtc.DataChannelStateClosed {
		r.mu.Unlock()
		r.loseDown(edgeID, old.channel, true)
		r.mu.Lock()
	}
	if r.closed || r.down[edgeID] != nil {
		r.mu.Unlock()
		_ = channel.Close()
		return func() {}
	}
	child := &leg{channel: channel, endpoints: make(map[string]map[string]struct{})}
	r.down[edgeID] = child
	r.mu.Unlock()
	channel.OnOpen(func() { r.mu.Lock(); defer r.mu.Unlock(); send(channel, Packet{Ready: &r.ready}) })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		p, ok := decode(message)
		if !ok {
			return
		}
		r.mu.Lock()
		child := r.down[edgeID]
		if r.closed || child == nil || child.channel != channel {
			r.mu.Unlock()
			return
		}
		if p.Ready != nil {
			send(channel, Packet{Ready: &r.ready})
			r.mu.Unlock()
			return
		}
		if !r.ready {
			r.mu.Unlock()
			return
		}
		if p.Closed {
			delete(child.endpoints[p.ID], p.Epoch)
			if len(child.endpoints[p.ID]) == 0 {
				delete(child.endpoints, p.ID)
			}
		} else {
			epochs := child.endpoints[p.ID]
			if epochs == nil && len(child.endpoints) >= 20 {
				r.mu.Unlock()
				return
			}
			if _, known := epochs[p.Epoch]; !known {
				count := 0
				for _, tracked := range child.endpoints {
					count += len(tracked)
				}
				if count >= maxTrackedEpochs {
					r.mu.Unlock()
					r.loseDown(edgeID, channel, true)
					_ = channel.Close()
					return
				}
				if epochs == nil {
					epochs = make(map[string]struct{})
					child.endpoints[p.ID] = epochs
				}
				// A late packet from an old branch must not erase another epoch
				// whose grant the Host may still need to retire on branch loss.
				epochs[p.Epoch] = struct{}{}
			}
		}
		if r.receive == nil {
			send(r.up, p)
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()
		r.receive(edgeID, p, func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			return !r.closed && r.down[edgeID] == child && channel.ReadyState() == webrtc.DataChannelStateOpen
		})
	})
	channel.OnClose(func() { r.loseDown(edgeID, channel, true) })
	return func() { r.loseDown(edgeID, channel, false) }
}

func boolPointer(value bool) *bool { return &value }

// ResetDown invalidates in-flight deliveries from this exact input channel.
// The permission owner calls this under its own lock and retires its grants in
// the same transaction; this method must not call back into that owner.
func (r *Relay) ResetDown(edgeID string, channel *webrtc.DataChannel) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	child := r.down[edgeID]
	if r.closed || child == nil || child.channel != channel {
		return false
	}
	r.down[edgeID] = &leg{channel: channel, endpoints: make(map[string]map[string]struct{})}
	return true
}

func (r *Relay) loseDown(edgeID string, channel *webrtc.DataChannel, remove bool) {
	r.mu.Lock()
	child := r.down[edgeID]
	if child == nil || child.channel != channel {
		r.mu.Unlock()
		return
	}
	packets := make([]Packet, 0, len(child.endpoints))
	for id, epochs := range child.endpoints {
		for epoch := range epochs {
			packets = append(packets, Packet{ID: id, Epoch: epoch, Closed: true})
		}
	}
	if remove {
		delete(r.down, edgeID)
	} else {
		r.down[edgeID] = &leg{channel: child.channel, endpoints: make(map[string]map[string]struct{})}
	}
	if r.receive == nil {
		for _, p := range packets {
			send(r.up, p)
		}
	}
	r.mu.Unlock()
	if r.receive != nil {
		for _, p := range packets {
			r.receive(edgeID, p, nil)
		}
	}
}

func (r *Relay) Reply(p Packet) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	for _, child := range r.down {
		send(child.channel, p)
	}
}

func (r *Relay) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	channels := []*webrtc.DataChannel{r.up}
	for _, child := range r.down {
		channels = append(channels, child.channel)
	}
	r.mu.Unlock()
	for _, channel := range channels {
		if channel != nil {
			_ = channel.Close()
		}
	}
}
