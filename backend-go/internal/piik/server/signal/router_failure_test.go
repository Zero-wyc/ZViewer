package signal

import (
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

func TestCancelPreparedVideoAttachmentDoesNotFailRoom(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "cancel-video-attachment")
	h.locked(func() { h.doComplete(host); h.doComplete(viewer) })
	prepared := h.waitPrepared(viewer.sessionID)
	h.routeReady(viewer, int64(prepared.Revision))
	h.settle()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		rm.controller.SetVideoPublication("", false, h.router.now())
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		h.router.requestPump(created.RoomID)
		op := rm.controller.Operation()
		if op == nil || op.AttachConnectionID == "" || op.Current != nil {
			t.Fatal("expected admitted attachment waiting for the pump continuation")
		}
		// A stop can overtake the asynchronous BeginCurrentCandidate step.
		h.router.setVideoPublication(created.RoomID, "", false)
	})
	h.settle()
	for _, message := range h.messages(host.sessionID) {
		if failure, ok := message.(protocol.ErrorMessage); ok && failure.Code == "SERVER_ERROR" {
			t.Fatal("canceling a video attachment surfaced a media routing error")
		}
	}
}

func TestRoomVideoFailuresCannotInvalidateAnotherPhysicalFacet(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "room-video-replacement")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	prepared := h.waitPrepared(viewer.sessionID)
	h.locked(func() {
		h.doReady(viewer, int64(prepared.Revision))
		rm, _ := h.router.rooms.Get(created.RoomID)
		controller := rm.controller
		old, _ := controller.Snapshot().UpstreamByViewer.Get(viewer.peerID)
		rm.roomMedia = true
		controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		controller.SetVideoPublication("", false, h.router.now())
		controller.SetVideoPublication("room_video_replacement_123", false, h.router.now())
		op := controller.Reconcile(h.router.now()).Operation
		if op == nil || op.Reason != route.DemandPublicationAttach {
			t.Fatal("replacement did not prepare a video attachment")
		}
		begun := controller.BeginCurrentCandidate(route.BeginInput{Guard: cursorGuard(op, op.Candidates[op.Cursor]),
			NowMs: h.router.now(), ConnectionID: "replacement_video_connection_123"})
		if !begun.Accepted {
			t.Fatal("replacement attachment did not begin")
		}
		op = begun.Operation
		guard := route.CandidateGuard{ChildPeerID: viewer.peerID, ChildSessionID: viewer.sessionID,
			Revision: op.Current.Revision, ConnectionID: op.Current.ConnectionID}
		if !controller.CandidateReady(guard, h.router.now(), nil,
			route.CandidateProof{VideoGeneration: "room_video_replacement_123"}).Committed {
			t.Fatal("replacement attachment did not commit")
		}
		for _, participant := range []authenticatedRouteParticipant{host, viewer} {
			h.doFailed(participant, routeFailedMessage(int64(prepared.Revision), "active", old.ConnectionID))
			edge, ok := controller.Snapshot().UpstreamByViewer.Get(viewer.peerID)
			if !ok || !edge.Usable || !edge.VideoReady || edge.VideoConnectionID != guard.ConnectionID {
				t.Fatal("a retired video failure affected its replacement or room voice")
			}
		}
		h.doFailed(host, routeFailedMessage(controller.Revision(), "active", guard.ConnectionID))
		edge, _ := controller.Snapshot().UpstreamByViewer.Get(viewer.peerID)
		if edge.Usable {
			t.Fatal("the current parent video failure did not trigger normal route repair")
		}
	})
}

func TestRouterPreparesSfuForNewAndReauthenticatedViewers(t *testing.T) {
	for _, reauthenticate := range []bool{false, true} {
		name := "new-viewer"
		if reauthenticate {
			name = "lost-retained-media"
		}
		t.Run(name, func(t *testing.T) {
			h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true, fakeTimers: true})
			created := h.createRoom()
			_, first, sibling := h.establishSfuRoom(created)
			viewer := first
			if reauthenticate {
				viewer.sessionID = "replacement_viewer_session_12345678"
				h.locked(func() {
					connected, err := h.store.ConnectParticipant(room.ConnectParticipantInput{
						RoomID: created.RoomID, Role: protocol.RoleViewer,
						ViewerGrant: created.ViewerGrant,
						ClientID:    "viewer_client_sfu-root-" + created.RoomID + "_12345678",
						SessionID:   viewer.sessionID,
					})
					if err != nil || connected.PeerID != first.peerID {
						t.Fatalf("viewer replacement changed identity: %v", err)
					}
				})
			} else {
				viewer = h.connectViewer(created, "late-viewer")
			}
			var retained activeViewerMediaEdge
			h.locked(func() {
				if reauthenticate {
					retained = h.doMustEdge(created.RoomID, viewer.peerID)
				}
				state := h.doComplete(viewer)
				expected := protocol.NoUpstream()
				if reauthenticate {
					expected = protocol.SfuUpstream()
				}
				if state.routeAssignment.Upstream != expected {
					t.Fatalf("authentication upstream = %v, want %v", state.routeAssignment.Upstream, expected)
				}
			})
			if reauthenticate {
				h.settle()
				if sfuConfigCount(h.messages(viewer.sessionID)) != 1 {
					t.Fatal("healthy retained media must receive its current configuration")
				}
				for _, message := range h.messages(viewer.sessionID) {
					if _, ok := message.(protocol.RouteUpdatePrepareMessage); ok {
						t.Fatal("reauthentication alone must not replace healthy media")
					}
				}
				h.routeFailed(viewer, routeFailedMessage(retained.revision, "active", retained.connectionID))
			}
			prepared := h.waitPreparedTransport(viewer.sessionID, "sfu")
			if prepared.Candidate.ConnectionID == retained.connectionID {
				t.Fatal("replacement must allocate a new physical connection")
			}
			preparedSeen, configured := false, false
			for _, message := range h.messages(viewer.sessionID) {
				switch value := message.(type) {
				case protocol.RouteUpdatePrepareMessage:
					preparedSeen = value.Candidate.ConnectionID == prepared.Candidate.ConnectionID
				case protocol.SfuConfigMessage:
					if value.ConnectionID == prepared.Candidate.ConnectionID {
						if !preparedSeen {
							t.Fatal("new subscription configuration preceded its preparation")
						}
						configured = true
					}
				}
			}
			if !configured {
				t.Fatal("prepared subscription has no configuration")
			}
			h.routeReady(viewer, int64(prepared.Revision))
			h.locked(func() {
				if h.doMustEdge(created.RoomID, sibling.peerID).upstream != protocol.SfuUpstream() {
					t.Fatal("healthy sibling lost its SFU route")
				}
			})
			egress := 3
			if reauthenticate {
				egress = 2
			}
			h.waitUsage(sfu.Usage{Ingress: 1, Egress: egress})
		})
	}
}

func TestRouterFencesDelayedActiveFailureByPhysicalConnection(t *testing.T) {
	for _, transport := range []string{"peer", "sfu"} {
		for _, role := range []string{"host", "viewer"} {
			for _, report := range []string{"exact", "no-identity", "other-connection", "old-session", "future"} {
				t.Run(transport+"/"+role+"/"+report, func(t *testing.T) {
					h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: transport == "sfu", fakeTimers: true})
					created := h.createRoom()
					host := h.connectHost(created, nil, "", "")
					viewer := h.connectViewer(created, "delayed-failure")
					h.locked(func() { h.doComplete(host); h.doComplete(viewer) })
					prepared := h.waitPreparedTransport(viewer.sessionID, "direct")
					if transport == "sfu" {
						h.routeFailed(viewer, routeFailedMessage(int64(prepared.Revision), "prepare", prepared.Candidate.ConnectionID))
						prepared = h.waitPreparedTransport(viewer.sessionID, "sfu")
					}
					h.routeReady(viewer, int64(prepared.Revision))
					var message protocol.RouteFailedMessage
					h.locked(func() {
						edge := h.doMustEdge(created.RoomID, viewer.peerID)
						id := edge.connectionID
						if transport == "sfu" && role == "host" {
							rm, _ := h.router.rooms.Get(created.RoomID)
							id = rm.controller.Snapshot().HostPublication.ConnectionID
						}
						message = routeFailedMessage(edge.revision, "active", id)
					})

					other := h.connectViewer(created, "unrelated-join")
					h.complete(other)
					candidate := h.waitPreparedTransport(other.sessionID, "direct")
					h.routeReady(other, int64(candidate.Revision))
					h.locked(func() {
						rm, _ := h.router.rooms.Get(created.RoomID)
						before := rm.controller.Snapshot()
						if before.Revision <= int64(message.Revision) {
							t.Fatal("another Viewer must advance the room revision")
						}
						participant := viewer
						if role == "host" {
							participant = host
						}
						switch report {
						case "no-identity":
							message.ConnectionID = nil
						case "other-connection":
							id := "retired_connection_12345678"
							message.ConnectionID = &id
						case "old-session":
							participant.sessionID = "retired_session_12345678"
						case "future":
							message.Revision = protocol.Int(before.Revision + 1)
						}
						h.router.handleRouteFailed(participant, message)
						after := rm.controller.Snapshot()
						edge, ok := after.UpstreamByViewer.Get(viewer.peerID)
						usable := ok && edge.Usable
						if transport == "sfu" && role == "host" {
							usable = after.HostPublication != nil && after.HostPublication.Usable
						}
						if usable != (report != "exact") {
							t.Fatalf("active usable=%v after %s report", usable, report)
						}
						unaffected, ok := after.UpstreamByViewer.Get(other.peerID)
						if !ok || !unaffected.Usable {
							t.Fatal("unrelated direct Viewer must remain usable")
						}
					})
				})
			}
		}
	}
}

func TestRouterActiveFailureDuringPeerPreparationKeepsItsSubject(t *testing.T) {
	for _, role := range []string{"host", "viewer"} {
		t.Run(role, func(t *testing.T) {
			capacity := 2
			if role == "viewer" {
				capacity = 1
			}
			h := newRouterHarness(t, routerHarnessOptions{capacity: capacity, withSfu: true, fakeTimers: true})
			created := h.createRoom()
			host := h.connectHost(created, nil, "", "")
			viewer := h.connectViewer(created, "sfu-ingress")
			h.locked(func() { h.doComplete(host); h.doComplete(viewer) })
			direct := h.waitPreparedTransport(viewer.sessionID, "direct")
			h.routeFailed(viewer, routeFailedMessage(int64(direct.Revision), "prepare", direct.Candidate.ConnectionID))
			sfu := h.waitPreparedTransport(viewer.sessionID, "sfu")
			h.routeReady(viewer, int64(sfu.Revision))
			if role == "viewer" {
				h.locked(func() { h.doRelay(viewer, 1) })
			}
			child := h.connectViewer(created, "preparing-child")
			h.complete(child)
			candidate := h.waitPreparedTransport(child.sessionID, "direct")
			h.locked(func() {
				rm, _ := h.router.rooms.Get(created.RoomID)
				before := rm.controller.Snapshot()
				participant := host
				id := before.HostPublication.ConnectionID
				if role == "viewer" {
					participant = viewer
					edge, _ := before.UpstreamByViewer.Get(viewer.peerID)
					id = edge.ConnectionID
				}
				if before.Operation.Current.Tuple.ParentPeerID != participant.peerID {
					t.Fatal("preparation must belong to the reporting parent")
				}
				h.router.handleRouteFailed(participant, routeFailedMessage(before.Revision, "active", id))
				after := rm.controller.Snapshot()
				if role == "host" {
					if after.HostPublication != nil && after.HostPublication.Usable {
						t.Fatal("failed publication remains usable")
					}
					if after.Operation == nil || after.Operation.Current == nil || after.Operation.Current.ConnectionID != candidate.Candidate.ConnectionID {
						t.Fatal("independent direct candidate was retired")
					}
				} else if edge, ok := after.UpstreamByViewer.Get(viewer.peerID); ok && edge.Usable {
					t.Fatal("failed subscriber remains usable")
				}
			})
		})
	}
}
