package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The fixture is the single owner of the cross-language wire samples;
// tests/protocol-fixture.test.ts replays the same file against the zod schemas.
const fixturePath = "../../../../tests/fixtures/wire-samples.json"

type wireFixture struct {
	Constants      map[string]any `json:"constants"`
	ClientMessages []struct {
		Name   string `json:"name"`
		Schema string `json:"schema"`
		JSON   string `json:"json"`
		Valid  bool   `json:"valid"`
	} `json:"clientMessages"`
	ServerMessages []struct {
		Name string `json:"name"`
		JSON string `json:"json"`
	} `json:"serverMessages"`
}

func loadFixture(t *testing.T) wireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(fixturePath))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture wireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fixture
}

func TestFixtureConstants(t *testing.T) {
	fixture := loadFixture(t)
	expected := map[string]any{
		"signalingProtocol":                   SignalingProtocol,
		"maxViewersPerRoomLimit":              float64(MaxViewersPerRoomLimit),
		"maxParticipantsPerRoomLimit":         float64(MaxParticipantsPerRoomLimit),
		"maxSignalBytes":                      float64(MaxSignalBytes),
		"roomCodeLength":                      float64(RoomCodeLength),
		"maxMediaRouteRevision":               float64(MaxMediaRouteRevision),
		"maxIceServerUrls":                    float64(MaxIceServerURLs),
		"maxNatPredictionAuxiliaryStunUrls":   float64(MaxNatPredictionAuxiliaryStunURLs),
		"maxViewerQualityEvidenceBytes":       float64(MaxViewerQualityEvidenceBytes),
		"viewerQualityEvidenceIntervalMs":     float64(ViewerQualityEvidenceIntervalMs),
		"viewerQualityEvidenceExpiryMs":       float64(ViewerQualityEvidenceExpiryMs),
		"persistentNativeEdgeDegradedWindows": float64(PersistentNativeEdgeDegradedWindows),
		"maxDisplayNameCodePoints":            float64(MaxDisplayNameCodePoints),
		"maxChatCodePoints":                   float64(MaxChatCodePoints),
		"interactionIntervalMs":               float64(InteractionIntervalMs),
		"defaultViewerDisplayName":            DefaultViewerDisplayName,
		"defaultHostDisplayNamePrefix":        DefaultHostDisplayNamePrefix,
		"minViewerPasswordLength":             float64(MinViewerPasswordLength),
		"maxViewerPasswordLength":             float64(MaxViewerPasswordLength),
		"defaultEndpointMediaCopyCapacity":    float64(DefaultEndpointMediaCopyCapacity),
		"maxEndpointMediaCopyCapacity":        float64(MaxEndpointMediaCopyCapacity),
		"signalCloseCodeServiceRestart":       float64(SignalCloseServiceRestart),
		"signalCloseCodeSessionReplaced":      float64(SignalCloseSessionReplaced),
		"signalCloseCodeClientReconnect":      float64(SignalCloseClientReconnect),
		"signalCloseCodeAuthenticationFailed": float64(SignalCloseAuthenticationFailed),
		"signalCloseCodeViewerAccessRevoked":  float64(SignalCloseViewerAccessRevoked),
		"defaultQualitySettings":              jsonValue(t, DefaultQualitySettings),
		"defaultRoutePolicy":                  jsonValue(t, DefaultRoutePolicy),
	}
	if !reflect.DeepEqual(fixture.Constants, expected) {
		t.Fatalf("constants mismatch\n got: %#v\nwant: %#v", fixture.Constants, expected)
	}
}

func TestFixtureClientSamples(t *testing.T) {
	fixture := loadFixture(t)
	if len(fixture.ClientMessages) == 0 {
		t.Fatal("fixture carries no client samples")
	}
	for _, sample := range fixture.ClientMessages {
		t.Run(sample.Name, func(t *testing.T) {
			var err error
			switch sample.Schema {
			case "client":
				_, err = DecodeClientMessage([]byte(sample.JSON))
			case "createRoomRequest":
				_, err = DecodeCreateRoomRequest([]byte(sample.JSON))
			case "replaceRoomRequest":
				_, err = DecodeReplaceRoomRequest([]byte(sample.JSON))
			case "roomAccessUpdateRequest":
				_, err = DecodeRoomAccessUpdateRequest([]byte(sample.JSON))
			default:
				t.Fatalf("unknown fixture schema %q", sample.Schema)
			}
			if sample.Valid && err != nil {
				t.Fatalf("expected the sample to decode, got %v", err)
			}
			if !sample.Valid && err == nil {
				t.Fatal("expected the sample to be rejected")
			}
		})
	}
}

func TestFixtureServerSamplesRoundTrip(t *testing.T) {
	fixture := loadFixture(t)
	if len(fixture.ServerMessages) == 0 {
		t.Fatal("fixture carries no server samples")
	}
	for _, sample := range fixture.ServerMessages {
		t.Run(sample.Name, func(t *testing.T) {
			message, err := DecodeServerMessage([]byte(sample.JSON))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			encoded, err := EncodeServerMessage(message)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			var want, got any
			if err := json.Unmarshal([]byte(sample.JSON), &want); err != nil {
				t.Fatalf("parse sample: %v", err)
			}
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatalf("parse re-encoded message: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("round trip changed the message\n got: %s\nwant: %s",
					encoded, sample.JSON)
			}
		})
	}
}

func jsonValue(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return decoded
}
