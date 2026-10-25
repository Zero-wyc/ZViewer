package nms

import (
	"bytes"
	"encoding/binary"
	"io"
	"sync"
	"time"
)

// flvTag 是一条待下发的 FLV tag（音视频帧或脚本数据）。
type flvTag struct {
	typ  uint8 // 8 音频 / 9 视频 / 18 脚本
	ts   uint32
	data []byte
}

// GOP 缓存上限：一个关键帧间隔 2s、8Mbps 的情况下约 2MB；
// 给到 12MB 足够覆盖「观众晚几秒进来也能立刻出画面」，
// 又不至于让一个高码率推流把内存吃穿。
const (
	maxGOPBytes = 12 << 20
	maxGOPTags  = 1200
)

type flvSub struct {
	ch     chan flvTag
	closed bool
}

type liveStream struct {
	key      string
	meta     map[string]any
	audioSeq []byte
	videoSeq []byte
	gop      []flvTag
	gopBytes int
	subs     map[*flvSub]struct{}
}

// streamHub 维护「正在推的流 → 订阅者」的映射，并做 GOP 缓存。
//
// 所有方法都是并发安全的；广播路径上永远不阻塞：订阅者队列满了就丢帧，
// 丢到关键帧时直接断开该订阅者（让播放器重连重新对齐），
// 绝不让一个卡住的 HTTP 客户端拖慢推流解析。
type streamHub struct {
	mu      sync.Mutex
	streams map[string]*liveStream
}

func newStreamHub() *streamHub {
	return &streamHub{streams: make(map[string]*liveStream, 4)}
}

func (h *streamHub) start(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ls := h.streams[key]
	if ls == nil {
		ls = &liveStream{key: key, subs: make(map[*flvSub]struct{}, 2)}
		h.streams[key] = ls
		return
	}
	// 同一个推流码重推：保留订阅者（刷新页面/重连期间不断流），
	// 但元数据与 GOP 必须重置，否则新流会带着旧流的关键帧缓存开播。
	ls.meta = nil
	ls.audioSeq = nil
	ls.videoSeq = nil
	ls.gop = nil
	ls.gopBytes = 0
}

func (h *streamHub) stop(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ls := h.streams[key]
	if ls == nil {
		return
	}
	delete(h.streams, key)
	for sub := range ls.subs {
		closeSub(sub)
	}
	ls.subs = map[*flvSub]struct{}{}
}

func (h *streamHub) setMetadata(key string, meta map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ls := h.streams[key]; ls != nil {
		ls.meta = meta
	}
}

// audio / video 返回 false 表示当前没有这个推流码（推流已断开）。
func (h *streamHub) audio(key string, ts uint32, payload []byte) bool {
	if len(payload) == 0 {
		return true
	}
	tag := flvTag{typ: msgAudio, ts: ts, data: payload}

	h.mu.Lock()
	defer h.mu.Unlock()
	ls := h.streams[key]
	if ls == nil {
		return false
	}
	if isAudioSequenceHeader(payload) {
		ls.audioSeq = payload
		return true
	}
	h.broadcastLocked(ls, tag, false)
	return true
}

func (h *streamHub) video(key string, ts uint32, payload []byte) bool {
	if len(payload) == 0 {
		return true
	}
	tag := flvTag{typ: msgVideo, ts: ts, data: payload}

	h.mu.Lock()
	defer h.mu.Unlock()
	ls := h.streams[key]
	if ls == nil {
		return false
	}
	if isVideoSequenceHeader(payload) {
		ls.videoSeq = payload
		return true
	}
	keyframe := isKeyFrame(payload)
	if keyframe {
		ls.gop = ls.gop[:0]
		ls.gopBytes = 0
	}
	if len(ls.gop) > 0 || keyframe {
		ls.gop = append(ls.gop, tag)
		ls.gopBytes += len(payload)
		for ls.gopBytes > maxGOPBytes || len(ls.gop) > maxGOPTags {
			ls.gopBytes -= len(ls.gop[0].data)
			ls.gop = ls.gop[1:]
		}
	}
	h.broadcastLocked(ls, tag, keyframe)
	return true
}

func (h *streamHub) broadcastLocked(ls *liveStream, tag flvTag, keyframe bool) {
	for sub := range ls.subs {
		select {
		case sub.ch <- tag:
		default:
			// 队列满：音频/普通帧丢掉还能靠下一个关键帧恢复，
			// 关键帧丢了就彻底花屏，直接断开让播放器重连。
			if keyframe || tag.typ == msgVideo {
				closeSub(sub)
				delete(ls.subs, sub)
			}
		}
	}
}

func closeSub(sub *flvSub) {
	if sub.closed {
		return
	}
	sub.closed = true
	close(sub.ch)
}

// subscribe 订阅一条流，返回需要先补发的「历史帧」（元数据 + 序列头 + GOP）。
// 流不存在时最多等 wait 这么久——OBS 刚点开始推流、页面同时在拉流是常见时序。
func (h *streamHub) subscribe(key string, wait time.Duration) (*flvSub, []flvTag) {
	deadline := time.Now().Add(wait)
	for {
		h.mu.Lock()
		ls := h.streams[key]
		if ls != nil {
			backlog := make([]flvTag, 0, len(ls.gop)+3)
			if ls.meta != nil {
				if tag, err := metadataTag(ls.meta); err == nil {
					backlog = append(backlog, tag)
				}
			}
			if len(ls.videoSeq) > 0 {
				backlog = append(backlog, flvTag{typ: msgVideo, data: ls.videoSeq})
			}
			if len(ls.audioSeq) > 0 {
				backlog = append(backlog, flvTag{typ: msgAudio, data: ls.audioSeq})
			}
			backlog = append(backlog, ls.gop...)

			sub := &flvSub{ch: make(chan flvTag, 512)}
			ls.subs[sub] = struct{}{}
			h.mu.Unlock()
			return sub, backlog
		}
		h.mu.Unlock()

		if time.Now().After(deadline) {
			return nil, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (h *streamHub) unsubscribe(key string, sub *flvSub) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ls := h.streams[key]
	if ls == nil {
		return
	}
	if _, ok := ls.subs[sub]; ok {
		delete(ls.subs, sub)
		closeSub(sub)
	}
}

// streamKeys 返回当前正在推的流（诊断日志用）。
func (h *streamHub) streamKeys() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	keys := make([]string, 0, len(h.streams))
	for k := range h.streams {
		keys = append(keys, k)
	}
	return keys
}

// 编码判定：RTMP 的音视频载荷与 FLV tag body 逐字节相同，
// 所以这里只需要看包头就能区分「序列头」与「普通帧」。
func isVideoSequenceHeader(p []byte) bool {
	if len(p) < 2 {
		return false
	}
	if p[0]&0x80 != 0 { // 扩展 RTMP（HEVC/AV1）：低 4 位是 PacketType，0 = 序列头
		return p[0]&0x0F == 0
	}
	return p[0]&0x0F == 7 && p[1] == 0 // AVC 序列头
}

func isKeyFrame(p []byte) bool {
	if len(p) == 0 {
		return false
	}
	return (p[0]>>4)&0x07 == 1
}

func isAudioSequenceHeader(p []byte) bool {
	if len(p) < 2 {
		return false
	}
	return p[0]>>4 == 10 && p[1] == 0 // AAC 序列头
}

// ---- FLV 输出 ----

// writeFLVHeader 写 9 字节文件头 + 首帧 prevTagSize(0)。
func writeFLVHeader(w io.Writer) error {
	// flags：有音频 0x04、有视频 0x01。推流场景两路基本都有，
	// 一律置位——播放器不会因为多置位而拒绝，缺位反而可能不解析对应的 tag。
	if _, err := w.Write([]byte{'F', 'L', 'V', 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00}); err != nil {
		return err
	}
	return nil
}

func writeFLVTag(w io.Writer, tag flvTag) error {
	buf := make([]byte, 11+len(tag.data)+4)
	buf[0] = tag.typ
	size := len(tag.data)
	buf[1] = byte(size >> 16)
	buf[2] = byte(size >> 8)
	buf[3] = byte(size)
	buf[4] = byte(tag.ts >> 16)
	buf[5] = byte(tag.ts >> 8)
	buf[6] = byte(tag.ts)
	buf[7] = byte(tag.ts >> 24) // 扩展时间戳
	buf[8], buf[9], buf[10] = 0, 0, 0
	copy(buf[11:], tag.data)
	binary.BigEndian.PutUint32(buf[11+size:], uint32(11+size))
	_, err := w.Write(buf)
	return err
}

// metadataTag 把 onMetaData 编码成 FLV 脚本 tag。
func metadataTag(meta map[string]any) (flvTag, error) {
	var buf bytes.Buffer
	writeAMF0String(&buf, "onMetaData")
	writeAMF0EcmaArray(&buf, meta)
	return flvTag{typ: msgDataAMF0, ts: 0, data: buf.Bytes()}, nil
}
