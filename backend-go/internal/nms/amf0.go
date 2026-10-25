package nms

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"time"
)

// AMF0 只覆盖 RTMP 握手里的命令消息与数据消息（OBS 全程用 AMF0）。
// AMF3（消息类型 17 / 0x11）不在范围内：OBS 不会发，收到就丢弃。
const (
	amf0Number      byte = 0x00
	amf0Boolean     byte = 0x01
	amf0String      byte = 0x02
	amf0Object      byte = 0x03
	amf0Null        byte = 0x05
	amf0Undefined   byte = 0x06
	amf0EcmaArray   byte = 0x08
	amf0ObjectEnd   byte = 0x09
	amf0StrictArray byte = 0x0A
	amf0Date        byte = 0x0B
	amf0LongString  byte = 0x0C
)

// errAMF0 是解码失败（截断/未知标记/嵌套过深）的统一错误。
var errAMF0 = errors.New("amf0: 数据格式错误")

// maxAMF0Depth 防止恶意载荷用嵌套对象把栈打爆。
const maxAMF0Depth = 32

type amf0Decoder struct {
	buf []byte
	pos int
}

func newAMF0Decoder(buf []byte) *amf0Decoder { return &amf0Decoder{buf: buf} }

func (d *amf0Decoder) remaining() int { return len(d.buf) - d.pos }

func (d *amf0Decoder) take(n int) ([]byte, error) {
	if n < 0 || d.pos+n > len(d.buf) {
		return nil, errAMF0
	}
	out := d.buf[d.pos : d.pos+n]
	d.pos += n
	return out, nil
}

func (d *amf0Decoder) u8() (byte, error) {
	b, err := d.take(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func (d *amf0Decoder) u16() (uint16, error) {
	b, err := d.take(2)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(b), nil
}

func (d *amf0Decoder) u32() (uint32, error) {
	b, err := d.take(4)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(b), nil
}

func (d *amf0Decoder) f64() (float64, error) {
	b, err := d.take(8)
	if err != nil {
		return 0, err
	}
	return math.Float64frombits(binary.BigEndian.Uint64(b)), nil
}

// decode 解一个 AMF0 值。返回值形态：float64 / bool / string / nil /
// map[string]any / []any / time.Time。
func (d *amf0Decoder) decode() (any, error) { return d.decodeDepth(0) }

func (d *amf0Decoder) decodeDepth(depth int) (any, error) {
	if depth > maxAMF0Depth {
		return nil, errAMF0
	}
	marker, err := d.u8()
	if err != nil {
		return nil, err
	}
	return d.decodeWithMarker(marker, depth)
}

func (d *amf0Decoder) decodeWithMarker(marker byte, depth int) (any, error) {
	switch marker {
	case amf0Number:
		return d.f64()
	case amf0Boolean:
		b, err := d.u8()
		if err != nil {
			return nil, err
		}
		return b != 0, nil
	case amf0String:
		n, err := d.u16()
		if err != nil {
			return nil, err
		}
		b, err := d.take(int(n))
		if err != nil {
			return nil, err
		}
		return string(b), nil
	case amf0LongString:
		n, err := d.u32()
		if err != nil {
			return nil, err
		}
		b, err := d.take(int(n))
		if err != nil {
			return nil, err
		}
		return string(b), nil
	case amf0Object:
		return d.decodeObject(depth)
	case amf0EcmaArray:
		// 计数不可信（很多实现写 0），一律按「读到 object end 为止」处理。
		if _, err := d.u32(); err != nil {
			return nil, err
		}
		return d.decodeObject(depth)
	case amf0StrictArray:
		n, err := d.u32()
		if err != nil {
			return nil, err
		}
		if n > 4096 {
			return nil, errAMF0
		}
		arr := make([]any, 0, n)
		for i := uint32(0); i < n; i++ {
			v, err := d.decodeDepth(depth + 1)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		return arr, nil
	case amf0Null, amf0Undefined:
		return nil, nil
	case amf0Date:
		ms, err := d.f64()
		if err != nil {
			return nil, err
		}
		if _, err := d.take(2); err != nil { // 时区，无意义
			return nil, err
		}
		return time.UnixMilli(int64(ms)).UTC(), nil
	default:
		return nil, fmt.Errorf("%w: 未知标记 0x%02x", errAMF0, marker)
	}
}

func (d *amf0Decoder) decodeObject(depth int) (map[string]any, error) {
	obj := make(map[string]any, 8)
	for {
		n, err := d.u16()
		if err != nil {
			return nil, err
		}
		if n == 0 {
			// 空键 + 0x09 = object end
			marker, err := d.u8()
			if err != nil {
				return nil, err
			}
			if marker == amf0ObjectEnd {
				return obj, nil
			}
			v, err := d.decodeWithMarker(marker, depth+1)
			if err != nil {
				return nil, err
			}
			obj[""] = v
			continue
		}
		b, err := d.take(int(n))
		if err != nil {
			return nil, err
		}
		v, err := d.decodeDepth(depth + 1)
		if err != nil {
			return nil, err
		}
		obj[string(b)] = v
	}
}

// writeAMF0Value 把 Go 值编码成 AMF0。
//
// 支持：nil / bool / string / 各种整型与浮点（统一成 number）/ map[string]any /
// []any / time.Time。OBS 交互只用到这些。
func writeAMF0Value(buf *bytes.Buffer, v any) {
	switch val := v.(type) {
	case nil:
		buf.WriteByte(amf0Null)
	case bool:
		buf.WriteByte(amf0Boolean)
		if val {
			buf.WriteByte(1)
		} else {
			buf.WriteByte(0)
		}
	case string:
		writeAMF0String(buf, val)
	case float64:
		buf.WriteByte(amf0Number)
		var raw [8]byte
		binary.BigEndian.PutUint64(raw[:], math.Float64bits(val))
		buf.Write(raw[:])
	case float32:
		writeAMF0Value(buf, float64(val))
	case int:
		writeAMF0Value(buf, float64(val))
	case int32:
		writeAMF0Value(buf, float64(val))
	case int64:
		writeAMF0Value(buf, float64(val))
	case uint32:
		writeAMF0Value(buf, float64(val))
	case uint64:
		writeAMF0Value(buf, float64(val))
	case map[string]any:
		writeAMF0Object(buf, val)
	case []any:
		buf.WriteByte(amf0StrictArray)
		var raw [4]byte
		binary.BigEndian.PutUint32(raw[:], uint32(len(val)))
		buf.Write(raw[:])
		for _, item := range val {
			writeAMF0Value(buf, item)
		}
	case time.Time:
		buf.WriteByte(amf0Date)
		var raw [8]byte
		binary.BigEndian.PutUint64(raw[:], math.Float64bits(float64(val.UnixMilli())))
		buf.Write(raw[:])
		buf.Write([]byte{0, 0})
	default:
		// 未知类型不写标记，直接当空串：宁可缺字段，也不要写出半截非法载荷。
		writeAMF0String(buf, fmt.Sprint(val))
	}
}

func writeAMF0String(buf *bytes.Buffer, s string) {
	if len(s) > 0xFFFF {
		buf.WriteByte(amf0LongString)
		var raw [4]byte
		binary.BigEndian.PutUint32(raw[:], uint32(len(s)))
		buf.Write(raw[:])
		buf.WriteString(s)
		return
	}
	buf.WriteByte(amf0String)
	var raw [2]byte
	binary.BigEndian.PutUint16(raw[:], uint16(len(s)))
	buf.Write(raw[:])
	buf.WriteString(s)
}

func writeAMF0Object(buf *bytes.Buffer, obj map[string]any) {
	buf.WriteByte(amf0Object)
	for k, v := range obj {
		var raw [2]byte
		binary.BigEndian.PutUint16(raw[:], uint16(len(k)))
		buf.Write(raw[:])
		buf.WriteString(k)
		writeAMF0Value(buf, v)
	}
	buf.Write([]byte{0, 0, amf0ObjectEnd})
}

// writeAMF0EcmaArray 把元数据写成 ECMA array。
//
// onMetaData 传统上是 ECMA array；flv.js 两种都认，但写成 ECMA array
// 与绝大多数服务端（含 OBS 自己的实现）一致。
func writeAMF0EcmaArray(buf *bytes.Buffer, obj map[string]any) {
	buf.WriteByte(amf0EcmaArray)
	var raw [4]byte
	binary.BigEndian.PutUint32(raw[:], uint32(len(obj)))
	buf.Write(raw[:])
	for k, v := range obj {
		var nameLen [2]byte
		binary.BigEndian.PutUint16(nameLen[:], uint16(len(k)))
		buf.Write(nameLen[:])
		buf.WriteString(k)
		writeAMF0Value(buf, v)
	}
	buf.Write([]byte{0, 0, amf0ObjectEnd})
}
