package nms

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestPublishingIdleWindowTracksMediaAndPublisherLease(t *testing.T) {
	hub := newStreamHub()
	now := time.Unix(1800000000, 0)
	hub.now = func() time.Time { return now }
	const key = "ABCD2345"
	first := hub.start(key)
	if !hub.isPublishing(key) || hub.isPublishing("OTHER234") {
		t.Fatal("new publisher should be online only for its own stream")
	}
	now = now.Add(hub.offlineGrace)
	if !hub.isPublishing(key) {
		t.Fatal("publisher should remain online through the initial idle window")
	}
	now = now.Add(time.Nanosecond)
	if hub.isPublishing(key) {
		t.Fatal("publisher without media should expire")
	}
	hub.setMetadata(key, map[string]any{"width": float64(1920)}, first)
	hub.audio(key, 0, nil, first)
	hub.video(key, 0, nil, first)
	if hub.isPublishing(key) {
		t.Fatal("metadata and empty packets must not refresh media liveness")
	}

	for _, media := range []struct {
		name    string
		send    func(string, uint32, []byte, ...*liveStream) bool
		payload []byte
	}{
		{"audio sequence", hub.audio, []byte{0xAF, 0x00, 0x12, 0x10}},
		{"audio frame", hub.audio, []byte{0xAF, 0x01, 0x21}},
		{"video sequence", hub.video, []byte{0x17, 0x00, 0x00}},
		{"video frame", hub.video, []byte{0x17, 0x01, 0x00}},
	} {
		t.Run(media.name, func(t *testing.T) {
			if !media.send(key, 0, media.payload, first) || !hub.isPublishing(key) {
				t.Fatal("media packet did not refresh the publisher")
			}
			now = now.Add(hub.offlineGrace + time.Nanosecond)
			if hub.isPublishing(key) {
				t.Fatal("media liveness should expire when packets stop")
			}
		})
	}

	hub.stop(key, first)
	if hub.isPublishing(key) {
		t.Fatal("stopped publisher should be offline")
	}
	next := hub.start(key)
	if next == nil || hub.start(key) != nil {
		t.Fatal("new publisher should own the stream exclusively")
	}
	now = now.Add(hub.offlineGrace + time.Nanosecond)
	if hub.audio(key, 0, []byte{0xAF, 0x01}, first) || hub.video(key, 0, []byte{0x17, 0x01}, first) {
		t.Fatal("old publisher must not update a replacement stream")
	}
	if hub.isPublishing(key) {
		t.Fatal("old publisher refreshed the replacement stream")
	}
	if !hub.video(key, 0, []byte{0x17, 0x01}, next) || !hub.isPublishing(key) {
		t.Fatal("current publisher could not refresh its stream")
	}
	hub.stop(key, first)
	if !hub.isPublishing(key) {
		t.Fatal("old publisher stopped the replacement stream")
	}
}

func TestIsPublishingRequiresReadyAuthorizedEmbeddedService(t *testing.T) {
	const key = "ABCD2345"
	tests := []struct {
		name   string
		change func(*Service)
		want   bool
	}{
		{"authorized embedded publisher", func(*Service) {}, true},
		{"disabled", func(s *Service) { s.cfg.Disabled = true }, false},
		{"external media server", func(s *Service) { s.cfg.Embedded = false }, false},
		{"not started", func(s *Service) { s.embedded = nil }, false},
		{"not ready", func(s *Service) { s.embedded.ready = false }, false},
		{"missing authorizer", func(s *Service) { s.SetAuthorizers(nil, nil) }, false},
		{"revoked authorization", func(s *Service) {
			s.SetAuthorizers(func(context.Context, string) bool { return false }, nil)
		}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			svc := New(Config{Embedded: true})
			svc.probe = func(context.Context) error {
				t.Fatal("publishing checks must not probe external media servers")
				return nil
			}
			svc.embedded = newEmbeddedServer(svc.Config(), nil)
			svc.embedded.ready = true
			svc.embedded.hub.start(key)
			svc.SetAuthorizers(func(_ context.Context, candidate string) bool { return candidate == key }, nil)
			test.change(svc)
			if got := svc.IsPublishing(key); got != test.want {
				t.Fatalf("IsPublishing = %v, want %v", got, test.want)
			}
			if svc.IsPublishing("") || svc.IsPublishing("OTHER234") {
				t.Fatal("unpublished stream must not be online")
			}
		})
	}
}

func TestIsPublishingEmbeddedRTMPLifecycle(t *testing.T) {
	const key = "ABCD2345"
	cfg := Config{
		Embedded:     true,
		BindHost:     "127.0.0.1",
		RtmpPort:     freePort(t),
		HTTPFLVBase:  fmt.Sprintf("http://127.0.0.1:%d", freePort(t)),
		OfflineGrace: time.Second,
	}
	svc := New(cfg)
	svc.SetLogger(t.Logf)
	svc.SetAuthorizers(func(_ context.Context, candidate string) bool { return candidate == key }, nil)
	if err := svc.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close(context.Background()) })
	if svc.IsPublishing(key) {
		t.Fatal("listening media service must not imply a published stream")
	}
	pub := dialPublisher(t, cfg.RtmpPort)
	pub.connect("live")
	pub.publish(key)
	if !svc.IsPublishing(key) || svc.IsPublishing("OTHER234") {
		t.Fatal("real RTMP publisher was not reported online for its own stream")
	}
	duplicate := dialPublisher(t, cfg.RtmpPort)
	duplicate.connect("live")
	duplicate.publish(key)
	_ = duplicate.conn.Close()
	if !svc.IsPublishing(key) {
		t.Fatal("rejected duplicate publisher removed the current publisher")
	}
	_ = pub.conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for len(svc.embedded.hub.streamKeys()) > 0 {
		if time.Now().After(deadline) {
			t.Fatal("RTMP disconnect did not remove the published stream")
		}
		time.Sleep(time.Millisecond)
	}
	if !svc.IsPublishing(key) {
		t.Fatal("recently stopped RTMP source must retain its online grace")
	}
	reconnected := dialPublisher(t, cfg.RtmpPort)
	reconnected.connect("live")
	reconnected.publish(key)
	if !svc.IsPublishing(key) {
		t.Fatal("reconnected RTMP publisher was not reported online")
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if svc.IsPublishing(key) {
		t.Fatal("closed media service must not report a publisher")
	}
}

func TestStoppedPublisherGraceDoesNotKeepMediaConnectionsOpen(t *testing.T) {
	hub := newStreamHub()
	hub.offlineGrace = 2 * time.Second
	now := time.Unix(1800000000, 0)
	hub.now = func() time.Time { return now }
	const key = "ABCD2345"
	if hub.isPublishing(key) {
		t.Fatal("a source that never published must be offline")
	}
	owner := hub.start(key)
	sub, _ := hub.subscribe(key, 0)
	now = now.Add(time.Second)
	hub.audio(key, 0, []byte{0xAF, 0x01}, owner)
	hub.stop(key, owner)
	if len(hub.streamKeys()) != 0 || !sub.closed {
		t.Fatal("online grace must not retain publishers or media subscriptions")
	}
	if !hub.isPublishing(key) {
		t.Fatal("recently stopped publisher must retain online grace")
	}
	now = now.Add(hub.offlineGrace)
	if !hub.isPublishing(key) {
		t.Fatal("grace should last through the configured threshold")
	}
	now = now.Add(time.Nanosecond)
	if hub.isPublishing(key) {
		t.Fatal("stopped publisher remained online beyond the configured threshold")
	}
	if len(hub.stopped) != 0 {
		t.Fatal("expired presence record should be discarded")
	}
}

func TestRestartDuringGraceCannotBeExtendedByOldPublisher(t *testing.T) {
	hub := newStreamHub()
	hub.offlineGrace = 2 * time.Second
	now := time.Unix(1800000000, 0)
	hub.now = func() time.Time { return now }
	const key = "ABCD2345"
	first := hub.start(key)
	hub.stop(key, first)
	now = now.Add(time.Second)
	next := hub.start(key)
	hub.stop(key, first)
	if !hub.isPublishing(key) || len(hub.streamKeys()) != 1 || len(hub.stopped) != 0 {
		t.Fatal("old publisher damaged the replacement during grace")
	}
	now = now.Add(hub.offlineGrace + time.Nanosecond)
	if hub.audio(key, 0, []byte{0xAF, 0x01}, first) || hub.video(key, 0, []byte{0x17, 0x01}, first) {
		t.Fatal("old publisher refreshed the replacement")
	}
	if hub.isPublishing(key) {
		t.Fatal("old publisher extended a stale replacement")
	}
	hub.stop(key, next)
	if hub.isPublishing(key) {
		t.Fatal("closing an already-stale publisher must not start a new grace")
	}
	hub.start("OTHERKEY")
	if len(hub.stopped) != 0 {
		t.Fatal("new publishers should discard expired presence records")
	}
}

func TestIsPublishingGraceStillRequiresCurrentAuthorization(t *testing.T) {
	const key = "ABCD2345"
	svc := New(Config{Embedded: true})
	svc.embedded = newEmbeddedServer(svc.Config(), nil)
	svc.embedded.ready = true
	svc.SetAuthorizers(func(context.Context, string) bool { return true }, nil)
	owner := svc.embedded.hub.start(key)
	svc.embedded.hub.stop(key, owner)
	if !svc.IsPublishing(key) {
		t.Fatal("stopped authorized source should retain online grace")
	}
	svc.SetAuthorizers(func(context.Context, string) bool { return false }, nil)
	if svc.IsPublishing(key) {
		t.Fatal("revoked authorization must cancel visible online grace immediately")
	}
	svc.SetAuthorizers(func(context.Context, string) bool { return true }, nil)
	svc.cfg.Disabled = true
	if svc.IsPublishing(key) {
		t.Fatal("disabled service must not preserve visible online grace")
	}
}

func TestTracksPublishingReportsCapabilityWithoutAnActiveSource(t *testing.T) {
	var absent *Service
	if absent.TracksPublishing() {
		t.Fatal("absent service must not claim tracking capability")
	}
	for _, tc := range []struct {
		name string
		cfg  Config
		want bool
	}{
		{"embedded before startup", Config{Embedded: true}, true},
		{"disabled embedded", Config{Embedded: true, Disabled: true}, false},
		{"external", Config{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := New(tc.cfg)
			if svc.TracksPublishing() != tc.want {
				t.Fatalf("tracking capability = %v, want %v", svc.TracksPublishing(), tc.want)
			}
		})
	}
}

func TestConfigOfflineGrace(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want time.Duration
	}{
		{"", time.Minute},
		{"2", 2 * time.Second},
		{"3600", time.Hour},
		{"0", time.Minute},
		{"-1", time.Minute},
		{"3601", time.Minute},
		{"1.5", time.Minute},
		{"invalid", time.Minute},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			t.Setenv("STREAM_PUSH_OFFLINE_GRACE_SECONDS", tc.raw)
			if got := ConfigFromEnv().OfflineGrace; got != tc.want {
				t.Fatalf("offline grace = %v, want %v", got, tc.want)
			}
		})
	}
	for _, invalid := range []time.Duration{0, -time.Second, 2 * time.Hour} {
		if got := Normalize(Config{OfflineGrace: invalid}).OfflineGrace; got != DefaultOfflineGrace {
			t.Fatalf("invalid grace %v normalized to %v", invalid, got)
		}
	}
}
