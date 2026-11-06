package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPunchSignalStrictBoundedRoundTrip(t *testing.T) {
	prediction := `{"address":"198.51.100.1","port":40000,"step":1}`
	for _, body := range []string{
		`{"phase":"prepare","secret":"` + strings.Repeat("42", 32) + `"}`,
		`{"phase":"ready"}`, `{"phase":"ready","prediction":` + prediction + `}`,
		`{"phase":"start","prediction":` + prediction + `}`,
		`{"phase":"start","prediction":{"address":"198.51.100.1","port":65535,"step":0}}`,
		`{"phase":"complete","connected":false}`, `{"phase":"complete","connected":true}`,
	} {
		raw := `{"kind":"punch","connectionId":"connection_123456","punch":` + body + `}`
		var payload SignalPayload
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		encoded, err := json.Marshal(payload)
		if err != nil || string(encoded) != raw {
			t.Fatalf("round trip %s: %s, %v", raw, encoded, err)
		}
	}
	for _, body := range []string{
		`{"phase":"prepare","secret":"bad"}`, `{"phase":"prepare","secret":null}`,
		`{"phase":"ready","prediction":null}`, `{"phase":"ready","connected":true}`,
		`{"phase":"start"}`, `{"phase":"complete"}`, `{"phase":"complete","connected":null}`,
		`{"phase":"ready","prediction":` + prediction + `,"secret":"unused"}`,
		`{"phase":"start","prediction":{"address":"::1","port":40000,"step":1}}`,
		`{"phase":"start","prediction":{"address":"198.51.100.1","port":65535,"step":1}}`,
		`{"phase":"start","prediction":{"address":"198.51.100.1","port":40000,"step":17}}`,
		`{"phase":"start","prediction":{"address":"198.51.100.1","port":40000,"step":-1}}`,
	} {
		var payload PunchSignal
		if err := json.Unmarshal([]byte(body), &payload); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
	// A decoder reused by a caller must not inherit a previous phase's fields.
	var phase PunchSignal
	_ = json.Unmarshal([]byte(`{"phase":"start","prediction":`+prediction+`}`), &phase)
	if err := json.Unmarshal([]byte(`{"phase":"ready"}`), &phase); err != nil || phase.Prediction != nil {
		t.Fatal("reused decoder retained a stale endpoint")
	}
}
