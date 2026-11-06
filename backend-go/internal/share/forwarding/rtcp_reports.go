package forwarding

import (
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/report"
	"github.com/pion/rtcp"
)

func configureRTCPReports(registry *interceptor.Registry, downTrack func(uint32) *sfu.DownTrack) error {
	receiver, err := report.NewReceiverInterceptor()
	if err != nil {
		return err
	}
	// DownTrack matches RTT against its latest SR. LiveKit's three-second
	// cadence leaves ordinary one-second RR rounds time to return that marker.
	sender, err := report.NewSenderInterceptor(report.SenderInterval(3 * time.Second))
	if err != nil {
		return err
	}
	registry.Add(receiver)
	registry.Add(senderReportFactory{Factory: sender, downTrack: downTrack})
	return nil
}

type senderReportFactory struct {
	interceptor.Factory
	downTrack func(uint32) *sfu.DownTrack
}

func (factory senderReportFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	sender, err := factory.Factory.NewInterceptor(id)
	if err != nil {
		return nil, err
	}
	return &senderReports{Interceptor: sender, downTrack: factory.downTrack}, nil
}

type senderReports struct {
	interceptor.Interceptor
	downTrack func(uint32) *sfu.DownTrack
}

func (sender *senderReports) BindRTCPWriter(writer interceptor.RTCPWriter) interceptor.RTCPWriter {
	return sender.Interceptor.BindRTCPWriter(interceptor.RTCPWriterFunc(func(packets []rtcp.Packet, attributes interceptor.Attributes) (int, error) {
		reports := make([]rtcp.Packet, 0, len(packets))
		for _, packet := range packets {
			if report, ok := packet.(*rtcp.SenderReport); ok {
				if track := sender.downTrack(report.SSRC); track != nil {
					// Pion owns cadence; DownTrack owns the projected video clock and
					// its matching RR/RTT state. Audio keeps the ordinary Pion report.
					report = track.CreateSenderReport()
					if report == nil {
						continue
					}
					packet = report
				}
			}
			reports = append(reports, packet)
		}
		if len(reports) == 0 {
			return 0, nil
		}
		return writer.Write(reports, attributes)
	}))
}
