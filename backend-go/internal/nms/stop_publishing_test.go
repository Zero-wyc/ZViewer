package nms

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestStopPublishingKicksEmbeddedPublisher(t *testing.T) {
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

	pub := dialPublisher(t, cfg.RtmpPort)
	pub.connect("live")
	pub.publish(key)
	if !svc.IsPublishing(key) {
		t.Fatal("publisher should be online before the kick")
	}
	if !svc.StopPublishing(key) {
		t.Fatal("StopPublishing should report the kicked publisher")
	}
	// 连接被服务端关闭：客户端读到 EOF。给一点余量等 serve 的 defer unpublish。
	deadline := time.Now().Add(2 * time.Second)
	for len(svc.embedded.hub.streamKeys()) > 0 {
		if time.Now().After(deadline) {
			t.Fatal("kicked publisher left the stream registered")
		}
		time.Sleep(time.Millisecond)
	}
	_ = pub.conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := pub.conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("kicked publisher connection should be closed")
	}
	if svc.StopPublishing(key) {
		t.Fatal("second kick must report no publisher")
	}
	if svc.StopPublishing("") || svc.StopPublishing("OTHER234") {
		t.Fatal("unknown stream key must not report a publisher")
	}
}

func TestStopPublishingRejectsExternalMediaServer(t *testing.T) {
	svc := New(Config{Embedded: false})
	if svc.StopPublishing("ABCD2345") {
		t.Fatal("external media server connections are not ours to kick")
	}
	disabled := New(Config{Embedded: true, Disabled: true})
	disabled.embedded = newEmbeddedServer(disabled.Config(), nil)
	if disabled.StopPublishing("ABCD2345") {
		t.Fatal("disabled stream push must not kick anything")
	}
	if (*Service)(nil).StopPublishing("ABCD2345") {
		t.Fatal("nil service must not kick anything")
	}
}
