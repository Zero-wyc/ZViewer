package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strings"

	"zviewer/backend/internal/piik/server/protocol"
)

// LocalOptions describes App-selected Local composition. It never reads the
// process environment.
type LocalOptions struct {
	// Port 0 selects the default 8787.
	Port               int
	PublicAddress      string
	PublicOrigin       string
	AllowedAddresses   []string
	SiteAccessPassword string
	// Public-link discovery only. Pure LAN uses its selected address and port.
	STUNURLs              []string
	NATPredictionSTUNURLs []string
}

func Local(options LocalOptions) (Config, error) {
	port := options.Port
	if port == 0 {
		port = defaultPort
	}
	if port < 1 || port > maxPort {
		return Config{}, fmt.Errorf("Local server port must be an integer between 1 and %d", maxPort)
	}
	publicAddress := ""
	if options.PublicAddress != "" {
		parsed, err := localIPv4(options.PublicAddress, "public address")
		if err != nil {
			return Config{}, err
		}
		if parsed == "0.0.0.0" || strings.HasPrefix(parsed, "127.") {
			return Config{}, errors.New("Local server public address must be reachable from the LAN")
		}
		publicAddress = parsed
	} else if options.PublicOrigin == "" {
		return Config{}, errors.New("Local server public address must be reachable from the LAN")
	}
	allowedAddresses := make([]string, 0, 1+len(options.AllowedAddresses))
	if publicAddress != "" {
		allowedAddresses = append(allowedAddresses, publicAddress)
	}
	for _, address := range options.AllowedAddresses {
		normalized, err := localIPv4(address, "allowed address")
		if err != nil {
			return Config{}, err
		}
		if !slices.Contains(allowedAddresses, normalized) {
			allowedAddresses = append(allowedAddresses, normalized)
		}
	}

	// Copy non-nil lists so configured-empty prediction does not derive auxiliary URLs.
	stunURLs := append([]string{}, options.STUNURLs...)
	natPredictionSTUNURLs := append([]string{}, options.NATPredictionSTUNURLs...)
	var stunListeners []string
	if options.PublicOrigin == "" {
		// Routed LANs may not carry Browser mDNS. Discover the actual address
		// through the existing Binding-only service, without public STUN.
		endpoint := net.JoinHostPort(publicAddress, fmt.Sprint(port))
		stunURLs = []string{"stun:" + endpoint}
		stunListeners = []string{endpoint}
		natPredictionSTUNURLs = []string{}
	}
	if len(stunURLs)+len(natPredictionSTUNURLs) > protocol.MaxIceServerURLs ||
		!allValidStunURLs(stunURLs) ||
		!allValidStunURLs(natPredictionSTUNURLs) ||
		(len(natPredictionSTUNURLs) != 0 &&
			len(natPredictionSTUNURLs) != protocol.MaxNatPredictionAuxiliaryStunURLs) ||
		(len(natPredictionSTUNURLs) > 0 && len(stunURLs) == 0) {
		return Config{}, errors.New("Local STUN URLs are invalid")
	}

	// Loopback keeps the Host's stable HTTP origin. Local invitations use TLS;
	// the public tunnel still forwards the existing plain HTTP service.
	lanScheme := "https"
	if options.PublicOrigin != "" {
		lanScheme = "http"
	}
	origin := func(scheme, host string) string { return fmt.Sprintf("%s://%s:%d", scheme, host, port) }
	var publicBaseURL *url.URL
	if options.PublicOrigin != "" {
		parsed, err := publicHTTPSOrigin(options.PublicOrigin)
		if err != nil {
			return Config{}, err
		}
		publicBaseURL = parsed
	} else {
		publicBaseURL = &url.URL{Scheme: "https", Host: fmt.Sprintf("%s:%d", publicAddress, port), Path: "/"}
	}

	allowedOrigins := map[string]struct{}{
		origin("http", "localhost"): {},
		origin("http", "127.0.0.1"): {},
	}
	for _, address := range allowedAddresses {
		allowedOrigins[origin(lanScheme, address)] = struct{}{}
	}
	allowedOrigins[Origin(publicBaseURL)] = struct{}{}

	return Config{
		Env:                       EnvironmentProduction,
		Port:                      port,
		ListenHost:                "0.0.0.0",
		PublicBaseURL:             publicBaseURL,
		AllowedOrigins:            allowedOrigins,
		SiteAccessPassword:        options.SiteAccessPassword,
		MaxViewersPerRoom:         protocol.MaxViewersPerRoomLimit,
		EndpointMediaCopyCapacity: protocol.DefaultEndpointMediaCopyCapacity,
		STUNURLs:                  stunURLs,
		STUNListenAddresses:       stunListeners,
		NATPredictionEnabled:      len(natPredictionSTUNURLs) == protocol.MaxNatPredictionAuxiliaryStunURLs,
		NATPredictionSTUNURLs:     natPredictionSTUNURLs,
	}, nil
}

func allValidStunURLs(values []string) bool {
	for _, value := range values {
		if !protocol.ValidStunURLValue(value) {
			return false
		}
	}
	return true
}

// publicHTTPSOrigin uses one error message for all invalid origins.
func publicHTTPSOrigin(value string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" ||
		hasUserinfo(parsed) || (parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Local public origin must be an HTTPS origin")
	}
	host := normalizedHost(parsed)
	if host == "" {
		return nil, errors.New("Local public origin must be an HTTPS origin")
	}
	return &url.URL{Scheme: "https", Host: host, Path: "/"}, nil
}

// Node's isIP(value) === 4 accepts only a dotted
// quad, so an IPv4-mapped IPv6 literal such as "::ffff:192.168.1.10" — which
// net.ParseIP(...).To4() does resolve — is rejected here as well.
func localIPv4(value string, name string) (string, error) {
	address := strings.TrimFunc(value, protocol.IsJSWhitespace)
	parsed := net.ParseIP(address)
	if parsed == nil || parsed.To4() == nil || strings.ContainsRune(address, ':') {
		return "", fmt.Errorf("Local server %s must be an IPv4 address", name)
	}
	return address, nil
}
