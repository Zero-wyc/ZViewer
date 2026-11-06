package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
)

// fields holds the raw members of one JSON object. Validation reads it to tell
// "absent" from "null" the way zod's .optional() / .nullable() pair does, which
// encoding/json alone cannot express. Duplicate keys collapse to the last
// occurrence, matching JSON.parse.
type fields map[string]json.RawMessage

// decodeObject decodes one strict (zod `.strict()`) object: unknown keys are
// rejected and the raw member map is returned for presence checks.
func decodeObject(data []byte, target any) (fields, error) {
	var raw fields
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	// These wire structs declare every member with a JSON tag. Go's struct
	// decoder also accepts case-folded names; reject those before they can
	// disagree with the exact presence/null checks below.
	targetType := reflect.TypeOf(target).Elem()
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
	// JSON.parse keeps only the last occurrence of a duplicate key, so the
	// earlier ones must never reach the strict decode. Re-encoding the member
	// map drops them.
	// ponytail: one extra marshal per object; skip it behind a duplicate-key
	// scan if signaling ever shows up in a profile.
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

// marshalJSON encodes without HTML escaping, because JSON.stringify leaves
// "<", ">" and "&" alone and display names may carry them. The encoder's
// trailing newline is dropped.
func marshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func (f fields) has(key string) bool {
	_, ok := f[key]
	return ok
}

func (f fields) isNull(key string) bool {
	raw, ok := f[key]
	return ok && string(bytes.TrimSpace(raw)) == "null"
}

// require mirrors a plain required zod field: present and not null.
func (f fields) require(keys ...string) error {
	for _, key := range keys {
		if !f.has(key) {
			return fmt.Errorf("%s is required", key)
		}
		if f.isNull(key) {
			return fmt.Errorf("%s must not be null", key)
		}
	}
	return nil
}

// requireNullable mirrors `.nullable()` without `.optional()`: the key must be
// present but may be null.
func (f fields) requireNullable(keys ...string) error {
	for _, key := range keys {
		if !f.has(key) {
			return fmt.Errorf("%s is required", key)
		}
	}
	return nil
}

// optional mirrors `.optional()` without `.nullable()`: null is rejected, an
// absent key is not.
func (f fields) optional(keys ...string) error {
	for _, key := range keys {
		if f.isNull(key) {
			return fmt.Errorf("%s must not be null", key)
		}
	}
	return nil
}

// Int is a JSON number restricted to an integral value, mirroring zod's
// z.number().int(): 5.0 is an integer, 5.5 is not, and values outside the safe
// integer range are rejected (zod 4 rejects them too, and every `.int()` field
// in the contract is bounded by MAX_SAFE_INTEGER anyway).
type Int int64

// UnmarshalJSON implements json.Unmarshaler.
func (v *Int) UnmarshalJSON(data []byte) error {
	var number float64
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	if math.IsNaN(number) || math.IsInf(number, 0) ||
		number != math.Trunc(number) ||
		number < -MaxSafeInteger || number > MaxSafeInteger {
		return fmt.Errorf("%s is not a safe integer", string(data))
	}
	*v = Int(number)
	return nil
}

// Num is a JSON number restricted to a finite value, mirroring zod's
// z.number().finite().
type Num float64

// UnmarshalJSON implements json.Unmarshaler.
func (v *Num) UnmarshalJSON(data []byte) error {
	var number float64
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return fmt.Errorf("%s is not finite", string(data))
	}
	*v = Num(number)
	return nil
}

// Nullable carries a value that is both `.nullable()` and `.optional()`, so the
// three wire states (absent, null, value) survive a decode/encode round trip.
type Nullable[T any] struct {
	Set   bool
	Value *T
}

// IsZero reports whether the key was absent, so `omitzero` drops it.
func (n Nullable[T]) IsZero() bool { return !n.Set }

// MarshalJSON implements json.Marshaler.
func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if n.Value == nil {
		return []byte("null"), nil
	}
	return marshalJSON(*n.Value)
}

// UnmarshalJSON implements json.Unmarshaler.
func (n *Nullable[T]) UnmarshalJSON(data []byte) error {
	n.Set = true
	n.Value = nil
	if string(bytes.TrimSpace(data)) == "null" {
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	n.Value = &value
	return nil
}

// errUnknownVariant is the shared "no union member matched" failure.
var errUnknownVariant = errors.New("no matching message variant")

func enumOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func inRangeInt(value Int, minimum, maximum int64) bool {
	return int64(value) >= minimum && int64(value) <= maximum
}

func inRangeNum(value Num, minimum, maximum float64) bool {
	return float64(value) >= minimum && float64(value) <= maximum
}

// typeOf reads the union discriminator without imposing strictness, the way
// zod tries each member of z.union / z.discriminatedUnion.
func typeOf(data []byte, key string) (string, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return "", err
	}
	raw, ok := probe[key]
	if !ok {
		return "", errUnknownVariant
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", errUnknownVariant
	}
	return value, nil
}
