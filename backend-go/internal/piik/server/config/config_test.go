package config

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

// Ported from tests/server-config.test.ts.

// env merges the given maps, later keys winning, so a case can extend a base.
func env(parts ...map[string]string) map[string]string {
	merged := map[string]string{}
	for _, part := range parts {
		maps.Copy(merged, part)
	}
	return merged
}

var productionBase = map[string]string{
	"PIIK_ENV":             "production",
	"PUBLIC_BASE_URL":      "https://share.test",
	"SITE_ACCESS_PASSWORD": "host-password-12",
	"STUN_URLS":            "stun:stun.test:3478",
}

func stunList(count int, prefix string) string {
	urls := make([]string, 0, count)
	for index := range count {
		urls = append(urls, fmt.Sprintf("stun:%s-%d.test:3478", prefix, index))
	}
	return strings.Join(urls, ",")
}

func mustLoad(t *testing.T, environment map[string]string) Config {
	t.Helper()
	config, err := Load(environment)
	if err != nil {
		t.Fatalf("Load: unexpected error %v", err)
	}
	return config
}

func TestLoadDevelopmentDefaults(t *testing.T) {
	config := mustLoad(t, map[string]string{"PIIK_ENV": "development", "PORT": "9123"})

	if config.Env != EnvironmentDevelopment {
		t.Errorf("Env = %q", config.Env)
	}
	if config.ListenHost != "0.0.0.0" {
		t.Errorf("ListenHost = %q", config.ListenHost)
	}
	if got := config.PublicBaseURL.String(); got != "http://localhost:9123/" {
		t.Errorf("PublicBaseURL = %q", got)
	}
	want := map[string]struct{}{"http://localhost:9123": {}}
	if !reflect.DeepEqual(config.AllowedOrigins, want) {
		t.Errorf("AllowedOrigins = %v", config.AllowedOrigins)
	}
	defaultDatabasePath, err := filepath.Abs("rooms.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if config.RoomDatabasePath != defaultDatabasePath {
		t.Errorf("RoomDatabasePath = %q", config.RoomDatabasePath)
	}
	if len(config.STUNURLs) != 0 {
		t.Errorf("STUNURLs = %v", config.STUNURLs)
	}
	if len(config.STUNListenAddresses) != 0 {
		t.Errorf("STUNListenAddresses = %v", config.STUNListenAddresses)
	}
	if config.NATPredictionEnabled {
		t.Error("NATPredictionEnabled = true")
	}
	if config.NATPredictionSTUNURLs != nil {
		t.Errorf("NATPredictionSTUNURLs = %v, want nil (TS left it undefined)", config.NATPredictionSTUNURLs)
	}
	if config.MaxViewersPerRoom != 20 {
		t.Errorf("MaxViewersPerRoom = %d", config.MaxViewersPerRoom)
	}
	if config.EndpointMediaCopyCapacity != 2 {
		t.Errorf("EndpointMediaCopyCapacity = %d", config.EndpointMediaCopyCapacity)
	}
	if config.SFU != nil {
		t.Errorf("SFU = %+v", config.SFU)
	}
	if config.SiteAccessPassword != "" {
		t.Error("SiteAccessPassword is set")
	}
}

func TestLoadProductionAllowsAnUnsetOrEmptySiteAccessPassword(t *testing.T) {
	for _, name := range []string{"unset", "empty"} {
		t.Run(name, func(t *testing.T) {
			environment := env(productionBase, map[string]string{"SITE_ACCESS_PASSWORD": ""})
			if name == "unset" {
				delete(environment, "SITE_ACCESS_PASSWORD")
			}
			configuration := mustLoad(t, environment)
			if configuration.Env != EnvironmentProduction || configuration.SiteAccessPassword != "" {
				t.Fatal("expected a production site without an access password")
			}
		})
	}
}

func TestLoadPreservesTheChosenSiteAccessPassword(t *testing.T) {
	for _, base := range []map[string]string{nil, productionBase} {
		for _, password := range []string{"", "x", "中文", " ", "  中文 +&  ", strings.Repeat("x", 256)} {
			configuration := mustLoad(t, env(base, map[string]string{"SITE_ACCESS_PASSWORD": password}))
			if configuration.SiteAccessPassword != password {
				t.Fatal("site password changed")
			}
		}
	}
}

func TestLoadRoomStorage(t *testing.T) {
	directory := t.TempDir()
	t.Chdir(directory)
	for _, base := range []map[string]string{nil, productionBase} {
		for _, override := range []map[string]string{nil,
			{"ROOM_DATABASE_PATH": ""}, {"ROOM_DATABASE_PATH": " \t"},
			{"ROOM_DATABASE_PATH": ":memory:"},
		} {
			configuration := mustLoad(t, env(base, override))
			want := filepath.Join(directory, "rooms.sqlite")
			if override["ROOM_DATABASE_PATH"] == ":memory:" {
				want = ""
			}
			if configuration.RoomDatabasePath != want {
				t.Errorf("Load(%v): RoomDatabasePath = %q, want %q", override, configuration.RoomDatabasePath, want)
			}
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("configuration loading created runtime files: %v, %v", entries, err)
	}
}

func TestLoadSFU(t *testing.T) {
	config := mustLoad(t, map[string]string{
		"LISTEN_HOST":     "127.0.0.1",
		"SFU_UDP_PORT":    " 7882 ",
		"SFU_LISTEN_HOST": " 192.0.2.5 ",
		"SFU_PUBLIC_IP":   " 198.51.100.5 ",
	})
	want := SFUConfig{
		ListenHost: "192.0.2.5",
		Port:       7882,
		PublicIP:   "198.51.100.5",
	}
	if config.SFU == nil || *config.SFU != want {
		t.Errorf("SFU = %+v, want %+v", config.SFU, want)
	}
}

func TestLoadSFUPublicHostnameWithoutResolving(t *testing.T) {
	for input, want := range map[string]string{
		" Media.Example.COM ": "media.example.com",
		"home.example.com.":   "home.example.com.",
		"例子.example":          "xn--fsqu00a.example",
	} {
		configuration := mustLoad(t, map[string]string{"SFU_UDP_PORT": "7882", "SFU_PUBLIC_IP": input})
		if configuration.SFU.PublicIP != want {
			t.Fatalf("advertised host %q = %q, want %q", input, configuration.SFU.PublicIP, want)
		}
	}
}

func TestLoadSFUOptional(t *testing.T) {
	for _, values := range []map[string]string{
		nil,
		{"SFU_UDP_PORT": ""},
		{"SFU_UDP_PORT": "  "},
		{"SFU_LISTEN_HOST": "192.0.2.5", "SFU_PUBLIC_IP": "198.51.100.5"},
	} {
		if config := mustLoad(t, values); config.SFU != nil {
			t.Errorf("SFU = %+v without an enabled port", config.SFU)
		}
	}
	for _, port := range []int{1, 7882, maxPort} {
		config := mustLoad(t, env(productionBase, map[string]string{
			"SFU_UDP_PORT": strconv.Itoa(port),
		}))
		want := SFUConfig{ListenHost: "0.0.0.0", Port: port}
		if config.SFU == nil || *config.SFU != want {
			t.Errorf("SFU = %+v, want %+v", config.SFU, want)
		}
	}
}

func TestSFUOnlyRequiresAnEnabledListener(t *testing.T) {
	configuration := mustLoad(t, map[string]string{"SFU_UDP_PORT": "7882", "SFU_ONLY": "true"})
	if !configuration.SFU.Only {
		t.Fatal("SFU_ONLY was ignored")
	}
	for _, values := range []map[string]string{
		{"SFU_ONLY": "true"},
		{"SFU_ONLY": "yes", "SFU_UDP_PORT": "7882"},
	} {
		if _, err := Load(values); err == nil {
			t.Fatalf("accepted invalid SFU policy: %v", values)
		}
	}
}

func TestLoadAccepts(t *testing.T) {
	developmentPath, err := filepath.Abs(filepath.Join("state", "rooms.sqlite"))
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	productionPath, err := filepath.Abs(filepath.Join("production-state", "rooms.sqlite"))
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}

	cases := []struct {
		name  string
		env   map[string]string
		check func(*testing.T, Config)
	}{
		{"default viewer limit", map[string]string{}, func(t *testing.T, c Config) {
			if c.MaxViewersPerRoom != 20 {
				t.Errorf("MaxViewersPerRoom = %d", c.MaxViewersPerRoom)
			}
		}},
		{"viewer limit lower boundary", map[string]string{"MAX_VIEWERS_PER_ROOM": "1"},
			func(t *testing.T, c Config) {
				if c.MaxViewersPerRoom != 1 {
					t.Errorf("MaxViewersPerRoom = %d", c.MaxViewersPerRoom)
				}
			}},
		{"viewer limit ceiling",
			map[string]string{"MAX_VIEWERS_PER_ROOM": strconv.Itoa(protocol.MaxViewersPerRoomLimit)},
			func(t *testing.T, c Config) {
				if c.MaxViewersPerRoom != protocol.MaxViewersPerRoomLimit {
					t.Errorf("MaxViewersPerRoom = %d", c.MaxViewersPerRoom)
				}
			}},
		{"copy capacity 1", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "1"},
			func(t *testing.T, c Config) {
				if c.EndpointMediaCopyCapacity != 1 {
					t.Errorf("EndpointMediaCopyCapacity = %d", c.EndpointMediaCopyCapacity)
				}
			}},
		{"copy capacity 2", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "2"},
			func(t *testing.T, c Config) {
				if c.EndpointMediaCopyCapacity != 2 {
					t.Errorf("EndpointMediaCopyCapacity = %d", c.EndpointMediaCopyCapacity)
				}
			}},
		{"copy capacity 3", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "3"},
			func(t *testing.T, c Config) {
				if c.EndpointMediaCopyCapacity != 3 {
					t.Errorf("EndpointMediaCopyCapacity = %d", c.EndpointMediaCopyCapacity)
				}
			}},
		{"explicit loopback listen host", map[string]string{"LISTEN_HOST": " 127.0.0.1 "},
			func(t *testing.T, c Config) {
				if c.ListenHost != "127.0.0.1" {
					t.Errorf("ListenHost = %q", c.ListenHost)
				}
			}},
		{"production STUN", productionBase, func(t *testing.T, c Config) {
			if !slices.Equal(c.STUNURLs, []string{"stun:stun.test:3478"}) {
				t.Errorf("STUNURLs = %v", c.STUNURLs)
			}
			if !slices.Equal(c.STUNListenAddresses, []string{"0.0.0.0:3478"}) {
				t.Errorf("STUNListenAddresses = %v", c.STUNListenAddresses)
			}
		}},
		{"independent STUN bind host", env(productionBase, map[string]string{
			"LISTEN_HOST": "127.0.0.1", "STUN_LISTEN_HOST": " 192.0.2.5 ",
			"NAT_PREDICTION_ENABLED": "true",
		}), func(t *testing.T, c Config) {
			if !slices.Equal(c.STUNListenAddresses, []string{
				"192.0.2.5:3478", "192.0.2.5:3479", "192.0.2.5:3480",
			}) || !slices.Equal(c.STUNURLs, []string{"stun:stun.test:3478"}) {
				t.Fatalf("binding and advertisement were coupled: %+v", c)
			}
		}},
		{"production site access password",
			env(productionBase, map[string]string{"SITE_ACCESS_PASSWORD": "easy-key"}),
			func(t *testing.T, c Config) {
				if c.SiteAccessPassword != "easy-key" {
					t.Errorf("SiteAccessPassword = %q", c.SiteAccessPassword)
				}
			}},
		{"uppercase STUN scheme and IPv6 host", map[string]string{"STUN_URLS": "STUN:[2001:db8::1]:3478"},
			func(t *testing.T, c Config) {
				if !slices.Equal(c.STUNURLs, []string{"STUN:[2001:db8::1]:3478"}) {
					t.Errorf("STUNURLs = %v", c.STUNURLs)
				}
			}},
		{"ordinary STUN keeps an explicit non-default port", map[string]string{"STUN_URLS": "stun:stun.test:80"},
			func(t *testing.T, c Config) {
				if !slices.Equal(c.STUNURLs, []string{"stun:stun.test:80"}) || len(c.NATPredictionSTUNURLs) != 0 {
					t.Fatalf("unexpected ICE configuration: %+v", IceConfig(c))
				}
			}},
		{"NAT prediction with a base listener", map[string]string{
			"STUN_URLS":              "stun:share.test:3478",
			"NAT_PREDICTION_ENABLED": "true",
		}, func(t *testing.T, c Config) {
			if !c.NATPredictionEnabled {
				t.Error("NATPredictionEnabled = false")
			}
		}},
		{"file-backed room authority in development",
			map[string]string{"ROOM_DATABASE_PATH": " " + developmentPath + " "},
			func(t *testing.T, c Config) {
				if c.RoomDatabasePath != developmentPath {
					t.Errorf("RoomDatabasePath = %q", c.RoomDatabasePath)
				}
			}},
		{"file-backed room authority in production",
			env(productionBase, map[string]string{"ROOM_DATABASE_PATH": productionPath}),
			func(t *testing.T, c Config) {
				if c.RoomDatabasePath != productionPath {
					t.Errorf("RoomDatabasePath = %q", c.RoomDatabasePath)
				}
			}},
		{"allowed origins are normalised",
			map[string]string{"ALLOWED_ORIGINS": " https://Example.com:443/path , http://a.test:80 "},
			func(t *testing.T, c Config) {
				want := map[string]struct{}{"https://example.com": {}, "http://a.test": {}}
				if !reflect.DeepEqual(c.AllowedOrigins, want) {
					t.Errorf("AllowedOrigins = %v", c.AllowedOrigins)
				}
			}},
		// Number(string) coercion, which the TS parsers inherited.
		{"port with surrounding whitespace", map[string]string{"PORT": " 9123 "},
			func(t *testing.T, c Config) {
				if c.Port != 9123 {
					t.Errorf("Port = %d", c.Port)
				}
			}},
		{"hexadecimal port", map[string]string{"PORT": "0x1F5B"}, func(t *testing.T, c Config) {
			if c.Port != 8027 {
				t.Errorf("Port = %d", c.Port)
			}
		}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			testCase.check(t, mustLoad(t, testCase.env))
		})
	}
}

func TestLoadRejects(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"SFU port zero", map[string]string{"SFU_UDP_PORT": "0"},
			"SFU_UDP_PORT must be a positive integer"},
		{"SFU port negative", map[string]string{"SFU_UDP_PORT": "-1"},
			"SFU_UDP_PORT must be a positive integer"},
		{"SFU port fractional", map[string]string{"SFU_UDP_PORT": "7882.5"},
			"SFU_UDP_PORT must be a positive integer"},
		{"SFU port not a number", map[string]string{"SFU_UDP_PORT": "media"},
			"SFU_UDP_PORT must be a positive integer"},
		{"SFU port above UDP ceiling", map[string]string{"SFU_UDP_PORT": "65536"},
			"SFU_UDP_PORT must be between 1 and 65535"},
		{"SFU bind hostname", map[string]string{"SFU_UDP_PORT": "7882", "SFU_LISTEN_HOST": "sfu.test"},
			"SFU_LISTEN_HOST must be an IPv4 address"},
		{"SFU bind IPv6", map[string]string{"SFU_UDP_PORT": "7882", "SFU_LISTEN_HOST": "::1"},
			"SFU_LISTEN_HOST must be an IPv4 address"},
		{"SFU bind mapped IPv6", map[string]string{"SFU_UDP_PORT": "7882", "SFU_LISTEN_HOST": "::ffff:192.0.2.5"},
			"SFU_LISTEN_HOST must be an IPv4 address"},
		{"SFU public URL", map[string]string{"SFU_UDP_PORT": "7882", "SFU_PUBLIC_IP": "https://sfu.test"},
			"SFU_PUBLIC_IP must be an IPv4 address or DNS hostname"},
		{"SFU public port", map[string]string{"SFU_UDP_PORT": "7882", "SFU_PUBLIC_IP": "sfu.test:7882"},
			"SFU_PUBLIC_IP must be an IPv4 address or DNS hostname"},
		{"SFU public userinfo", map[string]string{"SFU_UDP_PORT": "7882", "SFU_PUBLIC_IP": "user@sfu.test"},
			"SFU_PUBLIC_IP must be an IPv4 address or DNS hostname"},
		{"SFU public path", map[string]string{"SFU_UDP_PORT": "7882", "SFU_PUBLIC_IP": "sfu.test/path"},
			"SFU_PUBLIC_IP must be an IPv4 address or DNS hostname"},
		{"SFU public IPv6", map[string]string{"SFU_UDP_PORT": "7882", "SFU_PUBLIC_IP": "2001:db8::5"},
			"SFU_PUBLIC_IP must be an IPv4 address or DNS hostname"},
		{"SFU public mapped IPv6", map[string]string{"SFU_UDP_PORT": "7882", "SFU_PUBLIC_IP": "::ffff:198.51.100.5"},
			"SFU_PUBLIC_IP must be an IPv4 address or DNS hostname"},

		// Bounded integers.
		{"viewer limit above ceiling",
			map[string]string{"MAX_VIEWERS_PER_ROOM": strconv.Itoa(protocol.MaxViewersPerRoomLimit + 1)},
			"MAX_VIEWERS_PER_ROOM must be between 1 and 20"},
		{"viewer limit zero", map[string]string{"MAX_VIEWERS_PER_ROOM": "0"},
			"MAX_VIEWERS_PER_ROOM must be a positive integer"},
		{"fractional viewer limit", map[string]string{"MAX_VIEWERS_PER_ROOM": "1.5"},
			"MAX_VIEWERS_PER_ROOM must be a positive integer"},
		{"copy capacity zero", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "0"},
			"ENDPOINT_MEDIA_COPY_CAPACITY must be a positive integer"},
		{"copy capacity above ceiling", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "4"},
			"ENDPOINT_MEDIA_COPY_CAPACITY must be between 1 and 3"},
		{"fractional copy capacity", map[string]string{"ENDPOINT_MEDIA_COPY_CAPACITY": "1.5"},
			"ENDPOINT_MEDIA_COPY_CAPACITY must be a positive integer"},
		{"port zero", map[string]string{"PORT": "0"}, "PORT must be a positive integer"},
		{"port not a number", map[string]string{"PORT": "eight"}, "PORT must be a positive integer"},
		{"port above the TCP ceiling", map[string]string{"PORT": "65536"}, "PORT must be at most 65535"},

		// Public base URL.
		{"public base URL credentials", map[string]string{"PUBLIC_BASE_URL": "https://user:pass@share.test"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL path", map[string]string{"PUBLIC_BASE_URL": "https://share.test/path"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL query", map[string]string{"PUBLIC_BASE_URL": "https://share.test?query=1"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL fragment", map[string]string{"PUBLIC_BASE_URL": "https://share.test#fragment"},
			"PUBLIC_BASE_URL must be an origin"},
		{"public base URL scheme", map[string]string{"PUBLIC_BASE_URL": "ftp://share.test"},
			"PUBLIC_BASE_URL must use http or https"},
		{"blank public base URL", map[string]string{"PUBLIC_BASE_URL": ""},
			"PUBLIC_BASE_URL must be a valid http or https origin"},
		{"plaintext public base URL in production", env(productionBase, map[string]string{
			"PUBLIC_BASE_URL": "http://share.test",
		}), "PUBLIC_BASE_URL must use https in production"},

		// Allowed origins.
		{"allowed origin scheme", map[string]string{"ALLOWED_ORIGINS": "ftp://share.test"},
			"Allowed origins must use http or https"},
		{"unparsable allowed origin", map[string]string{"ALLOWED_ORIGINS": "share.test"},
			"Allowed origins must be valid http or https URLs"},
		{"empty allowed origin entry", map[string]string{"ALLOWED_ORIGINS": "https://a.test,,https://b.test"},
			"ALLOWED_ORIGINS contains an empty URL"},

		// Production requirements.
		{"production without STUN", map[string]string{
			"PIIK_ENV": "production", "PUBLIC_BASE_URL": "https://share.test",
			"SITE_ACCESS_PASSWORD": "host-password-12",
		}, "STUN is required in production"},

		// STUN lists.
		{"STUN path", map[string]string{"STUN_URLS": "stun:stun.test/path"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN hostname is not a local bind address", map[string]string{
			"STUN_URLS": "stun:stun.test:3478", "STUN_LISTEN_HOST": "stun.test",
		}, "STUN_LISTEN_HOST must be an IPv4 address"},
		{"STUN IPv6 listener is unsupported", map[string]string{
			"STUN_URLS": "stun:stun.test:3478", "STUN_LISTEN_HOST": "::1",
		}, "STUN_LISTEN_HOST must be an IPv4 address"},
		{"STUN query", map[string]string{"STUN_URLS": "stun:stun.test?transport=udp"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN fragment", map[string]string{"STUN_URLS": "stun:stun.test#fragment"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN without authority", map[string]string{"STUN_URLS": "stun:"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN with an empty port", map[string]string{"STUN_URLS": "stun:stun.test:"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN port zero", map[string]string{"STUN_URLS": "stun:stun.test:0"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUN userinfo", map[string]string{"STUN_URLS": "stun:user@stun.test:3478"},
			"STUN_URLS contains an invalid STUN URL"},
		{"TURN scheme", map[string]string{"STUN_URLS": "turn:turn.test:3478"},
			"STUN_URLS contains an invalid STUN URL"},
		{"STUNS scheme", map[string]string{"STUN_URLS": "stuns:stun.test:5349"},
			"STUN_URLS contains an invalid STUN URL"},
		{"empty STUN entry", map[string]string{"STUN_URLS": "stun:a.test:3478,,stun:b.test:3478"},
			"STUN_URLS contains an empty URL"},
		{"too many STUN URLs", map[string]string{"STUN_URLS": stunList(9, "stun")},
			"STUN_URLS must contain at most 8 URLs"},
		{"no NAT prediction slots", map[string]string{
			"STUN_URLS": stunList(7, "ordinary"), "NAT_PREDICTION_ENABLED": "true",
		}, "STUN_URLS must contain at most 6 URLs when NAT_PREDICTION_ENABLED=true"},

		// NAT prediction.
		{"NAT prediction without STUN", map[string]string{"NAT_PREDICTION_ENABLED": "true"},
			"NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478"},
		{"NAT prediction cannot reinterpret explicit port 80", map[string]string{
			"STUN_URLS": "stun:share.test:80", "NAT_PREDICTION_ENABLED": "true",
		}, "NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478"},
		{"NAT prediction off the base port", map[string]string{
			"STUN_URLS": "stun:share.test:5349", "NAT_PREDICTION_ENABLED": "true",
		}, "NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478"},
		{"NAT prediction not a boolean", map[string]string{"NAT_PREDICTION_ENABLED": "sometimes"},
			"NAT_PREDICTION_ENABLED must be true or false"},

		// Room database path.
		{"room database path with a NUL", map[string]string{"ROOM_DATABASE_PATH": "rooms\x00.sqlite"},
			"ROOM_DATABASE_PATH must be an absolute file path"},
		{"bare room database file name", map[string]string{"ROOM_DATABASE_PATH": "rooms.sqlite"},
			"ROOM_DATABASE_PATH must be an absolute file path"},
		{"relative room database path", map[string]string{"ROOM_DATABASE_PATH": "./state/rooms.sqlite"},
			"ROOM_DATABASE_PATH must be an absolute file path"},

		// Runtime environment (DECISIONS D8).
		{"NODE_ENV is removed", map[string]string{"NODE_ENV": "production"},
			"NODE_ENV is no longer supported; use PIIK_ENV"},
		{"blank NODE_ENV is removed", map[string]string{"NODE_ENV": ""},
			"NODE_ENV is no longer supported; use PIIK_ENV"},
		{"test environment is gone", map[string]string{"PIIK_ENV": "test"},
			"PIIK_ENV must be development or production"},
		{"blank environment", map[string]string{"PIIK_ENV": ""},
			"PIIK_ENV must be development or production"},

		// Removed variables carrying their own replacement.
		{"removed relay downstream setting", map[string]string{"MAX_PEER_RELAY_DOWNSTREAM_EDGES": "2"},
			"MAX_PEER_RELAY_DOWNSTREAM_EDGES is no longer supported; use ENDPOINT_MEDIA_COPY_CAPACITY"},
		{"removed room rollout setting", map[string]string{"PEER_ASSISTED_ROOM_IDS": "1"},
			"PEER_ASSISTED_ROOM_IDS is no longer supported; peer-assisted media applies to every room"},
		{"removed peer-assisted toggle", map[string]string{"PEER_ASSISTED_MEDIA": "true"},
			"PEER_ASSISTED_MEDIA is no longer supported; peer-assisted media is always enabled"},
		{"removed room TTL", map[string]string{"ROOM_TTL_SECONDS": ""},
			"ROOM_TTL_SECONDS is no longer supported; use ROOM_EMPTY_TIMEOUT_SECONDS for empty-room retention"},
		{"removed room lease", map[string]string{"ROOM_LEASE_SECONDS": "86400"},
			"ROOM_LEASE_SECONDS is no longer supported; use ROOM_EMPTY_TIMEOUT_SECONDS for empty-room retention"},
		{"blank removed room lease", map[string]string{"ROOM_LEASE_SECONDS": ""},
			"ROOM_LEASE_SECONDS is no longer supported; use ROOM_EMPTY_TIMEOUT_SECONDS for empty-room retention"},
		{"removed access password", map[string]string{"ACCESS_PASSWORD": "legacy-password"},
			"ACCESS_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
		{"blank access password", map[string]string{"ACCESS_PASSWORD": ""},
			"ACCESS_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
		{"removed host admission password", map[string]string{"HOST_ADMISSION_PASSWORD": "legacy-password"},
			"HOST_ADMISSION_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
		{"blank host admission password", map[string]string{"HOST_ADMISSION_PASSWORD": ""},
			"HOST_ADMISSION_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Load(testCase.env)
			if err == nil {
				t.Fatalf("Load: want error containing %q", testCase.want)
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Errorf("Load: error %q, want it to contain %q", err, testCase.want)
			}
		})
	}
}

// TestLoadRejectsRemovedTurnVariables covers the ten TURN names that share the
// default reason, blank included.
func TestLoadRejectsRemovedTurnVariables(t *testing.T) {
	names := []string{
		"TURN_URLS", "TURN_SHARED_SECRET", "TURN_CREDENTIAL_TTL_SECONDS",
		"PEER_ICE_TURN_URLS", "PEER_ICE_TURN_SHARED_SECRET",
		"PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS", "SELECTED_EDGE_TURN_URLS",
		"SELECTED_EDGE_TURN_SHARED_SECRET", "SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS",
		"SELECTED_EDGE_TURN_ALLOCATION_CAPACITY",
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			_, err := Load(map[string]string{name: ""})
			want := name + " is no longer supported; ordinary ICE accepts STUN_URLS only"
			if err == nil || err.Error() != want {
				t.Errorf("Load: error %v, want %q", err, want)
			}
		})
	}
}

func TestOrigin(t *testing.T) {
	cases := []struct{ raw, scheme, alternative, want string }{
		{"https://Example.com:443/", "http", "https", "https://example.com"},
		{"http://Example.com:80", "http", "https", "http://example.com"},
		{"https://share.test:0443", "http", "https", "https://share.test"},
		{"http://localhost:9123", "http", "https", "http://localhost:9123"},
		{"https://[2001:DB8::1]:8443", "http", "https", "https://[2001:db8::1]:8443"},
		{"http://[::1]:7880", "http", "https", "http://[::1]:7880"},
		{"https://bücher.example:443", "http", "https", "https://xn--bcher-kva.example"},
		{"https://faß.de", "http", "https", "https://xn--fa-hia.de"},
		{"https://İ.example", "http", "https", "https://xn--i-9bb.example"},
		{"https://ẞ.example", "http", "https", "https://xn--zca.example"},
		{"https://example.ΟΣ", "http", "https", "https://example.xn--0xai"},
		{"https://EXAMPLE。com./", "http", "https", "https://example.com."},
		{"https://foo_bar.ab--cd.test", "http", "https", "https://foo_bar.ab--cd.test"},
		{"http://[0:0:0:0:0:0:0:1]:8787", "http", "https", "http://[::1]:8787"},
		{"http://[::ffff:192.0.2.1]:80", "http", "https", "http://[::ffff:c000:201]"},
	}
	for _, testCase := range cases {
		t.Run(testCase.raw, func(t *testing.T) {
			parsed, err := parseOriginURL(testCase.raw, "TEST", testCase.scheme, testCase.alternative)
			if err != nil {
				t.Fatalf("parseOriginURL: %v", err)
			}
			if got := Origin(parsed); got != testCase.want {
				t.Errorf("Origin = %q, want %q", got, testCase.want)
			}
			if got := parsed.String(); got != testCase.want+"/" {
				t.Errorf("String = %q, want %q", got, testCase.want+"/")
			}
		})
	}
}

func TestOriginConfigurationRejectsInvalidHostAndPort(t *testing.T) {
	for _, raw := range []string{
		"https://example.com:65536", "https://[fe80::1%25eth0]", "https://[not-an-ip]",
		"https://example／evil", "https://example：443", "https://example＠evil",
		"https://a％2eb", "https://＊.example", "https://\u00ad", "https://a\u200db.test",
	} {
		t.Run(raw, func(t *testing.T) {
			for _, key := range []string{"PUBLIC_BASE_URL", "ALLOWED_ORIGINS"} {
				if _, err := Load(map[string]string{key: raw}); err == nil {
					t.Errorf("%s accepted %q", key, raw)
				}
			}
			if _, err := publicHTTPSOrigin(raw); err == nil {
				t.Errorf("Local public origin accepted %q", raw)
			}
		})
	}
}
