package nms

import (
	"context"
	"testing"
	"time"
)

func TestPublisherLeaseRejectsDuplicatesAndStaleWrites(t *testing.T) {
	hub := newStreamHub()
	old := hub.start("fixture")
	if old == nil || hub.start("fixture") != nil {
		t.Fatal("duplicate publisher accepted")
	}
	hub.stop("fixture", old)
	next := hub.start("fixture")
	if next == nil {
		t.Fatal("reconnect rejected")
	}
	hub.stop("fixture", old)
	if hub.audio("fixture", 0, []byte{1}, old) || hub.video("fixture", 0, []byte{1}, old) {
		t.Fatal("stale publisher wrote to new stream")
	}
	hub.setMetadata("fixture", map[string]any{"stale": true}, old)
	if !hub.audio("fixture", 0, []byte{1}, next) || hub.streams["fixture"].meta != nil {
		t.Fatal("new stream damaged by old publisher")
	}
	hub.stop("fixture", next)
	if len(hub.streamKeys()) != 0 {
		t.Fatal("owner could not stop stream")
	}
}

func TestRTMPRejectsUnapprovedAndDuplicatePublishers(t *testing.T) {
	srv, port, _ := startTestServer(t)
	srv.publishAllowed = func(_ context.Context, key string) bool { return key == "AUTHORIZED" }
	a := dialPublisher(t, port)
	a.connect("live")
	a.publish("UNAUTHORIZED")
	time.Sleep(40 * time.Millisecond)
	if len(srv.hub.streamKeys()) != 0 {
		t.Fatal("arbitrary key started publishing")
	}
	a.publish("AUTHORIZED")
	time.Sleep(40 * time.Millisecond)
	b := dialPublisher(t, port)
	b.connect("live")
	b.publish("AUTHORIZED")
	time.Sleep(40 * time.Millisecond)
	b.conn.Close()
	time.Sleep(40 * time.Millisecond)
	if keys := srv.hub.streamKeys(); len(keys) != 1 || keys[0] != "AUTHORIZED" {
		t.Fatal("rejected publisher removed live stream", keys)
	}
	a.conn.Close()
}
