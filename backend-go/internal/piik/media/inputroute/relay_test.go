package inputroute

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestClosedDownstreamBindingAllowsReplacement(t *testing.T) {
	received := make(chan Packet, 10)
	relay := New(func(_ string, p Packet, _ func() bool) { received <- p })
	defer relay.Close()
	oldSend, oldChannel := inputChannelPair(t)
	oldLoss := relay.AttachDown("same-edge", oldChannel)
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
		relay.loseDown("same-edge", oldChannel, true)
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
	oldLoss()
	checkReplacement() // A queued ICE loss also belongs only to the old channel.
	_, duplicate := inputChannelPair(t)
	relay.AttachDown("same-edge", duplicate)
	waitInputChannel(t, "live duplicate rejected", func() bool { return duplicate.ReadyState() == webrtc.DataChannelStateClosed })
	checkReplacement()
}

func TestBranchLossRetiresEveryUnclosedEpoch(t *testing.T) {
	for _, oldClosed := range []bool{false, true} {
		t.Run(map[bool]string{false: "late-old-data", true: "late-old-closure"}[oldClosed], func(t *testing.T) {
			received := make(chan Packet, 10)
			relay := New(func(_ string, p Packet, _ func() bool) { received <- p })
			defer relay.Close()
			viewer, branch := inputChannelPair(t)
			loseBranch := relay.AttachDown("shared-branch", branch)
			old := Packet{ID: strings.Repeat("a", 32), Epoch: strings.Repeat("b", 32), Data: "old"}
			current := Packet{ID: old.ID, Epoch: strings.Repeat("c", 32), Data: "current"}
			// Two routes may converge on this leg. The old longer route's last
			// packet can follow a newer epoch without becoming current at Host.
			for _, p := range []Packet{old, current, old} {
				send(viewer, p)
				if got := receiveInputPacket(t, received); got != p {
					t.Fatalf("relayed packet = %+v, want %+v", got, p)
				}
			}
			if oldClosed {
				p := Packet{ID: old.ID, Epoch: old.Epoch, Closed: true}
				send(viewer, p)
				if got := receiveInputPacket(t, received); got != p {
					t.Fatalf("old closure = %+v", got)
				}
			}
			loseBranch()
			retired := map[string]bool{}
			for len(received) > 0 {
				p := <-received
				if p.ID != current.ID || !p.Closed {
					t.Fatalf("branch retirement = %+v", p)
				}
				retired[p.Epoch] = true
			}
			if !retired[current.Epoch] || retired[old.Epoch] == oldClosed {
				t.Fatalf("retired epochs = %v, old already closed = %v", retired, oldClosed)
			}
		})
	}
}

func TestEpochTrackingLimitRetiresInputWithoutClosingTransport(t *testing.T) {
	received := make(chan Packet, maxTrackedEpochs+2)
	relay := New(func(_ string, p Packet, _ func() bool) { received <- p })
	defer relay.Close()
	viewer, branch := inputChannelPair(t)
	relay.AttachDown("branch", branch)
	tracked := map[string]Packet{}
	for i := range maxTrackedEpochs {
		p := Packet{ID: fmt.Sprintf("%032x", i%20), Epoch: fmt.Sprintf("%032x", i), Data: "input"}
		send(viewer, p)
		if got := receiveInputPacket(t, received); got != p {
			t.Fatalf("packet = %+v, want %+v", got, p)
		}
		tracked[p.Epoch] = p
	}
	// At capacity, an existing epoch still carries input. A Closed packet frees
	// its exact record, without retiring another epoch of the same endpoint.
	p := tracked[fmt.Sprintf("%032x", 0)]
	send(viewer, p)
	if got := receiveInputPacket(t, received); got != p {
		t.Fatalf("existing epoch at capacity = %+v", got)
	}
	send(viewer, Packet{ID: p.ID, Epoch: p.Epoch, Closed: true})
	if got := receiveInputPacket(t, received); got.Epoch != p.Epoch || !got.Closed {
		t.Fatalf("closure at capacity = %+v", got)
	}
	delete(tracked, p.Epoch)
	p.Epoch = fmt.Sprintf("%032x", maxTrackedEpochs)
	send(viewer, p)
	if got := receiveInputPacket(t, received); got != p {
		t.Fatalf("replacement at capacity = %+v", got)
	}
	tracked[p.Epoch] = p
	p.Epoch = fmt.Sprintf("%032x", maxTrackedEpochs+1)
	send(viewer, p)
	for range maxTrackedEpochs {
		closed := receiveInputPacket(t, received)
		known, ok := tracked[closed.Epoch]
		if !ok || !closed.Closed || closed.ID != known.ID {
			t.Fatalf("overflow forwarded new input or lost known retirement: %+v", closed)
		}
		delete(tracked, closed.Epoch)
	}
	waitInputChannel(t, "overflow closes input channel", func() bool { return branch.ReadyState() == webrtc.DataChannelStateClosed })
	if branch.Transport().State() != webrtc.SCTPTransportStateConnected {
		t.Fatal("input metadata limit closed the shared transport")
	}
}

func TestResetDownInvalidatesReadBindingAcrossSameEpoch(t *testing.T) {
	permits := make(chan func() bool, 4)
	relay := New(func(_ string, _ Packet, current func() bool) { permits <- current })
	defer relay.Close()
	viewer, branch := inputChannelPair(t)
	relay.AttachDown("branch", branch)
	p := Packet{ID: strings.Repeat("a", 32), Epoch: strings.Repeat("b", 32), Data: "input"}
	readPermit := func() func() bool {
		t.Helper()
		send(viewer, p)
		select {
		case current := <-permits:
			return current
		case <-time.After(2 * time.Second):
			t.Fatal("missing root delivery")
			return nil
		}
	}
	old := readPermit()
	if !old() || !relay.ResetDown("branch", branch) {
		t.Fatal("current input binding was unavailable")
	}
	current := readPermit() // The same epoch can send a fresh request after ICE recovery.
	if old() || !current() {
		t.Fatal("re-registering the same epoch revived a pre-loss delivery")
	}
	if relay.ResetDown("branch", viewer) || !current() {
		t.Fatal("another physical channel retired the current binding")
	}
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
