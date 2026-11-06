package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"zviewer/backend/internal/piik/server/protocol"
)

const natPredictionBasePort = 3478

// natPredictionAuxiliaryPorts are the two listeners a NAT-prediction STUN
// deployment binds beside the base port; their answers reveal the peer's
// port-allocation stride.
var natPredictionAuxiliaryPorts = [...]int{natPredictionBasePort + 1, natPredictionBasePort + 2}

func stunListenAddresses(host string, prediction bool) ([]string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		host = "0.0.0.0"
	}
	address := net.ParseIP(host)
	if address == nil || address.To4() == nil || strings.ContainsRune(host, ':') {
		return nil, fmt.Errorf("STUN_LISTEN_HOST must be an IPv4 address")
	}
	listeners := []string{net.JoinHostPort(host, strconv.Itoa(natPredictionBasePort))}
	if prediction {
		for _, port := range natPredictionAuxiliaryPorts {
			listeners = append(listeners, net.JoinHostPort(host, strconv.Itoa(port)))
		}
	}
	return listeners, nil
}

// NATPredictionStunURLs returns the two auxiliary
// listeners derived from the first ordinary STUN authority on UDP 3478.
func NATPredictionStunURLs(stunURLs []string) []string {
	for _, stunURL := range stunURLs {
		authorityText := stunURL[strings.IndexByte(stunURL, ':')+1:]
		authority, err := url.Parse("http://" + authorityText)
		if err != nil || authority.Hostname() == "" {
			continue
		}
		port := authority.Port()
		if port != "" {
			number, err := strconv.Atoi(port)
			if err != nil || number != natPredictionBasePort {
				continue
			}
		}
		// WHATWG lowercases the host and keeps an IPv6 literal bracketed;
		// url.URL.Hostname strips the brackets, so put them back.
		hostname := strings.ToLower(authority.Hostname())
		if strings.Contains(hostname, ":") {
			hostname = "[" + hostname + "]"
		}
		derived := make([]string, 0, len(natPredictionAuxiliaryPorts))
		for _, auxiliaryPort := range natPredictionAuxiliaryPorts {
			derived = append(derived, fmt.Sprintf("stun:%s:%d", hostname, auxiliaryPort))
		}
		return derived
	}
	return nil
}

func IceConfig(c Config) protocol.IceConfig {
	// A configured empty list (Local without prediction) is kept as-is; only an
	// absent one is derived, so nil and empty differ here.
	prediction := c.NATPredictionSTUNURLs
	if prediction == nil {
		prediction = NATPredictionStunURLs(c.STUNURLs)
	}
	config := protocol.IceConfig{
		IceServers:            []protocol.IceServer{},
		NatPredictionStunURLs: []string{},
	}
	if len(c.STUNURLs) > 0 {
		config.IceServers = []protocol.IceServer{
			{URLs: protocol.IceServerURLList(append([]string{}, c.STUNURLs...)...)},
		}
	}
	if c.NATPredictionEnabled {
		config.NatPredictionStunURLs = append([]string{}, prediction...)
	}
	return config
}
