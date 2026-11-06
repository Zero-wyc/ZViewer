package signal

// Room authority prepares one candidate at a time; media signaling follows admission.

import (
	"log/slog"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

// preparedCandidate holds the allocations and signaling needed to begin an attempt.
type preparedCandidate struct {
	reservation             route.CandidateReservation
	connectionID            string
	publicationGeneration   string
	publicationConnectionID string
	hostSessionID           string
	hostSfuConfig           *protocol.SfuConfigMessage
	viewerSfuConfig         *protocol.SfuConfigMessage
	videoReady              *protocol.RouteReadyMessage
}

// prepareResult is one admitted candidate or a typed rejection.
type prepareResult struct {
	denied          bool
	rejectionBucket route.RejectionBucket
	prepared        preparedCandidate
}

func denied(bucket route.RejectionBucket) prepareResult {
	return prepareResult{denied: true, rejectionBucket: bucket}
}

// pumpCandidate keeps the admitted result across the pump driver's queued turn.
type pumpCandidate struct {
	operation *route.OperationSnapshot
	plan      route.CandidatePlan
	guard     route.CandidateCursorGuard
	revision  int64
	result    prepareResult
}

// requestPump starts the single-flight driver while the caller holds mu.
// Reconcile, candidate selection and admission reservations run synchronously
// so later calls in the handler see the result and rooms reserve SFU capacity
// in wake order. drivePump continues the remaining work in its goroutine.
//
// Set pumping before that synchronous prefix: re-entrant requests only set
// requested, which drivePump drains without starting an overlapping operation.
func (r *router) requestPump(roomID string) {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.controller == nil || r.closing {
		return
	}
	rm.requested = true
	if rm.pumping {
		return
	}
	rm.pumping = true
	rm.requested = false
	controller := rm.controller
	broadcastRevision := controller.Revision()
	var pending *pumpCandidate
	failed := r.recoverPump(func() {
		pending = r.pumpRoom(roomID, rm, controller, &broadcastRevision, nil, true)
	})
	r.inflight++
	go r.drivePump(roomID, rm, controller, broadcastRevision, pending, failed)
}

// recoverPump reports a failed pump segment, including controller assertion panics.
func (r *router) recoverPump(segment func()) (failed bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failed = true
			slog.Error("Media route reconciliation failed")
		}
	}()
	segment()
	return false
}

// drivePump is the asynchronous remainder of requestPump: the suspended
// first iteration, the `while (room.requested)` loop, the `finally` that
// frees the token and re-arms, and the `.catch` that tells the host.
func (r *router) drivePump(roomID string, rm *roomRuntime, controller *route.Controller, broadcastRevision int64, pending *pumpCandidate, failed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	defer func() { r.inflight-- }()
	if current, _ := r.rooms.Get(roomID); current != rm || rm.controller != controller {
		// Preparation yielded before this share retired. Its remainder owns only
		// the reservation, never the replacement room's waiters or deadline.
		rm.pumping = false
		if pending != nil && !pending.result.denied {
			r.releaseReservation(pending.result.prepared.reservation)
		}
		if current, _ := r.rooms.Get(roomID); current == rm && rm.controller != nil && rm.requested && !r.closing {
			r.requestPump(roomID)
		}
		return
	}
	if !failed {
		failed = r.recoverPump(func() {
			if pending != nil {
				r.pumpRoom(roomID, rm, controller, &broadcastRevision, pending, false)
			}
			for rm.requested && !r.closing {
				rm.requested = false
				if rm.controller == nil {
					continue
				}
				revision := rm.controller.Revision()
				r.pumpRoom(roomID, rm, rm.controller, &revision, nil, false)
			}
		})
	}
	rm.pumping = false
	if rm.requested && !r.closing {
		r.requestPump(roomID)
	}
	if failed {
		r.sendRoomError(roomID, "SERVER_ERROR", "Media routing failed")
	}
}

// pumpRoom keeps admission ordered while allowing the driver to yield before signaling.
func (r *router) pumpRoom(
	roomID string,
	rm *roomRuntime,
	controller *route.Controller,
	broadcastRevision *int64,
	resume *pumpCandidate,
	yieldAtPrepare bool,
) *pumpCandidate {
	broadcastRevisionChange := func() {
		revision := controller.Revision()
		if revision == *broadcastRevision {
			return
		}
		r.broadcastActive(roomID, rm)
		*broadcastRevision = revision
	}
	for {
		var candidate pumpCandidate
		if resume != nil {
			candidate, resume = *resume, nil
		} else {
			selected, done := r.selectCandidate(roomID, rm, controller, broadcastRevisionChange)
			if done {
				return nil
			}
			candidate = selected
			candidate.result = r.prepareCandidate(
				roomID, rm, controller, candidate.operation, candidate.plan, candidate.revision)
			if yieldAtPrepare {
				return &candidate
			}
		}
		operation, plan, guard := candidate.operation, candidate.plan, candidate.guard
		preparation := candidate.result
		if preparation.denied {
			r.debug(roomID, "candidate-preparation-denied",
				"child", r.debugPeer(roomID, operation.ChildPeerID),
				"route", r.debugTuple(roomID, plan.Tuple),
				"rejectionBucket", preparation.rejectionBucket,
				"cursor", operation.Cursor)
			if operation.Reason == route.DemandQualityConvergence ||
				operation.Reason == route.DemandRootConvergence {
				skipped := controller.SkipCurrentCandidate(guard, r.now(), preparation.rejectionBucket)
				r.releaseResources(skipped.Released)
				continue
			}
			if preparation.rejectionBucket != route.RejectionSfuAdmission {
				r.resourceWaiters.Delete(roomID)
			}
			if preparation.rejectionBucket == route.RejectionSfuAdmission {
				if !controller.NoteCurrentCandidateRejection(guard, route.RejectionSfuAdmission) {
					continue
				}
				r.resourceWaiters.Set(roomID, struct{}{})
				r.sendViewerRouteStatus(roomID, operation.DemandPeerID, protocol.RouteStatusMessage{
					Type:     "route-status",
					Revision: protocol.Int(operation.BaseRevision),
					State:    "waiting",
					Reason:   "sfu-admission",
				})
				r.scheduleDeadline(roomID, rm, operation)
				return nil
			}
			skipped := controller.SkipCurrentCandidate(guard, r.now(), preparation.rejectionBucket)
			r.releaseResources(skipped.Released)
			r.sendRouteFailures(roomID, skipped.FailedPeerIDs, controller.Revision())
			continue
		}
		prepared := preparation.prepared
		r.resourceWaiters.Delete(roomID)
		r.debug(roomID, "candidate-prepared",
			"child", r.debugPeer(roomID, operation.ChildPeerID),
			"route", r.debugTuple(roomID, plan.Tuple),
			"cursor", operation.Cursor)
		beginGuard := guard
		if plan.EndpointTransition.Kind == route.TransitionBoundedGap {
			gap := controller.RetireCurrentCandidateProducer(guard, r.now())
			r.releaseResources(gap.Released)
			r.sendRouteFailures(roomID, gap.FailedPeerIDs, controller.Revision())
			if !gap.Accepted {
				r.releaseReservation(prepared.reservation)
				continue
			}
			broadcastRevisionChange()
			currentOperation := controller.Operation()
			if currentOperation == nil || currentOperation.Cursor < 0 ||
				currentOperation.Cursor >= len(currentOperation.Candidates) {
				r.releaseReservation(prepared.reservation)
				continue
			}
			// The guard is re-derived: the retirement moved the revision.
			beginGuard = cursorGuard(currentOperation, currentOperation.Candidates[currentOperation.Cursor])
		}
		begun := controller.BeginCurrentCandidate(route.BeginInput{
			Guard:                   beginGuard,
			NowMs:                   r.now(),
			ConnectionID:            prepared.connectionID,
			Reservation:             prepared.reservation,
			PublicationGeneration:   prepared.publicationGeneration,
			PublicationConnectionID: prepared.publicationConnectionID,
			HostSessionID:           prepared.hostSessionID,
		})
		r.debug(roomID, "candidate-begin-settled",
			"child", r.debugPeer(roomID, operation.ChildPeerID),
			"route", r.debugTuple(roomID, plan.Tuple),
			"accepted", begun.Accepted,
			"exhausted", len(begun.FailedPeerIDs) > 0)
		// A rejected begin returns the reservation inside begun.Released; it
		// must not be released a second time.
		r.releaseResources(begun.Released)
		if !begun.Accepted || begun.Operation == nil || begun.Operation.Current == nil {
			r.sendRouteFailures(roomID, begun.FailedPeerIDs, controller.Revision())
			continue
		}
		rm.pendingMedia = &prepared
		r.sendPrepareMessages(roomID, controller, begun.Operation, prepared)
		r.debug(roomID, "candidate-prepare-sent",
			"child", r.debugPeer(roomID, operation.ChildPeerID),
			"route", r.debugTuple(roomID, plan.Tuple),
			"revision", begun.Operation.Current.Revision)
		r.scheduleDeadline(roomID, rm, begun.Operation)
		return nil
	}
}

// selectCandidate is pumpRoom steps 1-7 (map 7.2): reconcile, then either
// finish the iteration (done) or pick the cursor's plan and its guard.
func (r *router) selectCandidate(
	roomID string,
	rm *roomRuntime,
	controller *route.Controller,
	broadcastRevisionChange func(),
) (candidate pumpCandidate, done bool) {
	reconciled := controller.Reconcile(r.now())
	r.releaseResources(reconciled.Released)
	broadcastRevisionChange()
	r.sendRouteFailures(roomID, reconciled.FailedPeerIDs, controller.Revision())
	operation := reconciled.Operation
	if operation == nil {
		operation = controller.Operation()
	}
	if operation == nil {
		r.clearDeadline(rm)
		r.resourceWaiters.Delete(roomID)
		return pumpCandidate{}, true
	}
	if operation.Current != nil {
		r.resourceWaiters.Delete(roomID)
		r.scheduleDeadline(roomID, rm, operation)
		return pumpCandidate{}, true
	}
	if operation.Cursor < 0 || operation.Cursor >= len(operation.Candidates) {
		r.resourceWaiters.Delete(roomID)
		return pumpCandidate{}, true
	}
	plan := operation.Candidates[operation.Cursor]
	guard := cursorGuard(operation, plan)
	r.resourceWaiters.Delete(roomID)
	revision := operation.BaseRevision + 1
	if plan.EndpointTransition.Kind == route.TransitionBoundedGap {
		revision = operation.BaseRevision + 2
	}
	return pumpCandidate{operation: operation, plan: plan, guard: guard, revision: revision}, false
}

// prepareCandidate reserves the exact connection before any client can signal it.
func (r *router) prepareCandidate(
	roomID string,
	rm *roomRuntime,
	controller *route.Controller,
	operation *route.OperationSnapshot,
	plan route.CandidatePlan,
	revision int64,
) prepareResult {
	snapshot := controller.Snapshot()
	child, hasChild := r.store.GetConnectedViewer(roomID, operation.ChildPeerID)
	shareGeneration := r.hooks.shareGeneration(roomID)
	if rm.roomMedia {
		shareGeneration = rm.mediaGeneration
	}
	if !hasChild || child.SessionID != operation.ChildSessionID || shareGeneration == "" {
		return denied(route.RejectionStale)
	}
	connectionID := candidateConnectionIDPrefix + opaqueID()
	if operation.AttachConnectionID != "" {
		return prepareResult{prepared: preparedCandidate{connectionID: connectionID}}
	}
	var overlap *route.Resource
	if plan.EndpointTransition.Kind == route.TransitionOverlap {
		producerPeerID := ""
		if plan.EndpointTransition.ProducerPeerID != nil {
			producerPeerID = *plan.EndpointTransition.ProducerPeerID
		}
		overlap = overlapResource(producerPeerID)
	}
	if plan.Tuple.Kind == route.UpstreamPeer {
		return prepareResult{prepared: preparedCandidate{
			connectionID: connectionID,
			reservation:  route.CandidateReservation{Kind: route.ReservationDirect, Overlap: overlap},
		}}
	}

	fallback := r.sfu
	host, hasHost := r.store.GetConnectedHost(roomID)
	if fallback == nil || !hasHost || host.PeerID != rm.hostPeerID {
		return denied(route.RejectionStale)
	}
	if plan.Tuple.Publication == route.PublicationReuse {
		publication := snapshot.HostPublication
		if publication == nil || publication.Resource == nil ||
			publication.Resource.Kind != route.ResourceSfuPublication {
			return denied(route.RejectionStale)
		}
		fence := sfu.SubscriptionFence{
			ResourceFence: resourceFence(publication.Resource),
			ViewerPeerID:  operation.ChildPeerID,
			ConnectionID:  connectionID,
		}
		issue := func(edge *route.Resource) prepareResult {
			return prepareResult{prepared: preparedCandidate{
				connectionID: connectionID, hostSessionID: host.SessionID,
				reservation:           route.CandidateReservation{Kind: route.ReservationSfuReuse, Edge: edge, Overlap: overlap},
				publicationGeneration: publication.Generation,
				viewerSfuConfig: &protocol.SfuConfigMessage{
					Type: "sfu-config", Revision: protocol.Int(revision),
					PublicationGeneration: publication.Generation, ConnectionID: connectionID,
				},
			}}
		}
		if !fallback.admission.ReserveSubscription(fence) {
			return denied(route.RejectionSfuAdmission)
		}
		return issue(subscriptionResource(fence))
	}

	return r.prepareNewPublication(roomID, operation, revision, connectionID, shareGeneration, host, overlap)
}

// One candidate reserves both publication and first subscription atomically.
func (r *router) prepareNewPublication(
	roomID string,
	operation *route.OperationSnapshot,
	revision int64,
	connectionID string,
	shareGeneration string,
	host room.ConnectedPeer,
	overlap *route.Resource,
) prepareResult {
	fallback := r.sfu
	publicationGeneration := opaqueID()
	publicationFence := sfu.ResourceFence{
		RoomID:                roomID,
		ShareGeneration:       shareGeneration,
		PublicationGeneration: publicationGeneration,
	}
	subscriptionFence := sfu.SubscriptionFence{
		ResourceFence: publicationFence,
		ViewerPeerID:  operation.ChildPeerID,
		ConnectionID:  connectionID,
	}
	if !fallback.admission.ReservePublication(publicationFence) {
		return denied(route.RejectionSfuAdmission)
	}
	if !fallback.admission.ReserveSubscription(subscriptionFence) {
		fallback.admission.BeginDrain(publicationFence)
		r.scheduleSfuPublicationDrain(publicationFence)
		return denied(route.RejectionSfuAdmission)
	}
	subscription := subscriptionResource(subscriptionFence)
	publicationConnectionID := publicationGeneration
	publication := publicationResource(publicationFence)
	return prepareResult{prepared: preparedCandidate{
		connectionID: connectionID, hostSessionID: host.SessionID,
		publicationGeneration: publicationGeneration, publicationConnectionID: publicationConnectionID,
		reservation: route.CandidateReservation{
			Kind: route.ReservationSfuCreate, Edge: subscription, Publication: publication, Overlap: overlap,
		},
		hostSfuConfig: &protocol.SfuConfigMessage{
			Type: "sfu-config", Revision: protocol.Int(revision),
			PublicationGeneration: publicationGeneration, ConnectionID: publicationConnectionID,
		},
		viewerSfuConfig: &protocol.SfuConfigMessage{
			Type: "sfu-config", Revision: protocol.Int(revision),
			PublicationGeneration: publicationGeneration, ConnectionID: connectionID,
		},
	}}
}

// sendPrepareMessages preserves recipient order. It sends
// nothing at all when the child is stale or the peer parent vanished; the
// deadline timer then resolves the operation.
func (r *router) sendPrepareMessages(
	roomID string,
	controller *route.Controller,
	operation *route.OperationSnapshot,
	prepared preparedCandidate,
) {
	if rm, _ := r.rooms.Get(roomID); rm != nil && rm.roomMedia {
		if r.hooks.routesChanged != nil {
			r.hooks.routesChanged(roomID)
		}
		if operation.VideoGeneration == "" {
			return
		}
	}
	current := operation.Current
	candidate := preparedRouteCandidate(operation, current.Tuple, current.ConnectionID)
	tuple := current.Tuple
	assignments := r.assignments(roomID, controller.Snapshot(), &tuple, operation.ChildPeerID, prepared.publicationGeneration)
	child, hasChild := r.store.GetConnectedViewer(roomID, operation.ChildPeerID)
	if !hasChild || child.SessionID != operation.ChildSessionID {
		return
	}
	prepare := func(peerID string) protocol.RouteUpdatePrepareMessage {
		return protocol.RouteUpdatePrepareMessage{
			Type:       "route-update",
			Revision:   protocol.Int(current.Revision),
			Phase:      "prepare",
			Assignment: assignmentFor(assignments, peerID),
			Candidate:  candidate,
		}
	}
	childUpdate := prepare(operation.ChildPeerID)
	if current.Tuple.Kind == route.UpstreamPeer {
		parent, hasParent := r.connectedPeer(roomID, current.Tuple.ParentPeerID)
		if !hasParent {
			return
		}
		r.hooks.sendToSession(child.SessionID, childUpdate)
		r.hooks.sendToSession(parent.SessionID, prepare(parent.PeerID))
		return
	}
	host, hasHost := r.store.GetConnectedHost(roomID)
	if prepared.hostSfuConfig != nil && hasHost && host.SessionID == prepared.hostSessionID {
		r.hooks.sendToSession(host.SessionID, prepare(host.PeerID))
		r.hooks.sendToSession(host.SessionID, *prepared.hostSfuConfig)
	}
	r.hooks.sendToSession(child.SessionID, childUpdate)
	if operation.AttachConnectionID != "" {
		r.prepareSfuVideoAttachment(roomID, operation)
		return
	}
	if prepared.viewerSfuConfig != nil {
		r.hooks.sendToSession(child.SessionID, *prepared.viewerSfuConfig)
		if prepared.hostSfuConfig == nil {
			r.prepareSfuSubscriber(roomID, operation, prepared.publicationGeneration)
		}
	}
}

// scheduleDeadline fences callbacks by the room's deadline generation.
// clearDeadline invalidates even a callback that already won the timer Stop race.
func (r *router) scheduleDeadline(roomID string, rm *roomRuntime, operation *route.OperationSnapshot) {
	r.clearDeadline(rm)
	wakeInMs := max(int64(0), operation.WakeAtMs-r.now())
	if routeDebugEnabled() {
		var current any
		if operation.Current != nil {
			current = r.debugTuple(roomID, operation.Current.Tuple)
		}
		r.debug(roomID, "deadline-scheduled",
			"child", r.debugPeer(roomID, operation.ChildPeerID),
			"wakeInMs", wakeInMs,
			"cursor", operation.Cursor,
			"candidateCount", len(operation.Candidates),
			"current", current)
	}
	generation := rm.deadlineGeneration
	rm.deadlineStop = r.afterFunc(time.Duration(wakeInMs)*time.Millisecond, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if rm.deadlineGeneration != generation || rm.controller == nil || r.closing {
			return
		}
		rm.deadlineStop = nil
		before := rm.controller.Revision()
		expired := rm.controller.OperationExpired(r.now())
		r.debug(roomID, "deadline-fired",
			"child", r.debugPeer(roomID, operation.ChildPeerID),
			"accepted", expired.Accepted,
			"exhausted", len(expired.FailedPeerIDs) > 0)
		r.releaseResources(expired.Released)
		if rm.controller.Revision() != before {
			r.broadcastActive(roomID, rm)
		}
		r.sendRouteFailures(roomID, expired.FailedPeerIDs, rm.controller.Revision())
		r.requestPump(roomID)
	})
}

// clearDeadline bumps the generation to retire a
// callback that already lost the Stop race.
func (r *router) clearDeadline(rm *roomRuntime) {
	if rm.deadlineStop != nil {
		rm.deadlineStop()
	}
	rm.deadlineStop = nil
	rm.deadlineGeneration++
}

func cursorGuard(operation *route.OperationSnapshot, plan route.CandidatePlan) route.CandidateCursorGuard {
	return route.CandidateCursorGuard{
		ChildPeerID:    operation.ChildPeerID,
		ChildSessionID: operation.ChildSessionID,
		BaseRevision:   operation.BaseRevision,
		FactVersion:    operation.FactVersion,
		Cursor:         operation.Cursor,
		Plan:           plan,
	}
}

// preparedRouteCandidate includes connectionAttempt
// only when the current attempt carries one.
func preparedRouteCandidate(operation *route.OperationSnapshot, tuple route.CandidateTuple, connectionID string) protocol.PreparedRouteCandidate {
	transport := "sfu"
	if tuple.Kind == route.UpstreamPeer {
		transport = string(tuple.Transport)
	}
	candidate := protocol.PreparedRouteCandidate{
		ChildPeerID:  operation.ChildPeerID,
		ConnectionID: connectionID,
		Transport:    transport,
		QualityProbe: operation.Reason == route.DemandQualityConvergence,
	}
	if operation.Current != nil && operation.Current.ConnectionAttempt != nil {
		candidate.ConnectionAttempt = &protocol.ConnectionAttempt{
			Current: protocol.Int(operation.Current.ConnectionAttempt.Current),
			Total:   protocol.Int(operation.Current.ConnectionAttempt.Total),
		}
	}
	return candidate
}

func overlapResource(endpointPeerID string) *route.Resource {
	return &route.Resource{Kind: route.ResourceOverlap, EndpointPeerID: endpointPeerID}
}

func subscriptionResource(fence sfu.SubscriptionFence) *route.Resource {
	return &route.Resource{
		Kind:                  route.ResourceSfuSubscription,
		RoomID:                fence.RoomID,
		ShareGeneration:       fence.ShareGeneration,
		PublicationGeneration: fence.PublicationGeneration,
		ViewerPeerID:          fence.ViewerPeerID,
		ConnectionID:          fence.ConnectionID,
	}
}

func publicationResource(fence sfu.ResourceFence) *route.Resource {
	return &route.Resource{
		Kind:                  route.ResourceSfuPublication,
		RoomID:                fence.RoomID,
		ShareGeneration:       fence.ShareGeneration,
		PublicationGeneration: fence.PublicationGeneration,
	}
}

func resourceFence(resource *route.Resource) sfu.ResourceFence {
	return sfu.ResourceFence{
		RoomID:                resource.RoomID,
		ShareGeneration:       resource.ShareGeneration,
		PublicationGeneration: resource.PublicationGeneration,
	}
}

func subscriptionFence(resource *route.Resource) sfu.SubscriptionFence {
	return sfu.SubscriptionFence{ResourceFence: resourceFence(resource), ViewerPeerID: resource.ViewerPeerID, ConnectionID: resource.ConnectionID}
}
