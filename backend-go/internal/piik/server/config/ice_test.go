package config

import (
	"encoding/json"
	"slices"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

// Ported from tests/ice.test.ts.

func TestIceConfig(t *testing.T) {
	cases := []struct {
		name   string
		config Config
		want   string
	}{
		{
			name: "returns only the configured STUN servers",
			config: Config{
				STUNURLs:             []string{"stun:stun-a.example.test:3478", "stun:stun-b.example.test:3478"},
				NATPredictionEnabled: true,
				NATPredictionSTUNURLs: []string{
					"stun:survey-a.example.test:3478", "stun:survey-b.example.test:3478",
				},
			},
			want: `{"iceServers":[{"urls":["stun:stun-a.example.test:3478",` +
				`"stun:stun-b.example.test:3478"]}],"natPredictionStunUrls":` +
				`["stun:survey-a.example.test:3478","stun:survey-b.example.test:3478"]}`,
		},
		{
			name:   "keeps local development explicit when STUN is absent",
			config: Config{},
			want:   `{"iceServers":[],"natPredictionStunUrls":[]}`,
		},
		{
			name:   "does not expose auxiliary listeners when the capability is disabled",
			config: Config{STUNURLs: []string{"stun:share.example.test:3478"}},
			want: `{"iceServers":[{"urls":["stun:share.example.test:3478"]}],` +
				`"natPredictionStunUrls":[]}`,
		},
		{
			name: "derives auxiliary listeners from an IPv6 STUN authority",
			config: Config{
				STUNURLs:             []string{"STUN:[2001:db8::1]:3478"},
				NATPredictionEnabled: true,
			},
			want: `{"iceServers":[{"urls":["STUN:[2001:db8::1]:3478"]}],` +
				`"natPredictionStunUrls":["stun:[2001:db8::1]:3479","stun:[2001:db8::1]:3480"]}`,
		},
		{
			// TS: `options.natPredictionStunUrls ?? natPredictionStunUrls(...)`
			// keeps a configured empty list instead of deriving one.
			name: "keeps a configured empty prediction list",
			config: Config{
				STUNURLs:              []string{"stun:share.example.test:3478"},
				NATPredictionEnabled:  true,
				NATPredictionSTUNURLs: []string{},
			},
			want: `{"iceServers":[{"urls":["stun:share.example.test:3478"]}],` +
				`"natPredictionStunUrls":[]}`,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := json.Marshal(IceConfig(testCase.config))
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if string(encoded) != testCase.want {
				t.Errorf("IceConfig = %s, want %s", encoded, testCase.want)
			}
		})
	}
}

func TestIceConfigDoesNotAliasTheConfiguration(t *testing.T) {
	config := Config{
		STUNURLs:              []string{"stun:a.test:3478"},
		NATPredictionEnabled:  true,
		NATPredictionSTUNURLs: []string{"stun:a.test:3479", "stun:a.test:3480"},
	}
	derived := IceConfig(config)
	derived.IceServers[0].URLs.List[0] = "stun:mutated.test:3478"
	derived.NatPredictionStunURLs[0] = "stun:mutated.test:3479"
	if config.STUNURLs[0] != "stun:a.test:3478" || config.NATPredictionSTUNURLs[0] != "stun:a.test:3479" {
		t.Errorf("IceConfig shares its slices with the Config: %v %v",
			config.STUNURLs, config.NATPredictionSTUNURLs)
	}
}

func TestNATPredictionStunURLs(t *testing.T) {
	cases := []struct {
		name     string
		stunURLs []string
		want     []string
	}{
		{"no URLs", nil, nil},
		{"implicit base port", []string{"stun:share.test"},
			[]string{"stun:share.test:3479", "stun:share.test:3480"}},
		{"explicit base port", []string{"stun:share.test:3478"},
			[]string{"stun:share.test:3479", "stun:share.test:3480"}},
		{"leading zeros in the port", []string{"stun:share.test:03478"},
			[]string{"stun:share.test:3479", "stun:share.test:3480"}},
		{"explicit port 80 is not the base port", []string{"stun:share.test:80"}, nil},
		{"leading zero port 80 is not the base port", []string{"stun:share.test:00080"}, nil},
		{"uppercase scheme and host", []string{"STUN:Share.TEST:3478"},
			[]string{"stun:share.test:3479", "stun:share.test:3480"}},
		{"IPv6 authority", []string{"stun:[2001:DB8::1]:3478"},
			[]string{"stun:[2001:db8::1]:3479", "stun:[2001:db8::1]:3480"}},
		{"first base listener wins",
			[]string{"stun:a.test:80", "stun:b.test:3478", "stun:c.test:3478"},
			[]string{"stun:b.test:3479", "stun:b.test:3480"}},
		{"no base listener", []string{"stun:a.test:5349", "stun:b.test:19302"}, nil},
		// TS: indexOf(":") is -1, so the whole text becomes the authority.
		{"no scheme separator", []string{"sharetest"},
			[]string{"stun:sharetest:3479", "stun:sharetest:3480"}},
		{"no authority", []string{"stun:"}, nil},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := NATPredictionStunURLs(testCase.stunURLs)
			if !slices.Equal(got, testCase.want) {
				t.Errorf("NATPredictionStunURLs = %v, want %v", got, testCase.want)
			}
			if len(got) > protocol.MaxNatPredictionAuxiliaryStunURLs {
				t.Errorf("NATPredictionStunURLs returned %d URLs", len(got))
			}
		})
	}
}
