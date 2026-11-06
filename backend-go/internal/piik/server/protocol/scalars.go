package protocol

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// UTF16Length counts UTF-16 code units, which is what zod's string .min/.max/
// .length and String.prototype.length measure: not bytes, not code points.
// It is the single owner of that measurement for the server packages.
func UTF16Length(value string) int {
	length := 0
	for _, character := range value {
		if character > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}

// IsJSWhitespace matches the JavaScript regular-expression \s class, which is
// also what String.prototype.trim and Number(string) strip. It is the single
// owner of that predicate for the server packages.
func IsJSWhitespace(character rune) bool {
	switch character {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return character >= 0x2000 && character <= 0x200a
}

var (
	opaqueIDPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	roomCodePattern       = regexp.MustCompile(`^[1-9][0-9]*$`)
	viewerGrantPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{21}[AQgw]$`)
	viewerPasswordPattern = regexp.MustCompile(`^[\x21-\x7e]+$`)
)

// ValidOpaqueID mirrors opaqueIdSchema: 8..128 code units of [A-Za-z0-9_-].
func ValidOpaqueID(value string) bool {
	length := UTF16Length(value)
	return length >= 8 && length <= 128 && opaqueIDPattern.MatchString(value)
}

// ValidToken mirrors tokenSchema: 32..128 code units of [A-Za-z0-9_-].
func ValidToken(value string) bool {
	length := UTF16Length(value)
	return length >= 32 && length <= 128 && opaqueIDPattern.MatchString(value)
}

// ValidRoomCode mirrors roomCodeSchema.
func ValidRoomCode(value string) bool {
	return UTF16Length(value) == RoomCodeLength && roomCodePattern.MatchString(value)
}

// ValidViewerGrant mirrors viewerGrantSchema.
func ValidViewerGrant(value string) bool {
	return UTF16Length(value) == 22 && viewerGrantPattern.MatchString(value)
}

// ValidViewerPassword mirrors viewerPasswordSchema.
func ValidViewerPassword(value string) bool {
	length := UTF16Length(value)
	return length >= MinViewerPasswordLength &&
		length <= MaxViewerPasswordLength &&
		viewerPasswordPattern.MatchString(value)
}

// forbiddenDisplayNameCharacters is FORBIDDEN_DISPLAY_NAME_CHARACTERS from
// src/shared/protocol.ts.
var forbiddenDisplayNameCharacters = regexp.MustCompile(
	`[\p{Cc}\p{Zl}\p{Zp}\x{061c}\x{200b}\x{200e}\x{200f}\x{202a}-\x{202e}` +
		`\x{2060}\x{2066}-\x{2069}\x{feff}]`)

// NormalizeDisplayName returns false where the shared TypeScript normalizer returns null.
func NormalizeDisplayName(value string) (string, bool) {
	if forbiddenDisplayNameCharacters.MatchString(value) {
		return "", false
	}
	// The TypeScript rejects code points in D800..DFFF, which a JavaScript
	// string can hold as an unpaired surrogate. A Go string can only carry one
	// as invalid UTF-8 (WTF-8), so utf8.ValidString is the exact analogue.
	if !utf8.ValidString(value) {
		return "", false
	}

	normalized := collapseUnicodeSpaces(
		strings.TrimFunc(norm.NFC.String(value), isUnicodeSpaceSeparator))
	count := utf8.RuneCountInString(normalized)
	if count < 1 || count > MaxDisplayNameCodePoints {
		return "", false
	}
	return normalized, true
}

// isUnicodeSpaceSeparator matches \p{Zs}. Every other character trimmed by
// JavaScript's String.prototype.trim (Cc, Zl, Zp, FEFF) is already forbidden
// above, so trimming Zs alone is equivalent here.
func isUnicodeSpaceSeparator(character rune) bool {
	return unicode.Is(unicode.Zs, character)
}

// collapseUnicodeSpaces implements .replace(/\p{Zs}+/gu, " ").
func collapseUnicodeSpaces(value string) string {
	var builder strings.Builder
	pendingSpace := false
	for _, character := range value {
		if isUnicodeSpaceSeparator(character) {
			pendingSpace = true
			continue
		}
		if pendingSpace {
			builder.WriteByte(' ')
			pendingSpace = false
		}
		builder.WriteRune(character)
	}
	if pendingSpace {
		builder.WriteByte(' ')
	}
	return builder.String()
}

// DisplayName mirrors displayNameSchema: 1..96 UTF-16 code units that
// normalizeDisplayName leaves unchanged.
type DisplayName string

// UnmarshalJSON implements json.Unmarshaler.
func (d *DisplayName) UnmarshalJSON(data []byte) error {
	// encoding/json folds an unpaired \uD800-\uDFFF escape to U+FFFD, so the
	// raw token is the only place the TypeScript surrogate rejection is still
	// observable.
	if hasUnpairedSurrogateEscape(data) {
		return errors.New("displayName contains an unpaired surrogate")
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	if !ValidDisplayName(value) {
		return errors.New("display name must be canonical")
	}
	*d = DisplayName(value)
	return nil
}

// ValidDisplayName mirrors displayNameSchema's bounds and canonical refine.
func ValidDisplayName(value string) bool {
	length := UTF16Length(value)
	if length < 1 || length > MaxDisplayNameCodePoints*4 {
		return false
	}
	normalized, ok := NormalizeDisplayName(value)
	return ok && normalized == value
}

func hasUnpairedSurrogateEscape(token []byte) bool {
	text := string(token)
	for index := 0; index+6 <= len(text); index++ {
		if text[index] != '\\' {
			continue
		}
		if text[index+1] != 'u' {
			// Consume the whole escape, including \\, before looking for \u.
			index++
			continue
		}
		unit, err := strconv.ParseUint(text[index+2:index+6], 16, 32)
		if err != nil {
			continue
		}
		switch {
		case unit >= 0xd800 && unit <= 0xdbff:
			if index+12 > len(text) || text[index+6] != '\\' || text[index+7] != 'u' {
				return true
			}
			low, err := strconv.ParseUint(text[index+8:index+12], 16, 32)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return true
			}
			index += 11
		case unit >= 0xdc00 && unit <= 0xdfff:
			return true
		default:
			index += 5
		}
	}
	return false
}

// ValidStunURL ports isValidStunUrl from src/shared/protocol.ts. The
// TypeScript feeds "http://<authority>" to the WHATWG URL parser; net/url is
// more permissive in several places, so the extra checks below restore the
// WHATWG answers (see stun_test.go for the recorded comparisons).
func ValidStunURL(value string) bool {
	separator := strings.IndexByte(value, ':')
	if separator <= 0 || !asciiEqualFold(value[:separator], "stun") {
		return false
	}

	authority := value[separator+1:]
	if authority == "" || strings.HasSuffix(authority, ":") {
		return false
	}
	for _, character := range authority {
		if character == '\\' || character == '/' || character == '?' ||
			character == '#' || IsJSWhitespace(character) {
			return false
		}
	}

	parsed, err := url.Parse("http://" + authority)
	if err != nil {
		return false
	}
	// WHATWG reports an empty username/password for "@host" and ":@host";
	// net/url reports a non-nil Userinfo, so compare the parts, not the pointer.
	if parsed.User != nil {
		if parsed.User.Username() != "" {
			return false
		}
		if password, _ := parsed.User.Password(); password != "" {
			return false
		}
	}
	if hostname := parsed.Hostname(); hostname == "" || !validWHATWGHost(parsed.Host, hostname) {
		return false
	}
	if port := parsed.Port(); port != "" {
		// net/url accepts any digit run; WHATWG fails above 65535.
		number, err := strconv.Atoi(port)
		if err != nil || number <= 0 || number > 65535 {
			return false
		}
	}
	// net/url leaves Path empty where WHATWG reports "/". The authority scan
	// above already rejected "/", "?" and "#", so these are belt and braces.
	return (parsed.Path == "" || parsed.Path == "/") &&
		parsed.RawQuery == "" && parsed.Fragment == ""
}

func asciiEqualFold(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := 0; index < len(left); index++ {
		if asciiLower(left[index]) != asciiLower(right[index]) {
			return false
		}
	}
	return true
}

func asciiLower(character byte) byte {
	if character >= 'A' && character <= 'Z' {
		return character + 'a' - 'A'
	}
	return character
}

// forbiddenDomainCodePoints is the WHATWG "forbidden domain code point" set
// minus the characters the authority scan already rejected.
const forbiddenDomainCodePoints = " #/:<>?@[\\]^|%"

func validWHATWGHost(rawHost, hostname string) bool {
	if strings.HasPrefix(rawHost, "[") {
		// net/url accepts "[1.2.3.4]" and IPv6 zone identifiers; the WHATWG
		// IPv6 parser accepts neither.
		return strings.Contains(hostname, ":") && !strings.Contains(hostname, "%")
	}
	for _, character := range hostname {
		if character <= 0x1f || character == 0x7f ||
			strings.ContainsRune(forbiddenDomainCodePoints, character) {
			return false
		}
	}
	if hostEndsInNumber(hostname) {
		return validIPv4Host(hostname)
	}
	return true
}

// hostEndsInNumber implements the WHATWG "ends in a number" checker.
func hostEndsInNumber(host string) bool {
	parts := strings.Split(host, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && isASCIIDigits(last) {
		return true
	}
	_, ok := parseIPv4Number(last)
	return ok
}

// validIPv4Host implements the WHATWG IPv4 parser's failure conditions.
func validIPv4Host(host string) bool {
	parts := strings.Split(host, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return false
	}
	numbers := make([]uint64, 0, len(parts))
	for _, part := range parts {
		number, ok := parseIPv4Number(part)
		if !ok {
			return false
		}
		numbers = append(numbers, number)
	}
	for _, number := range numbers[:len(numbers)-1] {
		if number > 255 {
			return false
		}
	}
	limit := uint64(1)
	for index := 0; index < 5-len(numbers); index++ {
		limit *= 256
	}
	return numbers[len(numbers)-1] < limit
}

// parseIPv4Number implements the WHATWG IPv4 number parser (decimal, 0-octal
// and 0x-hexadecimal forms).
func parseIPv4Number(input string) (uint64, bool) {
	if input == "" {
		return 0, false
	}
	radix := 10
	switch {
	case len(input) >= 2 && (strings.HasPrefix(input, "0x") || strings.HasPrefix(input, "0X")):
		input, radix = input[2:], 16
	case len(input) >= 2 && input[0] == '0':
		input, radix = input[1:], 8
	}
	if input == "" {
		return 0, true
	}
	for index := 0; index < len(input); index++ {
		if radixDigit(input[index]) >= radix {
			return 0, false
		}
	}
	number, err := strconv.ParseUint(input, radix, 64)
	if err != nil {
		return 0, false
	}
	return number, true
}

func radixDigit(character byte) int {
	switch {
	case character >= '0' && character <= '9':
		return int(character - '0')
	case character >= 'a' && character <= 'f':
		return int(character-'a') + 10
	case character >= 'A' && character <= 'F':
		return int(character-'A') + 10
	}
	return 99
}

func isASCIIDigits(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}
