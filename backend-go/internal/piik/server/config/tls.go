package config

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"zviewer/backend/internal/piik/tlsconfig"
)

func loadTLS(env map[string]string, origin *url.URL) (*tls.Config, error) {
	selfSigned, err := parseBoolean(env["TLS_SELF_SIGNED"], "TLS_SELF_SIGNED")
	if err != nil {
		return nil, err
	}
	certificateFile, keyFile := strings.TrimSpace(env["TLS_CERT_FILE"]), strings.TrimSpace(env["TLS_KEY_FILE"])
	if certificateFile == "" && keyFile == "" && !selfSigned {
		return nil, nil
	}
	if origin.Scheme != "https" {
		return nil, errors.New("direct TLS requires PUBLIC_BASE_URL to use https")
	}
	if selfSigned {
		if certificateFile != "" || keyFile != "" {
			return nil, errors.New("choose TLS_SELF_SIGNED or TLS_CERT_FILE with TLS_KEY_FILE")
		}
		return tlsconfig.SelfSigned(origin.Hostname())
	}
	if certificateFile == "" || keyFile == "" {
		return nil, errors.New("TLS_CERT_FILE and TLS_KEY_FILE must be configured together")
	}
	certificate, err := tls.LoadX509KeyPair(certificateFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("could not load TLS_CERT_FILE and TLS_KEY_FILE: %w", err)
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return nil, err
	}
	if err := leaf.VerifyHostname(origin.Hostname()); err != nil {
		return nil, fmt.Errorf("TLS_CERT_FILE does not cover PUBLIC_BASE_URL: %w", err)
	}
	if now := time.Now(); now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		return nil, errors.New("TLS_CERT_FILE is expired or not yet valid")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}, nil
}
