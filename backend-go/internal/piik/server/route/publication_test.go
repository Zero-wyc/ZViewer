package route

import "testing"

func TestRoomVideoRecoveryPreservesLogicalConnection(t *testing.T) {
	routes := voiceTree(t)
	routes.SetVideoPublication("share", false, 10)
	a := beginVideoAttach(t, routes, 11, A, "video-a")
	eq(t, routes.CandidateReady(a, 12, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
	// Optional downstream video attachment may remain pending while recovery
	// replaces the parent's video. Neither mutation replaces voice identity.
	before := edgeOf(t, routes, A)
	result := routes.AdoptDirectConnection(AdoptDirectConnectionInput{
		EdgeGuard:       edgeGuard(A, "host_session", routes.Revision(), before.ConnectionID),
		NewConnectionID: "recovered-video",
	}, 13)
	eq(t, result.Accepted, true)
	after := edgeOf(t, routes, A)
	eq(t, after.ConnectionID, before.ConnectionID)
	eq(t, after.VideoConnectionID, "recovered-video")
	eq(t, after.VideoGeneration, "share")
	eq(t, after.VideoReady, true)
	eq(t, after.ParentSessionID, before.ParentSessionID)
	eq(t, after.opportunityKey, before.opportunityKey)
	routes.SetVideoPublication("", false, 14)
	eq(t, routes.AdoptDirectConnection(AdoptDirectConnectionInput{
		EdgeGuard:       edgeGuard(A, "host_session", routes.Revision(), before.ConnectionID),
		NewConnectionID: "late-video",
	}, 15).Accepted, false)
	eq(t, edgeOf(t, routes, A).ConnectionID, before.ConnectionID)
}

func commitRoomPeer(t *testing.T, routes *Controller, at int64, connection string) CandidateGuard {
	t.Helper()
	must(t, routes.Reconcile(at).Operation)
	op := beginOperation(t, routes, BeginInput{NowMs: at, ConnectionID: connection, Reservation: direct()})
	guard := guardFor(op.ChildPeerID, op.Current.Revision, connection)
	eq(t, routes.CandidateReady(guard, at+1, nil, CandidateProof{}).Accepted, false)
	eq(t, routes.CandidateTransportConnected(guard, at+1).Accepted, true)
	eq(t, routes.CandidateReady(guard, at+2, nil, CandidateProof{}).Committed, true)
	return guard
}

func voiceTree(t *testing.T) *Controller {
	t.Helper()
	routes := newController(1, Options{})
	routes.SetVideoPublication("", false, 0)
	addViewer(routes, A, 1, ms(1))
	commitRoomPeer(t, routes, 2, "voice-a")
	addViewer(routes, B, 0, ms(5))
	commitRoomPeer(t, routes, 6, "voice-b")
	eq(t, edgeOf(t, routes, B).ParentPeerID, A)
	return routes
}

func beginVideoAttach(t *testing.T, routes *Controller, at int64, child, connection string) CandidateGuard {
	t.Helper()
	op := must(t, routes.Reconcile(at).Operation)
	eq(t, op.Reason, DemandPublicationAttach)
	eq(t, op.ChildPeerID, child)
	eq(t, op.AttachConnectionID, edgeOf(t, routes, child).ConnectionID)
	eq(t, op.Candidates[0].EndpointTransition.Kind, TransitionNone)
	begun := routes.BeginCurrentCandidate(BeginInput{
		Guard: cursorGuard(op), NowMs: at, ConnectionID: connection,
	})
	eq(t, begun.Accepted, true)
	eq(t, len(begun.Released), 0)
	return guardFor(child, begun.Operation.Current.Revision, connection)
}

func TestRoomVoiceTreeAttachesVideoSeriallyAndStopPreservesGraph(t *testing.T) {
	routes := voiceTree(t)
	before := routes.Snapshot()
	routes.SetVideoPublication("share-one", false, 10)
	a := beginVideoAttach(t, routes, 11, A, "video-a")
	eq(t, routes.CandidateReady(a, 12, nil, CandidateProof{VideoGeneration: "old-share"}).Accepted, false)
	eq(t, edgeOf(t, routes, A).VideoReady, false)
	// A connected transport alone does not complete video attachment.
	eq(t, routes.CandidateTransportConnected(a, 12).Accepted, true)
	eq(t, routes.Reconcile(13).Operation.ChildPeerID, A)
	eq(t, routes.CandidateReady(a, 14, nil, CandidateProof{VideoGeneration: "share-one"}).Committed, true)
	b := beginVideoAttach(t, routes, 15, B, "video-b")
	eq(t, routes.CandidateReady(b, 16, nil, CandidateProof{VideoGeneration: "share-one"}).Committed, true)
	noOperation(t, routes.Reconcile(17).Operation)
	for _, child := range []string{A, B} {
		edge := edgeOf(t, routes, child)
		previous, _ := before.UpstreamByViewer.Get(child)
		eq(t, edge.ConnectionID, previous.ConnectionID)
		eq(t, edge.ParentPeerID, previous.ParentPeerID)
		eq(t, edge.VideoGeneration, "share-one")
		eq(t, edge.VideoReady, true)
	}
	eq(t, len(routes.SetVideoPublication("", false, 18)), 0)
	for _, child := range []string{A, B} {
		edge := edgeOf(t, routes, child)
		eq(t, edge.Usable && edge.PhysicalActive, true)
		eq(t, edge.VideoGeneration, "")
		eq(t, edge.VideoConnectionID, "")
		eq(t, edge.VideoReady, false)
	}
	noOperation(t, routes.Reconcile(19).Operation)
	routes.SetVideoPublication("share-two", false, 20)
	a2 := beginVideoAttach(t, routes, 21, A, "video-a2")
	eq(t, routes.CandidateReady(a, 22, nil, CandidateProof{VideoGeneration: "share-one"}).Accepted, false)
	eq(t, routes.CandidateReady(a2, 22, nil, CandidateProof{VideoGeneration: "share-two"}).Committed, true)
}

func TestFailedPublicationAttachmentDoesNotRetryOrConsumeVoiceOpportunity(t *testing.T) {
	for _, failure := range []string{"failure", "timeout", "skip"} {
		t.Run(failure, func(t *testing.T) {
			routes := voiceTree(t)
			before := edgeOf(t, routes, A)
			routes.SetVideoPublication("share", false, 10)
			if failure == "skip" {
				op := must(t, routes.Reconcile(11).Operation)
				eq(t, routes.SkipCurrentCandidate(cursorGuard(op), 12, RejectionCandidateFailed).Accepted, true)
			} else {
				guard := beginVideoAttach(t, routes, 11, A, "video-a")
				if failure == "failure" {
					eq(t, routes.CandidateFailed(guard, 12).Accepted, true)
				} else {
					eq(t, routes.OperationExpired(routes.Operation().DeadlineAtMs).Accepted, true)
				}
			}
			edge := edgeOf(t, routes, A)
			eq(t, edge.ConnectionID, before.ConnectionID)
			eq(t, edge.Usable && edge.PhysicalActive, true)
			eq(t, edge.VideoGeneration, "share")
			eq(t, edge.VideoReady, false)
			eq(t, edge.VideoConnectionID, "")
			child, _ := routes.participants.Get(A)
			eq(t, child.availabilityExhausted, false)
			for _, at := range []int64{20_000, 40_000, 80_000} {
				noOperation(t, routes.Reconcile(at).Operation)
			}
			routes.SetVideoPublication("replacement", false, 80_001)
			beginVideoAttach(t, routes, 80_002, A, "replacement-a")
		})
	}
}

func TestStopCancelsAttachmentAndRejectsLateFrame(t *testing.T) {
	routes := voiceTree(t)
	routes.SetVideoPublication("share", false, 10)
	guard := beginVideoAttach(t, routes, 11, A, "video-a")
	eq(t, len(routes.SetVideoPublication("", false, 12)), 0)
	noOperation(t, routes.Operation())
	eq(t, routes.CandidateReady(guard, 13, nil, CandidateProof{VideoGeneration: "share"}).Accepted, false)
	eq(t, edgeOf(t, routes, A).ConnectionID, "voice-a")
	eq(t, edgeOf(t, routes, B).ConnectionID, "voice-b")
}

func TestCanceledPublicationPreparationReleasesNoRoomResources(t *testing.T) {
	for _, change := range []string{"stop", "replacement", "pause", "child-session", "parent-session"} {
		t.Run(change, func(t *testing.T) {
			routes := voiceTree(t)
			routes.SetVideoPublication("share", false, 10)
			op := must(t, routes.Reconcile(11).Operation)
			eq(t, op.Reason, DemandPublicationAttach)
			// The effect layer prepares this optional facet without a reservation,
			// then yields before handing the guarded result back to the controller.
			prepared := BeginInput{Guard: cursorGuard(op), NowMs: 13, ConnectionID: "late-video"}
			switch change {
			case "stop":
				routes.SetVideoPublication("", false, 12)
			case "replacement":
				routes.SetVideoPublication("replacement-share", false, 12)
			case "pause":
				routes.SetVideoPublication("share", true, 12)
			case "child-session":
				routes.UpsertParticipant(viewerInput(A, "replacement-child", 1), ms(12))
			case "parent-session":
				routes.UpsertParticipant(hostInput("replacement-parent", 1), ms(12))
			}
			result := routes.BeginCurrentCandidate(prepared)
			eq(t, result.Accepted, false)
			eq(t, len(result.Released), 0)
			eq(t, edgeOf(t, routes, A).ConnectionID, "voice-a")
			eq(t, edgeOf(t, routes, B).ConnectionID, "voice-b")
			eq(t, edgeOf(t, routes, A).Usable && edgeOf(t, routes, B).Usable, true)
		})
	}
}

func TestVoiceOptInRetainsAlreadyProvenVideo(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, ms(1))
	must(t, routes.Reconcile(1).Operation)
	commitCurrent(t, routes, 2, "existing-video")
	routes.SetVideoPublication("live-share", false, 4)
	edge := edgeOf(t, routes, A)
	eq(t, edge.VideoGeneration, "live-share")
	eq(t, edge.VideoConnectionID, "existing-video")
	eq(t, edge.VideoReady, true)
	noOperation(t, routes.Reconcile(5).Operation)
}

func TestPausedVideoStillAllowsRoomJoinAndResumeAttaches(t *testing.T) {
	routes := newController(1, Options{})
	routes.SetVideoPublication("", false, 0)
	routes.SetVideoPublication("share", true, 1)
	addViewer(routes, A, 0, ms(2))
	commitRoomPeer(t, routes, 3, "voice-a")
	eq(t, routes.Snapshot().Paused, false)
	eq(t, routes.Snapshot().VideoPaused, true)
	eq(t, edgeOf(t, routes, A).VideoReady, false)
	routes.SetPaused(false, ms(6))
	beginVideoAttach(t, routes, 7, A, "video-a")
}

func TestRoomSfuAttachmentKeepsItsAdmittedRoomResources(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true, SfuOnly: true})
	addViewer(routes, A, 0, ms(1))
	routes.hydrateHostPublication("room-ingress", res("ingress"), "ingress-pc")
	routes.hydrateEdge(A, sfuEdge("room-ingress", "voice-a", "subscription"))
	routes.SetVideoPublication("", false, 2)
	before := routes.Snapshot()
	routes.SetVideoPublication("share", false, 3)
	guard := beginVideoAttach(t, routes, 4, A, "video-a")
	eq(t, routes.CandidateReady(guard, 5, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
	eq(t, len(routes.SetVideoPublication("", false, 6)), 0)
	eq(t, routes.Publication().Resource, before.HostPublication.Resource)
	old, _ := before.UpstreamByViewer.Get(A)
	eq(t, edgeOf(t, routes, A).Resource, old.Resource)
	eq(t, edgeOf(t, routes, A).ConnectionID, old.ConnectionID)
}

func TestAttachedVideoQualityUsesPhysicalVideoIdentityAndNativeProof(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	routes.SetVideoPublication("", false, 0)
	addViewer(routes, A, 1, ms(1))
	commitRoomPeer(t, routes, 2, "voice-a")
	routes.SetVideoPublication("share", false, 5)
	guard := beginVideoAttach(t, routes, 6, A, "video-a")
	eq(t, routes.CandidateReady(guard, 7, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
	eq(t, observeSenderState(routes, senderState{
		childPeerID: A, connectionID: "voice-a", state: SenderQualityDegraded, acceptedAtMs: 8,
	}).Accepted, false)
	observePersistentDegraded(t, routes, A, "video-a", 10)
	op := must(t, routes.Reconcile(14).Operation)
	eq(t, op.Reason, DemandQualityConvergence)
	begun := beginOperation(t, routes, BeginInput{NowMs: 15, ConnectionID: "replacement", Reservation: direct()})
	candidate := guardFor(A, begun.Current.Revision, "replacement")
	eq(t, routes.CandidateReady(candidate, 16, nil, CandidateProof{
		RelativeQualityApproved: true, VideoGeneration: "share",
	}).Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		HOST, A, begun.Current.Revision, "replacement", "replacement-sender", SenderQualityHealthy, 17), nil).Committed, true)
	eq(t, edgeOf(t, routes, A).VideoConnectionID, "replacement")
	routes.SetVideoPublication("", false, 18)
	eq(t, observeSenderState(routes, senderState{
		childPeerID: A, connectionID: "replacement", state: SenderQualityHealthy, acceptedAtMs: 19,
	}).Accepted, false)
}

func TestFailedOptionalPictureReopensOnlyForNewEndpointSession(t *testing.T) {
	for _, endpoint := range []string{"child", "parent", "host"} {
		t.Run(endpoint, func(t *testing.T) {
			routes := voiceTree(t)
			routes.SetVideoPublication("share", false, 10)
			failedChild := B
			if endpoint == "host" {
				failedChild = A
			} else {
				a := beginVideoAttach(t, routes, 11, A, "video-a")
				eq(t, routes.CandidateReady(a, 12, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
			}
			failed := beginVideoAttach(t, routes, 13, failedChild, "failed-video")
			routes.CandidateFailed(failed, 14)
			before := routes.Snapshot()
			changedPeer := A
			if endpoint == "child" {
				changedPeer = B
			} else if endpoint == "host" {
				changedPeer = HOST
			}
			participant, _ := routes.participants.Get(changedPeer)
			input := viewerInput(changedPeer, participant.sessionID, 1)
			if endpoint == "host" {
				input = hostInput(participant.sessionID, 1)
			}
			routes.UpsertParticipant(input, ms(15))
			noOperation(t, routes.Reconcile(16).Operation)
			eq(t, edgeOf(t, routes, failedChild).VideoGeneration, "share")
			input.SessionID = "new_endpoint_session"
			routes.UpsertParticipant(input, ms(17))
			retry := beginVideoAttach(t, routes, 18, failedChild, "recovered-video")
			retry.ChildSessionID = edgeOf(t, routes, failedChild).ChildSessionID
			eq(t, routes.CandidateReady(retry, 19, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
			if endpoint == "host" {
				b := beginVideoAttach(t, routes, 20, B, "video-b")
				eq(t, routes.CandidateReady(b, 21, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
			} else {
				eq(t, edgeOf(t, routes, A).VideoConnectionID, "video-a")
			}
			for _, peerID := range []string{A, B} {
				previous, _ := before.UpstreamByViewer.Get(peerID)
				eq(t, edgeOf(t, routes, peerID).ConnectionID, previous.ConnectionID)
				eq(t, edgeOf(t, routes, peerID).Usable, true)
			}
			// Further endpoint sessions retain proven physical video without another attach.
			input.SessionID = "healthy_endpoint_session"
			routes.UpsertParticipant(input, ms(22))
			noOperation(t, routes.Reconcile(23).Operation)
			eq(t, edgeOf(t, routes, failedChild).VideoConnectionID, "recovered-video")
		})
	}
}

func TestHostSessionReopensFailedSfuPictureWithoutReplacingHealthyPicture(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true, SfuOnly: true})
	routes.SetVideoPublication("", false, 0)
	addViewer(routes, A, 0, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateHostPublication("publication", res("publication"), "publisher")
	routes.hydrateEdge(A, sfuEdge("publication", "voice-a", "subscription-a"))
	routes.hydrateEdge(B, sfuEdge("publication", "voice-b", "subscription-b"))
	routes.SetVideoPublication("share", false, 1)
	a := beginVideoAttach(t, routes, 2, A, "failed-a")
	routes.CandidateFailed(a, 3)
	b := beginVideoAttach(t, routes, 4, B, "healthy-b")
	eq(t, routes.CandidateReady(b, 5, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
	host, _ := routes.participants.Get(HOST)
	routes.UpsertParticipant(hostInput(host.sessionID, 1), ms(6))
	noOperation(t, routes.Reconcile(7).Operation)
	routes.UpsertParticipant(hostInput("replacement-host", 1), ms(8))
	a = beginVideoAttach(t, routes, 9, A, "recovered-a")
	eq(t, routes.CandidateReady(a, 10, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
	noOperation(t, routes.Reconcile(11).Operation)
	eq(t, edgeOf(t, routes, A).ConnectionID, "voice-a")
	eq(t, edgeOf(t, routes, B).VideoConnectionID, "healthy-b")
	eq(t, routes.Publication().HostSessionID, "replacement-host")
}
