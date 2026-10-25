package sio

import (
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
)

func TestConcurrentRoomMembershipAndDisconnect(t *testing.T) {
	for range 100 {
		s := NewServer(Options{})
		sess := &session{id: "test", srv: s, wake: make(chan struct{})}
		s.sessions[sess.id] = sess
		s.attachSocket(sess, "{}")
		sc := s.SocketByID(sess.id)
		var wg sync.WaitGroup
		for range 4 {
			wg.Go(func() {
				for range 100 {
					sc.Join("room")
					sc.Leave("room")
				}
			})
		}
		wg.Go(func() { s.closeSession(sess, "transport close") })
		wg.Wait()
		if len(sc.Rooms()) != 0 || len(s.RoomSockets("room")) != 0 || len(s.RoomSockets(sc.ID)) != 0 || len(s.allSockets()) != 0 {
			t.Fatal("disconnected socket left ghost room memberships")
		}
	}
}

func TestSocketDataSnapshotConcurrentAccess(t *testing.T) {
	sc := &Socket{Data: map[string]any{"userId": int64(1)}}
	var wg sync.WaitGroup
	wg.Go(func() {
		for range 500 {
			sc.SetData("pendingRoomId", "room")
			sc.DeleteData("pendingRoomId")
		}
	})
	wg.Go(func() {
		for range 500 {
			snapshot := sc.DataSnapshot()
			if snapshot["userId"] != int64(1) {
				t.Error("snapshot lost the identity")
			}
			snapshot["userId"] = int64(2)
		}
	})
	wg.Wait()
	if value, _ := sc.GetData("userId"); value != int64(1) {
		t.Error("snapshot mutated live data")
	}
}

func TestCloseDuringSocketAuthentication(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := NewServer(Options{})
		release := make(chan struct{})
		s.UseAuth(func(*Handshake) error { <-release; return nil })
		var connected atomic.Int32
		s.OnConnect(func(*Socket) { connected.Add(1) })
		sess := &session{id: "test", srv: s, wake: make(chan struct{})}
		s.sessions[sess.id] = sess
		go s.attachSocket(sess, "{}")
		synctest.Wait()
		s.closeSession(sess, "transport close")
		close(release)
		synctest.Wait()
		if connected.Load() != 0 || len(s.allSockets()) != 0 || len(s.RoomSockets(sess.id)) != 0 {
			t.Error("authentication resurrected an already closed session")
		}
	})
}

func TestConcurrentSocketAuthentication(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := NewServer(Options{})
		release := make(chan struct{})
		s.UseAuth(func(*Handshake) error { <-release; return nil })
		var connected atomic.Int32
		s.OnConnect(func(*Socket) { connected.Add(1) })
		sess := &session{id: "test", srv: s, wake: make(chan struct{})}
		s.sessions[sess.id] = sess
		for range 2 {
			go s.attachSocket(sess, "{}")
		}
		synctest.Wait()
		close(release)
		synctest.Wait()
		if connected.Load() != 1 || len(s.allSockets()) != 1 || len(s.RoomSockets(sess.id)) != 1 {
			t.Errorf("one Engine.IO session created %d Socket.IO connections", connected.Load())
		}
		s.closeSession(sess, "test cleanup")
	})
}
