// Package config owns Hosted and App Local configuration and ICE discovery.
// Callers provide configuration inputs; loading opens no runtime resources.
package config

import (
	"crypto/tls"
	"errors"
	"fmt"
	"math"
	"net/netip"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"zviewer/backend/internal/piik/server/protocol"
)

// Environment selects development-only behavior. A stale unit file must fail
// closed rather than fall back to development.
type Environment string

// The two accepted PIIK_ENV values.
const (
	EnvironmentDevelopment Environment = "development"
	EnvironmentProduction  Environment = "production"
)

// Bounds and defaults for Hosted configuration.
const (
	defaultMaxViewersPerRoom = protocol.MaxViewersPerRoomLimit
	defaultPort              = 8787
	maxPort                  = 65_535
)

const removedTurnReason = "ordinary ICE accepts STUN_URLS only"

// removedEnvironmentVariables names settings with no current equivalent. An
// empty reason takes the TURN default.
// The order is the report order when several removed names are present.
var removedEnvironmentVariables = []struct{ name, reason string }{
	{"TURN_URLS", ""},
	{"TURN_SHARED_SECRET", ""},
	{"TURN_CREDENTIAL_TTL_SECONDS", ""},
	{"PEER_ICE_TURN_URLS", ""},
	{"PEER_ICE_TURN_SHARED_SECRET", ""},
	{"PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS", ""},
	{"SELECTED_EDGE_TURN_URLS", ""},
	{"SELECTED_EDGE_TURN_SHARED_SECRET", ""},
	{"SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS", ""},
	{"SELECTED_EDGE_TURN_ALLOCATION_CAPACITY", ""},
	{"PEER_ASSISTED_ROOM_IDS", "peer-assisted media applies to every room"},
	{"PEER_ASSISTED_MEDIA", "peer-assisted media is always enabled"},
	{"HOST_ADMISSION_PASSWORD", "use SITE_ACCESS_PASSWORD"},
	{"MAX_PEER_RELAY_DOWNSTREAM_EDGES", "use ENDPOINT_MEDIA_COPY_CAPACITY"},
	{"ROOM_TTL_SECONDS", "use ROOM_EMPTY_TIMEOUT_SECONDS for empty-room retention"},
	{"ROOM_LEASE_SECONDS", "use ROOM_EMPTY_TIMEOUT_SECONDS for empty-room retention"},
	{"ACCESS_PASSWORD", "use SITE_ACCESS_PASSWORD"},
	{"NODE_ENV", "use PIIK_ENV"},
}

// SFUConfig enables the embedded UDP media listener.
type SFUConfig struct {
	ListenHost string
	Port       int
	PublicIP   string
	Only       bool
}

// Config describes runtime configuration. Zero values mean open site
// access, process-memory rooms, and no SFU fallback.
type Config struct {
	Env           Environment
	Port          int
	ListenHost    string
	PublicBaseURL *url.URL
	// TLS is optional direct HTTPS. Reverse-proxy deployments leave it nil.
	TLS *tls.Config
	// AllowedOrigins is a membership test only; map order is not observable.
	AllowedOrigins            map[string]struct{}
	SiteAccessPassword        string
	RoomDatabasePath          string
	RoomEmptyTimeoutSeconds   int
	MaxViewersPerRoom         int
	EndpointMediaCopyCapacity int
	SFU                       *SFUConfig
	STUNURLs                  []string
	// STUNListenAddresses belongs to the application lifecycle. Pure LAN binds
	// its selected interface; public-link discovery URLs never create listeners.
	STUNListenAddresses  []string
	NATPredictionEnabled bool
	// NATPredictionSTUNURLs is nil when unset, which IceConfig distinguishes
	// from a configured empty list.
	NATPredictionSTUNURLs []string
}

// Load validates the whole process environment. Presence, not emptiness,
// distinguishes an explicit value from an unset value where that distinction
// is part of the contract.
func Load(env map[string]string) (Config, error) {
	for _, removed := range removedEnvironmentVariables {
		if _, present := env[removed.name]; present {
			reason := removed.reason
			if reason == "" {
				reason = removedTurnReason
			}
			return Config{}, fmt.Errorf("%s is no longer supported; %s", removed.name, reason)
		}
	}

	environment, err := parseEnvironment(env)
	if err != nil {
		return Config{}, err
	}
	port, err := parsePositiveInteger(env["PORT"], defaultPort, "PORT")
	if err != nil {
		return Config{}, err
	}
	if port > maxPort {
		return Config{}, fmt.Errorf("PORT must be at most %d", maxPort)
	}
	listenHost := strings.TrimFunc(env["LISTEN_HOST"], protocol.IsJSWhitespace)
	if listenHost == "" {
		listenHost = "0.0.0.0"
	}

	// Only an absent variable takes the default; an explicit empty value is
	// invalid below.
	rawPublicBaseURL, present := env["PUBLIC_BASE_URL"]
	if !present {
		rawPublicBaseURL = fmt.Sprintf("http://localhost:%d", port)
	}
	publicBaseURL, err := parseOriginURL(rawPublicBaseURL, "PUBLIC_BASE_URL", "http", "https")
	if err != nil {
		return Config{}, err
	}
	if environment == EnvironmentProduction && publicBaseURL.Scheme != "https" {
		return Config{}, errors.New("PUBLIC_BASE_URL must use https in production")
	}

	siteAccessPassword := env["SITE_ACCESS_PASSWORD"]
	roomDatabasePath, err := parseRoomDatabasePath(env["ROOM_DATABASE_PATH"])
	if err != nil {
		return Config{}, err
	}
	roomEmptyTimeout := 0
	if value := strings.TrimSpace(env["ROOM_EMPTY_TIMEOUT_SECONDS"]); value != "" {
		roomEmptyTimeout, err = strconv.Atoi(value)
		if err != nil || roomEmptyTimeout < 0 || roomEmptyTimeout > 31_536_000 {
			return Config{}, errors.New("ROOM_EMPTY_TIMEOUT_SECONDS must be an integer between 0 and 31536000")
		}
	}
	stunURLs, err := ParseSTUNURLs(env["STUN_URLS"], "STUN_URLS")
	if err != nil {
		return Config{}, err
	}
	natPredictionEnabled, err := parseBoolean(env["NAT_PREDICTION_ENABLED"], "NAT_PREDICTION_ENABLED")
	if err != nil {
		return Config{}, err
	}
	if natPredictionEnabled && len(NATPredictionStunURLs(stunURLs)) == 0 {
		return Config{}, errors.New("NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478")
	}
	if natPredictionEnabled &&
		len(stunURLs)+protocol.MaxNatPredictionAuxiliaryStunURLs > protocol.MaxIceServerURLs {
		return Config{}, fmt.Errorf(
			"STUN_URLS must contain at most %d URLs when NAT_PREDICTION_ENABLED=true",
			protocol.MaxIceServerURLs-protocol.MaxNatPredictionAuxiliaryStunURLs)
	}
	var stunListeners []string
	if len(stunURLs) > 0 {
		stunListeners, err = stunListenAddresses(env["STUN_LISTEN_HOST"], natPredictionEnabled)
		if err != nil {
			return Config{}, err
		}
	}
	maxViewersPerRoom, err := parseBoundedInteger(env["MAX_VIEWERS_PER_ROOM"],
		defaultMaxViewersPerRoom, "MAX_VIEWERS_PER_ROOM", 1, protocol.MaxViewersPerRoomLimit)
	if err != nil {
		return Config{}, err
	}
	endpointMediaCopyCapacity, err := parseBoundedInteger(env["ENDPOINT_MEDIA_COPY_CAPACITY"],
		protocol.DefaultEndpointMediaCopyCapacity, "ENDPOINT_MEDIA_COPY_CAPACITY",
		1, protocol.MaxEndpointMediaCopyCapacity)
	if err != nil {
		return Config{}, err
	}
	sfu, err := parseSFU(env)
	if err != nil {
		return Config{}, err
	}

	if environment == EnvironmentProduction && len(stunURLs) == 0 {
		return Config{}, errors.New("STUN is required in production")
	}

	allowedOrigins, err := parseOrigins(env["ALLOWED_ORIGINS"], Origin(publicBaseURL))
	if err != nil {
		return Config{}, err
	}
	transportTLS, err := loadTLS(env, publicBaseURL)
	if err != nil {
		return Config{}, err
	}

	return Config{
		Env:                       environment,
		Port:                      int(port),
		ListenHost:                listenHost,
		PublicBaseURL:             publicBaseURL,
		TLS:                       transportTLS,
		AllowedOrigins:            allowedOrigins,
		SiteAccessPassword:        siteAccessPassword,
		RoomDatabasePath:          roomDatabasePath,
		RoomEmptyTimeoutSeconds:   roomEmptyTimeout,
		MaxViewersPerRoom:         int(maxViewersPerRoom),
		EndpointMediaCopyCapacity: int(endpointMediaCopyCapacity),
		SFU:                       sfu,
		STUNURLs:                  stunURLs,
		STUNListenAddresses:       stunListeners,
		NATPredictionEnabled:      natPredictionEnabled,
	}, nil
}

func parseEnvironment(env map[string]string) (Environment, error) {
	value, present := env["PIIK_ENV"]
	if !present {
		return EnvironmentDevelopment, nil
	}
	switch Environment(value) {
	case EnvironmentDevelopment, EnvironmentProduction:
		return Environment(value), nil
	}
	return "", errors.New("PIIK_ENV must be development or production")
}

// parseBoolean defaults an absent value to false.
func parseBoolean(value string, name string) (bool, error) {
	switch value {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	}
	return false, fmt.Errorf("%s must be true or false", name)
}

// parsePositiveInteger preserves Number.isSafeInteger's bounds.
func parsePositiveInteger(value string, fallback int64, name string) (int64, error) {
	if value == "" {
		return fallback, nil
	}
	number, ok := jsNumber(value)
	if !ok || number != math.Trunc(number) || number <= 0 || number > protocol.MaxSafeInteger {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return int64(number), nil
}

func parseBoundedInteger(value string, fallback int64, name string, minimum, maximum int64) (int64, error) {
	parsed, err := parsePositiveInteger(value, fallback, name)
	if err != nil {
		return 0, err
	}
	if parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return parsed, nil
}

// Hosted defaults to durable room authority in its working directory. Explicit
// paths stay absolute so a deployment cannot relocate an existing database
// when its working directory changes. :memory: selects the in-memory RoomStore.
func parseRoomDatabasePath(value string) (string, error) {
	path := strings.TrimFunc(value, protocol.IsJSWhitespace)
	if path == "" {
		return filepath.Abs("rooms.sqlite")
	}
	if path == ":memory:" {
		return "", nil
	}
	if strings.ContainsRune(path, 0) || !filepath.IsAbs(path) {
		return "", errors.New("ROOM_DATABASE_PATH must be an absolute file path")
	}
	return path, nil
}

func parseSFU(env map[string]string) (*SFUConfig, error) {
	only, err := parseBoolean(env["SFU_ONLY"], "SFU_ONLY")
	if err != nil {
		return nil, err
	}
	rawPort := strings.TrimSpace(env["SFU_UDP_PORT"])
	if rawPort == "" {
		if only {
			return nil, errors.New("SFU_ONLY requires SFU_UDP_PORT")
		}
		return nil, nil
	}
	port, err := parseBoundedInteger(rawPort, 0, "SFU_UDP_PORT", 1, maxPort)
	if err != nil {
		return nil, err
	}
	listenHost := strings.TrimSpace(env["SFU_LISTEN_HOST"])
	if listenHost == "" {
		listenHost = "0.0.0.0"
	}
	if address, err := netip.ParseAddr(listenHost); err != nil || !address.Is4() {
		return nil, errors.New("SFU_LISTEN_HOST must be an IPv4 address")
	}
	publicIP := strings.TrimSpace(env["SFU_PUBLIC_IP"])
	if publicIP != "" {
		if address, err := netip.ParseAddr(publicIP); err == nil {
			if !address.Is4() {
				return nil, errors.New("SFU_PUBLIC_IP must be an IPv4 address or DNS hostname")
			}
			publicIP = address.String()
		} else {
			host, err := url.Parse("http://" + publicIP)
			if err == nil && host.Host == publicIP && !strings.Contains(publicIP, ":") {
				publicIP = normalizedHost(host)
			} else {
				publicIP = ""
			}
			if publicIP == "" {
				return nil, errors.New("SFU_PUBLIC_IP must be an IPv4 address or DNS hostname")
			}
		}
	}
	return &SFUConfig{
		ListenHost: listenHost,
		Port:       int(port),
		PublicIP:   publicIP,
		Only:       only,
	}, nil
}

func parseURLList(value string, name string) ([]string, error) {
	if strings.TrimFunc(value, protocol.IsJSWhitespace) == "" {
		return nil, nil
	}
	entries := strings.Split(value, ",")
	list := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimFunc(entry, protocol.IsJSWhitespace)
		if trimmed == "" {
			return nil, fmt.Errorf("%s contains an empty URL", name)
		}
		list = append(list, trimmed)
	}
	return list, nil
}

// ParseSTUNURLs validates a comma-separated discovery list for Server or App.
func ParseSTUNURLs(value string, name string) ([]string, error) {
	values, err := parseURLList(value, name)
	if err != nil {
		return nil, err
	}
	if len(values) > protocol.MaxIceServerURLs {
		return nil, fmt.Errorf("%s must contain at most %d URLs", name, protocol.MaxIceServerURLs)
	}
	for _, value := range values {
		if !protocol.ValidStunURLValue(value) {
			return nil, fmt.Errorf("%s contains an invalid STUN URL", name)
		}
	}
	return values, nil
}

func parseOrigins(value string, fallback string) (map[string]struct{}, error) {
	origins, err := parseURLList(value, "ALLOWED_ORIGINS")
	if err != nil {
		return nil, err
	}
	if len(origins) == 0 {
		origins = []string{fallback}
	}
	set := make(map[string]struct{}, len(origins))
	for _, entry := range origins {
		origin, err := toOrigin(entry)
		if err != nil {
			return nil, err
		}
		set[origin] = struct{}{}
	}
	return set, nil
}

// toOrigin validates one allowed HTTP(S) origin.
func toOrigin(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("Allowed origins must be valid http or https URLs")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("Allowed origins must use http or https")
	}
	origin := Origin(parsed)
	if origin == "" {
		return "", errors.New("Allowed origins must have a valid host and port")
	}
	return origin, nil
}

// parseOriginURL validates an origin and returns the WHATWG-normalised URL
// (lowercase host, default port removed, path "/").
func parseOriginURL(value, name, scheme, alternative string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	// net/url accepts relative references and opaque URLs that the WHATWG
	// parser rejects (or, for "wss:host", repairs); require both parts.
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%s must be a valid %s or %s origin", name, scheme, alternative)
	}
	if parsed.Scheme != scheme && parsed.Scheme != alternative {
		return nil, fmt.Errorf("%s must use %s or %s", name, scheme, alternative)
	}
	// WHATWG reports "/" for an empty path, while net/url leaves it "".
	if hasUserinfo(parsed) || (parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf(
			"%s must be an origin without credentials, path, query, or fragment", name)
	}
	host := normalizedHost(parsed)
	if host == "" {
		return nil, fmt.Errorf("%s must have a valid host and port", name)
	}
	return &url.URL{Scheme: parsed.Scheme, Host: host, Path: "/"}, nil
}

// hasUserinfo ports `url.username || url.password`: WHATWG reports empty
// strings for "https://@host" and "https://:@host", where net/url reports a
// non-nil (but empty) Userinfo.
func hasUserinfo(parsed *url.URL) bool {
	if parsed.User == nil {
		return false
	}
	password, _ := parsed.User.Password()
	return parsed.User.Username() != "" || password != ""
}

// Origin ports the WHATWG URL `origin` getter for the http/https/ws/wss schemes
// this package accepts: new URL("https://Example.com:443/").origin is
// "https://example.com". It is exported so app and cmd can compare request
// origins without a second copy of the rule. Invalid hosts/ports return empty.
func Origin(parsed *url.URL) string {
	host := normalizedHost(parsed)
	if host == "" {
		return ""
	}
	return parsed.Scheme + "://" + host
}

// Match browser domain-to-ASCII rules; default Lookup also rejects underscores
// and hyphen positions that web origins permit. See WHATWG URL host parsing.
var originIDNA = idna.New(idna.MapForLookup(), idna.StrictDomainName(false),
	idna.Transitional(false), idna.CheckHyphens(false), idna.BidiRule())

// normalizedHost owns configured host spelling for HTTP and local App trust.
// Request consumers still require the header to equal its canonical origin.
func normalizedHost(parsed *url.URL) string {
	host := parsed.Hostname()
	if strings.HasPrefix(parsed.Host, "[") {
		address, err := netip.ParseAddr(host)
		if err != nil || !address.Is6() || address.Zone() != "" {
			return ""
		}
		host = address.String()
		if address.Is4In6() {
			// Go prints a dotted tail; browsers serialize all IPv6 pieces as hex.
			bytes := address.As16()
			host = fmt.Sprintf("::ffff:%x:%x", uint16(bytes[12])<<8|uint16(bytes[13]),
				uint16(bytes[14])<<8|uint16(bytes[15]))
		}
		host = "[" + host + "]"
	} else {
		var err error
		// Use full IDNA casing: strings.ToLower loses the dot in İ; the
		// installed IDNA mapping table still maps capital ẞ to the domain ss.
		// Final sigma handling is disabled as required for IDNA, not prose.
		host = cases.Lower(language.Und, cases.HandleFinalSigma(false)).String(host)
		host, err = originIDNA.ToASCII(host)
		if err != nil || host == "" || strings.ContainsAny(host, "#/:<>?@[\\]^|%*") ||
			strings.IndexFunc(host, func(r rune) bool { return r <= 0x20 || r == 0x7f }) >= 0 {
			return ""
		}
	}
	// WHATWG parses the port as a number, so "0443" and "443" are both default.
	if parsed.Port() != "" {
		number, err := strconv.Atoi(parsed.Port())
		if err != nil || number < 0 || number > 65535 {
			return ""
		}
		if port := strconv.Itoa(number); port != defaultSchemePort(parsed.Scheme) {
			host += ":" + port
		}
	}
	return host
}

func defaultSchemePort(scheme string) string {
	switch scheme {
	case "http", "ws":
		return "80"
	case "https", "wss":
		return "443"
	}
	return ""
}

// decimalNumberPattern is the StrDecimalLiteral grammar Number(string) accepts.
var decimalNumberPattern = regexp.MustCompile(
	`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// jsNumber ports Number(string). The second result is false where JavaScript
// yields NaN; values JavaScript renders as Infinity are reported as NaN too,
// because every caller rejects them through Number.isSafeInteger anyway.
func jsNumber(value string) (float64, bool) {
	text := strings.TrimFunc(value, protocol.IsJSWhitespace)
	if text == "" {
		return 0, true // Number("") and Number(" ") are 0.
	}
	if len(text) > 2 && text[0] == '0' {
		if base := numericBase(text[1]); base != 0 {
			number, err := strconv.ParseUint(text[2:], base, 64)
			return float64(number), err == nil
		}
	}
	if !decimalNumberPattern.MatchString(text) {
		return 0, false
	}
	number, err := strconv.ParseFloat(text, 64)
	return number, err == nil
}

func numericBase(marker byte) int {
	switch marker {
	case 'x', 'X':
		return 16
	case 'o', 'O':
		return 8
	case 'b', 'B':
		return 2
	}
	return 0
}
