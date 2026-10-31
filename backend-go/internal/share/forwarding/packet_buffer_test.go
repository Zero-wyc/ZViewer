package forwarding

import (
	"errors"
	"io"
	"testing"
	"time"

	"github.com/pion/transport/v5/packetio"
)

func TestPacketBufferRetainsSRTPContract(t *testing.T) {
	buffer := &packetBuffer{Buffer: packetio.NewBuffer()}
	buffer.SetLimitCount(2)
	if err := buffer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var stream io.ReadWriteCloser = buffer
	t.Cleanup(func() { _ = stream.Close() })
	if _, err := stream.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if _, err := buffer.WriteWithAttributes([]byte{2}, packetio.Attributes{{Key: "arrival", Value: 7}}); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Write([]byte{3}); !errors.Is(err, packetio.ErrFull) {
		t.Fatalf("queue limit lost at SRTP boundary: %v", err)
	}
	payload := make([]byte, 8)
	if n, err := stream.Read(payload); err != nil || n != 1 || payload[0] != 1 {
		t.Fatalf("ordinary SRTP read: n=%d err=%v", n, err)
	}
	n, attributes, err := buffer.ReadWithAttributes(payload, nil)
	if err != nil || n != 1 || payload[0] != 2 || attributes.Get("arrival") != 7 {
		t.Fatalf("packet or attributes lost: n=%d attributes=%v err=%v", n, attributes, err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Read(payload); !errors.Is(err, io.EOF) {
		t.Fatalf("closed SRTP buffer did not finish: %v", err)
	}
}
