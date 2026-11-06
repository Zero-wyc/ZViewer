package forwarding

import (
	"io"

	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/pion/transport/v5/packetio"
)

// packetBufferFactory uses LiveKit's claimed video RTCP reader and preserves
// stock Pion SRTP/SRTCP bounds for all remaining streams, including audio.
func packetBufferFactory(factory *buffer.Factory) func(packetio.BufferPacketType, uint32) io.ReadWriteCloser {
	return func(kind packetio.BufferPacketType, ssrc uint32) io.ReadWriteCloser {
		if kind == packetio.RTCPBufferPacket {
			if reader := factory.GetRTCPReader(ssrc); reader != nil {
				return reader
			}
		}
		input := &packetBuffer{Buffer: packetio.NewBuffer()}
		limit := 1_000_000
		if kind == packetio.RTCPBufferPacket {
			limit = 100_000
		}
		input.SetLimitSize(limit)
		return input
	}
}

// packetBuffer adapts Pion's bounded packet queue to its SRTP BufferFactory's
// io.ReadWriteCloser contract, retaining optional packet attributes.
type packetBuffer struct {
	*packetio.Buffer
}

func (buffer *packetBuffer) Read(payload []byte) (int, error) {
	n, _, err := buffer.Buffer.Read(payload, nil)
	return n, err
}

func (buffer *packetBuffer) Write(payload []byte) (int, error) {
	return buffer.Buffer.Write(payload, nil)
}

func (buffer *packetBuffer) ReadWithAttributes(payload []byte, attributes packetio.Attributes) (int, packetio.Attributes, error) {
	return buffer.Buffer.Read(payload, attributes)
}

func (buffer *packetBuffer) WriteWithAttributes(payload []byte, attributes packetio.Attributes) (int, error) {
	return buffer.Buffer.Write(payload, attributes)
}
