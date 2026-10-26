package room

import (
	"context"
	"net/url"
	"testing"

	"zviewer/backend/internal/store"
)

func TestPortableMusicCover(t *testing.T) {
	image := "https://i0.hdslb.com/bfs/archive/fixture.jpg@640w_400h.webp?quality=80"
	for _, base := range []string{"http://localhost:3333", "https://localhost:3333/prefix", "http://127.0.0.1:47111/private-channel/prefix", "https://old.example.com/old"} {
		proxy := base + "/api/stream/proxy-image?url=" + url.QueryEscape(image)
		if got := portableMusicCover(proxy); got != image {
			t.Errorf("%s -> %s", base, got)
		}
		nested := "/api/stream/proxy-image?url=" + url.QueryEscape(proxy)
		if got := portableMusicCover(nested); got != image {
			t.Errorf("nested -> %s", got)
		}
	}
	for _, raw := range []string{"https://p4.music.126.net/fixture.jpg", "/local-cover.jpg", "data:image/png;base64,opaque", "/api/stream/proxy-image?url=invalid", "/api/stream/proxy-image?url=https%3A%2F%2Fother.example%2Fcover.jpg"} {
		if got := portableMusicCover(raw); got != raw {
			t.Errorf("unrelated changed: %s", got)
		}
	}
	if got := portableMusicCover("//i0.hdslb.com/bfs/fixture.jpg"); got != "https://i0.hdslb.com/bfs/fixture.jpg" {
		t.Fatal(got)
	}
}

func TestMusicQueuePayloadRepairsLegacyArtworkWithoutRewritingRows(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "COVER001", &owner, 10, false)
	image := "https://i0.hdslb.com/bfs/archive/fixture.jpg"
	old := "https://localhost:3333/api/stream/proxy-image?url=" + url.QueryEscape(image)
	sourceID := "BV17x411w7KC:123"
	_, err := env.svc.MusicQueue.Insert(ctx, &store.MusicQueueItem{RoomID: "COVER001", Source: "bili", SourceID: &sourceID, Name: "fixture", Artist: "fixture", Cover: &old, DurationMs: 10000, Order: 1})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := env.svc.musicQueuePayload(ctx, "COVER001")
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) != 1 || payload[0].Cover != image {
		t.Fatalf("cover did not survive wire conversion: %+v", payload)
	}
	if payload[0].BiliBvid == nil || *payload[0].BiliBvid != "BV17x411w7KC" || payload[0].BiliCid == nil || *payload[0].BiliCid != 123 {
		t.Fatal("playback identity changed")
	}
	rows, err := env.svc.MusicQueue.ListByRoom(ctx, "COVER001")
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Cover == nil || *rows[0].Cover != old {
		t.Fatal("read path rewrote legacy data")
	}
}
