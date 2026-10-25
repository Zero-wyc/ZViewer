package room

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	"zviewer/backend/internal/sio"
)

func TestBroadcastMovieListClearsDeletedPlayback(t *testing.T) {
	env := newTestEnv(t)
	env.insertRoom(t, "room", int64p(1), 10, false)
	s, ctx := env.svc, context.Background()
	s.SetCurrentMovie("room", int64(2))
	s.SetPlayback("room", &Playback{SourceURL: "https://example.invalid/deleted.mp4", IsPlaying: true})
	s.SetSubtitle("room", map[string]any{"text": "old subtitle"})
	if err := s.Playback.SetPlayback(ctx, "room", Playback{SourceURL: "https://example.invalid/deleted.mp4", SourceType: "url", IsPlaying: true, PlaybackRate: 1}, "host", 0, int64p(2)); err != nil {
		t.Fatal(err)
	}
	s.SetMovieLister(func(context.Context, string) (*MovieList, error) {
		return &MovieList{DTOs: []any{}, IDs: []int64{}}, nil
	})
	if err := s.BroadcastMovieList(ctx, "room"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Playback.Advanced(ctx, "room"); !errors.Is(err, ErrNoPlayback) {
		t.Errorf("deleted movie retained a heartbeat/reconnect baseline: %v", err)
	}
	if s.GetPlayback("room") != nil || s.Subtitle("room") != nil {
		t.Error("deleted movie retained runtime playback or subtitle state")
	}
}

func waitForBlockedPlaybackWrite(t *testing.T, conn *sql.DB, previous int64) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for conn.Stats().WaitCount <= previous {
		if time.Now().After(deadline) {
			t.Fatal("flush did not reach the reserved database connection")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPlaybackFlushPreservesConcurrentUpdate(t *testing.T) {
	env := newTestEnv(t)
	env.insertRoom(t, "flush-room", int64p(1), 10, false)
	m, ctx := env.svc.Playback, context.Background()
	state := Playback{SourceURL: "https://example.invalid/video.mp4", SourceType: "url", CurrentTime: 1, PlaybackRate: 1}
	if err := m.SetPlayback(ctx, "flush-room", state, "host", 0, nil); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	stamp := m.cache["flush-room"].state.UpdatedAt
	m.cache["flush-room"].dirty = true
	m.mu.Unlock()
	held, err := env.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	previous := env.db.Stats().WaitCount
	done := make(chan error, 1)
	go func() { done <- m.FlushToDB(ctx, "flush-room") }()
	waitForBlockedPlaybackWrite(t, env.db, previous)
	state.CurrentTime = 2
	if err := m.SetPlayback(ctx, "flush-room", state, "host", 0, nil); err != nil {
		t.Fatal(err)
	}
	// Distinct updates can share a millisecond; timestamps are not revisions.
	m.mu.Lock()
	m.cache["flush-room"].state.UpdatedAt = stamp
	m.mu.Unlock()
	held.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	dirty := m.cache["flush-room"].dirty
	m.mu.Unlock()
	if !dirty {
		t.Error("old flush marked a newer playback update as persisted")
	}
	if err := m.FlushToDB(ctx, "flush-room"); err != nil {
		t.Fatal(err)
	}
	var position float64
	if err := env.db.QueryRow(`SELECT "currentTime" FROM "playback_states" WHERE "roomId"='flush-room'`).Scan(&position); err != nil {
		t.Fatal(err)
	}
	if position != 2 {
		t.Errorf("persisted position = %v, want 2", position)
	}
}

func TestMusicFlushPreservesConcurrentUpdate(t *testing.T) {
	env := newTestEnv(t)
	env.insertRoom(t, "flush-room", int64p(1), 10, false)
	m, ctx := env.svc.Music, context.Background()
	state := MusicSyncState{PositionSec: 1, PlayMode: MusicPlaySequence}
	if err := m.SetPlayback(ctx, "flush-room", state, "host", 0); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	stamp := m.cache["flush-room"].state.UpdatedAt
	m.cache["flush-room"].dirty = true
	m.mu.Unlock()
	held, err := env.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	previous := env.db.Stats().WaitCount
	done := make(chan error, 1)
	go func() { done <- m.FlushToDB(ctx, "flush-room") }()
	waitForBlockedPlaybackWrite(t, env.db, previous)
	state.PositionSec = 2
	if err := m.SetPlayback(ctx, "flush-room", state, "host", 0); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.cache["flush-room"].state.UpdatedAt = stamp
	m.mu.Unlock()
	held.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	dirty := m.cache["flush-room"].dirty
	m.mu.Unlock()
	if !dirty {
		t.Error("old flush marked a newer music update as persisted")
	}
	if err := m.FlushToDB(ctx, "flush-room"); err != nil {
		t.Fatal(err)
	}
	var position float64
	if err := env.db.QueryRow(`SELECT "positionSec" FROM "music_playback_states" WHERE "roomId"='flush-room'`).Scan(&position); err != nil {
		t.Fatal(err)
	}
	if position != 2 {
		t.Errorf("persisted position = %v, want 2", position)
	}
}

func TestBroadcasterCleanupDoesNotDeadlock(t *testing.T) {
	memory := NewPlaybackMemory(nil)
	host := "host"
	memory.cache["room"] = &cachedPlayback{state: &Playback{HostSocketID: &host, UpdatedAt: nowMillis()}}
	hub := newFakeHub()
	hub.online[host] = true
	s := NewService(Deps{Playback: memory, Hub: hub})
	done := make(chan struct{})
	go func() { NewBroadcaster(s, nil).cleanupOnce(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cleanup deadlocked while checking the host socket through playback memory")
	}
	if !memory.HasCache("room") {
		t.Error("online room lost its playback cache")
	}
}

func TestMusicStaleDurationCannotOverrideNewTrack(t *testing.T) {
	m := NewMusicMemory(nil)
	key, duration := "ncm:2", 90.0
	c := &cachedMusic{state: MusicSyncState{TrackKey: &key}, durationKey: key, durationSec: &duration}
	// A duration request started before a track was selected completes afterwards.
	m.resolveDuration(context.Background(), "room", c, "")
	if c.durationKey != key || c.durationSec == nil || *c.durationSec != duration {
		t.Error("stale duration lookup replaced the newly selected track's duration")
	}
}

func TestMusicAdvancedStateConcurrentWrites(t *testing.T) {
	m := NewMusicMemory(nil)
	m.cache["room"] = &cachedMusic{lastDBWriteAt: nowMillis()}
	var wg sync.WaitGroup
	wg.Go(func() {
		for i := range 500 {
			if err := m.SetPlayback(context.Background(), "room", MusicSyncState{IsPlaying: true, PositionSec: float64(i)}, "host", 0); err != nil {
				t.Error(err)
			}
		}
	})
	wg.Go(func() {
		for range 500 {
			_, _ = m.GetAdvancedState(context.Background(), "room")
		}
	})
	wg.Wait()
}

func TestRuntimeStateConcurrentAccess(t *testing.T) {
	s := NewService(Deps{})
	var wg sync.WaitGroup
	for worker := range 8 {
		wg.Go(func() {
			for i := range 200 {
				if worker%2 == 0 {
					s.SetMovies("room", []any{i}, []int64{int64(i)})
					s.SetCurrentMovie("room", int64(i))
					s.SetPlayback("room", &Playback{CurrentTime: float64(i)})
					s.SetSubtitle("room", i)
				} else {
					_ = s.Movies("room")
					_ = s.MovieIDs("room")
					_ = s.CurrentMovieID("room")
					_ = s.GetPlayback("room")
					_ = s.Subtitle("room")
				}
			}
		})
	}
	wg.Wait()
}

func TestSocketIdentityConcurrentDataUpdates(t *testing.T) {
	sc := &sio.Socket{Data: map[string]any{"userId": int64(1), "role": "user", "username": "fixture", "guestId": "fixture-guest"}}
	var wg sync.WaitGroup
	wg.Go(func() {
		for range 500 {
			sc.SetData("pendingRoomId", "room")
			sc.DeleteData("pendingRoomId")
		}
	})
	wg.Go(func() {
		for range 500 {
			_ = socketUserID(sc)
			_ = socketRole(sc)
			_ = socketUsername(sc)
			_ = socketGuestID(sc)
		}
	})
	wg.Wait()
}

func TestRuntimeStateOwnsMovieSlices(t *testing.T) {
	s := NewService(Deps{})
	movies, ids := []any{"original"}, []int64{1}
	s.SetMovies("room", movies, ids)
	movies[0], ids[0] = "changed", 2
	if s.Movies("room")[0] != "original" || s.MovieIDs("room")[0] != 1 {
		t.Error("caller changed the stored movie list through input slices")
	}
	gotMovies, gotIDs := s.Movies("room"), s.MovieIDs("room")
	gotMovies[0], gotIDs[0] = "changed again", 3
	if s.Movies("room")[0] != "original" || s.MovieIDs("room")[0] != 1 {
		t.Error("caller changed the stored movie list through returned slices")
	}
}
