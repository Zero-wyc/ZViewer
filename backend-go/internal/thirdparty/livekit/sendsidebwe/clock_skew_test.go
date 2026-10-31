package sendsidebwe

import (
	"fmt"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/protocol/logger"
	"github.com/livekit/protocol/utils/mono"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
)

func TestClockRateSkewDoesNotAccumulateCongestion(t *testing.T) {
	for _, ppm := range []int64{0, 67, -67, 200, -200, 400} {
		t.Run(fmt.Sprintf("%dppm", ppm), func(t *testing.T) {
			c := newCongestionDetector(congestionDetectorParams{Config: defaultCongestionDetectorConfig, Logger: logger.GetDiscardLogger()})
			c.estimatedAvailableChannelCapacity = 8_000_000
			start := mono.UnixMicro()
			c.RecordPacketSendAndGetSequenceNumber(start, 1200, false, ccutils.ProbeClusterIdInvalid, false)
			recorder := twcc.NewRecorder(1)
			for elapsed := int64(1500); elapsed <= 1_800_000_000; elapsed += 1500 {
				sn := c.RecordPacketSendAndGetSequenceNumber(start+elapsed, 1200, false, ccutils.ProbeClusterIdInvalid, false)
				recorder.Record(1, sn, 1_000_000+elapsed+elapsed*ppm/1_000_000)
				if elapsed%150_000 != 0 {
					continue
				}
				for _, packet := range recorder.BuildFeedbackPacket() {
					c.HandleTWCCFeedback(packet.(*rtcp.TransportLayerCC))
				}
				if c.CongestionState() != bwe.CongestionStateNone {
					t.Fatalf("clock skew became congestion after %.2fs", float64(elapsed)/1e6)
				}
			}
			if !c.CanProbe() || c.estimatedAvailableChannelCapacity != 8_000_000 {
				t.Fatalf("healthy transport lost recovery: probe=%v capacity=%d", c.CanProbe(), c.estimatedAvailableChannelCapacity)
			}
			last := c.packetGroups[len(c.packetGroups)-1]
			t.Logf("30-minute delay=%dus acknowledged=%dbps", last.PropagatedQueuingDelay(), last.Traffic().AcknowledgedBitrate())
		})
	}
}

func TestClockTolerancePreservesCongestionAndRecovery(t *testing.T) {
	c := newCongestionDetector(congestionDetectorParams{Config: defaultCongestionDetectorConfig, Logger: logger.GetDiscardLogger()})
	// Packet time advances virtually; expire the separate wall-clock probe gate.
	c.probeRegulator.ProbeSignal(ccutils.ProbeSignalNotCongesting, mono.Now().Add(-time.Minute))
	c.estimatedAvailableChannelCapacity = 8_000_000
	start := mono.UnixMicro()
	c.RecordPacketSendAndGetSequenceNumber(start, 1200, false, ccutils.ProbeClusterIdInvalid, false)
	recorder := twcc.NewRecorder(1)
	queueDetected, lossDetected := false, false
	for elapsed := int64(1500); elapsed <= 30_000_000; elapsed += 1500 {
		sn := c.RecordPacketSendAndGetSequenceNumber(start+elapsed, 1200, false, ccutils.ProbeClusterIdInvalid, false)
		queue := int64(0)
		if elapsed >= 8_000_000 && elapsed < 11_000_000 {
			queue = (elapsed - 8_000_000) / 25 // a real queue growing by 40ms/s
		}
		loss := elapsed >= 18_000_000 && elapsed < 20_000_000
		if !loss || (elapsed/1500)%2 == 0 {
			recorder.Record(1, sn, 1_000_000+elapsed+elapsed*67/1_000_000+queue)
		}
		if elapsed%150_000 != 0 {
			continue
		}
		for _, packet := range recorder.BuildFeedbackPacket() {
			c.HandleTWCCFeedback(packet.(*rtcp.TransportLayerCC))
		}
		if c.CongestionState() == bwe.CongestionStateCongested {
			queueDetected = queueDetected || elapsed >= 8_000_000 && elapsed < 11_000_000
			lossDetected = lossDetected || loss
		}
		if (elapsed >= 12_000_000 && elapsed < 18_000_000 || elapsed >= 22_000_000) && !c.CanProbe() {
			t.Fatalf("cleared congestion still blocked probing at %.2fs: %v", float64(elapsed)/1e6, c.CongestionState())
		}
	}
	if !queueDetected || !lossDetected || c.estimatedAvailableChannelCapacity >= 8_000_000 {
		t.Fatalf("real congestion was hidden: queue=%v loss=%v capacity=%d", queueDetected, lossDetected, c.estimatedAvailableChannelCapacity)
	}
}
