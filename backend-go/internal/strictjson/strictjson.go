// Package strictjson 是控制面消息的严格解码器。
//
// 结构取自 Piik（MIT）的 internal/server/protocol/codec.go：一帧 = 一个 JSON
// 对象，`t` 做判别式；未知字段、未知 `t` 一律拒绝，不做「宽容解码」。
//
// 为什么不能直接用 encoding/json：
//  1. Go 的 struct 解码接受**大小写折叠**的键，`{"RoomId":...}` 会写进
//     `roomId` 字段，绕过「按白名单校验字段名」这一步；
//  2. `*T` 的 nil 既可能是「缺省」也可能是「显式 null」，两者语义不同。
//
// 所以这里先按目标结构体的 json tag 收集白名单，命名字段逐个比对，再用
// `DisallowUnknownFields` 二次解码。
package strictjson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// MaxFrameBytes 是单帧上限，对齐 Piik 的 64KiB。
//
// SDP 是小对象；超过这个体量基本可以判定是畸形输入或攻击。
const MaxFrameBytes = 64 * 1024

// Fields 保存一个 JSON 对象的原始成员，用于区分「缺省」与「null」。
//
// 重复键折叠成最后一个，与 `JSON.parse` 行为一致。
type Fields map[string]json.RawMessage

// Decode 严格解码一个对象：拒绝未知键，并返回原始成员表。
func Decode(data []byte, target any) (Fields, error) {
	var raw Fields
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	targetType := reflect.TypeOf(target)
	if targetType == nil || targetType.Kind() != reflect.Pointer || targetType.Elem().Kind() != reflect.Struct {
		return nil, fmt.Errorf("strictjson: target must be a pointer to struct")
	}
	targetType = targetType.Elem()
	known := make(map[string]struct{}, targetType.NumField())
	for index := range targetType.NumField() {
		name, _, _ := strings.Cut(targetType.Field(index).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			known[name] = struct{}{}
		}
	}
	for name := range raw {
		if _, ok := known[name]; !ok {
			return nil, fmt.Errorf("unknown field %q", name)
		}
	}
	// 重复键只保留最后一个，也避免前面的值进到严格解码。
	canonical, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return nil, err
	}
	return raw, nil
}

// Marshal 编码时不转义 HTML 字符（与 JSON.stringify 一致，昵称可能带 < > &）。
func Marshal(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

// Has 报告键是否出现（值为 null 也算出现）。
func (f Fields) Has(key string) bool {
	_, ok := f[key]
	return ok
}

// IsNull 报告键是否为显式 null。
func (f Fields) IsNull(key string) bool {
	raw, ok := f[key]
	return ok && string(bytes.TrimSpace(raw)) == "null"
}

// Require 要求键存在且不为 null（对应 zod 的必填字段）。
func (f Fields) Require(keys ...string) error {
	for _, key := range keys {
		if !f.Has(key) {
			return fmt.Errorf("%s is required", key)
		}
		if f.IsNull(key) {
			return fmt.Errorf("%s must not be null", key)
		}
	}
	return nil
}

// String 读一个字符串字段；缺省返回空串，长度超限返回错误。
func (f Fields) String(key string, maxLen int) (string, error) {
	value, ok := f[key]
	if !ok || f.IsNull(key) {
		return "", nil
	}
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	if len(text) > maxLen {
		return "", fmt.Errorf("%s is too long", key)
	}
	return text, nil
}

// Bool 读一个布尔字段；缺省为 false。
func (f Fields) Bool(key string) (bool, error) {
	value, ok := f[key]
	if !ok || f.IsNull(key) {
		return false, nil
	}
	var flag bool
	if err := json.Unmarshal(value, &flag); err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return flag, nil
}

// Raw 读一个嵌套对象/数组的原始字节；缺省返回 nil。
func (f Fields) Raw(key string) json.RawMessage {
	value, ok := f[key]
	if !ok || f.IsNull(key) {
		return nil
	}
	return value
}
