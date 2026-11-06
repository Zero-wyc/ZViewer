// Package encoded contains shared encoded-video primitives, independent of
// room authority, capture implementation and PeerConnection lifecycle.
package encoded

import (
	"errors"
	"time"

	"github.com/pion/rtp"
)

const MaxAccessUnitBytes = 4 * 1024 * 1024

// At the 1200-byte media MTU, this window covers a maximum-sized fragmented AU
// with header headroom. It does not promise unlimited tiny-NAL packetization.
const MaxPacketWindow = MaxAccessUnitBytes / 1024
const videoClockRate = 90_000

var ErrInvalidTimestamp = errors.New("encoded video timestamp is not monotonic")

// Frame is one complete codec access unit. Recovery includes the codec
// configuration needed to decode independently of previous output.
type Frame struct {
	Data          []byte
	PTS, Duration time.Duration
	Recovery      bool
}

// Packetizer preserves one outbound RTP sequence and source timeline across
// complete access units. Its owner serializes calls; it buffers no media.
type Packetizer struct {
	rtp                rtp.Packetizer
	hasTimestamp       bool
	lastTimestamp      time.Duration
	timestampRemainder float64
}

func NewPacketizer(payloader rtp.Payloader, payloadType uint8, mtu uint16) *Packetizer {
	return &Packetizer{rtp: rtp.NewPacketizer(
		mtu, payloadType, 0, payloader, rtp.NewRandomSequencer(), videoClockRate,
	)}
}

func (p *Packetizer) Packetize(data []byte, timestamp, duration time.Duration) ([]*rtp.Packet, error) {
	if len(data) == 0 || len(data) > MaxAccessUnitBytes || timestamp < 0 || duration <= 0 {
		return nil, errors.New("encoded video access unit is invalid")
	}
	if p.hasTimestamp {
		if timestamp <= p.lastTimestamp {
			return nil, ErrInvalidTimestamp
		}
		ticksFloat := (timestamp-p.lastTimestamp).Seconds()*videoClockRate + p.timestampRemainder
		ticks := uint64(ticksFloat)
		p.timestampRemainder = ticksFloat - float64(ticks)
		p.rtp.SkipSamples(uint32(ticks))
	} else {
		p.hasTimestamp = true
	}
	p.lastTimestamp = timestamp
	return p.rtp.Packetize(data, 0), nil
}
