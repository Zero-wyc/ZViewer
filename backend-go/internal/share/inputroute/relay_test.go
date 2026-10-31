package inputroute

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestClosedDownstreamBindingAllowsReplacement(t *testing.T) {
	received := make(chan Packet, 10)
	relay := New(func(_ string, p Packet) { received <- p })
	defer relay.Close()
	oldSend, oldChannel := inputChannelPair(t)
	relay.AttachDown("same-edge", oldChannel)
	oldPacket := Packet{ID: strings.Repeat("a", 32), Epoch: strings.Repeat("b", 32), Data: "old"}
	send(oldSend, oldPacket)
	if p := receiveInputPacket(t, received); p != oldPacket {
		t.Fatalf("old packet = %+v", p)
	}
	released, closed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(released) }) }
	defer release()
	// Hold the actual SCTP callback after its channel has entered Closed.
	oldChannel.OnClose(func() {
		<-released
		relay.LoseDown("same-edge", oldChannel)
		close(closed)
	})
	if err := oldSend.Close(); err != nil {
		t.Fatal(err)
	}
	waitInputChannel(t, "old SCTP closes", func() bool { return oldChannel.ReadyState() == webrtc.DataChannelStateClosed })
	newSend, newChannel := inputChannelPair(t)
	relay.AttachDown("same-edge", newChannel)
	if p := receiveInputPacket(t, received); p != (Packet{ID: oldPacket.ID, Epoch: oldPacket.Epoch, Closed: true}) {
		t.Fatalf("old endpoint was not retired: %+v", p)
	}
	packet := Packet{ID: strings.Repeat("c", 32), Epoch: strings.Repeat("d", 32), Data: "new"}
	checkReplacement := func() {
		t.Helper()
		send(newSend, packet)
		if p := receiveInputPacket(t, received); p != packet {
			t.Fatalf("replacement packet = %+v", p)
		}
	}
	checkReplacement()
	release()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("old OnClose did not finish")
	}
	checkReplacement() // Late cleanup must not detach the replacement.
	_, duplicate := inputChannelPair(t)
	relay.AttachDown("same-edge", duplicate)
	waitInputChannel(t, "live duplicate rejected", func() bool { return duplicate.ReadyState() == webrtc.DataChannelStateClosed })
	checkReplacement()
}

func receiveInputPacket(t *testing.T, packets <-chan Packet) Packet {
	t.Helper()
	select {
	case p := <-packets:
		return p
	case <-time.After(2 * time.Second):
		t.Fatal("no relayed input packet")
		return Packet{}
	}
}

func waitInputChannel(t *testing.T, label string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(label)
}

func inputChannelPair(t *testing.T) (*webrtc.DataChannel, *webrtc.DataChannel) {
	t.Helper()
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	a, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	b, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	remote := make(chan *webrtc.DataChannel, 1)
	b.OnDataChannel(func(c *webrtc.DataChannel) { remote <- c })
	local, err := a.CreateDataChannel(Label, nil)
	if err != nil {
		t.Fatal(err)
	}
	offer, err := a.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(a)
	if err = a.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		t.Fatal("offer gather")
	}
	if err = b.SetRemoteDescription(*a.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := b.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather = webrtc.GatheringCompletePromise(b)
	if err = b.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		t.Fatal("answer gather")
	}
	if err = a.SetRemoteDescription(*b.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	var other *webrtc.DataChannel
	select {
	case other = <-remote:
	case <-time.After(5 * time.Second):
		t.Fatal("remote data channel")
	}
	waitInputChannel(t, "SCTP opens", func() bool {
		return local.ReadyState() == webrtc.DataChannelStateOpen && other.ReadyState() == webrtc.DataChannelStateOpen
	})
	return local, other
}
