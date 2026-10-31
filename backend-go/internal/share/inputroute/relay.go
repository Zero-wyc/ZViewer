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
	endpoints map[string]string
}

type Relay struct {
	mu     sync.Mutex
	up     *webrtc.DataChannel
	down   map[string]*leg
	ready  bool
	closed bool
	// Root callbacks run outside mu. The root validates endpoint authority.
	receive func(edgeID string, packet Packet)
}

func New(receive func(string, Packet)) *Relay {
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

func (r *Relay) AttachDown(edgeID string, channel *webrtc.DataChannel) {
	r.mu.Lock()
	// SCTP can close before its OnClose callback retires the old binding.
	if old := r.down[edgeID]; !r.closed && old != nil && old.channel.ReadyState() == webrtc.DataChannelStateClosed {
		r.mu.Unlock()
		r.LoseDown(edgeID, old.channel)
		r.mu.Lock()
	}
	if r.closed || r.down[edgeID] != nil {
		r.mu.Unlock()
		_ = channel.Close()
		return
	}
	child := &leg{channel: channel, endpoints: make(map[string]string)}
	r.down[edgeID] = child
	r.mu.Unlock()
	channel.OnOpen(func() { r.mu.Lock(); defer r.mu.Unlock(); send(channel, Packet{Ready: &r.ready}) })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		p, ok := decode(message)
		if !ok {
			return
		}
		r.mu.Lock()
		if r.closed || r.down[edgeID] != child {
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
			if child.endpoints[p.ID] == p.Epoch {
				delete(child.endpoints, p.ID)
			}
		} else {
			if child.endpoints[p.ID] == "" && len(child.endpoints) >= 20 {
				r.mu.Unlock()
				return
			}
			child.endpoints[p.ID] = p.Epoch
		}
		if r.receive == nil {
			send(r.up, p)
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()
		r.receive(edgeID, p)
	})
	channel.OnClose(func() { r.LoseDown(edgeID, channel) })
}

func boolPointer(value bool) *bool { return &value }

func (r *Relay) LoseDown(edgeID string, channel *webrtc.DataChannel) {
	r.mu.Lock()
	child := r.down[edgeID]
	if child == nil || channel != nil && child.channel != channel {
		r.mu.Unlock()
		return
	}
	packets := make([]Packet, 0, len(child.endpoints))
	for id, epoch := range child.endpoints {
		packets = append(packets, Packet{ID: id, Epoch: epoch, Closed: true})
	}
	clear(child.endpoints)
	if channel != nil {
		delete(r.down, edgeID)
	}
	if r.receive == nil {
		for _, p := range packets {
			send(r.up, p)
		}
	}
	r.mu.Unlock()
	if r.receive != nil {
		for _, p := range packets {
			r.receive(edgeID, p)
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
