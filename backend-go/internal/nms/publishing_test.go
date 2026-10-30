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
	now = now.Add(publishingIdleTimeout)
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
			now = now.Add(publishingIdleTimeout + time.Nanosecond)
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
	now = now.Add(publishingIdleTimeout + time.Nanosecond)
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
		Embedded:    true,
		BindHost:    "127.0.0.1",
		RtmpPort:    freePort(t),
		HTTPFLVBase: fmt.Sprintf("http://127.0.0.1:%d", freePort(t)),
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
	for svc.IsPublishing(key) {
		if time.Now().After(deadline) {
			t.Fatal("RTMP disconnect did not remove the published stream")
		}
		time.Sleep(time.Millisecond)
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
