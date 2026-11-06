package protocol

import "testing"

func TestUTF16Len(t *testing.T) {
	// zod's string bounds count UTF-16 code units, so an astral code point
	// counts as two.
	for _, sample := range []struct {
		value string
		want  int
	}{
		{"", 0},
		{"abc", 3},
		{"名", 1},
		{"\U0001f469", 2},
		{"\U0001f469\u200d\U0001f4bb", 5},
	} {
		if got := UTF16Length(sample.value); got != sample.want {
			t.Errorf("UTF16Length(%q) = %d, want %d", sample.value, got, sample.want)
		}
	}
}

func TestNormalizeDisplayName(t *testing.T) {
	for _, sample := range []struct {
		name  string
		value string
		want  string
		ok    bool
	}{
		{"composes and collapses", "  Café 朋友  ",
			"Café 朋友", true},
		{"keeps a zero width joiner sequence",
			"玩家 \U0001f469\u200d\U0001f4bb",
			"玩家 \U0001f469\u200d\U0001f4bb", true},
		{"accepts the code point limit",
			repeat("名", MaxDisplayNameCodePoints),
			repeat("名", MaxDisplayNameCodePoints), true},
		{"rejects one code point past the limit",
			repeat("名", MaxDisplayNameCodePoints+1), "", false},
		{"rejects a control character", "a\nb", "", false},
		{"rejects a bidi override", "a\u202eb", "", false},
		{"rejects a byte order mark", "a\ufeffb", "", false},
		{"rejects a zero width space", "a\u200bb", "", false},
		{"rejects an unpaired surrogate", "a\xed\xa0\x80b", "", false},
		{"rejects an all-space name", "   ", "", false},
	} {
		t.Run(sample.name, func(t *testing.T) {
			got, ok := NormalizeDisplayName(sample.value)
			if ok != sample.ok || got != sample.want {
				t.Fatalf("NormalizeDisplayName(%q) = (%q, %v), want (%q, %v)",
					sample.value, got, ok, sample.want, sample.ok)
			}
		})
	}
}

func TestValidDisplayNameRequiresCanonicalForm(t *testing.T) {
	if ValidDisplayName(" Café ") {
		t.Error("a non-canonical display name must not validate")
	}
	if !ValidDisplayName("Café 朋友") {
		t.Error("a canonical display name must validate")
	}
	if ValidDisplayName("") {
		t.Error("an empty display name must not validate")
	}
}

func TestDisplayNameRejectsSurrogateEscapes(t *testing.T) {
	// encoding/json folds an unpaired escape to U+FFFD, so the raw token is the
	// only place the TypeScript surrogate rejection stays observable.
	var name DisplayName
	if err := name.UnmarshalJSON([]byte(`"a\ud800b"`)); err == nil {
		t.Fatal("an unpaired high surrogate escape must be rejected")
	}
	if err := name.UnmarshalJSON([]byte(`"a\udc00b"`)); err == nil {
		t.Fatal("an unpaired low surrogate escape must be rejected")
	}
	if err := name.UnmarshalJSON([]byte(`"a😀b"`)); err != nil {
		t.Fatalf("a surrogate pair escape must be accepted: %v", err)
	}
}

func TestScalarValidators(t *testing.T) {
	for _, sample := range []struct {
		name  string
		valid func(string) bool
		value string
		want  bool
	}{
		{"opaque id at floor", ValidOpaqueID, "abcdefgh", true},
		{"opaque id below floor", ValidOpaqueID, "abcdefg", false},
		{"opaque id with punctuation", ValidOpaqueID, "abcdefg.", false},
		{"opaque id at ceiling", ValidOpaqueID, repeat("a", 128), true},
		{"opaque id past ceiling", ValidOpaqueID, repeat("a", 129), false},
		{"token at floor", ValidToken, repeat("a", 32), true},
		{"token below floor", ValidToken, repeat("a", 31), false},
		{"token past ceiling", ValidToken, repeat("a", 129), false},
		{"room code", ValidRoomCode, "1234", true},
		{"room code with leading zero", ValidRoomCode, "0123", false},
		{"room code too long", ValidRoomCode, "12345", false},
		{"room code too short", ValidRoomCode, "123", false},
		{"viewer grant", ValidViewerGrant, repeat("b", 21) + "g", true},
		{"viewer grant short", ValidViewerGrant, repeat("b", 21), false},
		{"viewer grant long", ValidViewerGrant, repeat("b", 23), false},
		{"viewer grant padded", ValidViewerGrant, repeat("b", 21) + "=", false},
		{"viewer grant off alphabet tail", ValidViewerGrant, repeat("b", 21) + "b", false},
		{"viewer password minimal", ValidViewerPassword, "x", true},
		{"viewer password simple", ValidViewerPassword, "simple-password", true},
		{"viewer password empty", ValidViewerPassword, "", false},
		{"viewer password with space", ValidViewerPassword, "contains space", false},
		{"viewer password with newline", ValidViewerPassword, "line\nbreak", false},
		{"viewer password past ceiling", ValidViewerPassword,
			repeat("x", MaxViewerPasswordLength+1), false},
	} {
		t.Run(sample.name, func(t *testing.T) {
			if got := sample.valid(sample.value); got != sample.want {
				t.Fatalf("validator(%q) = %v, want %v", sample.value, got, sample.want)
			}
		})
	}
}

// TestValidStunURL records the WHATWG answers isValidStunUrl produces in the
// browser. The cases marked "net/url divergence" are the ones where Go's
// parser alone would disagree.
func TestValidStunURL(t *testing.T) {
	for _, sample := range []struct {
		value string
		want  bool
	}{
		// tests/server-config.test.ts and tests/protocol.test.ts.
		{"stun:stun.test:3478", true},
		{"stun:share.test:5349", true},
		{"STUN:[2001:db8::1]:3478", true},
		{"stun:stun.test", true},
		{"stun:stun.test/path", false},
		{"stun:stun.test:80/", false},
		{"stun:stun.test:3478/", false},
		{"stun:stun.test?transport=udp", false},
		{"stun:stun.test#fragment", false},
		{"stun:", false},
		{"stun:stun.test:", false},
		{"stun:stun.test:0", false},
		{"stun:user@stun.test:3478", false},
		{"turn:turn.test:3478", false},
		{"stuns:stun.test:5349", false},
		{"stun:relay.example.test:3478?transport=udp", false},

		// net/url divergence: it accepts ports above 65535.
		{"stun:stun.test:65535", true},
		{"stun:stun.test:65536", false},
		{"stun:stun.test:99999", false},
		// net/url divergence: it accepts "<", ">" and "]" in a host name.
		{"stun:a<b:3478", false},
		{"stun:a>b:3478", false},
		{"stun:a]b:3478", false},
		{"stun:a|b:3478", false},
		{"stun:a^b:3478", false},
		// net/url divergence: it does not run the WHATWG IPv4 parser.
		{"stun:999.999.999.999", false},
		{"stun:1.2.3.4.5", false},
		{"stun:09.1", false},
		{"stun:1.2.3.256", false},
		{"stun:1.2.3.4", true},
		{"stun:1.2.3.4.", true},
		{"stun:0300.0250.0.1", true},
		{"stun:0x7f.1", true},
		{"stun:123", true},
		// net/url divergence: it accepts "[1.2.3.4]" and IPv6 zone ids.
		{"stun:[1.2.3.4]", false},
		{"stun:[notanip]:3478", false},
		{"stun:[2001:db8::1", false},
		{"stun:[::1]", true},
		// WHATWG treats empty userinfo as absent.
		{"stun:@stun.test:3478", true},
		{"stun::@stun.test:3478", true},
		{"stun::pass@stun.test:3478", false},
		{"stun:user:@stun.test:3478", false},
		// A host is mandatory and the authority scan rejects the framing
		// characters before net/url ever sees them.
		{"stun::3478", false},
		{"stun:stun.test:+3478", false},
		{"stun:stun.test:34a78", false},
		{"stun:stun test:3478", false},
		{"stun:stun.test\\path", false},
		{"stun:a_b.test", true},
		{"stun:stun.test:03478", true},
	} {
		t.Run(sample.value, func(t *testing.T) {
			if got := ValidStunURL(sample.value); got != sample.want {
				t.Fatalf("ValidStunURL(%q) = %v, want %v", sample.value, got, sample.want)
			}
		})
	}
}

func repeat(value string, count int) string {
	out := make([]byte, 0, len(value)*count)
	for index := 0; index < count; index++ {
		out = append(out, value...)
	}
	return string(out)
}
