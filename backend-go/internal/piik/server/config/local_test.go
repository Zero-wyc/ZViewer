package config

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

// Ported from tests/local-server-config.test.ts. The environment form,
// loadLocalServerConfig, went away with the Node child process, so its scenario
// is expressed through LocalOptions here.

func mustLocal(t *testing.T, options LocalOptions) Config {
	t.Helper()
	config, err := Local(options)
	if err != nil {
		t.Fatalf("Local: unexpected error %v", err)
	}
	return config
}

func TestLocalMapsClientInputs(t *testing.T) {
	config := mustLocal(t, LocalOptions{
		Port:               9123,
		PublicAddress:      "192.168.1.10",
		AllowedAddresses:   []string{"10.0.0.8", "192.168.1.10"},
		SiteAccessPassword: "local-access-password",
	})

	if config.Env != EnvironmentProduction {
		t.Errorf("Env = %q", config.Env)
	}
	if config.Port != 9123 {
		t.Errorf("Port = %d", config.Port)
	}
	if config.ListenHost != "0.0.0.0" {
		t.Errorf("ListenHost = %q", config.ListenHost)
	}
	if config.SiteAccessPassword != "local-access-password" {
		t.Errorf("SiteAccessPassword = %q", config.SiteAccessPassword)
	}
	if config.MaxViewersPerRoom != 20 {
		t.Errorf("MaxViewersPerRoom = %d", config.MaxViewersPerRoom)
	}
	if config.EndpointMediaCopyCapacity != 2 {
		t.Errorf("EndpointMediaCopyCapacity = %d", config.EndpointMediaCopyCapacity)
	}
	if !slices.Equal(config.STUNURLs, []string{"stun:192.168.1.10:9123"}) {
		t.Errorf("STUNURLs = %v", config.STUNURLs)
	}
	if !slices.Equal(config.STUNListenAddresses, []string{"192.168.1.10:9123"}) {
		t.Fatalf("Local STUN listener = %v", config.STUNListenAddresses)
	}
	if config.NATPredictionEnabled {
		t.Error("NATPredictionEnabled = true")
	}
	if got := config.PublicBaseURL.String(); got != "https://192.168.1.10:9123/" {
		t.Errorf("PublicBaseURL = %q", got)
	}
	want := map[string]struct{}{
		"http://localhost:9123":     {},
		"http://127.0.0.1:9123":     {},
		"https://192.168.1.10:9123": {},
		"https://10.0.0.8:9123":     {},
	}
	if !reflect.DeepEqual(config.AllowedOrigins, want) {
		t.Errorf("AllowedOrigins = %v, want %v", config.AllowedOrigins, want)
	}
	if config.SFU != nil {
		t.Errorf("SFU = %+v", config.SFU)
	}
	if config.RoomDatabasePath != "" {
		t.Errorf("RoomDatabasePath = %q", config.RoomDatabasePath)
	}
}

func TestLocalTunnelledClient(t *testing.T) {
	config := mustLocal(t, LocalOptions{
		Port:                  9234,
		PublicAddress:         "192.168.50.4",
		AllowedAddresses:      []string{"192.168.50.4", "10.10.0.4"},
		SiteAccessPassword:    "persistent-local-password",
		PublicOrigin:          "https://small-bright-room.trycloudflare.com",
		STUNURLs:              []string{"stun:stun.example:3478", "stun:stun.example:3479"},
		NATPredictionSTUNURLs: []string{"stun:survey-a.example:3478", "stun:survey-b.example:3478"},
	})

	if config.Port != 9234 {
		t.Errorf("Port = %d", config.Port)
	}
	if got := Origin(config.PublicBaseURL); got != "https://small-bright-room.trycloudflare.com" {
		t.Errorf("public origin = %q", got)
	}
	for _, origin := range []string{
		"https://small-bright-room.trycloudflare.com", "http://10.10.0.4:9234",
	} {
		if _, ok := config.AllowedOrigins[origin]; !ok {
			t.Errorf("AllowedOrigins is missing %q: %v", origin, config.AllowedOrigins)
		}
	}
	if !slices.Equal(config.STUNURLs, []string{"stun:stun.example:3478", "stun:stun.example:3479"}) {
		t.Errorf("STUNURLs = %v", config.STUNURLs)
	}
	if !config.NATPredictionEnabled {
		t.Error("NATPredictionEnabled = false")
	}
	if len(config.STUNListenAddresses) != 0 {
		t.Fatalf("public discovery created Local STUN listeners: %v", config.STUNListenAddresses)
	}
	if config.SFU != nil {
		t.Errorf("public link created an SFU listener: %+v", config.SFU)
	}
	if !slices.Equal(config.NATPredictionSTUNURLs,
		[]string{"stun:survey-a.example:3478", "stun:survey-b.example:3478"}) {
		t.Errorf("NATPredictionSTUNURLs = %v", config.NATPredictionSTUNURLs)
	}
}

func TestLocalTunnelledClientWithoutLANAddress(t *testing.T) {
	config := mustLocal(t, LocalOptions{
		Port:               9235,
		PublicOrigin:       "https://quiet-fancy-room.trycloudflare.com",
		AllowedAddresses:   []string{"172.18.0.1", "192.168.1.10"},
		SiteAccessPassword: "persistent-local-password",
	})

	if got := Origin(config.PublicBaseURL); got != "https://quiet-fancy-room.trycloudflare.com" {
		t.Errorf("public origin = %q", got)
	}
	want := map[string]struct{}{
		"http://localhost:9235":                      {},
		"http://127.0.0.1:9235":                      {},
		"http://172.18.0.1:9235":                     {},
		"http://192.168.1.10:9235":                   {},
		"https://quiet-fancy-room.trycloudflare.com": {},
	}
	if !reflect.DeepEqual(config.AllowedOrigins, want) {
		t.Errorf("AllowedOrigins = %v, want %v", config.AllowedOrigins, want)
	}
}

func TestLocalDefaults(t *testing.T) {
	config := mustLocal(t, LocalOptions{PublicAddress: "192.168.1.10"})

	if config.SiteAccessPassword != "" {
		t.Errorf("SiteAccessPassword = %q, want the open site", config.SiteAccessPassword)
	}
	if config.Port != 8787 {
		t.Errorf("Port = %d, want the 8787 default", config.Port)
	}
	if !slices.Equal(config.STUNURLs, []string{"stun:192.168.1.10:8787"}) ||
		!slices.Equal(config.STUNListenAddresses, []string{"192.168.1.10:8787"}) {
		t.Fatalf("Local discovery does not use its default port: %+v", config)
	}
	if got := Origin(config.PublicBaseURL); got != "https://192.168.1.10:8787" {
		t.Errorf("public origin = %q", got)
	}
	// A configured (empty) prediction list stays non-nil so IceConfig does not
	// derive one, which is TS's `?? []` spread.
	if config.NATPredictionSTUNURLs == nil {
		t.Error("NATPredictionSTUNURLs = nil, want an empty configured list")
	}
}

func TestLocalPreservesTheChosenPassword(t *testing.T) {
	for _, password := range []string{"", "x", "中文", " ", "  中文 +&  ", strings.Repeat("x", 256)} {
		config := mustLocal(t, LocalOptions{PublicAddress: "192.0.2.10", SiteAccessPassword: password})
		if config.SiteAccessPassword != password {
			t.Fatal("Local password changed")
		}
	}
}

func TestLocalRejects(t *testing.T) {
	cases := []struct {
		name    string
		options LocalOptions
		want    string
	}{
		{"hostname public address", LocalOptions{PublicAddress: "localhost",
			SiteAccessPassword: "valid-password"},
			"Local server public address must be an IPv4 address"},
		{"missing public address without an origin", LocalOptions{
			SiteAccessPassword: "valid-password"},
			"Local server public address must be reachable from the LAN"},
		{"IPv6 public address", LocalOptions{PublicAddress: "::ffff:192.168.1.10"},
			"Local server public address must be an IPv4 address"},
		{"loopback public address", LocalOptions{PublicAddress: "127.0.0.1",
			SiteAccessPassword: "valid-password"},
			"Local server public address must be reachable from the LAN"},
		{"unspecified public address", LocalOptions{PublicAddress: "0.0.0.0",
			SiteAccessPassword: "valid-password"},
			"Local server public address must be reachable from the LAN"},
		{"port above the TCP ceiling", LocalOptions{Port: 70_000, PublicAddress: "192.168.1.2"},
			"Local server port must be an integer between 1 and 65535"},
		{"negative port", LocalOptions{Port: -1, PublicAddress: "192.168.1.2"},
			"Local server port must be an integer between 1 and 65535"},
		{"hostname allowed address", LocalOptions{PublicAddress: "192.168.1.2",
			AllowedAddresses: []string{"share.local"}},
			"Local server allowed address must be an IPv4 address"},
		{"plaintext public origin", LocalOptions{PublicAddress: "192.168.1.2",
			PublicOrigin: "http://public.example", SiteAccessPassword: "valid-password"},
			"Local public origin must be an HTTPS origin"},
		{"public origin with a path", LocalOptions{PublicAddress: "192.168.1.2",
			PublicOrigin: "https://public.example/path", SiteAccessPassword: "valid-password"},
			"Local public origin must be an HTTPS origin"},
		{"public origin with userinfo", LocalOptions{PublicAddress: "192.168.1.2",
			PublicOrigin: "https://user@public.example", SiteAccessPassword: "valid-password"},
			"Local public origin must be an HTTPS origin"},
		{"unparsable public origin", LocalOptions{PublicAddress: "192.168.1.2",
			PublicOrigin: "public.example"},
			"Local public origin must be an HTTPS origin"},
		{"invalid STUN URL", LocalOptions{PublicAddress: "192.168.1.2", PublicOrigin: "https://public.example.test",
			STUNURLs: []string{"turn:turn.test:3478"}},
			"Local STUN URLs are invalid"},
		{"invalid prediction STUN URL", LocalOptions{PublicAddress: "192.168.1.2", PublicOrigin: "https://public.example.test",
			STUNURLs:              []string{"stun:a.test:3478"},
			NATPredictionSTUNURLs: []string{"stun:a.test:3479", "stuns:b.test:3480"}},
			"Local STUN URLs are invalid"},
		{"single prediction STUN URL", LocalOptions{PublicAddress: "192.168.1.2", PublicOrigin: "https://public.example.test",
			STUNURLs: []string{"stun:a.test:3478"}, NATPredictionSTUNURLs: []string{"stun:a.test:3479"}},
			"Local STUN URLs are invalid"},
		{"prediction without ordinary STUN", LocalOptions{PublicAddress: "192.168.1.2", PublicOrigin: "https://public.example.test",
			NATPredictionSTUNURLs: []string{"stun:a.test:3479", "stun:a.test:3480"}},
			"Local STUN URLs are invalid"},
		{"more ICE URLs than the wire carries", LocalOptions{PublicAddress: "192.168.1.2", PublicOrigin: "https://public.example.test",
			STUNURLs: []string{
				"stun:a.test:3478", "stun:b.test:3478", "stun:c.test:3478", "stun:d.test:3478",
				"stun:e.test:3478", "stun:f.test:3478", "stun:g.test:3478",
			},
			NATPredictionSTUNURLs: []string{"stun:a.test:3479", "stun:a.test:3480"}},
			"Local STUN URLs are invalid"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Local(testCase.options)
			if err == nil {
				t.Fatalf("Local: want error containing %q", testCase.want)
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Errorf("Local: error %q, want it to contain %q", err, testCase.want)
			}
		})
	}
}
