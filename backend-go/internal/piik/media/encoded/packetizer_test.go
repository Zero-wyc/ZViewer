package encoded

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/pion/rtp/codecs"
)

func TestPacketizerKeepsVP8IdentityAcrossAccessUnits(t *testing.T) {
	p := NewPacketizer(&codecs.VP8Payloader{EnablePictureID: true}, 96, 1200)
	var sequence uint16
	var timestamp uint32
	var pictureID uint16
	for frame := 0; frame < 4; frame++ {
		data := bytes.Repeat([]byte{byte(frame)}, 1000+frame*1100)
		packets, err := p.Packetize(data, time.Duration(frame)*time.Second/30, time.Second/30)
		if err != nil {
			t.Fatal(err)
		}
		var decoded []byte
		for index, packet := range packets {
			var header codecs.VP8Packet
			payload, err := header.Unmarshal(packet.Payload)
			if err != nil {
				t.Fatal(err)
			}
			decoded = append(decoded, payload...)
			if (frame > 0 || index > 0) && packet.SequenceNumber != sequence+1 {
				t.Fatal("sequence changed between encoded representations")
			}
			if index == 0 && frame > 0 {
				if delta := packet.Timestamp - timestamp; delta < 2999 || delta > 3001 {
					t.Fatalf("source clock delta = %d", delta)
				}
				if header.PictureID != pictureID+1 {
					t.Fatal("VP8 picture identity restarted")
				}
			}
			if packet.Marker != (index == len(packets)-1) {
				t.Fatal("access unit marker did not match frame boundary")
			}
			sequence, timestamp, pictureID = packet.SequenceNumber, packet.Timestamp, header.PictureID
		}
		if !bytes.Equal(data, decoded) {
			t.Fatal("packetization changed the shared encoded payload")
		}
	}
	if _, err := p.Packetize([]byte{1}, 0, time.Second/30); !errors.Is(err, ErrInvalidTimestamp) {
		t.Fatalf("backward source timestamp error = %v", err)
	}
	packets, err := p.Packetize([]byte{1}, 5*time.Second, time.Second/30)
	if err != nil || len(packets) != 1 || packets[0].SequenceNumber != sequence+1 {
		t.Fatalf("dormant source did not retain packet identity: %v", err)
	}
	if advance := packets[0].Timestamp - timestamp; advance < 440999 || advance > 441001 {
		t.Fatalf("dormant source clock advanced %d ticks, want 4.9 seconds", advance)
	}
}

// This measures RTP bookkeeping only, never repeated video encoding.
func BenchmarkSharedFramePacketization(b *testing.B) {
	data := make([]byte, 20*1024)
	for _, children := range []int{1, 2} {
		name := "one-packetizer-reference"
		if children == 2 {
			name = "two-independent-output-identities"
		}
		b.Run(name, func(b *testing.B) {
			packetizers := make([]*Packetizer, children)
			for i := range packetizers {
				packetizers[i] = NewPacketizer(&codecs.VP8Payloader{EnablePictureID: true}, 96, 1200)
			}
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				for _, packetizer := range packetizers {
					if _, err := packetizer.Packetize(data, time.Duration(i)*time.Second/30, time.Second/30); err != nil {
						b.Fatal(err)
					}
				}
			}
		})
	}
}
