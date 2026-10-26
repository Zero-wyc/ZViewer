package auth

import (
	"testing"
	"time"
)

func TestCapabilityPurposeExpiryAndTampering(t *testing.T) {
	m, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	token := m.SignCapability("poster", "mount:1:item:2", time.Hour)
	if value, err := m.VerifyCapability(token, "poster"); err != nil || value != "mount:1:item:2" {
		t.Fatal(value, err)
	}
	if _, err := m.VerifyCapability(token, "flv-watch"); err == nil {
		t.Fatal("cross-purpose capability accepted")
	}
	if _, err := m.VerifyAccess(token); err == nil {
		t.Fatal("resource capability authenticated as login")
	}
	if _, err := m.VerifyCapability("a"+token, "poster"); err == nil {
		t.Fatal("tampered capability accepted")
	}
	if _, err := m.VerifyCapability(m.SignCapability("poster", "x", -time.Second), "poster"); err != ErrTokenExpired {
		t.Fatal(err)
	}
}
