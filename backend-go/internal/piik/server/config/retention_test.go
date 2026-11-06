package config

import "testing"

func TestRoomEmptyTimeoutConfiguration(t *testing.T) {
	for _, value := range []string{"", "0", "3600", "31536000"} {
		cfg, err := Load(map[string]string{"ROOM_EMPTY_TIMEOUT_SECONDS": value})
		if err != nil {
			t.Fatalf("value %q: %v", value, err)
		}
		if value == "3600" && cfg.RoomEmptyTimeoutSeconds != 3600 ||
			(value == "" || value == "0") && cfg.RoomEmptyTimeoutSeconds != 0 {
			t.Fatalf("value %q: timeout=%d", value, cfg.RoomEmptyTimeoutSeconds)
		}
	}
	for _, value := range []string{"-1", "1.5", "31536001", "NaN", "Infinity"} {
		if _, err := Load(map[string]string{"ROOM_EMPTY_TIMEOUT_SECONDS": value}); err == nil {
			t.Fatalf("accepted invalid timeout %q", value)
		}
	}
}
