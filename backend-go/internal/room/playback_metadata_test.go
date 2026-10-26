package room

import (
	"context"
	"encoding/json"
	"testing"
)

func TestPlaybackOptionalPoliciesPersistAndClear(t *testing.T) {
	e := newTestEnv(t)
	owner := int64(1)
	e.insertRoom(t, "META0001", &owner, 10, false)
	ctx := context.Background()
	var state Playback
	wire := `{"sourceUrl":"https://example.org/a.mp4","sourceType":"bilibili","isPlaying":false,"currentTime":12,"duration":100,"playbackRate":1,"playsvideoEnabled":false,"hostCliEnabled":true,"epId":1001,"seasonId":2001,"seasonTitle":"fixture season","preview":false}`
	if err := json.Unmarshal([]byte(wire), &state); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Playback.SetPlayback(ctx, "META0001", state, "host", 0, nil); err != nil {
		t.Fatal(err)
	}
	check := func(memory *PlaybackMemory) {
		t.Helper()
		p, err := memory.Advanced(ctx, "META0001")
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(p)
		var actual map[string]any
		json.Unmarshal(raw, &actual)
		for key, want := range map[string]any{"playsvideoEnabled": false, "hostCliEnabled": true, "epId": float64(1001), "seasonId": float64(2001), "seasonTitle": "fixture season", "preview": false} {
			if actual[key] != want {
				t.Errorf("%s=%v want=%v", key, actual[key], want)
			}
		}
	}
	check(e.svc.Playback)
	if err := e.svc.Playback.ApplyHostHeartbeat(ctx, "META0001", HostHeartbeat{CurrentTime: 20, PlaybackRate: 1}, 0); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Playback.UpdateHostSocket(ctx, "META0001", nil); err != nil {
		t.Fatal(err)
	}
	check(e.svc.Playback)
	if err := e.svc.Playback.FlushToDB(ctx, "META0001"); err != nil {
		t.Fatal(err)
	}
	check(NewPlaybackMemory(e.db)) // independent cache simulates process restart
	next := Playback{SourceURL: "https://example.org/b.mp4", SourceType: "url", PlaybackRate: 1}
	if err := e.svc.Playback.SetPlayback(ctx, "META0001", next, "host", 0, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Playback.FlushToDB(ctx, "META0001"); err != nil {
		t.Fatal(err)
	}
	restored, err := NewPlaybackMemory(e.db).Raw(ctx, "META0001")
	if err != nil {
		t.Fatal(err)
	}
	if restored.PlaysvideoEnabled != nil || restored.HostCLIEnabled != nil || restored.EpID != nil || restored.Preview != nil {
		t.Fatal("new source inherited old metadata")
	}
}
