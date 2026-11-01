// Package signal owns authenticated signaling and room/media effects. It
// serializes session and presence changes, HTTP-facing room mutations, and
// execution of the synchronous route controller's decisions.
//
// # Locking
//
// Server.mu is the one lock of the effect layer: it guards every field of
// the server and the router, the room.Store and the route controllers. Every
// handler, timer callback and goroutine takes it; password KDF and media
// transport work run unlocked, after which current session,
// room and operation identities must be revalidated. Router methods and hooks are
// called with mu held and never lock. Room persistence and the optional route
// diagnostic sink are synchronous and belong in this lock's latency budget.
package signal

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"

	"zviewer/backend/internal/piik/server/config"
	"zviewer/backend/internal/piik/server/ordered"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

// Connection admission, queue and timeout bounds limit the signaling resources
// a stalled or unauthenticated peer can retain.
const (
	// maxBufferedSignalBytes bounds unsent data per connection; exceeding it
	// terminates a stalled reader before it can grow the server's heap.
	maxBufferedSignalBytes = 256 * 1024
	// defaultMaxSignalConnections and defaultMaxUnauthenticatedConnections are
	// admission ceilings: 20 viewers plus a host across 9_000
	// room codes is far above either, so they bound abuse, not capacity.
	defaultMaxSignalConnections          = 2_048
	defaultMaxUnauthenticatedConnections = 256
	// minSignalingChallengeIntervalMs bounds liveness challenge frequency.
	minSignalingChallengeIntervalMs = int64(1_000)
	// serviceRestartCloseGrace is how long a
	// peer has to acknowledge close{1012} before the socket is terminated.
	serviceRestartCloseGrace = 1_000 * time.Millisecond

	defaultAuthenticationTimeoutMs = 5_000
	// Covers the Browser's nominal first five reconnect backoffs (about
	// 0.5-15.5 s); connection/authentication time can extend those attempts.
	defaultViewerDisconnectGraceMs = 20_000
	defaultHeartbeatIntervalMs     = 30_000
)

// SfuFallback configures embedded media; a zero prepare timeout selects the
// router's default.
type SfuFallback struct {
	Media            sfu.Runtime
	Admission        *sfu.Admission
	PrepareTimeoutMs int64
}

// Options supplies room authority, runtime capabilities and signaling limits.
type Options struct {
	Store                     *room.Store
	EndpointMediaCopyCapacity int
	// SfuFallback is nil when embedded SFU media is disabled.
	SfuFallback *SfuFallback
	// SfuOnly restricts the existing controller to server media candidates.
	SfuOnly bool
	// Ice is the derived wire ICE configuration (config.IceConfig).
	Ice protocol.IceConfig
	// NATPredictionEnabled is the server capability that clamps a Host's
	// requested natPrediction route policy (configuredRoutePolicy). It is
	// not derivable from Ice: an enabled capability with no STUN listener
	// still echoes the Host's policy.
	NATPredictionEnabled bool
	AllowedOrigins       map[string]struct{}
	SiteAccessAtUpgrade  func(*http.Request) bool
	PublicBaseURL        *url.URL
	// Now returns Unix milliseconds; nil uses the wall clock.
	Now                     func() int64
	AuthenticationTimeoutMs int
	ViewerDisconnectGraceMs int
	HeartbeatIntervalMs     int
	// Zero retains room authority indefinitely. Otherwise empty rooms expire
	// and allocation pressure may reclaim the oldest empty room early.
	RoomEmptyTimeoutMs            int64
	MaxConnections                int
	MaxUnauthenticatedConnections int
	// AfterFunc is the timer factory; nil uses time.AfterFunc.
	AfterFunc func(time.Duration, func()) func() bool
	// Logger receives signaling failures; nil uses slog.Default().
	Logger *slog.Logger
}

// viewerQualityEvidenceGate rejects stale or repeated evidence for the current
// edge and presentation epoch. upstreamPeerID is empty for SFU.
type viewerQualityEvidenceGate struct {
	viewerSessionID   string
	upstreamKind      string
	upstreamPeerID    string
	connectionID      string
	presentationEpoch int64
	sequence          int64
}

// viewerQualityEvidenceAttempt scopes the rate window to a committed connection.
// A replacement connection is not held back by its predecessor's timestamp.
// Reports for the same connection remain subject to the existing window.
type viewerQualityEvidenceAttempt struct {
	connectionID string
	atMs         int64
}

// roomShare owns one room's Host publication intent. Its zero value means no
// intent; active generations are nonempty, falling back to the Host session ID.
type roomShare struct {
	// generation survives stopSharing; only closeRoom drops the whole
	// record.
	generation string
	// Missing qualitySettings and routePolicy remain nil; their presence
	// affects the host's authenticated response and quality defaults.
	qualitySettings *protocol.QualitySettings
	routePolicy     *protocol.RoutePolicy
	// pausedGeneration is the share generation the Host paused, "" if none.
	pausedGeneration string
	audioAvailable   *bool
	coPlayGrants     []protocol.CoPlayGrant
}

type senderQualityRateWindow struct {
	startedAtMs int64
	count       int
}

// graceTimer callbacks compare their registered pointer so replacement or
// cancellation invalidates a callback even after its timer has fired.
type graceTimer struct {
	stop func() bool
}

// Server owns room signaling and serializes its effects.
type Server struct {
	// ponytail: global lock, per-room locks if throughput matters
	mu sync.Mutex

	store                     *room.Store
	endpointMediaCopyCapacity int
	sfuFallback               *SfuFallback
	ice                       protocol.IceConfig
	natPredictionEnabled      bool
	allowedOrigins            map[string]struct{}
	siteAccessAtUpgrade       func(*http.Request) bool
	publicBaseURL             *url.URL
	now                       func() int64
	afterFunc                 func(time.Duration, func()) func() bool
	logger                    *slog.Logger

	authenticationTimeoutMs       int
	viewerDisconnectGraceMs       int
	heartbeatIntervalMs           int
	roomEmptyTimeoutMs            int64
	maxConnections                int
	maxUnauthenticatedConnections int

	router *router

	// Heartbeat walks sessions in insertion order; sessionsByID indexes them.
	sessions     ordered.Map[*session, struct{}]
	sessionsByID map[string]*session
	// pendingConnections reserves the slots of upgrades between the capacity
	// check and accept().
	pendingConnections         int
	unauthenticatedConnections int

	viewerGraceTimers             map[string]*graceTimer
	viewerQualityEvidenceGates    map[string]viewerQualityEvidenceGate
	viewerQualityEvidenceAttempts map[string]viewerQualityEvidenceAttempt
	senderQualityRateBySession    map[string]*senderQualityRateWindow
	// shares keeps generation, settings, route policy and pause intent together.
	shares                      map[string]roomShare
	voices                      map[string]*roomVoice
	deferredViewerPresenceRooms map[string]struct{}

	heartbeatStop func() bool
	closing       bool
}

// New creates the signaling owner and starts its heartbeat timer.
func New(options Options) (*Server, error) {
	if err := protocol.AssertEndpointMediaCopyCapacity(options.EndpointMediaCopyCapacity); err != nil {
		return nil, err
	}
	if options.Store == nil {
		return nil, errors.New("signaling requires a room store")
	}
	if options.SfuFallback != nil && (options.SfuFallback.Media == nil || options.SfuFallback.Admission == nil) {
		return nil, errors.New("SFU fallback requires media and resource admission")
	}
	if options.SfuOnly && options.SfuFallback == nil {
		return nil, errors.New("SFU-only routing requires SFU media and resource admission")
	}
	s := &Server{
		store:                         options.Store,
		endpointMediaCopyCapacity:     options.EndpointMediaCopyCapacity,
		sfuFallback:                   options.SfuFallback,
		ice:                           options.Ice,
		natPredictionEnabled:          options.NATPredictionEnabled,
		allowedOrigins:                options.AllowedOrigins,
		siteAccessAtUpgrade:           options.SiteAccessAtUpgrade,
		publicBaseURL:                 options.PublicBaseURL,
		now:                           options.Now,
		afterFunc:                     options.AfterFunc,
		logger:                        options.Logger,
		authenticationTimeoutMs:       orDefault(options.AuthenticationTimeoutMs, defaultAuthenticationTimeoutMs),
		viewerDisconnectGraceMs:       orDefault(options.ViewerDisconnectGraceMs, defaultViewerDisconnectGraceMs),
		heartbeatIntervalMs:           orDefault(options.HeartbeatIntervalMs, defaultHeartbeatIntervalMs),
		roomEmptyTimeoutMs:            options.RoomEmptyTimeoutMs,
		maxConnections:                orDefault(options.MaxConnections, defaultMaxSignalConnections),
		maxUnauthenticatedConnections: orDefault(options.MaxUnauthenticatedConnections, defaultMaxUnauthenticatedConnections),
		sessionsByID:                  map[string]*session{},
		viewerGraceTimers:             map[string]*graceTimer{},
		viewerQualityEvidenceGates:    map[string]viewerQualityEvidenceGate{},
		viewerQualityEvidenceAttempts: map[string]viewerQualityEvidenceAttempt{},
		senderQualityRateBySession:    map[string]*senderQualityRateWindow{},
		shares:                        map[string]roomShare{},
		deferredViewerPresenceRooms:   map[string]struct{}{},
	}
	if s.maxConnections <= 0 || s.maxUnauthenticatedConnections <= 0 ||
		s.maxUnauthenticatedConnections > s.maxConnections {
		return nil, errors.New("WebSocket connection limits are invalid")
	}
	if s.now == nil {
		s.now = func() int64 { return time.Now().UnixMilli() }
	}
	if s.afterFunc == nil {
		s.afterFunc = func(d time.Duration, fn func()) func() bool {
			return time.AfterFunc(d, fn).Stop
		}
	}
	if s.logger == nil {
		s.logger = slog.Default()
	}
	if s.siteAccessAtUpgrade == nil {
		s.siteAccessAtUpgrade = func(*http.Request) bool { return true }
	}
	var fallback *sfuFallback
	if options.SfuFallback != nil {
		fallback = &sfuFallback{
			media:            options.SfuFallback.Media,
			admission:        options.SfuFallback.Admission,
			prepareTimeoutMs: options.SfuFallback.PrepareTimeoutMs,
		}
	}
	mediaRouter, err := buildRouter(routerOptions{
		mu:                        &s.mu,
		store:                     s.store,
		endpointMediaCopyCapacity: s.endpointMediaCopyCapacity,
		sfu:                       fallback,
		sfuOnly:                   options.SfuOnly,
		hooks: routerHooks{
			sendToSession:   s.sendToSession,
			shareGeneration: func(roomID string) string { return s.shares[roomID].generation },
			routesChanged: func(roomID string) {
				s.sendViewerPresence(roomID)
				s.syncRoomVoice(roomID)
			},
			voiceAllowed:        s.voiceAllowed,
			voiceDemandChanged:  s.syncVoiceDemand,
			voiceCandidateReady: s.voiceCandidateReady,
			voiceRouteFailed:    s.voiceRouteFailed,
			videoGeneration:     s.activeHostShareGeneration,
		},
		now:       s.now,
		afterFunc: s.afterFunc,
	})
	if err != nil {
		return nil, err
	}
	s.router = mediaRouter
	s.mu.Lock()
	s.armHeartbeat()
	s.mu.Unlock()
	return s, nil
}

// buildRouter returns constructor assertions through the startup error path.
func buildRouter(options routerOptions) (r *router, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%v", recovered)
		}
	}()
	return newRouter(options), nil
}

func orDefault(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

// InviteURL adds an optional Viewer grant only in the URL fragment, keeping it
// out of HTTP requests. Existing base URL query/fragment values are discarded.
func InviteURL(publicBaseURL *url.URL, roomID, viewerGrant string) string {
	invite := *publicBaseURL
	invite.Opaque = ""
	invite.Path = "/r/" + roomID
	invite.RawPath = ""
	invite.ForceQuery = false
	invite.RawQuery = ""
	invite.Fragment = ""
	invite.RawFragment = ""
	if viewerGrant != "" {
		invite.Fragment = "v=" + viewerGrant
	}
	return invite.String()
}

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

// ServeHTTP validates the signaling endpoint, origin and capacity before upgrade.
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	// HTTP parsing accepts scheme-relative targets as paths; reject malformed
	// authorities such as "//[" before checking the endpoint.
	if _, err := url.Parse(request.RequestURI); err != nil {
		rejectUpgrade(writer, http.StatusBadRequest)
		return
	}
	// Match the literal endpoint, rejecting encoded aliases such as "/%73ignal",
	// just as the sibling HTTP router's requestPath does.
	if request.URL.EscapedPath() != "/signal" || request.URL.RawQuery != "" {
		rejectUpgrade(writer, http.StatusNotFound)
		return
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		rejectUpgrade(writer, http.StatusServiceUnavailable)
		return
	}
	if !s.isAllowedOrigin(request.Header.Get("Origin")) {
		s.mu.Unlock()
		rejectUpgrade(writer, http.StatusForbidden)
		return
	}
	if !s.hasConnectionCapacity() {
		s.mu.Unlock()
		rejectUpgrade(writer, http.StatusServiceUnavailable)
		return
	}
	// Reserve capacity before Accept performs I/O outside the lock.
	s.pendingConnections++
	s.mu.Unlock()

	siteAccessAuthenticated := s.siteAccessAtUpgrade(request)
	var sess *session
	// Origin was verified above with the exact isAllowedOrigin rule, so the
	// library's own check is skipped.
	conn, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
		OnPongReceived: func(context.Context, []byte) {
			s.mu.Lock()
			if sess != nil {
				sess.alive = true
			}
			s.mu.Unlock()
		},
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pendingConnections--
	if err != nil {
		return
	}
	conn.SetReadLimit(protocol.MaxSignalBytes)
	sess = s.accept(conn, siteAccessAuthenticated)
}

// rejectUpgrade is `HTTP/1.1 {status} {message}\r\nConnection: close\r\n
// Content-Length: 0\r\n\r\n`; net/http supplies the reason phrase.
func rejectUpgrade(writer http.ResponseWriter, status int) {
	writer.Header().Set("Connection", "close")
	writer.Header().Set("Content-Length", "0")
	writer.WriteHeader(status)
}

// isAllowedOrigin requires a present, parseable origin equal to its own
// serialised origin (so "http://x/path" is refused) and configured.
func (s *Server) isAllowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	_, allowed := s.allowedOrigins[origin]
	return config.Origin(parsed) == origin && allowed
}

// hasConnectionCapacity includes reserved upgrade slots.
func (s *Server) hasConnectionCapacity() bool {
	return !s.closing &&
		s.sessions.Len()+s.pendingConnections < s.maxConnections &&
		s.unauthenticatedConnections+s.pendingConnections < s.maxUnauthenticatedConnections
}

// ---------------------------------------------------------------------------
// lifecycle and HTTP-facing mutations
// ---------------------------------------------------------------------------

// Close tells every client 1012 "Service restart" before the router drains.
// Readers get one second to finish
// the close handshake, survivors are terminated, and the router's drain
// error, if any, is returned after everything else settled.
func (s *Server) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	for roomID := range s.voices {
		s.closeRoomVoice(roomID)
	}
	if s.heartbeatStop != nil {
		s.heartbeatStop()
	}
	for key, timer := range s.viewerGraceTimers {
		timer.stop()
		delete(s.viewerGraceTimers, key)
	}
	sessions := s.sessions.Keys()
	for _, sess := range sessions {
		sess.clearAuthenticationTimer()
		sess.close(websocket.StatusServiceRestart, "Service restart")
	}

	// Start reader grace before draining the router. After the drain, wait
	// only for the remaining grace or ctx cancellation, then force-close
	// surviving readers.
	grace := time.NewTimer(serviceRestartCloseGrace)
	defer grace.Stop()
	// Keep mu held through the router's synchronous closing prefix so a
	// timer callback cannot start a new media operation during shutdown.
	routeCloseError := s.router.close(ctx)
	s.mu.Unlock()

	// A fired timer channel never delivers again, so once the grace has expired
	// every session still inside its close handshake is a survivor.
	var survivors []*session
	expired := false
	for _, sess := range sessions {
		if !expired {
			select {
			case <-sess.readerDone:
				continue
			case <-grace.C:
			case <-ctx.Done():
			}
			expired = true
		}
		select {
		case <-sess.readerDone:
		default:
			survivors = append(survivors, sess)
		}
	}
	if len(survivors) > 0 {
		s.mu.Lock()
		for _, sess := range survivors {
			sess.terminate()
		}
		s.mu.Unlock()
		for _, sess := range survivors {
			select {
			case <-sess.readerDone:
			case <-ctx.Done():
			}
		}
	}
	return routeCloseError
}

// CloseStorage follows HTTP draining. A timed-out drain can leave admitted
// mutations running, so database closure still takes the store's owning lock.
func (s *Server) CloseStorage() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.Close()
}

// EndAllRooms closes rooms in store order.
func (s *Server) EndAllRooms() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	closedRooms, err := s.store.AbandonAllRooms()
	if err != nil {
		return err
	}
	for _, closed := range closedRooms {
		s.closeRoom(closed)
	}
	return nil
}

// UpdateRoomAccess releases mu around the password KDF for set-viewer-password,
// following the room package's sequence. Room mutations take no context: they
// run to completion even when the browser goes away, avoiding partial mutation.
func (s *Server) UpdateRoomAccess(
	roomID, hostToken string,
	request protocol.RoomAccessUpdateRequest,
) (protocol.RoomAccessUpdateResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch action := request.(type) {
	case protocol.SetCodeEntryPolicyRequest:
		update, err := s.store.SetCodeEntryPolicy(roomID, action.Policy, hostToken)
		if err != nil {
			return nil, err
		}
		return protocol.CodeEntryPolicyUpdatedResponse{
			Type:                  "code-entry-policy-updated",
			CodeEntryPolicy:       update.CodeEntryPolicy,
			ViewerPasswordEnabled: update.ViewerPasswordEnabled,
		}, nil
	case protocol.SetViewerPasswordRequest:
		current, err := s.store.HostManagedRoom(roomID, hostToken)
		if err != nil {
			return nil, err
		}
		material, derived := s.deriveViewerPasswordMaterial(roomID, hostToken, action.Password, current)
		enabled, err := s.store.SetViewerPassword(roomID, hostToken, material, derived, current)
		if err != nil {
			return nil, err
		}
		return protocol.ViewerPasswordUpdatedResponse{Type: "viewer-password-updated", Enabled: enabled}, nil
	case protocol.RotateViewerGrantRequest, protocol.RevokeViewerGrantRequest:
		verb := "revoke"
		if _, rotate := action.(protocol.RotateViewerGrantRequest); rotate {
			verb = "rotate"
		}
		update, err := s.store.SetViewerGrant(roomID, verb, hostToken)
		if err != nil {
			return nil, err
		}
		s.revokeGrantViewers(roomID, update)
		var inviteURL *string
		if verb == "rotate" {
			invite := InviteURL(s.publicBaseURL, roomID, update.ViewerGrant)
			inviteURL = &invite
		}
		return protocol.ViewerGrantUpdatedResponse{
			Type:                          "viewer-grant-updated",
			ViewerAuthorizationGeneration: update.ViewerAuthorizationGeneration,
			InviteURL:                     inviteURL,
		}, nil
	}
	return nil, fmt.Errorf("unknown room access request %T", request)
}

// deriveViewerPasswordMaterial releases mu for password derivation, rechecking
// exact room/Host authority when the gate admits the work. The caller holds mu;
// a nil or empty password derives nothing.
func (s *Server) deriveViewerPasswordMaterial(
	roomID, hostToken string, password *string, current *room.Room,
) (material []byte, derived error) {
	if password == nil || *password == "" {
		return nil, nil
	}
	s.mu.Unlock()
	defer s.mu.Lock()
	return s.store.DeriveViewerPasswordMaterial(*password, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.store.HostStillOwnsRoom(roomID, hostToken, current)
	})
}

// ReplaceRoom runs the KDF unlocked; the commit and closeRoom run locked.
func (s *Server) ReplaceRoom(
	roomID, hostToken string,
	codeEntryPolicy protocol.CodeEntryPolicy,
	roomPassword *string,
) (room.CreatedRoom, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.store.HostManagedRoom(roomID, hostToken)
	if err != nil {
		return room.CreatedRoom{}, err
	}
	material, derived := s.deriveViewerPasswordMaterial(roomID, hostToken, roomPassword, current)
	replacement, err := s.store.ReplaceRoom(roomID, hostToken, codeEntryPolicy, material, derived, current)
	if derived == nil {
		if candidate := s.roomCapacityCandidate(err, roomID); candidate != "" {
			if err = s.abandonRoom(candidate); err == nil {
				replacement, err = s.store.ReplaceRoom(roomID, hostToken, codeEntryPolicy, material, derived, current)
			}
		}
	}
	if err != nil {
		return room.CreatedRoom{}, err
	}
	s.closeRoom(replacement.Closed)
	return replacement.Created, nil
}

// CreateRoom serializes room admission and commit, releasing mu for password
// derivation according to the room package's locking contract.
func (s *Server) CreateRoom(
	codeEntryPolicy protocol.CodeEntryPolicy,
	roomPassword *string,
	preferredRoomID string,
) (room.CreatedRoom, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.BeginCreateRoom(); err != nil && s.roomCapacityCandidate(err, "") == "" {
		return room.CreatedRoom{}, err
	}
	var material []byte
	var derived error
	if roomPassword != nil && *roomPassword != "" {
		func() {
			s.mu.Unlock()
			defer s.mu.Lock()
			material, derived = s.store.DeriveViewerPasswordMaterial(*roomPassword, nil)
		}()
	}
	created, err := s.store.CreateRoom(codeEntryPolicy, material, derived, preferredRoomID)
	if derived == nil {
		if candidate := s.roomCapacityCandidate(err, ""); candidate != "" {
			if err = s.abandonRoom(candidate); err == nil {
				created, err = s.store.CreateRoom(codeEntryPolicy, material, derived, preferredRoomID)
			}
		}
	}
	return created, err
}

// armHeartbeat is the heartbeat setInterval: each tick re-arms the
// next; a tick that lost the Stop race sees closing.
func (s *Server) armHeartbeat() {
	interval := time.Duration(s.heartbeatIntervalMs) * time.Millisecond
	s.heartbeatStop = s.afterFunc(interval, func() {
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			return
		}
		pings := s.heartbeat()
		s.expireEmptyRooms()
		s.armHeartbeat()
		s.mu.Unlock()
		for _, sess := range pings {
			go sess.ping(interval)
		}
	})
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

// handleMessage requires mu to be held.
func (s *Server) handleMessage(sess *session, encoded []byte) {
	if !s.sessions.Has(sess) || s.closing || !sess.open() {
		return
	}
	if sess.revoked {
		return
	}
	message, err := protocol.DecodeClientMessage(encoded)
	if err != nil {
		s.rejectInvalidMessage(sess)
		return
	}
	if _, evidence := message.(protocol.ViewerQualityEvidenceMessage); evidence &&
		len(encoded) > protocol.MaxViewerQualityEvidenceBytes {
		s.rejectInvalidMessage(sess)
		return
	}

	if sess.authenticated == nil {
		request, isAuthenticate := authRequestOf(message)
		if !isAuthenticate {
			s.sendError(sess, "AUTH_REQUIRED", "Authenticate before sending messages")
			sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication required")
			return
		}
		if sess.authenticating {
			s.rejectInvalidMessage(sess)
			return
		}
		sess.authenticating = true
		s.authenticate(sess, request)
		return
	}
	if _, isAuthenticate := message.(protocol.AuthenticateHostMessage); isAuthenticate {
		s.sendError(sess, "FORBIDDEN", "Session is already authenticated")
		return
	}
	if _, isAuthenticate := message.(protocol.AuthenticateViewerMessage); isAuthenticate {
		s.sendError(sess, "FORBIDDEN", "Session is already authenticated")
		return
	}
	if !s.isCurrentSession(sess) {
		sess.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Session replaced")
		return
	}
	s.handleAuthenticatedMessage(sess, sess.authenticated, message)
}

// authRequest is the role-agnostic view of an authenticate message: the
// fields authenticate() and authenticationErrorCode() read. Empty strings
// and nil pointers are absent keys.
type authRequest struct {
	role            protocol.Role
	roomID          string
	clientID        string
	token           string
	viewerGrant     string
	viewerPassword  string
	routePreference *protocol.ViewerRoutePreference
	shareGeneration string
	sharingPaused   bool
	qualitySettings *protocol.QualitySettings
	routePolicy     protocol.RoutePolicy
	viewerPresence  bool
	displayName     *string
	roomOnly        bool
	roomSession     bool
}

func authRequestOf(message protocol.ClientMessage) (authRequest, bool) {
	switch m := message.(type) {
	case protocol.AuthenticateHostMessage:
		return authRequest{
			role:            protocol.RoleHost,
			roomID:          m.RoomID,
			clientID:        m.ClientID,
			token:           m.Token,
			shareGeneration: m.ShareGeneration,
			sharingPaused:   m.SharingPaused != nil && *m.SharingPaused,
			qualitySettings: m.QualitySettings,
			routePolicy:     m.RoutePolicy,
			viewerPresence:  m.ViewerPresence,
			displayName:     displayNameString(m.DisplayName),
			roomOnly:        m.RoomOnly,
			roomSession:     m.RoomSession,
		}, true
	case protocol.AuthenticateViewerMessage:
		return authRequest{
			role:            protocol.RoleViewer,
			roomID:          m.RoomID,
			clientID:        m.ClientID,
			viewerGrant:     m.ViewerGrant,
			viewerPassword:  m.ViewerPassword,
			routePreference: m.RoutePreference,
			viewerPresence:  m.ViewerPresence,
			displayName:     displayNameString(m.DisplayName),
		}, true
	}
	return authRequest{}, false
}

func displayNameString(name *protocol.DisplayName) *string {
	if name == nil {
		return nil
	}
	value := string(*name)
	return &value
}

// authenticate completes non-password checks in the caller's critical
// section. Password checks run in a goroutine so the reader can keep reading
// while the KDF runs.
func (s *Server) authenticate(sess *session, request authRequest) {
	// Reject the conflicting preference before acquiring room or media authority,
	// including reconnects from older pages. Never turn peer-only into SFU consent.
	if request.role == protocol.RoleHost && !request.roomOnly && s.router.sfuOnly && request.routePolicy.PeerOnly {
		s.sendError(sess, "FORBIDDEN", "This site requires server media; turn off Privacy mode or use another site")
		sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Route policy conflict")
		s.finishAuthenticating(sess)
		return
	}
	if request.role == protocol.RoleHost && !sess.siteAccessAuthenticated {
		s.sendError(sess, "AUTH_REQUIRED", "Site access is required")
		sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication failed")
		s.finishAuthenticating(sess)
		return
	}
	if request.role == protocol.RoleViewer && !sess.siteAccessAuthenticated {
		mayEnter := false
		if request.viewerGrant != "" {
			allowed, err := s.store.ViewerGrantMayEnter(request.roomID, request.viewerGrant)
			if err != nil {
				s.authenticationFailed(sess, request, err)
				s.finishAuthenticating(sess)
				return
			}
			mayEnter = allowed
		}
		if !mayEnter {
			s.sendError(sess, "INVALID_TOKEN", authenticationErrorMessage("INVALID_TOKEN"))
			sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication failed")
			s.finishAuthenticating(sess)
			return
		}
	}

	if request.role == protocol.RoleViewer && request.viewerGrant == "" && request.viewerPassword != "" {
		go s.authenticateWithPassword(sess, request)
		return
	}
	participant, err := s.store.ConnectParticipant(room.ConnectParticipantInput{
		RoomID:      request.roomID,
		Role:        request.role,
		Token:       request.token,
		ViewerGrant: request.viewerGrant,
		ClientID:    request.clientID,
		SessionID:   sess.sessionID,
	})
	if err != nil {
		s.authenticationFailed(sess, request, err)
	} else {
		s.completeAuthentication(sess, request, participant)
	}
	s.finishAuthenticating(sess)
}

// finishAuthenticating is the `.finally` of `void this.authenticate(...)`.
func (s *Server) finishAuthenticating(sess *session) {
	if s.sessions.Has(sess) {
		sess.authenticating = false
	}
}

// authenticateWithPassword is the connectViewerWithPassword branch: the
// KDF runs with mu released; mayConnect is evaluated on the derive goroutine
// (gate admission) and again inside the commit, both against live state.
func (s *Server) authenticateWithPassword(sess *session, request authRequest) {
	mayConnect := func() bool {
		return !s.closing && s.sessions.Has(sess) && !sess.revoked &&
			sess.authenticated == nil && sess.open()
	}
	s.mu.Lock()
	salt, expected, ref, err := s.store.ViewerPasswordChallenge(request.roomID)
	s.mu.Unlock()
	var derivedKey []byte
	if err == nil {
		derivedKey, err = s.store.DeriveViewerPassword(request.viewerPassword, salt, func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return mayConnect()
		})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.finishAuthenticating(sess)
	var participant room.ConnectedParticipant
	if err == nil {
		participant, err = s.store.ConnectViewerWithPassword(room.ConnectViewerWithPasswordInput{
			RoomID:    request.roomID,
			Password:  request.viewerPassword,
			ClientID:  request.clientID,
			SessionID: sess.sessionID,
		}, derivedKey, expected, ref, mayConnect)
	}
	if err != nil {
		s.authenticationFailed(sess, request, err)
		return
	}
	s.completeAuthentication(sess, request, participant)
}

// authenticationFailed is the catch of authenticate(): silent for a socket
// that is gone or revoked, otherwise the mapped error and 4003.
func (s *Server) authenticationFailed(sess *session, request authRequest, err error) {
	if !s.sessions.Has(sess) || sess.revoked {
		return
	}
	var roomError *room.Error
	if !errors.As(err, &roomError) {
		s.logger.Error("Signaling authentication failed unexpectedly")
	}
	code := authenticationErrorCode(request, err)
	s.sendError(sess, code, authenticationErrorMessage(code))
	sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication failed")
}

// completeAuthentication rechecks session ownership after store admission.
func (s *Server) completeAuthentication(sess *session, request authRequest, participant room.ConnectedParticipant) {
	if s.closing || !s.sessions.Has(sess) || sess.revoked || !sess.open() {
		if _, err := s.store.DisconnectParticipant(participant.RoomID, participant.PeerID, sess.sessionID); err != nil {
			// Failing to retire the aborted admission is an internal invariant failure.
			panic(fmt.Errorf("room store failed while releasing an aborted authentication: %w", err))
		}
		return
	}

	sess.clearAuthenticationTimer()
	s.unauthenticatedConnections--
	roomID := participant.RoomID
	shareGeneration := ""
	if participant.Role == protocol.RoleHost && request.role == protocol.RoleHost {
		shareGeneration = s.settleHostShare(roomID, sess.sessionID, request)
	}
	displayName := authenticatedDisplayName(request)
	authenticated := &authenticatedSession{
		roomID:          roomID,
		role:            participant.Role,
		peerID:          participant.PeerID,
		shareGeneration: shareGeneration,
		displayName:     displayName,
		viewerPresence:  request.viewerPresence,
		roomSession:     request.roomSession,
	}
	sess.authenticated = authenticated
	if participant.Role == protocol.RoleViewer {
		s.clearViewerEvidence(roomID, participant.PeerID)
	}
	s.clearViewerGrace(roomID, participant.PeerID)
	mediaActive := participant.Role == protocol.RoleHost && shareGeneration != ""
	if participant.Role == protocol.RoleViewer {
		mediaActive = s.activeHostShareGeneration(roomID) != ""
	}
	routeParticipant := routeParticipant(sess, authenticated)
	routeParticipant.routePreference = request.routePreference
	if participant.Role == protocol.RoleHost && mediaActive {
		policy := s.routePolicyOf(roomID)
		routeParticipant.routePolicy = &policy
	}
	hybridState := hybridAuthenticationState{routeAssignment: emptyAssignment()}
	if participant.Role == protocol.RoleViewer || mediaActive {
		var assigned bool
		hybridState, assigned = s.connectRouteParticipant(routeParticipant)
		if !assigned {
			s.logger.Error("Media router did not assign an authenticated participant")
			s.sendError(sess, "SERVER_ERROR", "Media assignment failed")
			sess.close(websocket.StatusInternalError, "Media assignment failed")
			return
		}
	}
	// The viewer's media identity is derived from the committed edge, never
	// stored beside it; connectParticipant has just settled the graph.
	var connectionID *string
	if participant.Role == protocol.RoleViewer {
		if edge, ok := s.router.resolveActiveViewerMediaEdge(roomID, participant.PeerID); ok {
			current := edge.connectionID
			connectionID = &current
		}
	}
	// The host-status fan-out below uses this pre-router snapshot.
	var connectedViewers []room.ConnectedPeer
	if participant.Role == protocol.RoleHost {
		connectedViewers = s.store.GetConnectedViewers(roomID)
	}
	share := s.shares[roomID]
	routePolicy := s.routePolicyOf(roomID)

	qualitySettings := protocol.DefaultQualitySettings
	if share.qualitySettings != nil {
		qualitySettings = *share.qualitySettings
	}
	var roomShareGeneration *string
	if participant.Role == protocol.RoleHost && mediaActive {
		generation := shareGeneration
		roomShareGeneration = &generation
	} else if participant.Role == protocol.RoleViewer && mediaActive {
		generation := s.activeHostShareGeneration(roomID)
		roomShareGeneration = &generation
	}
	if participant.Role == protocol.RoleHost {
		s.send(sess, protocol.AuthenticatedHostMessage{
			Type:                          "authenticated",
			Protocol:                      protocol.SignalingProtocol,
			PeerID:                        participant.PeerID,
			MaxViewers:                    protocol.Int(s.store.MaxViewersPerRoom()),
			EndpointMediaCopyCapacity:     protocol.Int(s.endpointMediaCopyCapacity),
			HostOnline:                    participant.HostOnline,
			ConnectionID:                  connectionID,
			IceConfig:                     s.ice,
			RoutePolicy:                   routePolicy,
			CodeEntryPolicy:               participant.CodeEntryPolicy,
			ViewerAuthorizationGeneration: participant.ViewerAuthorizationGeneration,
			MediaMode:                     "peer-assisted",
			ShareGeneration:               roomShareGeneration,
			RouteRevision:                 protocol.Int(hybridState.routeRevision),
			RouteAssignment:               hybridState.routeAssignment,
			QualitySettings:               qualitySettings,
			Role:                          protocol.RoleHost,
			ViewerPasswordEnabled:         participant.ViewerPasswordEnabled,
		})
	} else {
		hostOnline := participant.HostOnline && mediaActive
		hostPaused := hostOnline && share.pausedGeneration == share.generation
		s.send(sess, protocol.AuthenticatedViewerMessage{
			Type:                          "authenticated",
			Protocol:                      protocol.SignalingProtocol,
			PeerID:                        participant.PeerID,
			MaxViewers:                    protocol.Int(s.store.MaxViewersPerRoom()),
			EndpointMediaCopyCapacity:     protocol.Int(s.endpointMediaCopyCapacity),
			HostOnline:                    hostOnline,
			HostPaused:                    &hostPaused,
			ConnectionID:                  connectionID,
			IceConfig:                     s.ice,
			RoutePolicy:                   routePolicy,
			CodeEntryPolicy:               participant.CodeEntryPolicy,
			ViewerAuthorizationGeneration: participant.ViewerAuthorizationGeneration,
			MediaMode:                     "peer-assisted",
			ShareGeneration:               roomShareGeneration,
			RouteRevision:                 protocol.Int(hybridState.routeRevision),
			RouteAssignment:               hybridState.routeAssignment,
			QualitySettings:               qualitySettings,
			Role:                          protocol.RoleViewer,
		})
	}
	if participant.Role == protocol.RoleViewer && request.routePreference != nil {
		s.router.sendViewerRoutePreference(roomID, participant.PeerID, true)
	}
	if participant.ReplacedSessionID != "" {
		if replaced := s.sessionsByID[participant.ReplacedSessionID]; replaced != nil && replaced != sess {
			replaced.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Session replaced")
		}
		if participant.Role == protocol.RoleViewer {
			s.refreshRemoteInputMembers(roomID)
		}
	}

	if participant.Role == protocol.RoleHost && mediaActive {
		if rm, _ := s.router.rooms.Get(roomID); rm != nil && rm.roomMedia && rm.controller != nil &&
			rm.controller.Snapshot().VideoGeneration != shareGeneration {
			s.router.setVideoPublication(roomID, shareGeneration, s.shares[roomID].pausedGeneration == shareGeneration)
		}
		s.router.setPaused(roomID, s.shares[roomID].pausedGeneration == shareGeneration)
	}
	if participant.Role == protocol.RoleViewer || mediaActive {
		s.router.completeAuthentication(routeParticipant, hybridState)
	}

	if participant.Role == protocol.RoleHost && mediaActive &&
		s.shares[roomID].pausedGeneration == shareGeneration {
		s.sendToSession(sess.sessionID, protocol.PauseSharingSourceMessage{
			Type:            "pause-sharing-source",
			ShareGeneration: shareGeneration,
		})
	}

	s.sendViewerPresence(roomID)

	if participant.Role == protocol.RoleHost && mediaActive {
		for _, viewer := range connectedViewers {
			s.sendToSession(viewer.SessionID, protocol.HostStatusMessage{
				Type:   "host-status",
				Online: true,
				Paused: s.shares[roomID].pausedGeneration == shareGeneration,
			})
		}
	}
}

// settleHostShare is the share half of authenticate() for a Host: it settles
// which share generation this connection owns, retires a superseded one, and
// broadcasts the quality settings and route policy the new generation starts
// with. It returns the settled generation and must run with mu held, before the
// `authenticated` message is built from the record it writes.
func (s *Server) settleHostShare(roomID, sessionID string, request authRequest) string {
	if request.roomOnly {
		// A room-only reconnect must not resurrect a stale publication. The
		// stop path normally already cleared it; this guard covers a socket
		// loss between the client cleanup and the server's stop message.
		if s.shares[roomID].generation != "" {
			s.stopSharing(roomID)
		}
		return ""
	}
	current := s.shares[roomID]
	currentGeneration := current.generation
	shareGeneration := request.shareGeneration
	if shareGeneration == "" {
		shareGeneration = currentGeneration
	}
	// Persistent room sessions may reconnect after a stop overtook their
	// authentication request. The retained generation fences that publication;
	// only a fresh generation may start another one. Legacy sessions keep their
	// established authenticate-to-publish lifecycle.
	if request.roomSession && currentGeneration != "" &&
		shareGeneration == currentGeneration && current.routePolicy == nil {
		return ""
	}
	if shareGeneration == "" {
		shareGeneration = sessionID
	}
	sameShareWasAuthoritativelyPaused := currentGeneration == shareGeneration &&
		current.pausedGeneration == shareGeneration
	if currentGeneration != "" && currentGeneration != shareGeneration {
		s.stopSharing(roomID)
	}
	// stopSharing may have cleared fields, so read the surviving intent afterwards.
	share := s.shares[roomID]
	if request.shareGeneration != "" &&
		(currentGeneration != shareGeneration || share.qualitySettings == nil) {
		initialQualitySettings := protocol.DefaultQualitySettings
		if request.qualitySettings != nil {
			initialQualitySettings = *request.qualitySettings
		}
		share.qualitySettings = &initialQualitySettings
		// Store order.
		for _, viewer := range s.store.GetConnectedViewers(roomID) {
			s.sendToSession(viewer.SessionID, protocol.QualitySettingsMessage{
				Type:            "quality-settings",
				QualitySettings: initialQualitySettings,
			})
		}
	}
	if currentGeneration != shareGeneration || share.routePolicy == nil {
		routePolicy := s.configuredRoutePolicy(request.routePolicy)
		share.routePolicy = &routePolicy
		for _, viewer := range s.store.GetConnectedViewers(roomID) {
			message := protocol.RoutePolicyMessage{
				Type:            "route-policy",
				ShareGeneration: shareGeneration,
				RoutePolicy:     routePolicy,
			}
			// No `has(roomId)` term here, unlike `authenticated`.
			s.sendToSession(viewer.SessionID, message)
		}
	}
	share.generation = shareGeneration
	share.pausedGeneration = ""
	if request.sharingPaused || sameShareWasAuthoritativelyPaused {
		share.pausedGeneration = shareGeneration
	}
	s.shares[roomID] = share
	if currentGeneration != shareGeneration {
		share.coPlayGrants = nil
		s.shares[roomID] = share
		s.broadcastAudioPresence(roomID)
		s.broadcastCoPlayPresence(roomID)
	}
	return shareGeneration
}

// authenticatedDisplayName is the display name authenticate() records: nil for
// a Host that did not opt into viewer presence, and otherwise the requested
// name or the role's default.
func authenticatedDisplayName(request authRequest) *string {
	if request.role == protocol.RoleHost && !request.viewerPresence {
		return nil
	}
	if request.displayName != nil {
		return request.displayName
	}
	name := protocol.DefaultViewerDisplayName
	if request.role == protocol.RoleHost {
		name = protocol.DefaultHostDisplayNamePrefix
	}
	return &name
}

// connectRouteParticipant leaves the participant unassigned if a controller
// assertion prevents route admission.
func (s *Server) connectRouteParticipant(participant authenticatedRouteParticipant) (state hybridAuthenticationState, assigned bool) {
	defer func() {
		if recover() != nil {
			assigned = false
		}
	}()
	if participant.role == protocol.RoleHost && participant.routePolicy != nil {
		if rm, _ := s.router.rooms.Get(participant.roomID); rm != nil && rm.roomMedia && rm.controller != nil {
			s.router.releaseResources(rm.controller.SetRoutePolicy(*participant.routePolicy, s.now()))
			for peerID, settings := range rm.viewerSettings.All() {
				if settings.preference != "" && !rm.controller.AllowsViewerRoutePreference(settings.preference) {
					settings.preference = protocol.ViewerRouteAuto
					rm.viewerSettings.Set(peerID, settings)
					s.router.sendViewerRoutePreference(participant.roomID, peerID, true)
				}
			}
		}
	}
	return s.router.connectParticipant(participant), true
}

func (s *Server) routePolicyOf(roomID string) protocol.RoutePolicy {
	if policy := s.shares[roomID].routePolicy; policy != nil {
		return *policy
	}
	return s.configuredRoutePolicy(protocol.DefaultRoutePolicy)
}

// activeHostShareGeneration is the media truth for a room. The room share
// record intentionally keeps its generation as a stale reconnect fence after
// stopSharing, so membership or that fence alone cannot mean "publishing".
// Callers hold Server.mu.
func (s *Server) activeHostShareGeneration(roomID string) string {
	host, ok := s.store.GetConnectedHost(roomID)
	if !ok {
		return ""
	}
	hostSession := s.sessionsByID[host.SessionID]
	if hostSession == nil || hostSession.authenticated == nil ||
		hostSession.authenticated.role != protocol.RoleHost ||
		hostSession.authenticated.roomID != roomID {
		return ""
	}
	generation := hostSession.authenticated.shareGeneration
	if generation == "" || s.shares[roomID].generation != generation {
		return ""
	}
	return generation
}

// configuredRoutePolicy restricts share preferences to the services this runtime owns.
func (s *Server) configuredRoutePolicy(policy protocol.RoutePolicy) protocol.RoutePolicy {
	policy.PeerOnly = s.router.sfu == nil || policy.PeerOnly
	policy.NatPrediction = s.natPredictionEnabled && !s.router.sfuOnly && policy.NatPrediction
	policy.TopologyOptimization = !s.router.sfuOnly && policy.TopologyOptimization
	return policy
}

// routeParticipant is the `{...authenticated, sessionId}` spread handed to
// the router by the authenticated message handlers.
func routeParticipant(sess *session, authenticated *authenticatedSession) authenticatedRouteParticipant {
	return authenticatedRouteParticipant{
		roomID:    authenticated.roomID,
		role:      authenticated.role,
		peerID:    authenticated.peerID,
		sessionID: sess.sessionID,
	}
}

func (s *Server) handleAuthenticatedMessage(sess *session, authenticated *authenticatedSession, message protocol.ClientMessage) {
	switch m := message.(type) {
	case protocol.SetRelayVolunteerMessage:
		s.setRelayVolunteer(sess, authenticated, m)
	case protocol.SubscribeRoomVoiceMessage:
		sess.roomVoiceBitrate = m.Bitrate
		s.subscribeRoomVoice(sess, authenticated, m.Deafened)
	case protocol.RoomVoiceCommandMessage:
		s.handleRoomVoiceCommand(sess, authenticated, m.Command)
	case protocol.RoomVoiceSignalMessage:
		s.handleRoomVoiceSignal(sess, authenticated, m)
	case protocol.RoomVoiceTransportMessage:
		s.handleRoomVoiceTransport(sess, authenticated, m)
	case protocol.SubscribeRemoteInputMessage:
		s.subscribeRemoteInput(sess, authenticated, m)
	case protocol.SubscribeRoomInteractionsMessage:
		// Explicit opt-in protects older v23 readers from unknown events.
		sess.roomInteractions = true
		s.send(sess, protocol.RoomInteractionsReadyMessage{Type: "room-interactions-ready", ServerTime: protocol.Int(s.now())})
	case protocol.SendRoomInteractionMessage:
		s.handleRoomInteraction(sess, authenticated, m)
	case protocol.SignalingChallengeMessage:
		if !s.sessions.Has(sess) || sess.authenticated != authenticated {
			return
		}
		now := s.now()
		if sess.challenged {
			elapsedMs := now - sess.lastSignalingChallengeAtMs
			if elapsedMs < 0 {
				sess.lastSignalingChallengeAtMs = now
				return
			}
			if elapsedMs < minSignalingChallengeIntervalMs {
				return
			}
		}
		sess.challenged = true
		sess.lastSignalingChallengeAtMs = now
		s.send(sess, protocol.SignalingChallengeResponseMessage{
			Type:     "signaling-challenge-response",
			Sequence: m.Sequence,
		})
	case protocol.ClientSignalMessage:
		s.routePeerAssistedSignal(sess, authenticated, m)
	case protocol.ClientRestartRequestMessage:
		if authenticated.role != protocol.RoleViewer {
			s.sendError(sess, "FORBIDDEN", "Only viewers may request an ICE restart")
			return
		}
		s.routePeerAssistedRestart(sess, authenticated, m)
	case protocol.SetQualitySettingsMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may set quality settings")
			return
		}
		if authenticated.shareGeneration == "" ||
			s.shares[authenticated.roomID].generation != authenticated.shareGeneration {
			return
		}
		share := s.shares[authenticated.roomID]
		share.qualitySettings = &m.QualitySettings
		s.shares[authenticated.roomID] = share
		// Store order.
		for _, viewer := range s.store.GetConnectedViewers(authenticated.roomID) {
			s.sendToSession(viewer.SessionID, protocol.QualitySettingsMessage{
				Type:            "quality-settings",
				QualitySettings: m.QualitySettings,
			})
		}
	case protocol.SetViewerRoutePreferenceMessage:
		if authenticated.role != protocol.RoleViewer {
			s.sendError(sess, "FORBIDDEN", "Only a viewer may select an incoming route")
			return
		}
		s.router.setViewerRoutePreference(routeParticipant(sess, authenticated), m.Preference)
	case protocol.RelayCapacityMessage:
		if authenticated.role != protocol.RoleViewer {
			s.sendError(sess, "FORBIDDEN", "Only a viewer may advertise relay capacity")
			return
		}
		s.router.setViewerRelayCapacity(routeParticipant(sess, authenticated), int(m.DownstreamEdges))
	case protocol.RouteReadyMessage:
		s.router.handleRouteReady(routeParticipant(sess, authenticated), m)
	case protocol.RouteTransportConnectedMessage:
		s.router.handleRouteTransportConnected(routeParticipant(sess, authenticated), m)
	case protocol.RouteMediaUnavailableMessage:
		s.router.handleRouteMediaUnavailable(routeParticipant(sess, authenticated), m)
	case protocol.RouteFailedMessage:
		s.router.handleRouteFailed(routeParticipant(sess, authenticated), m)
	case protocol.SfuSignalMessage:
		s.router.handleSfuSignal(routeParticipant(sess, authenticated), m)
	case protocol.RefreshSfuMessage:
		if s.sfuFallback == nil {
			s.sendError(sess, "FORBIDDEN", "SFU fallback is not enabled")
			return
		}
		s.router.refreshSfu(routeParticipant(sess, authenticated), int64(m.Revision))
	case protocol.RequestRouteDiagnosticMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may request route diagnostics")
			return
		}
		s.send(sess, protocol.RouteDiagnosticSnapshotMessage{
			Type:     "route-diagnostic-snapshot",
			Snapshot: s.router.routeDiagnosticSnapshot(authenticated.roomID),
		})
	case protocol.ViewerQualityEvidenceMessage:
		s.handleViewerQualityEvidence(sess, authenticated, m)
	case protocol.SenderQualityEvidenceMessage:
		s.handleSenderQualityEvidence(sess, authenticated, m)
	case protocol.SfuPublisherQualityEvidenceMessage:
		s.handleSfuPublisherQualityEvidence(sess, authenticated, m)
	case protocol.ResetSenderQualityMessage:
		if s.sessions.Has(sess) && sess.authenticated == authenticated {
			s.router.resetSenderQuality(routeParticipant(sess, authenticated))
		}
	case protocol.SetDisplayNameMessage:
		if authenticated.role == protocol.RoleHost && !authenticated.viewerPresence {
			s.sendError(sess, "FORBIDDEN", "Display names require the Web presence capability")
			return
		}
		name := string(m.DisplayName)
		authenticated.displayName = &name
		s.sendViewerPresence(authenticated.roomID)
	case protocol.SubscribeAudioPresenceMessage:
		if authenticated.role == protocol.RoleViewer {
			sess.audioPresence = true
			s.sendAudioPresence(sess, authenticated.roomID)
		}
	case protocol.SetAudioPresenceMessage:
		s.setAudioPresence(sess, authenticated, m)
	case protocol.SubscribeCoPlayPresenceMessage:
		if authenticated.role == protocol.RoleViewer {
			sess.coPlayPresence = true
			s.sendCoPlayPresence(sess, authenticated.roomID)
		}
	case protocol.SetCoPlayPresenceMessage:
		s.setCoPlayPresence(sess, authenticated, m)
	case protocol.SetSharingPausedMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "只有当前房主可以暂停分享")
			return
		}
		connectedHost, hasHost := s.store.GetConnectedHost(authenticated.roomID)
		if !s.sessions.Has(sess) ||
			!hasHost || connectedHost.SessionID != sess.sessionID ||
			authenticated.shareGeneration == "" ||
			s.shares[authenticated.roomID].generation != authenticated.shareGeneration ||
			m.ShareGeneration != authenticated.shareGeneration {
			sess.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Sharing generation replaced")
			return
		}
		share := s.shares[authenticated.roomID]
		share.pausedGeneration = ""
		if m.Paused {
			share.pausedGeneration = authenticated.shareGeneration
		}
		s.shares[authenticated.roomID] = share
		s.router.setPaused(authenticated.roomID, m.Paused)
		s.broadcastHostStatus(authenticated.roomID, true, m.Paused)
	case protocol.StartSharingMessage:
		s.startSharing(sess, authenticated, m)
	case protocol.StopSharingMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "只有当前房主可以停止分享")
			return
		}
		if authenticated.shareGeneration == "" {
			return
		}
		if s.shares[authenticated.roomID].generation != authenticated.shareGeneration ||
			(m.ShareGeneration != "" && m.ShareGeneration != authenticated.shareGeneration) {
			sess.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Sharing generation replaced")
			return
		}
		if !authenticated.roomSession {
			// Older clients treat stopping media as leaving the Host session.
			// Keep that contract until the client explicitly opts into the
			// persistent room-session lifecycle.
			if s.sessions.Has(sess) && sess.authenticated == authenticated {
				if _, err := s.store.DisconnectParticipant(authenticated.roomID, authenticated.peerID, sess.sessionID); err != nil {
					panic(fmt.Errorf("room store failed while stopping sharing: %w", err))
				}
			}
			s.stopSharing(authenticated.roomID)
			sess.close(websocket.StatusNormalClosure, "Sharing stopped")
			return
		}
		s.stopSharing(authenticated.roomID)
		s.sendViewerPresence(authenticated.roomID)
	case protocol.AbandonRoomMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may abandon the room")
			return
		}
		if err := s.abandonRoom(authenticated.roomID); err != nil {
			s.logger.Error("Room abandonment failed", "errorType", fmt.Sprintf("%T", err))
			s.sendError(sess, "SERVER_ERROR", "Room could not be abandoned")
		}
	}
}

// startSharing claims a new publication generation without replacing the
// authenticated Host participant. Room interactions therefore keep the same
// session while the media graph is rebuilt for the new source.
func (s *Server) startSharing(sess *session, authenticated *authenticatedSession, message protocol.StartSharingMessage) {
	if authenticated.role != protocol.RoleHost {
		s.sendError(sess, "FORBIDDEN", "Only the host may start sharing")
		return
	}
	if !authenticated.roomSession {
		s.sendError(sess, "FORBIDDEN", "Persistent room session is not enabled")
		return
	}
	if !s.sessions.Has(sess) || sess.authenticated != authenticated ||
		authenticated.shareGeneration != "" || message.ShareGeneration == s.shares[authenticated.roomID].generation ||
		(s.router.sfuOnly && message.RoutePolicy.PeerOnly) {
		s.send(sess, protocol.SharingStartFailedMessage{Type: "sharing-start-failed",
			ShareGeneration: message.ShareGeneration, Code: "FORBIDDEN"})
		return
	}

	// stop-sharing deliberately leaves the previous generation as a stale
	// fence for reconnect validation. A fresh start supersedes that fence
	// without emitting a second sharing-stopped event.
	share := s.shares[authenticated.roomID]
	share.generation = ""
	share.pausedGeneration = ""
	share.audioAvailable = nil
	share.coPlayGrants = nil
	s.shares[authenticated.roomID] = share
	request := authRequest{
		role:            protocol.RoleHost,
		roomID:          authenticated.roomID,
		shareGeneration: message.ShareGeneration,
		sharingPaused:   message.SharingPaused,
		qualitySettings: message.QualitySettings,
		routePolicy:     message.RoutePolicy,
	}
	shareGeneration := s.settleHostShare(authenticated.roomID, sess.sessionID, request)
	authenticated.shareGeneration = shareGeneration
	routeParticipant := routeParticipant(sess, authenticated)
	policy := s.routePolicyOf(authenticated.roomID)
	routeParticipant.routePolicy = &policy
	routeState, assigned := s.connectRouteParticipant(routeParticipant)
	if !assigned {
		authenticated.shareGeneration = ""
		s.stopSharing(authenticated.roomID)
		s.send(sess, protocol.SharingStartFailedMessage{Type: "sharing-start-failed",
			ShareGeneration: message.ShareGeneration, Code: "SERVER_ERROR"})
		return
	}

	share = s.shares[authenticated.roomID]
	qualitySettings := protocol.DefaultQualitySettings
	if share.qualitySettings != nil {
		qualitySettings = *share.qualitySettings
	}
	s.send(sess, protocol.SharingStartedMessage{
		Type:            "sharing-started",
		ShareGeneration: shareGeneration,
		RoutePolicy:     s.routePolicyOf(authenticated.roomID),
		RouteRevision:   protocol.Int(routeState.routeRevision),
		RouteAssignment: routeState.routeAssignment,
		QualitySettings: qualitySettings,
		Paused:          share.pausedGeneration == shareGeneration,
	})
	s.router.setVideoPublication(authenticated.roomID, shareGeneration, share.pausedGeneration == shareGeneration)
	// Acknowledge publication authority before any media effects use it.
	s.router.setPaused(authenticated.roomID, share.pausedGeneration == shareGeneration)
	s.router.completeAuthentication(routeParticipant, routeState)
	s.sendViewerPresence(authenticated.roomID)
	s.broadcastHostStatus(authenticated.roomID, true, share.pausedGeneration == shareGeneration)
}

// ---------------------------------------------------------------------------
// quality evidence
// ---------------------------------------------------------------------------

// handleViewerQualityEvidence encodes the forwarded envelope once; the same bytes reach the upstream
// recipient and, when different and opted in, the host.
func (s *Server) handleViewerQualityEvidence(sess *session, source *authenticatedSession, message protocol.ViewerQualityEvidenceMessage) {
	if source.role != protocol.RoleViewer {
		return
	}
	if !s.sessions.Has(sess) || sess.authenticated != source {
		return
	}
	connectedViewer, ok := s.store.GetConnectedViewer(source.roomID, source.peerID)
	if !ok || connectedViewer.SessionID != sess.sessionID {
		return
	}

	// The committed edge owns the viewer's media identity; connectionID is
	// empty while the viewer has no physical path.
	edge, hasEdge := s.router.resolveActiveViewerMediaEdge(source.roomID, source.peerID)
	connectionID := ""
	if hasEdge {
		connectionID = edge.connectionID
	}

	gateKey := viewerKey(source.roomID, source.peerID)
	now := s.now()
	if previous, attempted := s.viewerQualityEvidenceAttempts[gateKey]; attempted &&
		previous.connectionID == connectionID &&
		now-previous.atMs < protocol.ViewerQualityEvidenceIntervalMs {
		return
	}
	s.viewerQualityEvidenceAttempts[gateKey] = viewerQualityEvidenceAttempt{connectionID: connectionID, atMs: now}

	if !hasEdge || message.Guard.ConnectionID != connectionID {
		return
	}

	host, hasHost := s.store.GetConnectedHost(source.roomID)
	routeRevision := edge.revision
	upstream := edge.upstream
	var recipient room.ConnectedPeer
	hasRecipient := false
	if upstream.Kind == "peer" {
		recipient, hasRecipient = s.connectedPeer(source.roomID, upstream.PeerID)
	} else {
		recipient, hasRecipient = host, hasHost
	}
	if !hasRecipient || int64(message.Guard.RouteRevision) != routeRevision ||
		(upstream.Kind == "peer" && upstream.PeerID == source.peerID) {
		return
	}

	presentationEpoch := int64(message.Guard.PresentationEpoch)
	sequence := int64(message.Sequence)
	previous, hasPrevious := s.viewerQualityEvidenceGates[gateKey]
	sameEdge := hasPrevious &&
		previous.viewerSessionID == sess.sessionID &&
		previous.upstreamKind == upstream.Kind &&
		previous.upstreamPeerID == upstream.PeerID &&
		previous.connectionID == connectionID
	if sameEdge &&
		(presentationEpoch < previous.presentationEpoch ||
			(presentationEpoch == previous.presentationEpoch && sequence <= previous.sequence)) {
		return
	}

	forwarded := protocol.ServerViewerQualityEvidenceMessage{
		Type:         "viewer-quality-evidence",
		ViewerPeerID: source.peerID,
		Upstream:     upstream,
		Guard: protocol.ViewerQualityEvidenceGuard{
			ConnectionID:      connectionID,
			RouteRevision:     protocol.Int(routeRevision),
			PresentationEpoch: message.Guard.PresentationEpoch,
		},
		Sequence: message.Sequence,
		WindowMs: message.WindowMs,
		Metrics:  message.Metrics,
	}
	encoded, err := protocol.EncodeServerMessage(forwarded)
	if err != nil {
		panic(err)
	}
	if len(encoded) > protocol.MaxViewerQualityEvidenceBytes {
		return
	}
	qualityUpstream := route.QualityUpstream{Kind: route.UpstreamSfu}
	if upstream.Kind == "peer" {
		qualityUpstream = route.QualityUpstream{Kind: route.UpstreamPeer, PeerID: upstream.PeerID}
	}
	qualityResult := s.router.observeQualityEvidence(source.roomID, route.RouteQualityEvidenceInput{
		ChildPeerID:       source.peerID,
		ChildSessionID:    sess.sessionID,
		RouteRevision:     routeRevision,
		ConnectionID:      connectionID,
		Upstream:          qualityUpstream,
		PresentationEpoch: presentationEpoch,
		WindowMs:          int64(message.WindowMs),
		Metrics:           message.Metrics,
		AcceptedAtMs:      now,
	})
	if qualityResult == route.QualityEvidenceRejected {
		return
	}
	s.viewerQualityEvidenceGates[gateKey] = viewerQualityEvidenceGate{
		viewerSessionID:   sess.sessionID,
		upstreamKind:      upstream.Kind,
		upstreamPeerID:    upstream.PeerID,
		connectionID:      connectionID,
		presentationEpoch: presentationEpoch,
		sequence:          sequence,
	}
	s.sendEncodedToSession(recipient.SessionID, encoded)
	if !hasHost || host.SessionID == recipient.SessionID {
		return
	}
	if hostState := s.authenticatedOf(host.SessionID); hostState != nil &&
		hostState.role == protocol.RoleHost &&
		hostState.roomID == source.roomID &&
		hostState.peerID == host.PeerID &&
		hostState.viewerPresence {
		s.sendEncodedToSession(host.SessionID, encoded)
	}
}

// authenticatedOf is `socketStates.get(socketsBySessionId.get(id))?.authenticated`.
func (s *Server) authenticatedOf(sessionID string) *authenticatedSession {
	if sess := s.sessionsByID[sessionID]; sess != nil {
		return sess.authenticated
	}
	return nil
}

func (s *Server) handleSenderQualityEvidence(sess *session, source *authenticatedSession, message protocol.SenderQualityEvidenceMessage) {
	if source.peerID == message.ChildPeerID {
		return
	}
	if !s.sessions.Has(sess) || sess.authenticated != source {
		return
	}
	if !s.consumeSenderQualityBudget(sess.sessionID, s.now()) {
		return
	}
	s.router.observeSenderQualityEvidence(routeParticipant(sess, source), message)
}

func (s *Server) handleSfuPublisherQualityEvidence(sess *session, source *authenticatedSession, message protocol.SfuPublisherQualityEvidenceMessage) {
	if source.role != protocol.RoleHost {
		return
	}
	if !s.sessions.Has(sess) || sess.authenticated != source {
		return
	}
	if !s.consumeSenderQualityBudget(sess.sessionID, s.now()) {
		return
	}
	s.router.observeSfuPublisherQualityEvidence(routeParticipant(sess, source), message)
}

func (s *Server) consumeSenderQualityBudget(sessionID string, nowMs int64) bool {
	// Volunteers may send to the whole room. Preserve one serial preparation
	// and the existing double allowance without mirroring route ownership here.
	maximumReports := (protocol.MaxViewersPerRoomLimit + 1) * 2
	current := s.senderQualityRateBySession[sessionID]
	if current == nil || nowMs-current.startedAtMs >= protocol.ViewerQualityEvidenceIntervalMs {
		s.senderQualityRateBySession[sessionID] = &senderQualityRateWindow{startedAtMs: nowMs, count: 1}
		return true
	}
	if current.count >= maximumReports {
		return false
	}
	current.count++
	return true
}

// ---------------------------------------------------------------------------
// peer-assisted signaling
// ---------------------------------------------------------------------------

func (s *Server) routePeerAssistedSignal(sess *session, source *authenticatedSession, message protocol.ClientSignalMessage) {
	targetPeerID := message.TargetPeerID
	if targetPeerID == "" {
		s.sendError(sess, "FORBIDDEN", "Peer-assisted signals must target an assigned peer")
		return
	}
	parentToChild := s.router.isActivePeerParentOf(source.roomID, source.peerID, targetPeerID)
	childToParent := s.router.isActivePeerParentOf(source.roomID, targetPeerID, source.peerID)
	target, hasTarget := s.connectedPeer(source.roomID, targetPeerID)
	if !hasTarget {
		if parentToChild || childToParent {
			return
		}
		s.sendError(sess, "PEER_NOT_FOUND", "Target peer is not connected")
		return
	}

	payload := message.Payload
	descriptionType := ""
	if payload.Kind == "description" && payload.Description != nil {
		descriptionType = payload.Description.Type
	}
	punchPhase := ""
	if payload.Punch != nil {
		punchPhase = payload.Punch.Phase
	}
	candidateAuthorized := s.router.peerSignalAuthorization(peerSignalInput{
		roomID:          source.roomID,
		sourcePeerID:    source.peerID,
		sourceSessionID: sess.sessionID,
		targetPeerID:    target.PeerID,
		targetSessionID: target.SessionID,
		connectionID:    payload.ConnectionID,
		signalKind:      payload.Kind,
		descriptionType: descriptionType,
		punchPhase:      punchPhase,
		punched:         payload.Punched,
	})
	debugInput := peerSignalDebugInput{
		roomID:          source.roomID,
		sourcePeerID:    source.peerID,
		targetPeerID:    target.PeerID,
		signalKind:      payload.Kind,
		descriptionType: descriptionType,
		authorization:   candidateAuthorized,
	}
	if payload.Kind == "candidate" {
		candidate := ""
		if payload.Candidate != nil {
			candidate = payload.Candidate.Candidate
		}
		debugInput.candidateOrigin = protocol.CandidateSignalOriginOf(candidate)
	}
	s.router.debugPeerSignal(debugInput)
	var assignedEdgeAuthorized bool
	switch descriptionType {
	case "offer":
		assignedEdgeAuthorized = parentToChild
	case "":
		assignedEdgeAuthorized = parentToChild || childToParent
	default:
		assignedEdgeAuthorized = childToParent
	}
	var authorized bool
	switch candidateAuthorized {
	case signalAuthorizationUnassigned:
		authorized = assignedEdgeAuthorized
	case signalAuthorizationDenied:
		authorized = false
	default:
		authorized = true
	}
	if !authorized {
		return
	}

	// An authorized non-probe offer either matches the committed connection or was
	// adopted into it by peerSignalAuthorization.
	s.sendToSession(target.SessionID, protocol.ServerSignalMessage{
		Type:       "signal",
		FromPeerID: source.peerID,
		Payload:    payload,
	})
}

func (s *Server) routePeerAssistedRestart(sess *session, source *authenticatedSession, message protocol.ClientRestartRequestMessage) {
	targetPeerID := message.TargetPeerID
	if targetPeerID == "" || !s.router.isActivePeerParentOf(source.roomID, targetPeerID, source.peerID) {
		s.sendError(sess, "FORBIDDEN", "Restart target is not the assigned media parent")
		return
	}
	parent, hasParent := s.connectedPeer(source.roomID, targetPeerID)
	if !hasParent {
		s.sendError(sess, "PEER_NOT_FOUND", "Media parent is not connected")
		return
	}
	s.sendToSession(parent.SessionID, protocol.ServerRestartRequestMessage{
		Type:         "restart-request",
		FromPeerID:   source.peerID,
		ConnectionID: message.ConnectionID,
		Rebuild:      message.Rebuild,
	})
}

// isCurrentSession is checked on every authenticated
// message before dispatch.
func (s *Server) isCurrentSession(sess *session) bool {
	authenticated := sess.authenticated
	if authenticated == nil {
		return false
	}
	var current room.ConnectedPeer
	var ok bool
	if authenticated.role == protocol.RoleHost {
		current, ok = s.store.GetConnectedHost(authenticated.roomID)
	} else {
		current, ok = s.store.GetConnectedViewer(authenticated.roomID, authenticated.peerID)
	}
	return ok && current.SessionID == sess.sessionID
}

func (s *Server) connectedPeer(roomID, peerID string) (room.ConnectedPeer, bool) {
	if host, ok := s.store.GetConnectedHost(roomID); ok && host.PeerID == peerID {
		return host, true
	}
	return s.store.GetConnectedViewer(roomID, peerID)
}

// ---------------------------------------------------------------------------
// error tables
// ---------------------------------------------------------------------------

func authenticationErrorMessage(code string) string {
	switch code {
	case "ROOM_ACCESS_DENIED":
		return "Room access denied"
	case "ROOM_NOT_FOUND":
		return "Room not found"
	case "ROOM_FULL":
		return "Room is full"
	case "HOST_ALREADY_CONNECTED":
		return "A host is already connected"
	case "INVALID_TOKEN":
		return "Room credentials are invalid"
	}
	return "Authentication failed"
}

func authenticationErrorCode(request authRequest, err error) string {
	var roomError *room.Error
	if !errors.As(err, &roomError) || roomError.Code == room.CodeRoomLimit {
		return "SERVER_ERROR"
	}
	if roomError.Code == room.CodeRoomBusy {
		if request.role == protocol.RoleViewer {
			return "ROOM_ACCESS_DENIED"
		}
		return "SERVER_ERROR"
	}
	if request.role != protocol.RoleViewer {
		return string(roomError.Code)
	}
	if request.viewerGrant == "" {
		if roomError.Code == room.CodeRoomNotFound {
			return "ROOM_NOT_FOUND"
		}
		return "ROOM_ACCESS_DENIED"
	}
	if roomError.Code == room.CodeRoomNotFound {
		return "INVALID_TOKEN"
	}
	return string(roomError.Code)
}
