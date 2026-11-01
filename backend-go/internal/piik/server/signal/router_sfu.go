package signal

import (
	"context"
	"errors"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

type drainKind string

const (
	drainPublication      drainKind = "publication"
	drainSubscription     drainKind = "subscription"
	drainVideoPublication drainKind = "video-publication"
	drainVoice            drainKind = "voice"
)

// sfuDrainTask owns one asynchronous exact physical close.
type sfuDrainTask struct {
	kind          drainKind
	fence         sfu.SubscriptionFence
	operation     *drainOperation
	closePhysical func() error
}

// drainOperation is the promise runSfuDrain tracked: done is closed after err
// is set, with mu held, so a waiter that relocks sees the settled task.
type drainOperation struct {
	done chan struct{}
	err  error
}

// commitReservation drains generations in admission order.
func (r *router) commitReservation(reservation route.CandidateReservation) bool {
	if reservation.Kind == route.ReservationDirect {
		return true
	}
	if reservation.Kind == route.ReservationSfuReuse {
		return reservation.Edge != nil &&
			reservation.Edge.Kind == route.ResourceSfuSubscription &&
			r.sfu != nil &&
			r.sfu.admission.CommitSubscription(subscriptionFence(reservation.Edge))
	}
	if reservation.Publication == nil || reservation.Publication.Kind != route.ResourceSfuPublication {
		return false
	}
	if r.sfu == nil {
		return false
	}
	draining, ok := r.sfu.admission.CommitPublication(resourceFence(reservation.Publication))
	if !ok {
		return false
	}
	for _, fence := range draining {
		r.scheduleSfuPublicationDrain(fence)
	}
	return true
}

func (r *router) releaseReservation(reservation route.CandidateReservation) {
	r.releaseResources(reservationResources(reservation))
}

// releaseResources retires publications before their exact subscriptions.
func (r *router) releaseResources(resources []*route.Resource) {
	for _, resource := range resources {
		if resource.Kind == route.ResourceSfuPublication {
			r.releaseResource(resource)
		}
	}
	for _, resource := range resources {
		if resource.Kind != route.ResourceSfuPublication {
			r.releaseResource(resource)
		}
	}
}

// releaseResource is idempotent through Released.
func (r *router) releaseResource(resource *route.Resource) {
	if resource.Released {
		return
	}
	resource.Released = true
	switch resource.Kind {
	case route.ResourceOverlap:
		return
	case route.ResourceSfuSubscription:
		r.releaseSubscription(subscriptionFence(resource))
		return
	}
	if r.sfu != nil && r.sfu.admission.BeginDrain(resourceFence(resource)) {
		r.scheduleSfuPublicationDrain(resourceFence(resource))
	}
}

func (r *router) releaseSubscription(fence sfu.SubscriptionFence) bool {
	if r.sfu == nil {
		return false
	}
	accepted := r.sfu.admission.BeginSubscriptionDrain(fence)
	if accepted {
		r.scheduleSfuSubscriptionDrain(fence)
	}
	return accepted
}

// wakeResourceWaiters preserves the waiters' snapshot order.
func (r *router) wakeResourceWaiters() {
	roomIDs := r.resourceWaiters.Keys()
	r.resourceWaiters.Clear()
	for _, roomID := range roomIDs {
		rm, _ := r.rooms.Get(roomID)
		if rm == nil || rm.controller == nil {
			continue
		}
		rm.controller.TouchExternalFacts()
		r.requestPump(roomID)
	}
}

// Reauthentication describes the existing physical connection without replacing it.
func (r *router) sendFreshSfuConfig(participant authenticatedRouteParticipant) {
	rm, _ := r.rooms.Get(participant.roomID)
	if r.sfu == nil || rm == nil || rm.controller == nil {
		return
	}
	snapshot := rm.controller.Snapshot()
	if rm.roomMedia && snapshot.VideoGeneration == "" {
		return
	}
	publication := snapshot.HostPublication
	if publication == nil || !publication.PhysicalActive {
		return
	}
	if publication.Resource != nil && r.sfuVideoRetiring(resourceFence(publication.Resource)) {
		return
	}
	connectionID := publication.ConnectionID
	revision := snapshot.Revision
	if participant.role == protocol.RoleViewer {
		edge, ok := snapshot.UpstreamByViewer.Get(participant.peerID)
		if !ok || edge.Kind != route.UpstreamSfu || !edge.PhysicalActive {
			return
		}
		connectionID = edge.ConnectionID
		if rm.roomMedia {
			operation := snapshot.Operation
			if operation != nil && operation.Current != nil && operation.Reason == route.DemandPublicationAttach &&
				operation.ChildPeerID == participant.peerID && operation.ChildSessionID == participant.sessionID &&
				operation.AttachConnectionID == edge.ConnectionID && operation.Current.Tuple.Kind == route.UpstreamSfu {
				connectionID = operation.Current.ConnectionID
			} else if edge.VideoReady && edge.VideoConnectionID != "" {
				connectionID = edge.VideoConnectionID
			} else {
				return
			}
		}
	}
	if rm.roomMedia {
		if operation := snapshot.Operation; operation != nil && operation.Current != nil &&
			operation.Current.Tuple.Kind == route.UpstreamSfu &&
			(participant.role == protocol.RoleHost || operation.ChildPeerID == participant.peerID) {
			revision = operation.Current.Revision
		}
	}
	r.hooks.sendToSession(participant.sessionID, protocol.SfuConfigMessage{
		Type: "sfu-config", Revision: protocol.Int(revision),
		PublicationGeneration: publication.Generation, ConnectionID: connectionID,
	})
	if participant.role == protocol.RoleHost && publication.Resource != nil {
		if active, err := r.sfu.media.PublicationDemand(resourceFence(publication.Resource), connectionID); err == nil {
			count := protocol.Int(active)
			r.hooks.sendToSession(participant.sessionID, protocol.SfuSignalMessage{
				Type: "sfu-signal", Kind: "layers", Revision: protocol.Int(snapshot.Revision),
				PublicationGeneration: publication.Generation, ConnectionID: connectionID, ActiveCount: &count,
			})
		}
	}
}

// prepareSfuVideoAttachment attaches video to an already admitted room edge.
// The pump has begun this exact operation and installed the current Host video
// connection identity before calling it.
func (r *router) prepareSfuVideoAttachment(roomID string, operation *route.OperationSnapshot) {
	rm, _ := r.rooms.Get(roomID)
	if r.sfu == nil || rm == nil || !rm.roomMedia || rm.controller == nil ||
		operation == nil || operation.Current == nil || operation.Reason != route.DemandPublicationAttach ||
		operation.Current.Tuple.Kind != route.UpstreamSfu {
		return
	}
	snapshot := rm.controller.Snapshot()
	current := snapshot.Operation
	publication := snapshot.HostPublication
	if current == nil || current.Current == nil || current.Current.ConnectionID != operation.Current.ConnectionID ||
		publication == nil || publication.Resource == nil || publication.ConnectionID == "" {
		return
	}
	host, hasHost := r.store.GetConnectedHost(roomID)
	child, hasChild := r.store.GetConnectedViewer(roomID, operation.ChildPeerID)
	if !hasHost || host.SessionID != publication.HostSessionID ||
		!hasChild || child.SessionID != operation.ChildSessionID {
		return
	}
	if r.sfuVideoRetiring(resourceFence(publication.Resource)) {
		r.resourceWaiters.Set(roomID, struct{}{})
		return
	}
	config := protocol.SfuConfigMessage{Type: "sfu-config", Revision: protocol.Int(operation.Current.Revision),
		PublicationGeneration: publication.Generation}
	config.ConnectionID = publication.ConnectionID
	r.hooks.sendToSession(host.SessionID, config)
	config.ConnectionID = operation.Current.ConnectionID
	r.hooks.sendToSession(child.SessionID, config)
	if r.sfu.media.HasPublication(resourceFence(publication.Resource), publication.ConnectionID) {
		r.prepareSfuSubscriber(roomID, operation, publication.Generation)
	}
}

// retireRoomVideo retains room admission and the independent voice transports.
func (r *router) retireRoomVideo(roomID string, rm *roomRuntime) {
	if r.sfu == nil || rm == nil || !rm.roomMedia || rm.controller == nil {
		return
	}
	publication := rm.controller.Publication()
	if publication == nil || publication.Resource == nil {
		return
	}
	fence := resourceFence(publication.Resource)
	if fence.RoomID == roomID {
		r.retireSfuVideoPublication(fence, publication.ConnectionID)
	}
}

func (r *router) retireSfuVideoPublication(fence sfu.ResourceFence, connectionID string) {
	if r.sfu == nil {
		return
	}
	var closeVideo func() error
	if media, ok := r.sfu.media.(interface {
		RetirePublication(sfu.ResourceFence, string) func() error
	}); ok {
		closeVideo = media.RetirePublication(fence, connectionID)
	} else {
		// Legacy runtimes cannot detach a reusable room-generation handle.
		// Their video-only publication fences are unique for each share.
		if rm, _ := r.rooms.Get(fence.RoomID); rm != nil && rm.roomMedia {
			return
		}
		media := r.sfu.media
		if media.HasPublication(fence, connectionID) {
			closeVideo = func() error { return media.ClosePublication(fence) }
		}
	}
	if closeVideo == nil {
		return
	}
	key := sfu.SubscriptionFence{ResourceFence: fence, ConnectionID: connectionID}
	task := &sfuDrainTask{kind: drainVideoPublication, fence: key, closePhysical: closeVideo}
	r.sfuDrainTasks.Set(key, task)
	r.runSfuDrain(key, task)
}

// The logical room reservation also owns its retiring picture facet. Do not
// issue a replacement until its exact physical close and reader join settle.
func (r *router) sfuVideoRetiring(fence sfu.ResourceFence) bool {
	for _, task := range r.sfuDrainTasks.All() {
		if task.kind == drainVideoPublication && task.fence.ResourceFence == fence {
			return true
		}
	}
	return false
}

// scheduleSfuPublicationDrain deletes sibling subscription tasks during
// the live iteration.
func (r *router) scheduleSfuPublicationDrain(fence sfu.ResourceFence) {
	for key, task := range r.sfuDrainTasks.All() {
		if task.kind == drainSubscription && task.fence.ResourceFence == fence {
			r.sfuDrainTasks.Delete(key)
		}
	}
	r.scheduleSfuDrain(drainPublication, sfu.SubscriptionFence{ResourceFence: fence})
}

// scheduleSfuSubscriptionDrain skips work when a pending
// publication drain of the same room already removes every participant.
func (r *router) scheduleSfuSubscriptionDrain(fence sfu.SubscriptionFence) {
	if r.sfuDrainTasks.Has(sfu.SubscriptionFence{ResourceFence: fence.ResourceFence}) {
		return
	}
	r.scheduleSfuDrain(drainSubscription, fence)
}

func (r *router) scheduleSfuDrain(kind drainKind, fence sfu.SubscriptionFence) {
	if r.sfu == nil {
		return
	}
	key := fence
	task, _ := r.sfuDrainTasks.Get(key)
	if task == nil {
		task = &sfuDrainTask{kind: kind, fence: fence}
		r.sfuDrainTasks.Set(key, task)
	}
	if task.operation == nil {
		r.runSfuDrain(key, task)
	}
}

// runSfuDrain performs physical close outside the authority mutex.
func (r *router) runSfuDrain(key sfu.SubscriptionFence, task *sfuDrainTask) *drainOperation {
	if task.operation != nil {
		return task.operation
	}
	operation := &drainOperation{done: make(chan struct{})}
	fallback := r.sfu
	if fallback == nil {
		close(operation.done)
		return operation
	}
	task.operation = operation
	var videoDrains []*drainOperation
	if task.kind == drainPublication {
		for siblingKey, sibling := range r.sfuDrainTasks.All() {
			if sibling.kind == drainVideoPublication && sibling.fence.ResourceFence == task.fence.ResourceFence {
				videoDrains = append(videoDrains, r.runSfuDrain(siblingKey, sibling))
			}
		}
	}
	r.inflight++
	go func() {
		var err error
		if task.kind == drainVideoPublication || task.kind == drainVoice {
			err = task.closePhysical()
		} else if task.kind == drainPublication {
			err = fallback.media.ClosePublication(task.fence.ResourceFence)
		} else {
			err = fallback.media.CloseSubscription(task.fence, task.fence.ConnectionID)
		}
		for _, retired := range videoDrains {
			<-retired.done
			err = errors.Join(err, retired.err)
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.inflight--
		operation.err = r.settleSfuDrain(key, task, err)
		if task.operation == operation {
			task.operation = nil
		}
		close(operation.done)
	}()
	return operation
}

// A failed physical close remains charged until shutdown completes it.
func (r *router) settleSfuDrain(key sfu.SubscriptionFence, task *sfuDrainTask, err error) error {
	fallback := r.sfu
	if err == nil {
		if registered, _ := r.sfuDrainTasks.Get(key); registered != task {
			return nil
		}
		if task.kind == drainPublication && !fallback.admission.CompleteDrain(task.fence.ResourceFence) {
			err = errors.New("SFU drain has no matching resource generation")
		} else {
			if task.kind == drainSubscription {
				fallback.admission.CompleteSubscriptionDrain(task.fence)
			}
			r.sfuDrainTasks.Delete(key)
			if task.kind != drainVoice {
				r.wakeResourceWaiters()
				if task.kind == drainVideoPublication && !r.closing {
					if rm, _ := r.rooms.Get(task.fence.RoomID); rm != nil && rm.controller != nil {
						r.prepareSfuVideoAttachment(task.fence.RoomID, rm.controller.Operation())
					}
				}
			} else if !r.closing {
				r.hooks.routesChanged(task.fence.RoomID)
			}
			return nil
		}
	}
	return err
}

// awaitDrain is `await task.operation` inside close(): mu is released while
// waiting and re-acquired before returning; ctx bounds the wait.
func (r *router) awaitDrain(ctx context.Context, operation *drainOperation) error {
	var err error
	r.io(func() {
		select {
		case <-operation.done:
			err = operation.err
		case <-ctx.Done():
			err = ctx.Err()
		}
	})
	return err
}

// In reservationResources, a borrowed reuse edge
// belongs to another holder and is not released.
func reservationResources(reservation route.CandidateReservation) []*route.Resource {
	var resources []*route.Resource
	if reservation.Edge != nil && (reservation.Kind != route.ReservationSfuReuse || !reservation.Borrowed) {
		resources = append(resources, reservation.Edge)
	}
	if reservation.Publication != nil {
		resources = append(resources, reservation.Publication)
	}
	if reservation.Overlap != nil {
		resources = append(resources, reservation.Overlap)
	}
	return resources
}
