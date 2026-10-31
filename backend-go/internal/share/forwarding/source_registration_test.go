package forwarding

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/protocol/livekit"
	"zviewer/backend/internal/share/encoded"
)

type heldClockSnapshot struct {
	buffer.BufferProvider
	reads   atomic.Int32
	held    chan struct{}
	live    chan struct{}
	release chan struct{}
}

func (input *heldClockSnapshot) GetSenderReportData() *livekit.RTCPSenderReportState {
	report := input.BufferProvider.GetSenderReportData()
	switch input.reads.Add(1) {
	case 2: // Initial replay fetched an old snapshot inside the sender wrapper.
		close(input.held)
		<-input.release
	case 3: // A new accepted report is about to enter its live callback.
		close(input.live)
	}
	return report
}

func TestSourceRegistrationRetainsCurrentClock(t *testing.T) {
	for _, simulcast := range []bool{false, true} {
		name := "transport"
		if simulcast {
			name = "publication"
		}
		t.Run(name, func(t *testing.T) {
			check := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			makeInput := func(at time.Time) *EncodedSource {
				t.Helper()
				input, err := NewEncodedSource(clockSourceOptions("joining"))
				check(err)
				t.Cleanup(input.Close)
				check(input.BeginFrame(0, at))
				for layer := 0; layer < 2; layer++ {
					check(input.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, Duration: time.Second / 30}))
				}
				return input
			}
			origin := time.Now().Add(-time.Second)
			input := makeInput(origin)
			earlier := input.buffers[0].GetSenderReportData()
			options := TransportOptions{Source: input.Source, ConnectionID: name, InitialBitrate: 1_000_000}
			var tracks []*sfu.DownTrack
			var connect func() error
			var replace func(*Source) error
			var closeTransport func() error
			if simulcast {
				publication, err := NewPublication(options)
				check(err)
				tracks, connect, replace, closeTransport = publication.tracks, publication.SetConnected, publication.ReplaceSource, publication.Close
			} else {
				transport, err := NewTransport(options)
				check(err)
				tracks, connect, replace, closeTransport = []*sfu.DownTrack{transport.Output.DownTrack}, transport.SetConnected, transport.ReplaceSource, transport.Close
			}
			defer closeTransport()
			// Public migration state exposes the Forwarder's accepted SRs without
			// binding a socket or making this a network/decoded-video test.
			for _, track := range tracks {
				track.SeedState(sfu.DownTrackState{ForwarderState: &livekit.RTPForwarderState{
					Started: true, RtpMunger: &livekit.RTPMungerState{},
				}})
			}
			held := &heldClockSnapshot{BufferProvider: input.GetAllBuffers()[0],
				held: make(chan struct{}), live: make(chan struct{}), release: make(chan struct{})}
			input.ReceiverBase.AddBuffer(held, 0)
			var release sync.Once
			unblock := func() { release.Do(func() { close(held.release) }) }
			defer unblock()
			connected := make(chan error, 1)
			go func() { connected <- connect() }()
			wait := func(signal <-chan struct{}) {
				t.Helper()
				select {
				case <-signal:
				case <-time.After(2 * time.Second):
					t.Fatal("source registration did not reach the clock boundary")
				}
			}
			wait(held.held)
			updated := make(chan error, 1)
			go func() {
				if err := input.BeginFrame(33*time.Millisecond, origin.Add(33*time.Millisecond)); err != nil {
					updated <- err
					return
				}
				updated <- input.WriteFrame(0, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: 33 * time.Millisecond, Duration: time.Second / 30})
			}()
			wait(held.live)
			unblock()
			for _, result := range []<-chan error{connected, updated} {
				select {
				case err := <-result:
					check(err)
				case <-time.After(2 * time.Second):
					t.Fatal("source registration and live report deadlocked")
				}
			}
			assertClock := func(expected uint64) {
				t.Helper()
				for _, track := range tracks {
					report := track.GetState().ForwarderState.SenderReportState[0]
					if report == nil || report.NtpTimestamp != expected {
						t.Fatal("subscriber retained an older sender-report clock")
					}
				}
			}
			latest := input.buffers[0].GetSenderReportData()
			assertClock(latest.NtpTimestamp)
			previous := input.GetDownTracks()
			// Even a queued callback entering after registration uses accepted state.
			for _, sender := range previous {
				check(sender.HandleRTCPSenderReportData(input.Codec().PayloadType, 0, earlier))
			}
			assertClock(latest.NtpTimestamp)
			next := makeInput(time.Now())
			check(replace(next.Source))
			latest = next.buffers[0].GetSenderReportData()
			assertClock(latest.NtpTimestamp)
			for _, sender := range previous {
				check(sender.HandleRTCPSenderReportData(input.Codec().PayloadType, 0, input.buffers[0].GetSenderReportData()))
			}
			assertClock(latest.NtpTimestamp)
		})
	}
}
