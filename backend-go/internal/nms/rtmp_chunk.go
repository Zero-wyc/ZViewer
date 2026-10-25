package nms

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
)

// RTMP 消息类型（规范第 5 章 + 扩展 RTMP）。
const (
	msgSetChunkSize     uint8 = 1
	msgAbort            uint8 = 2
	msgAcknowledgement  uint8 = 3
	msgUserControl      uint8 = 4
	msgWindowAckSize    uint8 = 5
	msgSetPeerBandwidth uint8 = 6
	msgAudio            uint8 = 8
	msgVideo            uint8 = 9
	msgDataAMF0         uint8 = 18
	msgCommandAMF0      uint8 = 20
	msgAggregate        uint8 = 22
)

// 默认块大小（规范 5.4.1）。
const defaultChunkSize uint32 = 128

// maxMessageSize 是单条消息的上限：防止坏客户端用超大 length 直接吃光内存。
// 视频关键帧在 8Mbps 码率下也远小于 16MB。
const maxMessageSize = 16 << 20

var errRTMPProtocol = errors.New("rtmp: 协议错误")

// rtmpMessage 是一条重组完成的 RTMP 消息。
type rtmpMessage struct {
	TypeID    uint8
	StreamID  uint32
	Timestamp uint32
	Payload   []byte
}

// inChunkStream 是单条 chunk stream 的重组状态（每条连接每个 csid 一份）。
type inChunkStream struct {
	ts         uint32
	delta      uint32
	hasDelta   bool
	length     uint32
	typeID     uint8
	streamID   uint32
	extended   bool
	inProgress bool
	payload    []byte
}

type countingReader struct {
	r io.Reader
	n uint64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += uint64(n)
	return n, err
}

type chunkReader struct {
	raw       *countingReader
	r         *bufio.Reader
	chunkSize uint32
	streams   map[uint32]*inChunkStream
}

func newChunkReader(r io.Reader) *chunkReader {
	cr := &countingReader{r: r}
	return &chunkReader{
		raw:       cr,
		r:         bufio.NewReaderSize(cr, 64<<10),
		chunkSize: defaultChunkSize,
		streams:   make(map[uint32]*inChunkStream, 8),
	}
}

func (cr *chunkReader) setChunkSize(n uint32) {
	if n >= 1 && n <= maxMessageSize {
		cr.chunkSize = n
	}
}

func (cr *chunkReader) bytesRead() uint64 { return cr.raw.n }

func (cr *chunkReader) readUint24() (uint32, error) {
	var b [3]byte
	if _, err := io.ReadFull(cr.r, b[:]); err != nil {
		return 0, err
	}
	return uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2]), nil
}

func (cr *chunkReader) readUint32LE() (uint32, error) {
	var b [4]byte
	if _, err := io.ReadFull(cr.r, b[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(b[:]), nil
}

func (cr *chunkReader) readUint32BE() (uint32, error) {
	var b [4]byte
	if _, err := io.ReadFull(cr.r, b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(b[:]), nil
}

// readMessage 读到一条完整消息为止（跨多个 chunk 自动重组）。
func (cr *chunkReader) readMessage() (rtmpMessage, error) {
	for {
		b0, err := cr.r.ReadByte()
		if err != nil {
			return rtmpMessage{}, err
		}
		format := b0 >> 6
		csid := uint32(b0 & 0x3F)
		switch csid {
		case 0:
			b, err := cr.r.ReadByte()
			if err != nil {
				return rtmpMessage{}, err
			}
			csid = 64 + uint32(b)
		case 1:
			lo, err := cr.r.ReadByte()
			if err != nil {
				return rtmpMessage{}, err
			}
			hi, err := cr.r.ReadByte()
			if err != nil {
				return rtmpMessage{}, err
			}
			csid = 64 + uint32(lo) + uint32(hi)*256
		}

		st := cr.streams[csid]
		if st == nil {
			st = &inChunkStream{}
			cr.streams[csid] = st
		}

		if format == 0 {
			ts, err := cr.readUint24()
			if err != nil {
				return rtmpMessage{}, err
			}
			length, err := cr.readUint24()
			if err != nil {
				return rtmpMessage{}, err
			}
			typeID, err := cr.r.ReadByte()
			if err != nil {
				return rtmpMessage{}, err
			}
			streamID, err := cr.readUint32LE()
			if err != nil {
				return rtmpMessage{}, err
			}
			st.ts = ts
			st.length = length
			st.typeID = typeID
			st.streamID = streamID
			st.extended = ts == 0xFFFFFF
			if st.extended {
				ext, err := cr.readUint32BE()
				if err != nil {
					return rtmpMessage{}, err
				}
				st.ts = ext
			}
			st.hasDelta = false
			st.inProgress = false
			// 每条消息都换一块新缓冲：载荷会被 hub 长期持有
			// （序列头 / GOP 缓存），复用底层数组会让后面到的帧把它覆盖掉。
			st.payload = nil
		} else if st.inProgress {
			// 续块：fmt3；带扩展时间戳的流每个 chunk 都会重复写那 4 字节。
			if st.extended {
				if _, err := cr.readUint32BE(); err != nil {
					return rtmpMessage{}, err
				}
			}
		} else {
			// 新消息沿用之前的头：fmt1 带长度/类型，fmt2/3 只推时间戳。
			switch format {
			case 1:
				delta, err := cr.readUint24()
				if err != nil {
					return rtmpMessage{}, err
				}
				length, err := cr.readUint24()
				if err != nil {
					return rtmpMessage{}, err
				}
				typeID, err := cr.r.ReadByte()
				if err != nil {
					return rtmpMessage{}, err
				}
				if length > maxMessageSize {
					return rtmpMessage{}, fmt.Errorf("%w: 消息过大 %d", errRTMPProtocol, length)
				}
				st.length = length
				st.typeID = typeID
				st.delta = delta
				st.hasDelta = true
				st.extended = delta == 0xFFFFFF
				if st.extended {
					ext, err := cr.readUint32BE()
					if err != nil {
						return rtmpMessage{}, err
					}
					st.delta = ext
				}
				st.ts += st.delta
			case 2:
				delta, err := cr.readUint24()
				if err != nil {
					return rtmpMessage{}, err
				}
				st.delta = delta
				st.hasDelta = true
				st.extended = delta == 0xFFFFFF
				if st.extended {
					ext, err := cr.readUint32BE()
					if err != nil {
						return rtmpMessage{}, err
					}
					st.delta = ext
				}
				st.ts += st.delta
			case 3:
				if st.extended {
					ext, err := cr.readUint32BE()
					if err != nil {
						return rtmpMessage{}, err
					}
					st.delta = ext
					st.hasDelta = true
				}
				if st.hasDelta {
					st.ts += st.delta
				}
			}
			st.payload = nil
		}

		if st.length > maxMessageSize {
			return rtmpMessage{}, fmt.Errorf("%w: 消息过大 %d", errRTMPProtocol, st.length)
		}
		remaining := int(st.length) - len(st.payload)
		if remaining < 0 {
			return rtmpMessage{}, errRTMPProtocol
		}
		n := remaining
		if uint32(n) > cr.chunkSize {
			n = int(cr.chunkSize)
		}
		if n > 0 {
			start := len(st.payload)
			// 预分配到最终长度，避免大帧反复扩容。
			if cap(st.payload) < int(st.length) {
				grown := make([]byte, start, st.length)
				copy(grown, st.payload)
				st.payload = grown
			}
			st.payload = st.payload[:start+n]
			if _, err := io.ReadFull(cr.r, st.payload[start:]); err != nil {
				return rtmpMessage{}, err
			}
		}

		if len(st.payload) < int(st.length) {
			st.inProgress = true
			continue
		}
		st.inProgress = false
		return rtmpMessage{
			TypeID:    st.typeID,
			StreamID:  st.streamID,
			Timestamp: st.ts,
			Payload:   st.payload,
		}, nil
	}
}

// chunkWriter 负责把消息切成 chunk 写出去。
//
// 只使用 fmt0 + fmt3：首块带完整头，后续块沿用。不用 fmt1/2 压缩头部——
// 推流场景的消息量以音视频帧为主（每帧一条消息），省下的几个字节不值一提，
// 换来的是「不需要在写侧维护时间戳差分状态」。
type chunkWriter struct {
	w         io.Writer
	mu        sync.Mutex
	chunkSize uint32
}

func newChunkWriter(w io.Writer) *chunkWriter {
	return &chunkWriter{w: w, chunkSize: 4096}
}

func (cw *chunkWriter) setChunkSize(n uint32) {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	if n >= 1 && n <= maxMessageSize {
		cw.chunkSize = n
	}
}

func csidForType(typeID uint8) byte {
	switch typeID {
	case msgAudio:
		return 4
	case msgVideo:
		return 5
	case msgCommandAMF0, msgDataAMF0:
		return 3
	default:
		return 2
	}
}

func (cw *chunkWriter) writeMessage(typeID uint8, streamID, ts uint32, payload []byte) error {
	cw.mu.Lock()
	defer cw.mu.Unlock()

	csid := csidForType(typeID)
	ext := ts >= 0xFFFFFF
	tsField := ts
	if ext {
		tsField = 0xFFFFFF
	}

	header := make([]byte, 0, 16)
	header = append(header, csid) // fmt=0, csid(6bit)
	header = append(header, byte(tsField>>16), byte(tsField>>8), byte(tsField))
	header = append(header, byte(len(payload)>>16), byte(len(payload)>>8), byte(len(payload)))
	header = append(header, typeID)
	header = append(header, byte(streamID), byte(streamID>>8), byte(streamID>>16), byte(streamID>>24))
	if ext {
		header = append(header, byte(ts>>24), byte(ts>>16), byte(ts>>8), byte(ts))
	}

	offset := 0
	first := true
	for {
		n := len(payload) - offset
		if uint32(n) > cw.chunkSize {
			n = int(cw.chunkSize)
		}
		var head []byte
		if first {
			head = header
			first = false
		} else {
			head = append([]byte{0xC0 | csid}, nil...)
			if ext {
				head = append(head, byte(ts>>24), byte(ts>>16), byte(ts>>8), byte(ts))
			}
		}
		if _, err := cw.w.Write(head); err != nil {
			return err
		}
		if n > 0 {
			if _, err := cw.w.Write(payload[offset : offset+n]); err != nil {
				return err
			}
			offset += n
		}
		if offset >= len(payload) {
			return nil
		}
	}
}
