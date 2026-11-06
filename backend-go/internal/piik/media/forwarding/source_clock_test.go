package forwarding

import (
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/rtpstats"
	"github.com/livekit/mediatransportutil"
	"github.com/livekit/protocol/utils/mono"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/media/encoded"
)

func clockSourceOptions(id string) SourceOptions {
	return SourceOptions{
		ID: id, StreamID: "clock",
		Codec: webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		}, PayloadType: 96},
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 100_000}, {Width: 16, Height: 16, Bitrate: 1_000_000}},
	}
}

// Project through the same sender statistics as DownTrack.CreateSenderReport.
// The wire NTP stays at emission time; compare the source-clock position it maps.
func projectedSourceClock(t *testing.T, source *Source, layer int, stats **rtpstats.RTPStatsSender) time.Duration {
	t.Helper()
	reference := source.GetAllBuffers()[layer].GetSenderReportData()
	if reference == nil {
		t.Fatal("source clock is absent")
	}
	if *stats == nil {
		*stats = rtpstats.NewRTPStatsSender(rtpstats.RTPStatsParams{}, 1024)
		(*stats).SetClockRate(90_000)
		(*stats).Update(mono.UnixNano(), 1, reference.RtpTimestampExt, true, 12, 20, 0, false)
	}
	before := mono.Now()
	report := (*stats).GetRtcpSenderReport(uint32(layer+1), reference, 0, false)
	after := mono.Now()
	if report == nil {
		t.Fatal("projected sender report is absent")
	}
	wireTime := mediatransportutil.NtpTime(report.NTPTime).Time()
	if wireTime.Before(before.Add(-time.Nanosecond)) || wireTime.After(after.Add(time.Nanosecond)) {
		t.Fatal("wire sender report does not use its emission time")
	}
	clock, ok := source.ReferenceTime(layer, report.RTPTime)
	if !ok {
		t.Fatal("projected source reference is absent")
	}
	raw, ok := source.ReferenceTime(layer, reference.RtpTimestamp)
	if !ok || raw.Sub(mediatransportutil.NtpTime(reference.NtpTimestamp).Time()).Abs() > time.Microsecond {
		t.Fatal("source RTP/NTP correlation changed")
	}
	return clock.Sub(wireTime)
}

func TestEncodedSourceClockIgnoresEncoderDelay(t *testing.T) {
	input, err := NewEncodedSource(clockSourceOptions("local"))
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	write := func(layer int, pts time.Duration) {
		t.Helper()
		check(input.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
	}
	// The first low output took 500 ms; the high output is current. Both carry
	// their correct capture PTS, and later low output catches up completely.
	origin := time.Now().Add(-500 * time.Millisecond)
	check(input.BeginFrame(0, origin))
	write(0, 0)
	check(input.BeginFrame(500*time.Millisecond, origin.Add(500*time.Millisecond)))
	write(1, 500*time.Millisecond)
	var stats [2]*rtpstats.RTPStatsSender
	before := projectedSourceClock(t, input.Source, 0, &stats[0]) - projectedSourceClock(t, input.Source, 1, &stats[1])
	time.Sleep(40 * time.Millisecond)
	check(input.BeginFrame(533*time.Millisecond, origin.Add(533*time.Millisecond)))
	write(0, 533*time.Millisecond)
	write(1, 533*time.Millisecond)
	after := projectedSourceClock(t, input.Source, 0, &stats[0]) - projectedSourceClock(t, input.Source, 1, &stats[1])
	if before.Abs() > time.Millisecond || after.Abs() > time.Millisecond {
		t.Fatalf("encoder delay moved the layer clock: before=%v after=%v", before, after)
	}
}

func TestDerivedSourceSharesRemoteClock(t *testing.T) {
	for _, offset := range []time.Duration{-2 * time.Hour, 0, 2 * time.Hour} {
		t.Run(offset.String(), func(t *testing.T) {
			check := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			options := clockSourceOptions("remote")
			original, err := NewSource(options)
			check(err)
			defer original.Close()
			check(original.BindLayer(1, 2, webrtc.RTPParameters{Codecs: []webrtc.RTPCodecParameters{options.Codec}}))
			derived, err := NewEncodedSource(clockSourceOptions("derived"))
			check(err)
			defer derived.Close()
			derived.UseSourceClock(original, 1)
			remoteOrigin := time.Now().Add(offset - 500*time.Millisecond)
			var stats [2]*rtpstats.RTPStatsSender
			// The second upstream report changes its estimated network/clock
			// offset. Derived output must use that current original correlation.
			for index, pts := range []time.Duration{0, 540 * time.Millisecond} {
				if index > 0 {
					time.Sleep(40 * time.Millisecond)
				}
				timestamp := uint32(900_000 + pts*90_000/time.Second)
				check(original.WriteRTP(1, &rtp.Packet{Header: rtp.Header{
					Version: 2, SSRC: 2, PayloadType: 96, SequenceNumber: uint16(index + 1), Timestamp: timestamp, Marker: true,
				}, Payload: append([]byte{0x10}, sfu.VP8KeyFrame8x8...)}))
				check(original.SenderReport(1, &rtcp.SenderReport{
					SSRC: 2, RTPTime: timestamp, NTPTime: uint64(mediatransportutil.ToNtpTime(remoteOrigin.Add(pts))),
					PacketCount: uint32(index + 1), OctetCount: uint32((index + 1) * 20),
				}))
				captured, ok := original.ReferenceTime(1, timestamp)
				if !ok {
					t.Fatal("original reference is absent")
				}
				check(derived.BeginFrame(pts, captured))
				check(derived.WriteFrame(0, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
				high := projectedSourceClock(t, original, 1, &stats[1])
				low := projectedSourceClock(t, derived.Source, 0, &stats[0])
				if mismatch := low - high; mismatch.Abs() > time.Millisecond {
					t.Fatalf("remote layer clocks disagree at frame %d: %v", index, mismatch)
				}
			}
		})
	}
}
