package config

import (
	"crypto/x509"
	"encoding/pem"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zviewer/backend/internal/piik/tlsconfig"
)

func TestDirectTLSConfiguration(t *testing.T) {
	origin, _ := url.Parse("https://192.0.2.10:8787")
	generated, err := loadTLS(map[string]string{"TLS_SELF_SIGNED": "true"}, origin)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(generated.Certificates[0].Certificate[0])
	if err != nil || leaf.VerifyHostname(origin.Hostname()) != nil || leaf.IsCA {
		t.Fatal("self-signed TLS does not cover the configured origin")
	}
	directory := t.TempDir()
	certificateFile, keyFile := filepath.Join(directory, "cert.pem"), filepath.Join(directory, "key.pem")
	key, err := x509.MarshalPKCS8PrivateKey(generated.Certificates[0].PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certificateFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadTLS(map[string]string{"TLS_CERT_FILE": certificateFile, "TLS_KEY_FILE": keyFile}, origin)
	if err != nil || tlsconfig.Fingerprint(loaded) != tlsconfig.Fingerprint(generated) {
		t.Fatalf("configured certificate was not retained: %v", err)
	}
	for _, test := range []struct {
		name   string
		env    map[string]string
		origin string
		want   string
	}{
		{"plaintext origin", map[string]string{"TLS_SELF_SIGNED": "true"}, "http://192.0.2.10:8787", "requires PUBLIC_BASE_URL"},
		{"mixed sources", map[string]string{"TLS_SELF_SIGNED": "true", "TLS_CERT_FILE": certificateFile}, origin.String(), "choose TLS_SELF_SIGNED"},
		{"missing key", map[string]string{"TLS_CERT_FILE": certificateFile}, origin.String(), "configured together"},
		{"unreadable pair", map[string]string{"TLS_CERT_FILE": certificateFile, "TLS_KEY_FILE": filepath.Join(directory, "missing.key")}, origin.String(), "could not load"},
		{"wrong host", map[string]string{"TLS_CERT_FILE": certificateFile, "TLS_KEY_FILE": keyFile}, "https://other.example", "does not cover PUBLIC_BASE_URL"},
	} {
		t.Run(test.name, func(t *testing.T) {
			origin, _ := url.Parse(test.origin)
			if _, err := loadTLS(test.env, origin); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("TLS configuration error = %v, want %q", err, test.want)
			}
		})
	}
}
