package forwarding

import (
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// Run only in a disposable network namespace with lab0 at 10.77.0.2/24.
// This exercises real interface replacement without changing the host network.
func TestUDPMuxRefreshesHostCandidates(t *testing.T) {
	if os.Getenv("PIIK_INTERFACE_LAB") != "1" {
		t.Skip("requires the isolated Linux interface fixture")
	}
	self, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	initial, err := os.Readlink("/proc/1/ns/net")
	if err != nil || self == initial {
		t.Fatal("refusing to change the initial network namespace")
	}
	iface, err := net.InterfaceByName("lab0")
	if err != nil {
		t.Fatal(err)
	}
	addresses, err := iface.Addrs()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, address := range addresses {
		found = found || address.String() == "10.77.0.2/24"
	}
	if !found {
		t.Fatal("fixture address is absent")
	}
	change := func(action, address string) {
		t.Helper()
		if output, err := exec.Command("ip", "addr", action, address, "dev", "lab0").CombinedOutput(); err != nil {
			t.Fatalf("fixture address change: %v: %s", err, output)
		}
	}
	udp, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	mux := NewUDPMux(ice.UDPMuxParams{UDPConn: udp})
	t.Cleanup(func() { _ = mux.Close() })
	settings := webrtc.SettingEngine{}
	settings.SetICEUDPMux(mux)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	newPeer := func() (*webrtc.PeerConnection, *webrtc.PeerConnection) {
		t.Helper()
		peer, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = peer.Close() })
		if _, err = peer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo); err != nil {
			t.Fatal(err)
		}
		remote, err := webrtc.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = remote.Close() })
		return peer, remote
	}
	gather := func(peer, remote *webrtc.PeerConnection, restart bool, want, reject string) {
		t.Helper()
		offer, err := peer.CreateOffer(&webrtc.OfferOptions{ICERestart: restart})
		if err != nil {
			t.Fatal(err)
		}
		complete := webrtc.GatheringCompletePromise(peer)
		if err = peer.SetLocalDescription(offer); err != nil {
			t.Fatal(err)
		}
		select {
		case <-complete:
		case <-time.After(3 * time.Second):
			t.Fatal("candidate gathering did not finish")
		}
		sdp := peer.LocalDescription().SDP
		if !strings.Contains(sdp, " "+want+" ") || (reject != "" && strings.Contains(sdp, " "+reject+" ")) {
			t.Fatalf("gathering did not replace the old interface address: want=%s reject=%s", want, reject)
		}
		if err = remote.SetRemoteDescription(*peer.LocalDescription()); err != nil {
			t.Fatal(err)
		}
		answer, err := remote.CreateAnswer(nil)
		if err != nil {
			t.Fatal(err)
		}
		if err = remote.SetLocalDescription(answer); err != nil {
			t.Fatal(err)
		}
		if err = peer.SetRemoteDescription(answer); err != nil {
			t.Fatal(err)
		}
	}
	peer, remote := newPeer()
	gather(peer, remote, false, "10.77.0.2", "")
	change("del", "10.77.0.2/24")
	t.Cleanup(func() { change("add", "10.77.0.2/24") })
	change("add", "10.77.0.3/24")
	t.Cleanup(func() { change("del", "10.77.0.3/24") })
	// App recovery retains its connection and socket; SFU also reuses its mux
	// across independent connections. Both must enumerate the current address.
	gather(peer, remote, true, "10.77.0.3", "10.77.0.2")
	peer, remote = newPeer()
	gather(peer, remote, false, "10.77.0.3", "10.77.0.2")
}
