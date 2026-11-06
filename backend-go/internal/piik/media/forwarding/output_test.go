package forwarding

import (
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	"github.com/pion/webrtc/v4"
)

// This fixture supplies allocation metadata, not simulated network evidence.
type allocationReceiver struct {
	*sfu.ReceiverBase
	rates      sfu.Bitrates
	available  []int32
	controlled bool
}

func (receiver *allocationReceiver) RateControlled(layer int32) bool {
	return receiver.controlled && layer == 0
}

func (receiver *allocationReceiver) GetLayeredBitrate() ([]int32, sfu.Bitrates) {
	return receiver.available, receiver.rates
}

type outputListener struct{}

func (*outputListener) OnBindAndConnected()                         {}
func (*outputListener) OnStatsUpdate(*livekit.AnalyticsStat)        {}
func (*outputListener) OnMaxSubscribedLayerChanged(int32)           {}
func (*outputListener) OnRttUpdate(uint32)                          {}
func (*outputListener) OnCodecNegotiated(webrtc.RTPCodecCapability) {}
func (*outputListener) OnDownTrackClose(bool)                       {}
func (*outputListener) OnStreamStarted(time.Duration)               {}

func TestOutputUsesLibraryAllocationAndExactLifetime(t *testing.T) {
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
	}, PayloadType: 96}
	log := logger.GetLogger()
	base := sfu.NewReceiverBase(sfu.ReceiverBaseParams{
		TrackID: "fixture", StreamID: "fixture", Kind: webrtc.RTPCodecTypeVideo,
		Codec: codec, Logger: log, StreamTrackerManagerConfig: sfu.DefaultStreamTrackerManagerConfig,
	}, &livekit.TrackInfo{Sid: "fixture", Type: livekit.TrackType_VIDEO,
		Source: livekit.TrackSource_SCREEN_SHARE, Layers: []*livekit.VideoLayer{
			{SpatialLayer: 0, Bitrate: 100_000}, {SpatialLayer: 1, Bitrate: 300_000},
			{SpatialLayer: 2, Bitrate: 900_000},
		}}, sfu.ReceiverCodecStateNormal)
	defer base.Close("test complete", true)
	receiver := &allocationReceiver{ReceiverBase: base}
	packetPacer := pacer.NewPassThrough(log, nil)
	defer packetPacer.Stop()
	track, err := sfu.NewDownTrack(sfu.DownTrackParams{
		Codecs: []webrtc.RTPCodecParameters{codec}, Receiver: receiver,
		BufferFactory: buffer.NewFactoryOfBufferFactory(64, 16).CreateBufferFactory(),
		SubID:         "child", StreamID: "fixture", MaxTrack: 64,
		Pacer: packetPacer, Logger: log, Listener: &outputListener{},
	})
	if err != nil {
		t.Fatal(err)
	}
	output := NewOutput(track, 1_000_000)
	defer output.Close()
	output.SetMaxSpatialLayer(2)
	output.SetMaxTemporalLayer(0)
	if state := output.State(); state.Target != -1 || state.Current != -1 {
		t.Fatalf("unmeasured source pretended to have a target: %+v", state)
	}
	// LiveKit publishes layer discovery asynchronously. Availability can arrive
	// first; allocation must use that observation without waiting for its notice.
	receiver.available = []int32{0}
	output.UpTrackLayersChange()
	if state := output.State(); state.Target != 0 || state.Paused {
		t.Fatalf("available source waited for its discovery notification: %+v", state)
	}
	output.UpTrackMaxPublishedLayerChange(2)
	output.UpTrackMaxTemporalLayerSeenChange(0)
	output.SetBudget(0)
	if state := output.State(); !state.Paused || state.Prepare != -1 || state.VideoBudget != 0 {
		t.Fatalf("bootstrap ignored an exhausted video budget: %+v", state)
	}
	receiver.rates = sfu.Bitrates{{100_000}, {300_000}, {900_000}}
	receiver.available = []int32{0, 1, 2}
	siblingTrack, err := sfu.NewDownTrack(sfu.DownTrackParams{
		Codecs: []webrtc.RTPCodecParameters{codec}, Receiver: receiver,
		BufferFactory: buffer.NewFactoryOfBufferFactory(64, 16).CreateBufferFactory(),
		SubID:         "healthy", StreamID: "fixture", MaxTrack: 64,
		Pacer: packetPacer, Logger: log, Listener: &outputListener{},
	})
	if err != nil {
		t.Fatal(err)
	}
	sibling := NewOutput(siblingTrack, 1_000_000)
	defer sibling.Close()
	sibling.SetMaxTemporalLayer(0)
	sibling.SetMaxSpatialLayer(2)
	sibling.UpTrackMaxPublishedLayerChange(2)
	sibling.UpTrackMaxTemporalLayerSeenChange(0)
	for _, check := range []struct {
		budget int64
		layer  int32
	}{{1_000_000, 2}, {200_000, 0}, {0, -1}, {400_000, 1}, {1_000_000, 2}} {
		output.SetBudget(check.budget)
		state := output.State()
		if state.Target != check.layer || state.Paused != (check.layer == -1) || state.Current != -1 || state.VideoBudget != check.budget {
			t.Fatalf("budget %d: %+v", check.budget, state)
		}
	}
	// A budget below every nominal output still reaches the lowest codec, while
	// only actual reduced media may make the library resume its network target.
	output.SetBudget(60_000)
	if state := output.State(); !state.Paused || state.Target != -1 || state.Prepare != 0 || state.VideoBudget != 60_000 {
		t.Fatalf("below-lowest budget cannot request codec adaptation: %+v", state)
	}
	// A new child's seed cannot veto a warm source's first video. Receiving
	// feedback alone is not congestion; a committed reduction constrains it again.
	observed := false
	output.feedbackObserved = func() bool { return observed }
	output.Reconcile()
	if state := output.State(); state.Paused || state.Target < 0 {
		t.Fatalf("warm source could not establish first feedback: %+v", state)
	}
	observed = true
	output.Reconcile()
	if state := output.State(); state.Paused {
		t.Fatalf("first feedback reinterpreted the seed as a capacity reduction: %+v", state)
	}
	output.SetBudget(50_000)
	if state := output.State(); !state.Paused {
		t.Fatalf("bootstrap bypassed a committed capacity reduction: %+v", state)
	}
	output.SetBudget(60_000)
	receiver.controlled = true
	output.Reconcile()
	if state := output.State(); state.Paused || state.Target != 0 {
		t.Fatalf("live lowest codec could not continue bitrate adaptation: %+v", state)
	}
	// An adapting encoder can be constrained inside its current logical layer.
	// Restore that layer's own ceiling before probing a higher spatial output,
	// including when there is no higher output at all.
	receiver.rates[0][0] = 50_000
	output.Reconcile()
	for _, maximum := range []int32{2, 0} {
		output.SetMaxSpatialLayer(maximum)
		if delta, usage := output.probeDemand(); delta != 50_000 || usage != 50_000 {
			t.Fatalf("current codec recovery skipped (maximum=%d): delta=%d usage=%d", maximum, delta, usage)
		}
		if !output.BandwidthLimited() {
			t.Fatalf("same-layer encoder restriction was reported as healthy (maximum=%d)", maximum)
		}
	}
	output.SetBudget(100_000)
	if delta, _ := output.probeDemand(); delta != 0 {
		t.Fatalf("satisfied codec ceiling retained probe demand: %d", delta)
	}
	if output.BandwidthLimited() {
		t.Fatal("satisfied codec ceiling retained a bandwidth restriction")
	}
	receiver.controlled = false
	output.SetBudget(60_000)
	if delta, _ := output.probeDemand(); delta != 0 {
		t.Fatalf("raw forwarding invented same-layer codec demand: %d", delta)
	}
	if output.BandwidthLimited() {
		t.Fatal("raw forwarding invented a local encoder restriction")
	}
	receiver.controlled = true
	output.SetMaxSpatialLayer(2)
	receiver.rates[0][0] = 100_000
	output.SetBudget(0)
	if state := output.State(); !state.Paused {
		t.Fatalf("codec control overrode exhausted connection budget: %+v", state)
	}
	receiver.available = []int32{1, 2}
	receiver.rates[0][0] = 0
	output.SetBudget(60_000)
	if state := output.State(); !state.Paused {
		t.Fatalf("codec control selected an unavailable lowest layer: %+v", state)
	}
	receiver.available = []int32{0, 1, 2}
	receiver.controlled = false
	receiver.rates[0][0] = 50_000
	output.Reconcile()
	if state := output.State(); state.Paused || state.Target != 0 || state.VideoBudget != 60_000 {
		t.Fatalf("real reduced output did not resume library allocation: %+v", state)
	}
	sibling.Reconcile()
	if state := sibling.State(); state.Paused || state.Target != 2 || state.VideoBudget != 1_000_000 || receiver.rates[2][0] != 900_000 {
		t.Fatalf("weak-child adaptation changed the shared high output: %+v", state)
	}
	// Frame complexity and RTP overhead can briefly exceed a nominal ceiling.
	// A source measurement is not new evidence that this connection lost capacity.
	// The layers' measurement windows can also become available independently.
	receiver.rates[2][0] = 0
	sibling.UpTrackBitrateAvailabilityChange()
	if state := sibling.State(); state.Target != 2 {
		t.Fatalf("unmeasured active layer was treated as unavailable: %+v", state)
	}
	receiver.rates[2][0] = 1_050_000
	sibling.UpTrackBitrateReport(receiver.available, receiver.rates)
	sibling.SetBudget(1_000_000)
	if state := sibling.State(); state.Target != 2 || state.VideoBudget != 1_000_000 {
		t.Fatalf("unchanged connection budget downgraded a healthy output: %+v", state)
	}
	sibling.SetBudget(1_020_000)
	if state := sibling.State(); state.Target != 2 {
		t.Fatalf("increased capacity downgraded an existing output: %+v", state)
	}
	sibling.SetBudget(800_000)
	if state := sibling.State(); state.Target != 1 {
		t.Fatalf("actual capacity reduction failed to constrain the output: %+v", state)
	}
	receiver.rates[1][0] = 850_000
	sibling.UpTrackBitrateReport(receiver.available, receiver.rates)
	sibling.SetBudget(800_000)
	if state := sibling.State(); state.Target != 1 {
		t.Fatalf("measured variation downgraded an already constrained output: %+v", state)
	}
	sibling.congestionState = func() bwe.CongestionState { return bwe.CongestionStateCongested }
	sibling.Reconcile()
	if state := sibling.State(); state.Target != 0 {
		t.Errorf("confirmed congestion retained an output above the unchanged budget: %+v", state)
	}
	sibling.congestionState = nil

	// A recovered low layer does not authorize an unmeasured high layer.
	receiver.rates = sfu.Bitrates{{50_000}, {0}, {0}}
	receiver.available = []int32{0}
	sibling.SetBudget(60_000)
	if state := sibling.State(); state.Target != 0 {
		t.Fatalf("recovery did not select the measured affordable layer: %+v", state)
	}
	receiver.available = []int32{0, 1, 2}
	sibling.Reconcile()
	if state := sibling.State(); state.Target != 0 {
		t.Errorf("a resumed unmeasured layer bypassed the connection budget: %+v", state)
	}
	receiver.rates[1][0] = 300_000
	receiver.rates[2][0] = 900_000
	sibling.SetBudget(1_000_000)
	if state := sibling.State(); state.Target != 2 {
		t.Fatalf("increased capacity did not restore the high output: %+v", state)
	}
	// Missing rate windows retain a legal target, but cannot override source
	// availability or subscription limits. The connection budget stays unchanged.
	receiver.rates = sfu.Bitrates{}
	sibling.Reconcile()
	if state := sibling.State(); state.Target != 2 || state.VideoBudget != 1_000_000 {
		t.Fatalf("missing rate windows changed a legal allocation: %+v", state)
	}
	receiver.available = []int32{0}
	sibling.UpTrackLayersChange()
	if state := sibling.State(); state.Target > 0 || state.VideoBudget != 1_000_000 {
		t.Fatalf("missing rate windows retained an unavailable target: %+v", state)
	}
	receiver.available = []int32{0, 1, 2}
	receiver.rates = sfu.Bitrates{{50_000}, {300_000}, {900_000}}
	sibling.Reconcile()
	if state := sibling.State(); state.Target != 2 {
		t.Fatalf("restored source did not resume before subscription change: %+v", state)
	}
	receiver.rates = sfu.Bitrates{}
	sibling.SetMaxSpatialLayer(0)
	if state := sibling.State(); state.Target > 0 || state.VideoBudget != 1_000_000 {
		t.Fatalf("missing rate windows retained a target above the subscription: %+v", state)
	}
	receiver.rates = sfu.Bitrates{{50_000}, {300_000}, {900_000}}
	sibling.Reconcile()
	if state := sibling.State(); state.Target != 0 {
		t.Fatalf("stable allocation ignored a changed subscription limit: %+v", state)
	}
	receiver.rates[0][0] = 100_000
	// A stopped upper output has no actual bitrate. Admission may prepare it,
	// but the library must not select it until it is genuinely available again.
	receiver.rates = sfu.Bitrates{{100_000}}
	receiver.available = []int32{0}
	output.SetBudget(1_000_000)
	if state := output.State(); state.Prepare != 2 || state.Target != 0 {
		t.Fatalf("stopped output preparation changed real availability: %+v", state)
	}
	output.SetBudget(200_000)
	if state := output.State(); state.Prepare != 0 || state.Target != 0 {
		t.Fatalf("low budget prepared an unaffordable upper output: %+v", state)
	}
	output.SetMaxSpatialLayer(1)
	output.SetBudget(1_000_000)
	if state := output.State(); state.Prepare != 1 {
		t.Fatalf("preparation exceeded child maximum: %+v", state)
	}
	output.SetMaxSpatialLayer(2)
	// Allocation-only fixture: put the accepted frame on a different layer so
	// BeginFrame must fence it. The real RTP gate verifies emitted frames.
	output.current = (output.State().Target + 1) % 3
	before := output.State()
	output.BeginFrame()
	after := output.State()
	if after.Current != -1 || after.Target != before.Target || after.Requested != before.Requested {
		t.Fatalf("controlled frame fence replaced its allocation: before=%+v after=%+v", before, after)
	}
	output.SetBudget(200_000)
	output.Resync()
	if state := output.State(); state.Target != -1 || state.Current != -1 {
		t.Fatalf("source resync retained old output state: %+v", state)
	}
	output.Reconcile()
	if state := output.State(); state.Target != 0 || state.VideoBudget != 200_000 {
		t.Fatalf("source resync discarded the established connection budget: %+v", state)
	}
	receiver.available = []int32{0, 1, 2}
	receiver.rates = sfu.Bitrates{{100_000}, {300_000}, {900_000}}
	sibling.SetMaxSpatialLayer(2)
	if state := sibling.State(); state.Target != 2 {
		t.Fatalf("high layer did not resume before source resync: %+v", state)
	}
	sibling.Resync()
	receiver.rates = sfu.Bitrates{{100_000}}
	sibling.Reconcile()
	if state := sibling.State(); state.Target != 0 {
		t.Fatalf("source resync reused an unmeasured retired allocation: %+v", state)
	}
	output.SetBudget(1_000_000)
	output.ReceiverRestart(receiver)
	if state := output.State(); state.Current != -1 {
		t.Fatalf("receiver restart retained old output state: %+v", state)
	}
	output.Close()
	output.SetBudget(1_000_000)
	if state := output.State(); state != (Snapshot{Prepare: -1, Target: -1, Requested: -1, Current: -1, Paused: true}) {
		t.Fatalf("closed output revived: %+v", state)
	}
}
