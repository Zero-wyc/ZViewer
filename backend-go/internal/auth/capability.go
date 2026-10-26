package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// Capabilities use a separate purpose and format from login JWTs. They cannot
// authenticate an API request and contain no upstream credentials.
func (m *Manager) SignCapability(purpose, resource string, ttl time.Duration) string {
	body, _ := json.Marshal(struct {
		Purpose  string `json:"p"`
		Resource string `json:"r"`
		Expires  int64  `json:"e"`
	}{purpose, resource, time.Now().Add(ttl).Unix()})
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, m.accessSecret)
	mac.Write([]byte("zviewer-capability-v1." + payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (m *Manager) VerifyCapability(token, purpose string) (string, error) {
	if len(token) > 16384 {
		return "", ErrTokenInvalid
	}
	payload, signature, ok := strings.Cut(token, ".")
	if !ok {
		return "", ErrTokenInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return "", ErrTokenInvalid
	}
	mac := hmac.New(sha256.New, m.accessSecret)
	mac.Write([]byte("zviewer-capability-v1." + payload))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return "", ErrTokenInvalid
	}
	body, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return "", ErrTokenInvalid
	}
	var claims struct {
		Purpose  string `json:"p"`
		Resource string `json:"r"`
		Expires  int64  `json:"e"`
	}
	if json.Unmarshal(body, &claims) != nil || claims.Purpose != purpose {
		return "", ErrTokenInvalid
	}
	if claims.Expires <= time.Now().Unix() {
		return "", ErrTokenExpired
	}
	return claims.Resource, nil
}
