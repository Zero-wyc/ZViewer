package signal

// The router owns no lock. signal.Server.mu (routerOptions.mu) is held by the
// caller of every method, hooks are called with it held, and the
// goroutines the router starts (pump driver, media prepares, drains and timer
// callbacks) take it themselves. After unlocked I/O, revalidate the owning
// room, operation and resource before committing effects under the lock.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/piik/server/ordered"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

const (
	defaultRouteOperationTimeoutMs int64 = 20_000
)

func routeDebugEnabled() bool {
	return routeDebugFlag(os.Getenv("PIIK_DEBUG")) ||
		slog.Default().Enabled(context.Background(), slog.LevelDebug)
}

func routeDebugFlag(value string) bool {
	for _, section := range strings.Split(value, ",") {
		if strings.TrimSpace(section) == "route" {
			return true
		}
	}
	return false
}

// routeDebugSink is the injected route-diagnostic sink; nil disables route
// events. The signaling effect layer owns environment and logger policy.
func routeDebugSink() func(string, ...any) {
	if !routeDebugEnabled() {
		return nil
	}
	return slog.Info
}

// sfuFallback supplies embedded media and admission; zero selects the default timeout.
type sfuFallback struct {
	media            sfu.Runtime
	admission        *sfu.Admission
	prepareTimeoutMs int64
}

// routerHooks are callbacks into the signaling server.
// Every hook is called with mu held and must not block. shareGeneration
// returns "" when no share exists; routesChanged may be nil.
type routerHooks struct {
	sendToSession       func(sessionID string, message protocol.ServerMessage)
	shareGeneration     func(roomID string) string
	routesChanged       func(roomID string)
	voiceAllowed        func(roomID, peerID string) bool
	videoGeneration     func(roomID string) string
	voiceDemandChanged  func(roomID string)
	voiceCandidateReady func(roomID, connectionID string) bool
	voiceRouteFailed    func(roomID, peerID string)
}

// routerOptions supplies the shared mutex and timer factory.
// now and afterFunc default to the wall clock.
type routerOptions struct {
	mu                        *sync.Mutex
	store                     *room.Store
	endpointMediaCopyCapacity int
	sfu                       *sfuFallback
	sfuOnly                   bool
	hooks                     routerHooks
	now                       func() int64
	afterFunc                 func(time.Duration, func()) func() bool
}

// authenticatedRouteParticipant carries admitted identity and optional Host policy.
type authenticatedRouteParticipant struct {
	roomID          string
	role            protocol.Role
	peerID          string
	sessionID       string
	routePolicy     *protocol.RoutePolicy
	routePreference *protocol.ViewerRoutePreference
}

// hybridAuthenticationState supplies the joining session's route assignment.
type hybridAuthenticationState struct {
	routeRevision   int64
	routeAssignment protocol.ParticipantRouteAssignment
}

// activeViewerMediaEdge identifies one Viewer's active Peer or SFU upstream.
type activeViewerMediaEdge struct {
	revision     int64
	connectionID string
	upstream     protocol.MediaRouteUpstream
}

// signalAuthorization is the peerSignalAuthorization result. Unassigned makes
// the signaling server check the committed-edge assignment.
type signalAuthorization int

const (
	signalAuthorizationUnassigned signalAuthorization = iota
	signalAuthorizationDenied
	signalAuthorizationAllowed
	signalAuthorizationProbe
)

// peerSignalInput supplies session/connection identity for signal authorization.
// descriptionType is empty for signals without an SDP description.
type peerSignalInput struct {
	roomID          string
	sourcePeerID    string
	sourceSessionID string
	targetPeerID    string
	targetSessionID string
	connectionID    string
	signalKind      string
	descriptionType string
	punchPhase      string
	punched         bool
}

// peerSignalDebugInput supplies signal provenance; optional fields are empty.
type peerSignalDebugInput struct {
	roomID          string
	sourcePeerID    string
	targetPeerID    string
	signalKind      string
	candidateOrigin protocol.CandidateSignalOrigin
	descriptionType string
	authorization   signalAuthorization
}

// roomRuntime owns one controller. pumping prevents concurrent drivers;
// deadlineGeneration is bumped by every clearDeadline so
// a callback that lost the Stop race sees it is stale.
type roomRuntime struct {
	hostPeerID      string
	controller      *route.Controller
	revisions       *route.RevisionSequence
	roomMedia       bool
	mediaGeneration string
	pendingMedia    *preparedCandidate
	// Viewer choices survive signaling recovery and share replacement, not leave.
	viewerSettings     ordered.Map[string, viewerRouteSettings]
	requested          bool
	pumping            bool
	deadlineStop       func() bool
	deadlineGeneration uint64
}

type viewerRouteSettings struct {
	capacity  int
	sessionID string
	volunteer bool
	// Empty means the page has not opted into route selection.
	preference protocol.ViewerRoutePreference
}

// router applies controller decisions through room signaling and media resources.
type router struct {
	mu        *sync.Mutex
	store     *room.Store
	capacity  int
	sfu       *sfuFallback
	sfuOnly   bool
	hooks     routerHooks
	now       func() int64
	afterFunc func(time.Duration, func()) func() bool

	// Rooms, drain tasks and waiters are walked in insertion
	// order.
	rooms           ordered.Map[string, *roomRuntime]
	resourceWaiters ordered.Map[string, struct{}]
	sfuDrainTasks   ordered.Map[sfu.SubscriptionFence, *sfuDrainTask]
	// inflight counts the goroutines that will re-acquire mu: the pump
	// drivers, fresh SFU config issues, voice negotiations and drains.
	inflight int
	closing  bool
}

// newRouter shares the server's lock and supplies clock defaults.
func newRouter(options routerOptions) *router {
	if err := protocol.AssertEndpointMediaCopyCapacity(options.endpointMediaCopyCapacity); err != nil {
		panic(err)
	}

	r := &router{
		mu:        options.mu,
		store:     options.store,
		capacity:  options.endpointMediaCopyCapacity,
		sfu:       options.sfu,
		sfuOnly:   options.sfuOnly,
		hooks:     options.hooks,
		now:       options.now,
		afterFunc: options.afterFunc,
	}
	if r.now == nil {
		r.now = func() int64 { return time.Now().UnixMilli() }
	}
	if r.afterFunc == nil {
		r.afterFunc = func(d time.Duration, fn func()) func() bool {
			return time.AfterFunc(d, fn).Stop
		}
	}
	return r
}

// io releases mu for external work and reacquires it even while a panic unwinds.
// This keeps the caller's deferred unlock valid when recoverPump catches the
// failure. Nothing may touch router state inside fn.
func (r *router) io(fn func()) {
	r.mu.Unlock()
	defer r.mu.Lock()
	fn()
}

// close retires room operations and waits for their exact physical resources.
func (r *router) close(ctx context.Context) error {
	r.closing = true
	for _, roomID := range r.rooms.Keys() {
		r.clearRoom(roomID)
	}
	r.resourceWaiters.Clear()
	fallback := r.sfu
	if fallback == nil {
		return nil
	}
	for _, fence := range fallback.admission.BeginDrainAll() {
		r.scheduleSfuPublicationDrain(fence)
	}
	type entry struct {
		key  sfu.SubscriptionFence
		task *sfuDrainTask
	}
	var snapshot []entry
	for key, task := range r.sfuDrainTasks.All() {
		snapshot = append(snapshot, entry{key, task})
	}
	var errs []error
	for _, current := range snapshot {
		key, task := current.key, current.task
		if task.operation != nil {
			if err := r.awaitDrain(ctx, task.operation); err != nil {
				errs = append(errs, err)
				continue
			}
		}
		if registered, _ := r.sfuDrainTasks.Get(key); registered == task {
			if err := r.awaitDrain(ctx, r.runSfuDrain(key, task)); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("SFU drain failed during shutdown: %w", errors.Join(errs...))
	}
	return nil
}

func (r *router) connectParticipant(input authenticatedRouteParticipant) hybridAuthenticationState {
	rm := r.room(input.roomID)
	if input.role == protocol.RoleHost {
		if rm.controller != nil && rm.hostPeerID != input.peerID {
			r.clearDeadline(rm)
			// rm.hostPeerID always equals the controller's, so this branch
			// takes RebindHostIdentity's clearing path: every committed edge goes.
			r.releaseResources(rm.controller.RebindHostIdentity(input.peerID, input.sessionID, r.nowPtr()))
		}
		rm.hostPeerID = input.peerID
		if rm.controller == nil {
			r.createController(input.roomID, rm, input)
		}
	} else {
		settings, _ := rm.viewerSettings.Get(input.peerID)
		if settings.sessionID != input.sessionID {
			settings.sessionID, settings.preference, settings.volunteer = input.sessionID, "", false
		}
		if input.routePreference != nil {
			settings.preference = *input.routePreference
			if !r.viewerRouteAllowed(input.roomID, settings.preference) {
				settings.preference = protocol.ViewerRouteAuto
			}
		}
		rm.viewerSettings.Set(input.peerID, settings)
	}
	if rm.controller != nil {
		if rm.roomMedia && input.role == protocol.RoleViewer && r.videoGeneration(input.roomID) == "" &&
			(r.hooks.voiceAllowed == nil || !r.hooks.voiceAllowed(input.roomID, input.peerID)) {
			return hybridAuthenticationState{routeAssignment: emptyAssignment()}
		}
		capacity := r.capacity
		var preference protocol.ViewerRoutePreference
		if input.role != protocol.RoleHost {
			settings, _ := rm.viewerSettings.Get(input.peerID)
			capacity, preference = settings.capacity, settings.preference
		}
		r.releaseResources(rm.controller.UpsertParticipant(route.ParticipantInput{
			PeerID:                      input.peerID,
			Role:                        input.role,
			SessionID:                   input.sessionID,
			EffectiveDownstreamCapacity: capacity,
			RoutePreference:             preference,
		}, r.nowPtr()))
		if input.role == protocol.RoleViewer {
			settings, _ := rm.viewerSettings.Get(input.peerID)
			rm.controller.SetRelayVolunteer(input.peerID, input.sessionID, settings.volunteer, r.nowPtr())
		}
	}
	state := hybridAuthenticationState{routeAssignment: emptyAssignment()}
	if rm.controller != nil {
		current := rm.controller.Snapshot()
		state.routeRevision = current.Revision
		state.routeAssignment = assignmentFor(r.assignments(input.roomID, current, nil, "", ""), input.peerID)
	}
	return state
}

func (r *router) completeAuthentication(participant authenticatedRouteParticipant, _ hybridAuthenticationState) {
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	r.broadcastActive(participant.roomID, rm)
	r.sendFreshSfuConfig(participant)
	r.requestPump(participant.roomID)
}

func (r *router) setPaused(roomID string, paused bool) {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	before := rm.controller.Revision()
	r.releaseResources(rm.controller.SetPaused(paused, r.nowPtr()))
	if rm.controller.Revision() != before {
		r.broadcastActive(roomID, rm)
	}
	if !paused || rm.roomMedia {
		r.requestPump(roomID)
	}
}

func (r *router) routeDiagnosticSnapshot(roomID string) protocol.RouteDiagnosticSnapshot {
	if rm, _ := r.rooms.Get(roomID); rm != nil && rm.controller != nil {
		return rm.controller.RouteDiagnosticSnapshot(r.now())
	}
	return protocol.RouteDiagnosticSnapshot{Children: []protocol.RouteDiagnosticChild{}, Operation: nil}
}

func (r *router) observeQualityEvidence(roomID string, evidence route.RouteQualityEvidenceInput) route.RouteQualityEvidenceResult {
	result := route.QualityEvidenceRejected
	if rm, _ := r.rooms.Get(roomID); rm != nil && rm.controller != nil {
		result = rm.controller.ObserveQualityEvidence(evidence)
	}
	if result != route.QualityEvidenceRejected && routeDebugEnabled() {
		upstream := "sfu"
		if evidence.Upstream.Kind == route.UpstreamPeer {
			upstream = "p2p:" + r.debugPeer(roomID, evidence.Upstream.PeerID)
		}
		metrics := evidence.Metrics
		var packetLossPercent any
		if percent, ok := protocol.PacketLossPercentFromDeltas(
			intFloat(metrics.PacketsReceivedDelta), intFloat(metrics.PacketsLostDelta)); ok {
			packetLossPercent = percent
		}
		r.debug(roomID, "viewer-quality-evidence",
			"viewer", r.debugPeer(roomID, evidence.ChildPeerID),
			"upstream", upstream,
			"natTraversalPath", metrics.NatTraversalPath,
			"framesPerSecond", optional(metrics.FramesPerSecond),
			"bitrateKbps", optional(metrics.BitrateKbps),
			"width", optional(metrics.Width),
			"height", optional(metrics.Height),
			"framesDecoded", optional(metrics.FramesDecodedDelta),
			"freezes", optional(metrics.FreezeCountDelta),
			"pauses", optional(metrics.PauseCountDelta),
			"packetsReceivedDelta", optional(metrics.PacketsReceivedDelta),
			"packetsLostDelta", optional(metrics.PacketsLostDelta),
			"packetLossPercent", packetLossPercent,
			"rttMs", optional(metrics.RttMs),
			"jitterMs", optional(metrics.JitterMs))
	}
	return result
}

func (r *router) observeSenderQualityEvidence(participant authenticatedRouteParticipant, message protocol.SenderQualityEvidenceMessage) bool {
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return false
	}
	controller := rm.controller
	snapshot := controller.Snapshot()
	before := snapshot.Revision
	endpointCapacity := r.capacity
	if participant.role != protocol.RoleHost {
		settings, _ := rm.viewerSettings.Get(participant.peerID)
		endpointCapacity = min(settings.capacity, r.capacity)
	}
	copyContext := r.qualityCopyContext(snapshot, rm.hostPeerID, participant.peerID, endpointCapacity, qualitySample{
		kind:          route.UpstreamPeer,
		childPeerID:   message.ChildPeerID,
		routeRevision: int64(message.RouteRevision),
		connectionID:  message.ConnectionID,
	})
	var senderIdentity *string
	if message.RtpStatsID != nil && *message.RtpStatsID != "" &&
		message.TrackIdentifier != nil && *message.TrackIdentifier != "" {
		identity := *message.RtpStatsID + "\x00" + *message.TrackIdentifier
		senderIdentity = &identity
	}
	input := route.SenderQualityEvidenceInput{
		ParentPeerID:      participant.peerID,
		ParentSessionID:   participant.sessionID,
		ChildPeerID:       message.ChildPeerID,
		RouteRevision:     int64(message.RouteRevision),
		ConnectionID:      message.ConnectionID,
		SenderIdentity:    senderIdentity,
		SampleTimestampMs: sampleTimestamp(message.SampleTimestampMs),
		State:             route.SenderQualityState(message.State),
		AcceptedAtMs:      r.now(),
	}
	result := controller.ObserveSenderQualityEvidence(input, r.commitReservation)
	if result.Accepted && routeDebugEnabled() {
		diagnostics := message.Diagnostics
		details := []any{
			"parent", r.debugPeer(participant.roomID, participant.peerID),
			"child", r.debugPeer(participant.roomID, message.ChildPeerID),
			"routeRevision", int64(message.RouteRevision),
		}
		details = append(details, copyContext.kv()...)
		details = append(details,
			"state", message.State,
			"natTraversalPath", diagnostics.NatTraversalPath,
			"reason", optional(diagnostics.Reason),
			"framesPerSecond", optional(diagnostics.FramesPerSecond),
			"bitrateKbps", optional(diagnostics.BitrateKbps),
			"captureFramesPerSecond", nullable(diagnostics.CaptureFramesPerSecond),
			"mediaSourceFramesPerSecond", nullable(diagnostics.MediaSourceFramesPerSecond),
			"width", nullable(diagnostics.Width),
			"height", nullable(diagnostics.Height),
			"availableOutgoingKbps", nullable(diagnostics.AvailableOutgoingKbps),
			"rttMs", nullable(diagnostics.RttMs),
			"packetLossPercent", nullable(diagnostics.PacketLossPercent))
		r.debug(participant.roomID, "sender-quality-evidence", details...)
	}
	r.releaseResources(result.Released)
	if result.Committed {
		r.resourceWaiters.Delete(participant.roomID)
	}
	if controller.Revision() != before {
		r.broadcastActive(participant.roomID, rm)
	}
	r.sendRouteFailures(participant.roomID, result.FailedPeerIDs, controller.Revision())
	if result.Accepted {
		r.requestPump(participant.roomID)
	}
	return result.Accepted
}

func (r *router) observeSfuPublisherQualityEvidence(participant authenticatedRouteParticipant, message protocol.SfuPublisherQualityEvidenceMessage) bool {
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil || participant.role != protocol.RoleHost {
		return false
	}
	controller := rm.controller
	snapshot := controller.Snapshot()
	operation := snapshot.Operation
	candidateChildPeerID, candidateConnectionID := "", ""
	if operation != nil {
		candidateChildPeerID = operation.ChildPeerID
		if operation.Current != nil {
			candidateConnectionID = operation.Current.ConnectionID
		}
	}
	before := snapshot.Revision
	copyContext := r.qualityCopyContext(snapshot, participant.peerID, participant.peerID, r.capacity, qualitySample{
		kind:                  route.UpstreamSfu,
		routeRevision:         int64(message.RouteRevision),
		publicationGeneration: message.PublicationGeneration,
		hostSessionID:         participant.sessionID,
	})
	input := route.SfuPublisherQualityEvidenceInput{
		HostPeerID:            participant.peerID,
		HostSessionID:         participant.sessionID,
		PublicationGeneration: message.PublicationGeneration,
		RouteRevision:         int64(message.RouteRevision),
		State:                 route.SenderQualityState(message.State),
		SampleTimestampMs:     sampleTimestamp(message.SampleTimestampMs),
		AcceptedAtMs:          r.now(),
	}
	result := controller.ObserveSfuPublisherQualityEvidence(input, r.commitReservation)
	if result.Accepted && routeDebugEnabled() {
		diagnostics := message.Diagnostics
		details := []any{"routeRevision", int64(message.RouteRevision)}
		details = append(details, copyContext.kv()...)
		details = append(details,
			"state", message.State,
			"reason", optional(diagnostics.Reason),
			"framesPerSecond", optional(diagnostics.FramesPerSecond),
			"bitrateKbps", optional(diagnostics.BitrateKbps),
			"captureFramesPerSecond", nullable(diagnostics.CaptureFramesPerSecond),
			"mediaSourceFramesPerSecond", nullable(diagnostics.MediaSourceFramesPerSecond),
			"width", nullable(diagnostics.Width),
			"height", nullable(diagnostics.Height),
			"videoEncodingCount", nullable(diagnostics.VideoEncodingCount),
			"activeVideoEncodingCount", nullable(diagnostics.ActiveVideoEncodingCount),
			"availableOutgoingKbps", nullable(diagnostics.AvailableOutgoingKbps),
			"rttMs", nullable(diagnostics.RttMs),
			"packetLossPercent", nullable(diagnostics.PacketLossPercent))
		r.debug(participant.roomID, "sfu-publisher-quality-evidence", details...)
	}
	r.releaseResources(result.Released)
	if result.Committed && candidateChildPeerID != "" && candidateConnectionID != "" {
		r.resourceWaiters.Delete(participant.roomID)
	}
	if controller.Revision() != before {
		r.broadcastActive(participant.roomID, rm)
	}
	r.sendRouteFailures(participant.roomID, result.FailedPeerIDs, controller.Revision())
	if result.Accepted {
		r.requestPump(participant.roomID)
	}
	return result.Accepted
}

func (r *router) resetSenderQuality(participant authenticatedRouteParticipant) {
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	before := rm.controller.Revision()
	r.releaseResources(rm.controller.ResetSenderQuality(participant.peerID, participant.sessionID, r.now()))
	if rm.controller.Revision() != before {
		r.broadcastActive(participant.roomID, rm)
	}
	r.requestPump(participant.roomID)
}

func (r *router) isActivePeerParentOf(roomID, parentPeerID, childPeerID string) bool {
	_, activeParent, ok := r.resolveActivePeerEdge(roomID, childPeerID)
	return ok && activeParent == parentPeerID
}

// resolveActivePeerEdge returns false when the child has no active Peer edge.
func (r *router) resolveActivePeerEdge(roomID, childPeerID string) (revision int64, parentPeerID string, ok bool) {
	edge, found := r.resolveActiveViewerMediaEdge(roomID, childPeerID)
	if !found || edge.upstream.Kind != "peer" {
		return 0, "", false
	}
	return edge.revision, edge.upstream.PeerID, true
}

func (r *router) resolveActiveViewerMediaEdge(roomID, childPeerID string) (activeViewerMediaEdge, bool) {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.controller == nil {
		return activeViewerMediaEdge{}, false
	}
	snapshot := rm.controller.Snapshot()
	edge, hasEdge := snapshot.UpstreamByViewer.Get(childPeerID)
	if !hasEdge || !r.pathIsPhysical(roomID, snapshot, childPeerID) {
		return activeViewerMediaEdge{}, false
	}
	upstream := protocol.SfuUpstream()
	if edge.Kind == route.UpstreamPeer {
		upstream = protocol.PeerUpstream(edge.ParentPeerID)
	}
	return activeViewerMediaEdge{
		revision:     snapshot.Revision,
		connectionID: videoConnectionID(snapshot, edge),
		upstream:     upstream,
	}, true
}

func (r *router) getViewerRouteUpstream(roomID, viewerPeerID string) protocol.MediaRouteUpstream {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.controller == nil {
		return protocol.NoUpstream()
	}
	return assignmentFor(r.assignments(roomID, rm.controller.Snapshot(), nil, "", ""), viewerPeerID).Upstream
}

// A retired server candidate must never be mistaken for a parent-initiated
// replacement. Its ID remains opaque to clients; no retired-ID history is needed.
const candidateConnectionIDPrefix = "route_"

// peerSignalAuthorization resolves candidate and retained media by connection,
// since both may belong to the same parent/child pair during overlap.
func (r *router) peerSignalAuthorization(input peerSignalInput) signalAuthorization {
	rm, _ := r.rooms.Get(input.roomID)
	if rm == nil || rm.controller == nil {
		if input.signalKind == "punch" || input.punched {
			return signalAuthorizationDenied
		}
		return signalAuthorizationUnassigned
	}
	controller := rm.controller
	snapshot := controller.Snapshot()
	operation := snapshot.Operation
	if operation != nil && operation.Current != nil && operation.Current.Tuple.Kind == route.UpstreamPeer {
		current := operation.Current
		parent, hasParent := r.connectedPeer(input.roomID, current.Tuple.ParentPeerID)
		child, hasChild := r.store.GetConnectedViewer(input.roomID, operation.ChildPeerID)
		parentToChild := input.sourcePeerID == current.Tuple.ParentPeerID &&
			input.targetPeerID == operation.ChildPeerID
		childToParent := input.sourcePeerID == operation.ChildPeerID &&
			input.targetPeerID == current.Tuple.ParentPeerID
		if (parentToChild || childToParent) && input.connectionID == current.ConnectionID {
			parentSession, childSession := input.targetSessionID, input.sourceSessionID
			if parentToChild {
				parentSession, childSession = input.sourceSessionID, input.targetSessionID
			}
			if hasParent && hasChild &&
				parent.SessionID == parentSession &&
				child.SessionID == childSession {
				if input.signalKind == "punch" || input.punched {
					if current.ConnectionAttempt == nil || current.ConnectionAttempt.Current <= 1 {
						return signalAuthorizationDenied
					}
					if (input.punched && parentToChild && input.descriptionType == "offer") ||
						(parentToChild && (input.punchPhase == "prepare" || input.punchPhase == "start")) ||
						(childToParent && (input.punchPhase == "ready" || input.punchPhase == "complete")) {
						return signalAuthorizationProbe
					}
					return signalAuthorizationDenied
				}
				if input.signalKind == "candidate" ||
					(parentToChild && input.descriptionType == "offer") ||
					(childToParent && input.descriptionType == "answer") {
					return signalAuthorizationProbe
				}
			}
			return signalAuthorizationDenied
		}
	}

	// Preparation is never an active-edge capability or an unassigned signal.
	if input.signalKind == "punch" || input.punched {
		return signalAuthorizationDenied
	}
	childPeerID := childForPair(snapshot, input.sourcePeerID, input.targetPeerID)
	if childPeerID == "" {
		return signalAuthorizationUnassigned
	}
	edge, hasEdge := snapshot.UpstreamByViewer.Get(childPeerID)
	if !hasEdge || edge.Kind != route.UpstreamPeer || !edge.PhysicalActive {
		return signalAuthorizationUnassigned
	}
	parentToChild := input.sourcePeerID == edge.ParentPeerID
	sessionsMatch := (parentToChild &&
		input.sourceSessionID == edge.ParentSessionID &&
		input.targetSessionID == edge.ChildSessionID) ||
		(!parentToChild &&
			input.sourceSessionID == edge.ChildSessionID &&
			input.targetSessionID == edge.ParentSessionID)
	if !sessionsMatch {
		return signalAuthorizationDenied
	}
	activeConnectionID := videoConnectionID(snapshot, edge)
	if rm.roomMedia && (!edge.VideoReady || edge.VideoGeneration != snapshot.VideoGeneration || snapshot.VideoGeneration == "") {
		return signalAuthorizationDenied
	}
	if edge.Transport == route.TransportDirect &&
		parentToChild &&
		input.signalKind == "description" &&
		input.descriptionType == "offer" &&
		input.connectionID != activeConnectionID {
		if strings.HasPrefix(input.connectionID, candidateConnectionIDPrefix) {
			return signalAuthorizationDenied
		}
		adopted := controller.AdoptDirectConnection(route.AdoptDirectConnectionInput{
			EdgeGuard: route.EdgeGuard{
				ChildPeerID:     childPeerID,
				ChildSessionID:  edge.ChildSessionID,
				ParentSessionID: edge.ParentSessionID,
				RouteRevision:   snapshot.Revision,
				ConnectionID:    edge.ConnectionID,
			},
			NewConnectionID: input.connectionID,
		}, r.now())
		if adopted.Accepted {
			r.releaseResources(adopted.Released)
			if adopted.ActiveRevision != snapshot.Revision {
				r.broadcastActive(input.roomID, rm)
				r.requestPump(input.roomID)
			}
			return signalAuthorizationAllowed
		}
		return signalAuthorizationDenied
	}
	if input.connectionID == activeConnectionID {
		return signalAuthorizationAllowed
	}
	return signalAuthorizationDenied
}

func (r *router) debugPeerSignal(input peerSignalDebugInput) {
	if !routeDebugEnabled() {
		return
	}
	var authorization any
	switch input.authorization {
	case signalAuthorizationUnassigned:
		authorization = "assignment"
	case signalAuthorizationDenied:
		authorization = false
	case signalAuthorizationAllowed:
		authorization = true
	case signalAuthorizationProbe:
		authorization = "probe"
	}
	r.debug(input.roomID, "peer-signal",
		"source", r.debugPeer(input.roomID, input.sourcePeerID),
		"target", r.debugPeer(input.roomID, input.targetPeerID),
		"signalKind", input.signalKind,
		"candidateOrigin", nullString(string(input.candidateOrigin)),
		"descriptionType", nullString(input.descriptionType),
		"authorization", authorization)
}

func (r *router) viewerRouteAllowed(roomID string, preference protocol.ViewerRoutePreference) bool {
	if rm, ok := r.rooms.Get(roomID); ok && rm.controller != nil {
		return rm.controller.AllowsViewerRoutePreference(preference)
	}
	return (preference != protocol.ViewerRouteSfu || r.sfu != nil) &&
		(preference != protocol.ViewerRoutePeer || !r.sfuOnly)
}

func (r *router) setViewerRoutePreference(participant authenticatedRouteParticipant, preference protocol.ViewerRoutePreference) {
	rm := r.room(participant.roomID)
	settings, _ := rm.viewerSettings.Get(participant.peerID)
	accepted := r.viewerRouteAllowed(participant.roomID, preference)
	if accepted {
		settings.preference = preference
	} else if settings.preference == "" {
		settings.preference = protocol.ViewerRouteAuto
	}
	rm.viewerSettings.Set(participant.peerID, settings)
	if accepted && rm.controller != nil {
		before := rm.controller.Revision()
		r.releaseResources(rm.controller.SetViewerRoutePreference(participant.peerID, participant.sessionID, preference, r.nowPtr()))
		if rm.controller.Revision() != before {
			r.broadcastActive(participant.roomID, rm)
		}
	}
	r.sendViewerRoutePreference(participant.roomID, participant.peerID, accepted)
	if accepted {
		r.requestPump(participant.roomID)
	}
}

func (r *router) sendViewerRoutePreference(roomID, peerID string, accepted bool) {
	rm, ok := r.rooms.Get(roomID)
	if !ok {
		return
	}
	settings, _ := rm.viewerSettings.Get(peerID)
	if settings.preference == "" {
		return // Published clients that did not opt in receive no new event.
	}
	if viewer, ok := r.store.GetConnectedViewer(roomID, peerID); ok {
		r.hooks.sendToSession(viewer.SessionID, protocol.ViewerRoutePreferenceMessage{
			Type: "viewer-route-preference", Preference: settings.preference, Accepted: accepted,
		})
	}
}

func (r *router) setViewerRelayCapacity(participant authenticatedRouteParticipant, downstreamEdges int) {
	rm := r.room(participant.roomID)
	r.debug(participant.roomID, "relay-capacity-received",
		"participant", r.debugPeer(participant.roomID, participant.peerID),
		"downstreamEdges", downstreamEdges)
	settings, _ := rm.viewerSettings.Get(participant.peerID)
	settings.capacity = downstreamEdges
	rm.viewerSettings.Set(participant.peerID, settings)
	if rm.controller != nil &&
		rm.controller.SetEffectiveCapacity(participant.peerID, participant.sessionID, downstreamEdges, r.nowPtr()) {
		r.requestPump(participant.roomID)
	}
}

func (r *router) handleRouteReady(participant authenticatedRouteParticipant, message protocol.RouteReadyMessage) {
	if participant.role != protocol.RoleViewer || message.Phase != "prepare" {
		return
	}
	revision := int64(message.Revision)
	r.debug(participant.roomID, "route-ready-received",
		"participant", r.debugPeer(participant.roomID, participant.peerID),
		"revision", revision)
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	controller := rm.controller
	operation := controller.Operation()
	if operation == nil || operation.Current == nil ||
		operation.ChildPeerID != participant.peerID ||
		operation.ChildSessionID != participant.sessionID ||
		operation.Current.Revision != revision {
		return
	}
	current := operation.Current
	if rm.roomMedia && rm.pendingMedia != nil && rm.pendingMedia.connectionID == current.ConnectionID {
		ready := message
		rm.pendingMedia.videoReady = &ready
		if r.hooks.voiceCandidateReady != nil && !r.hooks.voiceCandidateReady(participant.roomID, current.ConnectionID) {
			return
		}
	}
	before := controller.Revision()
	settled := controller.CandidateReady(route.CandidateGuard{
		ChildPeerID:    participant.peerID,
		ChildSessionID: participant.sessionID,
		Revision:       revision,
		ConnectionID:   current.ConnectionID,
	}, r.now(), r.commitReservation, route.CandidateProof{RelativeQualityApproved: message.QualityApproved, VideoGeneration: operation.VideoGeneration})
	r.debug(participant.roomID, "route-ready-settled",
		"participant", r.debugPeer(participant.roomID, participant.peerID),
		"revision", revision,
		"accepted", settled.Accepted,
		"committed", settled.Committed,
		"exhausted", len(settled.FailedPeerIDs) > 0)
	r.releaseResources(settled.Released)
	if settled.Committed && settled.Accepted {
		r.resourceWaiters.Delete(participant.roomID)
	}
	if controller.Revision() != before {
		r.broadcastActive(participant.roomID, rm)
	}
	r.sendRouteFailures(participant.roomID, settled.FailedPeerIDs, controller.Revision())
	r.requestPump(participant.roomID)
}

// Either endpoint may report transport progress or local failure. First-frame
// readiness remains owned by the candidate Viewer in handleRouteReady.
func (r *router) ownsCandidateEndpoint(participant authenticatedRouteParticipant, operation *route.OperationSnapshot) bool {
	if participant.role == protocol.RoleViewer && participant.peerID == operation.ChildPeerID &&
		participant.sessionID == operation.ChildSessionID {
		return true
	}
	if operation.Current.Tuple.Kind == route.UpstreamPeer && participant.peerID == operation.Current.Tuple.ParentPeerID {
		peer, ok := r.connectedPeer(participant.roomID, participant.peerID)
		return ok && peer.SessionID == participant.sessionID
	}
	return false
}

func (r *router) handleRouteTransportConnected(participant authenticatedRouteParticipant, message protocol.RouteTransportConnectedMessage) {
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	controller := rm.controller
	operation := controller.Operation()
	revision := int64(message.Revision)
	if operation == nil || operation.Current == nil ||
		operation.Current.Revision != revision ||
		operation.Current.ConnectionID != message.ConnectionID ||
		operation.Current.Tuple.Kind != route.UpstreamPeer ||
		!r.ownsCandidateEndpoint(participant, operation) {
		return
	}
	before := controller.Revision()
	progressed := controller.CandidateTransportConnected(route.CandidateGuard{
		ChildPeerID:    operation.ChildPeerID,
		ChildSessionID: operation.ChildSessionID,
		Revision:       revision,
		ConnectionID:   message.ConnectionID,
	}, r.now())
	r.releaseResources(progressed.Released)
	if controller.Revision() != before {
		r.broadcastActive(participant.roomID, rm)
	}
	r.sendRouteFailures(participant.roomID, progressed.FailedPeerIDs, controller.Revision())
	after := controller.Operation()
	if !progressed.Accepted || after == nil || after.WakeAtMs != operation.WakeAtMs {
		r.requestPump(participant.roomID)
	}
}

func (r *router) handleRouteMediaUnavailable(participant authenticatedRouteParticipant, message protocol.RouteMediaUnavailableMessage) {
	if participant.role != protocol.RoleViewer {
		return
	}
	revision := int64(message.Revision)
	r.debug(participant.roomID, "sfu-media-unavailable",
		"participant", r.debugPeer(participant.roomID, participant.peerID),
		"revision", revision)
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	snapshot := rm.controller.Snapshot()
	edge, hasEdge := snapshot.UpstreamByViewer.Get(participant.peerID)
	if snapshot.Paused || snapshot.Revision != revision ||
		!hasEdge || edge.Kind != route.UpstreamSfu ||
		edge.ChildSessionID != participant.sessionID {
		return
	}
	rm.controller.InvalidateEdge(route.EdgeGuard{
		ChildPeerID:    participant.peerID,
		ChildSessionID: participant.sessionID,
		RouteRevision:  snapshot.Revision,
		ConnectionID:   edge.ConnectionID,
	}, r.nowPtr())
	r.requestPump(participant.roomID)
}

func (r *router) handleRouteFailed(participant authenticatedRouteParticipant, message protocol.RouteFailedMessage) {
	connectionID := ""
	if message.ConnectionID != nil {
		connectionID = *message.ConnectionID
	}
	revision := int64(message.Revision)
	r.debug(participant.roomID, "route-failed-received",
		"participant", r.debugPeer(participant.roomID, participant.peerID),
		"role", participant.role,
		"phase", message.Phase,
		"revision", revision,
		"hasConnectionId", connectionID != "")
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	controller := rm.controller
	snapshot := controller.Snapshot()
	if message.Phase == "prepare" {
		operation := snapshot.Operation
		if operation == nil || operation.Current == nil || operation.Current.Revision != revision {
			return
		}
		current := operation.Current
		ownsEndpoint := r.ownsCandidateEndpoint(participant, operation)
		ownsPublication := false
		if current.Tuple.Kind == route.UpstreamSfu && participant.role == protocol.RoleHost &&
			participant.peerID == rm.hostPeerID {
			host, ok := r.store.GetConnectedHost(participant.roomID)
			ownsPublication = ok && host.SessionID == participant.sessionID
		}
		if !ownsEndpoint && !ownsPublication {
			return
		}
		if connectionID != "" && connectionID != current.ConnectionID {
			return
		}
		before := snapshot.Revision
		settled := controller.CandidateFailed(route.CandidateGuard{
			ChildPeerID:    operation.ChildPeerID,
			ChildSessionID: operation.ChildSessionID,
			Revision:       current.Revision,
			ConnectionID:   current.ConnectionID,
		}, r.now())
		r.releaseResources(settled.Released)
		if controller.Revision() != before {
			r.broadcastActive(participant.roomID, rm)
		}
		r.sendRouteFailures(participant.roomID, settled.FailedPeerIDs, controller.Revision())
		r.requestPump(participant.roomID)
		return
	}

	// A room revision can advance for another Viewer while this report is in
	// flight. Only an exact still-owned connection may outlive that revision;
	// identity-free reports retain their snapshot fence. Endpoint/session and
	// connection checks below still reject retired resources.
	if revision > snapshot.Revision || (revision != snapshot.Revision && connectionID == "") {
		return
	}
	if connectionID != "" {
		logicalConnectionID := connectionID
		if snapshot.RoomMedia {
			logicalConnectionID = ""
		}
		for _, edge := range snapshot.UpstreamByViewer.Values() {
			if edge.Kind == route.UpstreamPeer && edge.ParentPeerID == participant.peerID && videoConnectionID(snapshot, edge) == connectionID {
				logicalConnectionID = edge.ConnectionID
				break
			}
		}
		if logicalConnectionID != "" && controller.InvalidateDirectEdgeFromParent(route.ParentEdgeGuard{
			ParentPeerID:    participant.peerID,
			ParentSessionID: participant.sessionID,
			RouteRevision:   snapshot.Revision,
			ConnectionID:    logicalConnectionID,
		}, r.nowPtr()) {
			r.requestPump(participant.roomID)
			return
		}
	}
	if participant.role == protocol.RoleHost {
		publication := snapshot.HostPublication
		if publication == nil || publication.HostSessionID != participant.sessionID ||
			(connectionID != "" && connectionID != publication.ConnectionID) {
			return
		}
		controller.InvalidateHostPublication(route.PublicationGuard{
			HostSessionID: participant.sessionID,
			RouteRevision: snapshot.Revision,
			Generation:    publication.Generation,
			ConnectionID:  publication.ConnectionID,
		}, r.nowPtr())
		if !snapshot.RoomMedia {
			r.releaseResources(controller.RetireHostPublication(route.PublicationGuard{
				HostSessionID: participant.sessionID,
				RouteRevision: controller.Revision(),
				Generation:    publication.Generation,
				ConnectionID:  publication.ConnectionID,
			}))
		}
		r.broadcastActive(participant.roomID, rm)
		r.requestPump(participant.roomID)
		return
	}

	edge, hasEdge := snapshot.UpstreamByViewer.Get(participant.peerID)
	if !hasEdge || edge.ChildSessionID != participant.sessionID ||
		(connectionID != "" && connectionID != videoConnectionID(snapshot, edge)) {
		return
	}
	guard := route.EdgeGuard{
		ChildPeerID:    participant.peerID,
		ChildSessionID: participant.sessionID,
		RouteRevision:  snapshot.Revision,
		ConnectionID:   edge.ConnectionID,
	}
	if edge.Kind == route.UpstreamPeer {
		guard.ParentSessionID = edge.ParentSessionID
	}
	invalidated := controller.InvalidateEdge(guard, r.nowPtr())
	if invalidated && edge.Usable && snapshot.Paused && r.hooks.routesChanged != nil {
		r.hooks.routesChanged(participant.roomID)
	}
	r.requestPump(participant.roomID)
}

func (r *router) refreshSfu(participant authenticatedRouteParticipant, revision int64) {
	rm, _ := r.rooms.Get(participant.roomID)
	if rm != nil && rm.controller != nil && revision <= rm.controller.Revision() {
		r.sendFreshSfuConfig(participant)
	}
}

func (r *router) disconnectParticipant(roomID, peerID, sessionID string) {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.controller == nil || !rm.controller.DisconnectSession(peerID, sessionID) {
		return
	}
	r.requestPump(roomID)
}

func (r *router) removeViewer(roomID, peerID string) {
	rm, _ := r.rooms.Get(roomID)
	if rm != nil {
		rm.viewerSettings.Delete(peerID)
	}
	if rm != nil && rm.controller != nil && rm.controller.ConfirmDeparture(peerID, r.nowPtr()) {
		r.requestPump(roomID)
	}
}

// stopRoom preserves Viewer settings and the room's revision sequence across shares.
func (r *router) stopRoom(roomID string) {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil {
		return
	}
	if rm.roomMedia && rm.controller != nil {
		r.setVideoPublication(roomID, "", false)
		return
	}
	r.clearRoom(roomID)
	r.rooms.Set(roomID, &roomRuntime{revisions: rm.revisions, viewerSettings: rm.viewerSettings})
}

func (r *router) deleteRoom(roomID string) {
	r.clearRoom(roomID)
}

func (r *router) room(roomID string) *roomRuntime {
	rm, ok := r.rooms.Get(roomID)
	if !ok {
		rm = &roomRuntime{revisions: &route.RevisionSequence{}}
		r.rooms.Set(roomID, rm)
	}
	return rm
}

// createController connects viewers in store order.
func (r *router) createController(roomID string, rm *roomRuntime, host authenticatedRouteParticipant) {
	routePolicy := host.routePolicy
	operationTimeoutMs := defaultRouteOperationTimeoutMs
	if r.sfu != nil && r.sfu.prepareTimeoutMs != 0 {
		operationTimeoutMs = r.sfu.prepareTimeoutMs
	}
	rm.controller = route.New(route.Options{
		HostPeerID:                host.peerID,
		Revisions:                 rm.revisions,
		DebugRoomID:               roomID,
		DebugLog:                  routeDebugSink(),
		EndpointMediaCopyCapacity: r.capacity,
		OperationTimeoutMs:        operationTimeoutMs,
		SfuEnabled:                r.sfu != nil && !(routePolicy != nil && routePolicy.PeerOnly),
		SfuOnly:                   r.sfuOnly,
		QualityConvergenceEnabled: routePolicy != nil && routePolicy.TopologyOptimization,
		NatPredictionEnabled:      routePolicy != nil && routePolicy.NatPrediction,
	})
	if rm.roomMedia {
		rm.controller.SetVideoPublication(r.videoGeneration(roomID), false, r.now())
	}
	rm.controller.UpsertParticipant(route.ParticipantInput{
		PeerID:                      host.peerID,
		Role:                        protocol.RoleHost,
		SessionID:                   host.sessionID,
		EffectiveDownstreamCapacity: r.capacity,
	}, r.nowPtr())
	for _, viewer := range r.store.GetConnectedViewers(roomID) {
		if rm.roomMedia && r.videoGeneration(roomID) == "" &&
			(r.hooks.voiceAllowed == nil || !r.hooks.voiceAllowed(roomID, viewer.PeerID)) {
			continue
		}
		settings, _ := rm.viewerSettings.Get(viewer.PeerID)
		if settings.preference != "" && !r.viewerRouteAllowed(roomID, settings.preference) {
			settings.preference = protocol.ViewerRouteAuto
			rm.viewerSettings.Set(viewer.PeerID, settings)
			r.sendViewerRoutePreference(roomID, viewer.PeerID, true)
		}
		rm.controller.UpsertParticipant(route.ParticipantInput{
			PeerID:                      viewer.PeerID,
			Role:                        protocol.RoleViewer,
			SessionID:                   viewer.SessionID,
			EffectiveDownstreamCapacity: settings.capacity,
			RoutePreference:             settings.preference,
		}, r.nowPtr())
		rm.controller.SetRelayVolunteer(viewer.PeerID, viewer.SessionID, settings.volunteer, r.nowPtr())
	}
}

// clearRoom drains publications in admission order.
func (r *router) clearRoom(roomID string) {
	rm, ok := r.rooms.Get(roomID)
	if !ok {
		return
	}
	r.clearDeadline(rm)
	controller := rm.controller
	rm.controller = nil
	rm.requested = false
	if controller != nil {
		r.releaseResources(controller.Dispose())
	}
	r.rooms.Delete(roomID)
	r.resourceWaiters.Delete(roomID)
	if r.sfu != nil {
		for _, fence := range r.sfu.admission.BeginDrainRoom(roomID) {
			r.scheduleSfuPublicationDrain(fence)
		}
	}
}

// assignmentEdge is the value of the `edges` map of assignments().
type assignmentEdge struct {
	kind                  route.UpstreamKind
	parentPeerID          string
	publicationGeneration string
}

// assignments overlays the current attempt when candidate is non-nil
// and otherwise uses only the committed graph. Peers are the host first, then
// the store's viewer order; edges keep the snapshot's insertion
// order, which is the childPeerIds order on the wire.
func (r *router) assignments(
	roomID string,
	snapshot route.RouteSnapshot,
	candidate *route.CandidateTuple,
	candidateChildPeerID string,
	candidatePublicationGeneration string,
) map[string]protocol.ParticipantRouteAssignment {
	assignments := map[string]protocol.ParticipantRouteAssignment{}
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.hostPeerID == "" {
		return assignments
	}
	hostPeerID := rm.hostPeerID
	peerIDs := []string{hostPeerID}
	seen := map[string]struct{}{hostPeerID: {}}
	for _, peerID := range r.store.GetViewerPeerIDs(roomID) {
		if _, duplicate := seen[peerID]; !duplicate {
			seen[peerID] = struct{}{}
			peerIDs = append(peerIDs, peerID)
		}
	}
	edges := &ordered.Map[string, assignmentEdge]{}
	for childPeerID, edge := range snapshot.UpstreamByViewer.All() {
		if !edge.PhysicalActive {
			continue
		}
		if snapshot.RoomMedia && (!edge.VideoReady || edge.VideoGeneration != snapshot.VideoGeneration || snapshot.VideoGeneration == "") {
			continue
		}
		if edge.Kind == route.UpstreamPeer {
			edges.Set(childPeerID, assignmentEdge{kind: route.UpstreamPeer, parentPeerID: edge.ParentPeerID})
		} else {
			edges.Set(childPeerID, assignmentEdge{kind: route.UpstreamSfu, publicationGeneration: edge.PublicationGeneration})
		}
	}
	publicationGeneration := ""
	if snapshot.HostPublication != nil && snapshot.HostPublication.PhysicalActive {
		publicationGeneration = snapshot.HostPublication.Generation
	}
	if candidate != nil && candidateChildPeerID != "" {
		// The replacement candidate follows the surviving committed children.
		edges.Delete(candidateChildPeerID)
		if candidate.Kind == route.UpstreamPeer {
			edges.Set(candidateChildPeerID, assignmentEdge{kind: route.UpstreamPeer, parentPeerID: candidate.ParentPeerID})
			if old, hasOld := snapshot.UpstreamByViewer.Get(candidateChildPeerID); hasOld && old.Kind == route.UpstreamSfu {
				anySfu := false
				for _, edge := range edges.Values() {
					if edge.kind == route.UpstreamSfu {
						anySfu = true
						break
					}
				}
				if !anySfu {
					publicationGeneration = ""
				}
			}
		} else {
			if candidate.Publication != route.PublicationReuse {
				for peerID, edge := range edges.All() {
					if edge.kind == route.UpstreamSfu {
						edges.Delete(peerID)
					}
				}
				publicationGeneration = candidatePublicationGeneration
			}
			if publicationGeneration != "" {
				edges.Set(candidateChildPeerID, assignmentEdge{kind: route.UpstreamSfu, publicationGeneration: publicationGeneration})
			}
		}
	}
	var sourceReachable func(peerID string, visited map[string]struct{}) bool
	sourceReachable = func(peerID string, visited map[string]struct{}) bool {
		if peerID == hostPeerID {
			return true
		}
		if _, again := visited[peerID]; again {
			return false
		}
		visited[peerID] = struct{}{}
		edge, ok := edges.Get(peerID)
		if !ok {
			return false
		}
		if edge.kind == route.UpstreamSfu {
			return publicationGeneration == edge.publicationGeneration
		}
		return sourceReachable(edge.parentPeerID, visited)
	}
	for _, peerID := range peerIDs {
		edge, hasEdge := edges.Get(peerID)
		reachable := sourceReachable(peerID, map[string]struct{}{})
		childPeerIDs := []string{}
		for childPeerID, child := range edges.All() {
			if child.kind == route.UpstreamPeer && child.parentPeerID == peerID {
				childPeerIDs = append(childPeerIDs, childPeerID)
			}
		}
		upstream := protocol.NoUpstream()
		switch {
		case peerID == hostPeerID || !hasEdge:
		case edge.kind == route.UpstreamPeer:
			upstream = protocol.PeerUpstream(edge.parentPeerID)
		case reachable:
			upstream = protocol.SfuUpstream()
		}
		var sfuPublicationGeneration *string
		if peerID == hostPeerID {
			if publicationGeneration != "" {
				generation := publicationGeneration
				sfuPublicationGeneration = &generation
			}
		} else if reachable && hasEdge && edge.kind == route.UpstreamSfu {
			generation := edge.publicationGeneration
			sfuPublicationGeneration = &generation
		}
		assignments[peerID] = protocol.ParticipantRouteAssignment{
			Upstream:                 upstream,
			ChildPeerIDs:             childPeerIDs,
			SfuPublicationGeneration: sfuPublicationGeneration,
		}
	}
	return assignments
}

// broadcastActive sends to the host first, then viewers in store order,
// with one routesChanged call at the end.
func (r *router) broadcastActive(roomID string, rm *roomRuntime) {
	if rm.roomMedia && r.videoGeneration(roomID) == "" {
		if r.hooks.routesChanged != nil {
			r.hooks.routesChanged(roomID)
		}
		return
	}
	if rm.controller == nil {
		return
	}
	snapshot := rm.controller.Snapshot()
	if routeDebugEnabled() {
		type routeEntry struct {
			Child          string `json:"child"`
			Parent         string `json:"parent"`
			Usable         bool   `json:"usable"`
			PhysicalActive bool   `json:"physicalActive"`
		}
		routes := []routeEntry{}
		for childPeerID, edge := range snapshot.UpstreamByViewer.All() {
			parent := "sfu"
			if edge.Kind == route.UpstreamPeer {
				parent = r.debugPeer(roomID, edge.ParentPeerID)
			}
			routes = append(routes, routeEntry{r.debugPeer(roomID, childPeerID), parent, edge.Usable, edge.PhysicalActive})
		}
		r.debug(roomID, "active-topology",
			"revision", snapshot.Revision,
			"paused", snapshot.Paused,
			"committedHostPublication", snapshot.HostPublication != nil && snapshot.HostPublication.PhysicalActive,
			"routes", routes)
	}
	assignments := r.assignments(roomID, snapshot, nil, "", "")
	var participants []room.ConnectedPeer
	if host, ok := r.store.GetConnectedHost(roomID); ok {
		participants = append(participants, host)
	}
	participants = append(participants, r.store.GetConnectedViewers(roomID)...)
	for _, participant := range participants {
		r.hooks.sendToSession(participant.SessionID, protocol.RouteUpdateActiveMessage{
			Type:       "route-update",
			Revision:   protocol.Int(snapshot.Revision),
			Phase:      "active",
			Assignment: assignmentFor(assignments, participant.PeerID),
		})
	}
	if r.hooks.routesChanged != nil {
		r.hooks.routesChanged(roomID)
	}
}

func (r *router) pathIsPhysical(roomID string, snapshot route.RouteSnapshot, childPeerID string) bool {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.hostPeerID == "" {
		return false
	}
	hostPeerID := rm.hostPeerID
	seen := map[string]struct{}{}
	current := childPeerID
	for current != hostPeerID {
		if _, again := seen[current]; again {
			return false
		}
		seen[current] = struct{}{}
		edge, ok := snapshot.UpstreamByViewer.Get(current)
		if !ok || !edge.PhysicalActive || !edge.Usable {
			return false
		}
		if snapshot.RoomMedia && (!edge.VideoReady || edge.VideoGeneration != snapshot.VideoGeneration || snapshot.VideoGeneration == "") {
			return false
		}
		if edge.Kind == route.UpstreamSfu {
			return snapshot.HostPublication != nil &&
				snapshot.HostPublication.PhysicalActive &&
				snapshot.HostPublication.Generation == edge.PublicationGeneration
		}
		if edge.ParentPeerID == hostPeerID {
			return true
		}
		current = edge.ParentPeerID
	}
	return true
}

// childForPair returns an empty string when neither peer is the other's child.
func childForPair(snapshot route.RouteSnapshot, firstPeerID, secondPeerID string) string {
	if first, ok := snapshot.UpstreamByViewer.Get(firstPeerID); ok &&
		first.Kind == route.UpstreamPeer && first.ParentPeerID == secondPeerID {
		return firstPeerID
	}
	if second, ok := snapshot.UpstreamByViewer.Get(secondPeerID); ok &&
		second.Kind == route.UpstreamPeer && second.ParentPeerID == firstPeerID {
		return secondPeerID
	}
	return ""
}

func (r *router) connectedPeer(roomID, peerID string) (room.ConnectedPeer, bool) {
	if host, ok := r.store.GetConnectedHost(roomID); ok && host.PeerID == peerID {
		return host, true
	}
	return r.store.GetConnectedViewer(roomID, peerID)
}

func (r *router) debugPeer(roomID, peerID string) string {
	rm, _ := r.rooms.Get(roomID)
	if rm != nil && peerID == rm.hostPeerID {
		return "host"
	}
	if rm != nil && rm.controller != nil {
		return rm.controller.DiagnosticParticipantLabel(peerID)
	}
	return "viewer-unknown"
}

// qualitySample is QualitySampleReference; kind selects the peer or sfu
// fields.
type qualitySample struct {
	kind                  route.UpstreamKind
	childPeerID           string
	routeRevision         int64
	connectionID          string
	publicationGeneration string
	hostSessionID         string
}

// qualityCopyContext attributes copy demand to committed and candidate work;
// operationReason and candidateTransition are empty when no such work exists.
type qualityCopyContext struct {
	committedCopies         int
	candidateReservedCopies int
	possibleCopies          int
	endpointCapacity        int
	operationReason         route.DemandReason
	candidateTransition     route.TransitionKind
	sampleRole              string
}

// kv is the `...copyContext` spread of the debug events.
func (c qualityCopyContext) kv() []any {
	return []any{
		"committedCopies", c.committedCopies,
		"candidateReservedCopies", c.candidateReservedCopies,
		"possibleCopies", c.possibleCopies,
		"endpointCapacity", c.endpointCapacity,
		"operationReason", nullString(string(c.operationReason)),
		"candidateTransition", nullString(string(c.candidateTransition)),
		"sampleRole", c.sampleRole,
	}
}

// qualityCopyContext uses counts without depending on iteration order.
func (r *router) qualityCopyContext(
	snapshot route.RouteSnapshot,
	hostPeerID string,
	observedPeerID string,
	endpointCapacity int,
	sample qualitySample,
) qualityCopyContext {
	committedCopies := 0
	for _, edge := range snapshot.UpstreamByViewer.Values() {
		if edge.Kind == route.UpstreamPeer && edge.ParentPeerID == observedPeerID && edge.PhysicalActive {
			committedCopies++
		}
	}
	if observedPeerID == hostPeerID && snapshot.HostPublication != nil && snapshot.HostPublication.PhysicalActive {
		committedCopies++
	}

	operation := snapshot.Operation
	var current *route.CurrentAttempt
	var currentPlan *route.CandidatePlan
	if operation != nil {
		current = operation.Current
		if current != nil && operation.Cursor >= 0 && operation.Cursor < len(operation.Candidates) {
			plan := operation.Candidates[operation.Cursor]
			currentPlan = &plan
		}
	}
	candidateReservedCopies := 0
	if current != nil {
		if current.Tuple.Kind == route.UpstreamPeer && current.Tuple.ParentPeerID == observedPeerID {
			candidateReservedCopies = 1
		} else if current.Tuple.Kind == route.UpstreamSfu && observedPeerID == hostPeerID &&
			current.Tuple.Publication != route.PublicationReuse {
			candidateReservedCopies = 1
		}
	}

	candidateSample := false
	if current != nil {
		if sample.kind == route.UpstreamPeer {
			candidateSample = current.Tuple.Kind == route.UpstreamPeer &&
				operation.ChildPeerID == sample.childPeerID &&
				current.Tuple.ParentPeerID == observedPeerID &&
				current.Revision == sample.routeRevision &&
				current.ConnectionID == sample.connectionID
		} else {
			candidateSample = current.Tuple.Kind == route.UpstreamSfu &&
				observedPeerID == hostPeerID &&
				current.Revision == sample.routeRevision
		}
	}
	activeSample := false
	if sample.kind == route.UpstreamPeer {
		activeEdge, hasActive := snapshot.UpstreamByViewer.Get(sample.childPeerID)
		activeSample = sample.routeRevision == snapshot.Revision &&
			hasActive && activeEdge.Kind == route.UpstreamPeer &&
			activeEdge.PhysicalActive && activeEdge.Usable &&
			activeEdge.ParentPeerID == observedPeerID &&
			activeEdge.ConnectionID == sample.connectionID
	} else {
		publication := snapshot.HostPublication
		activeSample = sample.routeRevision == snapshot.Revision &&
			publication != nil && publication.PhysicalActive && publication.Usable &&
			publication.Generation == sample.publicationGeneration &&
			publication.HostSessionID == sample.hostSessionID
	}

	context := qualityCopyContext{
		committedCopies:         committedCopies,
		candidateReservedCopies: candidateReservedCopies,
		possibleCopies:          committedCopies + candidateReservedCopies,
		endpointCapacity:        endpointCapacity,
		sampleRole:              "unknown",
	}
	if operation != nil {
		context.operationReason = operation.Reason
	}
	if currentPlan != nil {
		context.candidateTransition = currentPlan.EndpointTransition.Kind
	}
	if candidateSample {
		context.sampleRole = "candidate"
	} else if activeSample {
		context.sampleRole = "active"
	}
	return context
}

func (r *router) debugTuple(roomID string, tuple route.CandidateTuple) string {
	if tuple.Kind == route.UpstreamPeer {
		label := "p2p:" + r.debugPeer(roomID, tuple.ParentPeerID)
		if tuple.Regenerate {
			label += ":regenerate"
		}
		return label
	}
	return "sfu:" + string(tuple.Publication)
}

// debug emits one sanitised slog event. Details are key/value
// pairs; never pass raw peer, session or connection IDs (use debugPeer).
func (r *router) debug(roomID, event string, details ...any) {
	if !routeDebugEnabled() {
		return
	}
	args := make([]any, 0, 4+len(details))
	args = append(args, "event", event, "roomId", roomID)
	args = append(args, details...)
	slog.Info("piik-route", args...)
}

// sendRoomError notifies only the connected host.
func (r *router) sendRoomError(roomID, code, message string) {
	if host, ok := r.store.GetConnectedHost(roomID); ok {
		r.hooks.sendToSession(host.SessionID, protocol.ErrorMessage{Type: "error", Code: code, Message: message})
	}
}

func (r *router) sendViewerRouteStatus(roomID, viewerPeerID string, message protocol.RouteStatusMessage) {
	if rm, _ := r.rooms.Get(roomID); rm != nil && rm.roomMedia && rm.controller != nil {
		snapshot := rm.controller.Snapshot()
		if snapshot.VideoGeneration == "" || snapshot.VideoPaused {
			if message.State == "failed" && r.hooks.voiceRouteFailed != nil {
				r.hooks.voiceRouteFailed(roomID, viewerPeerID)
			}
			return
		}
	}
	if viewer, ok := r.store.GetConnectedViewer(roomID, viewerPeerID); ok {
		r.hooks.sendToSession(viewer.SessionID, message)
	}
}

// sendRouteFailures deduplicates recipients; first occurrence wins.
func (r *router) sendRouteFailures(roomID string, failedPeerIDs []string, revision int64) {
	seen := map[string]struct{}{}
	for _, peerID := range failedPeerIDs {
		if _, duplicate := seen[peerID]; duplicate {
			continue
		}
		seen[peerID] = struct{}{}
		r.sendViewerRouteStatus(roomID, peerID, protocol.RouteStatusMessage{
			Type:     "route-status",
			Revision: protocol.Int(revision),
			State:    "failed",
			Reason:   "route-exhausted",
		})
	}
}

func (r *router) nowPtr() *int64 {
	now := r.now()
	return &now
}

func emptyAssignment() protocol.ParticipantRouteAssignment {
	return protocol.ParticipantRouteAssignment{
		Upstream:                 protocol.NoUpstream(),
		ChildPeerIDs:             []string{},
		SfuPublicationGeneration: nil,
	}
}

func assignmentFor(assignments map[string]protocol.ParticipantRouteAssignment, peerID string) protocol.ParticipantRouteAssignment {
	if assignment, ok := assignments[peerID]; ok {
		return assignment
	}
	return emptyAssignment()
}

// opaqueID encodes 16 random bytes as base64url without padding.
func opaqueID() string {
	value := make([]byte, 16)
	// crypto/rand.Read never fails; it panics if the operating system source does.
	_, _ = rand.Read(value)
	return base64.RawURLEncoding.EncodeToString(value)
}

func sampleTimestamp(value *protocol.Num) *int64 {
	if value == nil {
		return nil
	}
	timestamp := int64(*value)
	return &timestamp
}

func intFloat(value *protocol.Int) *float64 {
	if value == nil {
		return nil
	}
	converted := float64(*value)
	return &converted
}

// optional is the debug value of a nullable pointer field: nil for null.
func optional[T any](value *T) any {
	if value == nil {
		return nil
	}
	return *value
}

// nullable is the `value ?? null` of an optional-and-nullable field.
func nullable[T any](value protocol.Nullable[T]) any {
	if value.Value == nil {
		return nil
	}
	return *value.Value
}

// nullString emits absent debug identities as null.
func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
