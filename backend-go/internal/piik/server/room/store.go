package room

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"time"

	"zviewer/backend/internal/piik/server/ordered"
	"zviewer/backend/internal/piik/server/protocol"
)

// Capacity is the number of four-digit room codes without a leading zero.
const Capacity = 9_000

const roomCodeFirst = 1_000

// ErrorCode identifies a room authority or admission failure.
type ErrorCode string

// Room authority and admission errors.
const (
	CodeInvalidToken         ErrorCode = "INVALID_TOKEN"
	CodeRoomAccessDenied     ErrorCode = "ROOM_ACCESS_DENIED"
	CodeRoomBusy             ErrorCode = "ROOM_BUSY"
	CodeRoomNotFound         ErrorCode = "ROOM_NOT_FOUND"
	CodeRoomFull             ErrorCode = "ROOM_FULL"
	CodeHostAlreadyConnected ErrorCode = "HOST_ALREADY_CONNECTED"
	CodeRoomLimit            ErrorCode = "ROOM_LIMIT"
)

// Error carries a room authority or admission error code.
type Error struct {
	Code ErrorCode
}

// Error returns the code.
func (e *Error) Error() string { return string(e.Code) }

func codeError(code ErrorCode) error { return &Error{Code: code} }

func hasCode(err error, code ErrorCode) bool {
	var roomError *Error
	return errors.As(err, &roomError) && roomError.Code == code
}

// admittedBy values.
const (
	admittedByGrant = "grant"
	admittedByCode  = "code"
)

type participant struct {
	clientID string
	peerID   string
	// An empty sessionID means offline; validated wire IDs are never empty.
	sessionID  string
	admittedBy string
}

// Room is one room's authority plus its participants. It has no exported
// members: callers hold the pointer only to compare identity across the
// unlocked password derivation.
type Room struct {
	roomID                        string
	hostTokenDigest               []byte
	viewerGrantDigest             []byte
	viewerPasswordMaterial        []byte
	viewerAuthorizationGeneration string
	codeEntryPolicy               protocol.CodeEntryPolicy
	host                          *participant
	// Process-local: restored rooms receive a fresh reconnect window. Only the
	// last authenticated departure updates this; failed admission cannot renew it.
	emptySinceMs int64
	// Insertion order decides viewer presence order, the
	// closed-session list and the router's participant order.
	viewers ordered.Map[string, *participant]
}

// CreatedRoom carries newly issued Host authority and an optional Viewer grant.
type CreatedRoom struct {
	RoomID          string
	HostToken       string
	CodeEntryPolicy protocol.CodeEntryPolicy
	ViewerGrant     string
}

// ConnectParticipantInput uses Token for a Host and ViewerGrant for a Viewer.
// Empty credentials are absent.
type ConnectParticipantInput struct {
	RoomID      string
	Role        protocol.Role
	Token       string
	ViewerGrant string
	ClientID    string
	SessionID   string
}

// ConnectViewerWithPasswordInput supplies Viewer password admission. Password is
// consumed by the caller's DeriveViewerPassword call, not by the commit.
type ConnectViewerWithPasswordInput struct {
	RoomID    string
	Password  string
	ClientID  string
	SessionID string
}

// ConnectedParticipant records admission and any session it superseded.
// ReplacedSessionID is empty when no connected session was replaced.
type ConnectedParticipant struct {
	RoomID                        string
	Role                          protocol.Role
	PeerID                        string
	HostOnline                    bool
	ReplacedSessionID             string
	CodeEntryPolicy               protocol.CodeEntryPolicy
	ViewerPasswordEnabled         bool
	ViewerAuthorizationGeneration string
}

type DisconnectedParticipant struct {
	RoomID string
	Role   protocol.Role
	PeerID string
}

type ConnectedPeer struct {
	PeerID    string
	SessionID string
}

type ClosedRoom struct {
	RoomID     string
	SessionIDs []string
}

type ReplacedRoom struct {
	Created CreatedRoom
	Closed  ClosedRoom
}

// RevokedViewer identifies revoked admission. SessionID is empty for an offline Viewer.
type RevokedViewer struct {
	PeerID    string
	SessionID string
}

// ViewerGrantUpdate carries a grant change and affected Viewers; ViewerGrant is
// empty when the invitation was revoked.
type ViewerGrantUpdate struct {
	ViewerGrant                           string
	ViewerAuthorizationGeneration         string
	PreviousViewerAuthorizationGeneration string
	RevokedViewers                        []RevokedViewer
}

type CodeEntryUpdate struct {
	CodeEntryPolicy       protocol.CodeEntryPolicy
	ViewerPasswordEnabled bool
}

// Options configures capacity, optional persistence and injectable entropy/time.
type Options struct {
	MaxRooms          int
	MaxViewersPerRoom int
	Database          *Database
	Random            func(size int) []byte
	Now               func() int64
}

// Store owns room authority. See the package comment for the locking contract.
type Store struct {
	// Insertion order determines the order returned by AbandonAllRooms.
	rooms             ordered.Map[string, *Room]
	freeRoomCodes     []string
	random            func(size int) []byte
	now               func() int64
	database          *Database
	initialized       bool
	maxRooms          int
	maxViewersPerRoom int
	// The derivation gate bounds work across every room in this store.
	gate gate
}

// New validates limits and prepares a Store; Initialize loads persisted authority.
func New(options Options) (*Store, error) {
	if options.MaxRooms <= 0 || options.MaxRooms > Capacity {
		return nil, fmt.Errorf("Room limit must be an integer between 1 and %d", Capacity)
	}
	if options.MaxViewersPerRoom <= 0 ||
		options.MaxViewersPerRoom > protocol.MaxViewersPerRoomLimit {
		return nil, fmt.Errorf(
			"Room viewer limit must be an integer between 1 and %d",
			protocol.MaxViewersPerRoomLimit)
	}
	store := &Store{
		freeRoomCodes:     make([]string, Capacity),
		random:            options.Random,
		now:               options.Now,
		database:          options.Database,
		initialized:       options.Database == nil,
		maxRooms:          options.MaxRooms,
		maxViewersPerRoom: options.MaxViewersPerRoom,
		gate:              gate{limit: gateActiveLimit, pendingLimit: gatePendingLimit},
	}
	for index := range store.freeRoomCodes {
		store.freeRoomCodes[index] = strconv.Itoa(roomCodeFirst + index)
	}
	if store.random == nil {
		store.random = cryptoRandom
	}
	if store.now == nil {
		store.now = func() int64 { return time.Now().UnixMilli() }
	}
	return store, nil
}

func cryptoRandom(size int) []byte {
	value := make([]byte, size)
	// crypto/rand.Read never fails; it panics if the operating system source does.
	_, _ = rand.Read(value)
	return value
}

// MaxViewersPerRoom is the readonly RoomStore field of the same name.
func (s *Store) MaxViewersPerRoom() int { return s.maxViewersPerRoom }

// Size is the `size` getter.
func (s *Store) Size() int { return s.rooms.Len() }

// Close closes the database.
func (s *Store) Close() error {
	if s.database == nil {
		return nil
	}
	return s.database.Close()
}

// Initialize recovers the stable authority. It is a no-op without a database.
func (s *Store) Initialize() error {
	if s.initialized {
		return nil
	}
	if s.database == nil {
		s.initialized = true
		return nil
	}
	if err := s.restore(); err != nil {
		s.rooms.Clear()
		_ = s.database.Close()
		return err
	}
	s.initialized = true
	return nil
}

func (s *Store) restore() error {
	storedRooms, err := s.database.Initialize()
	if err != nil {
		return err
	}
	if len(storedRooms) > s.maxRooms {
		return errors.New("Room database exceeds the configured room limit")
	}
	roomIDs := make(map[string]struct{}, len(storedRooms))
	for _, stored := range storedRooms {
		roomIDs[stored.RoomID] = struct{}{}
	}
	if len(roomIDs) != len(storedRooms) {
		return errors.New("Room database contains duplicate room IDs")
	}
	for _, stored := range storedRooms {
		s.rooms.Set(stored.RoomID, &Room{
			roomID:                        stored.RoomID,
			hostTokenDigest:               bytes.Clone(stored.HostTokenDigest),
			viewerGrantDigest:             bytes.Clone(stored.ViewerGrantDigest),
			viewerPasswordMaterial:        bytes.Clone(stored.ViewerPasswordMaterial),
			viewerAuthorizationGeneration: stored.ViewerAuthorizationGeneration,
			codeEntryPolicy:               stored.CodeEntryPolicy,
			emptySinceMs:                  s.now(),
		})
	}
	available := s.freeRoomCodes[:0]
	for _, code := range s.freeRoomCodes {
		if _, taken := roomIDs[code]; !taken {
			available = append(available, code)
		}
	}
	s.freeRoomCodes = available
	return nil
}

// BeginCreateRoom checks room capacity before password derivation.
func (s *Store) BeginCreateRoom() error {
	if err := s.ensureInitialized(); err != nil {
		return err
	}
	if s.rooms.Len() >= s.maxRooms {
		return codeError(CodeRoomLimit)
	}
	return nil
}

// CreateRoom commits room creation. material and derived are the
// results of DeriveViewerPasswordMaterial (both zero when no password was
// given).
func (s *Store) CreateRoom(
	policy protocol.CodeEntryPolicy,
	material []byte,
	derived error,
	preferredRoomID string,
) (CreatedRoom, error) {
	// Derivation failures precede admission checks; gate outcomes are resolved below.
	if derived != nil && !isGateOutcome(derived) {
		return CreatedRoom{}, derived
	}
	if err := s.ensureInitialized(); err != nil {
		return CreatedRoom{}, err
	}
	if s.rooms.Len() >= s.maxRooms {
		return CreatedRoom{}, codeError(CodeRoomLimit)
	}
	if hasCode(derived, CodeRoomBusy) {
		return CreatedRoom{}, codeError(CodeRoomBusy)
	}
	if errors.Is(derived, errDerivationCancelled) {
		return CreatedRoom{}, errors.New("Room creation password derivation was cancelled")
	}
	roomID, err := s.takeRoomCode(preferredRoomID)
	if err != nil {
		return CreatedRoom{}, err
	}
	room, created, err := s.newRoom(roomID, policy, material)
	if err == nil {
		err = s.writeDatabase(func() error { return s.database.InsertRoom(storedRoomAuthority(room)) })
	}
	if err != nil {
		s.releaseRoomCode(roomID)
		return CreatedRoom{}, err
	}
	s.rooms.Set(roomID, room)
	return created, nil
}

// HostManagedRoom returns the room owned by the exact Host token. The caller
// retains its identity while deriving password material outside the lock.
func (s *Store) HostManagedRoom(roomID, hostToken string) (*Room, error) {
	if err := s.ensureInitialized(); err != nil {
		return nil, err
	}
	return s.getHostManagedRoom(roomID, hostToken)
}

// HostStillOwnsRoom is the mayStart closure ReplaceRoom and SetViewerPassword
// hand to the KDF gate: the room must still be the same object and the token
// must still own it. Call it with the lock held.
func (s *Store) HostStillOwnsRoom(roomID, hostToken string, current *Room) bool {
	room, ok := s.rooms.Get(roomID)
	return ok && room == current && verifyDigest(hostToken, room.hostTokenDigest)
}

// ReplaceRoom commits a replacement. current is the room
// HostManagedRoom returned before the derivation.
func (s *Store) ReplaceRoom(
	roomID, hostToken string,
	policy protocol.CodeEntryPolicy,
	material []byte,
	derived error,
	current *Room,
) (ReplacedRoom, error) {
	// Derivation failures return before rechecking authority; gate outcomes do not.
	if derived != nil && !isGateOutcome(derived) {
		return ReplacedRoom{}, derived
	}
	if err := s.ensureInitialized(); err != nil {
		return ReplacedRoom{}, err
	}
	owned, err := s.getHostManagedRoom(roomID, hostToken)
	if err != nil {
		return ReplacedRoom{}, err
	}
	if owned != current || errors.Is(derived, errDerivationCancelled) {
		return ReplacedRoom{}, codeError(CodeRoomAccessDenied)
	}
	if hasCode(derived, CodeRoomBusy) {
		return ReplacedRoom{}, codeError(CodeRoomBusy)
	}

	replacementRoomID, err := s.takeRoomCode("")
	if err != nil {
		return ReplacedRoom{}, err
	}
	replaced, err := s.replaceRoom(roomID, replacementRoomID, policy, material, current)
	if err != nil {
		s.releaseRoomCode(replacementRoomID)
		return ReplacedRoom{}, err
	}
	return replaced, nil
}

func (s *Store) replaceRoom(
	roomID, replacementRoomID string,
	policy protocol.CodeEntryPolicy,
	material []byte,
	current *Room,
) (ReplacedRoom, error) {
	room, created, err := s.newRoom(replacementRoomID, policy, material)
	if err != nil {
		return ReplacedRoom{}, err
	}
	err = s.writeDatabase(func() error {
		return s.database.ReplaceRoom(roomID, current.hostTokenDigest, storedRoomAuthority(room))
	})
	if err != nil {
		return ReplacedRoom{}, err
	}
	closed := ClosedRoom{RoomID: roomID, SessionIDs: connectedSessionIDs(current)}
	s.rooms.Delete(roomID)
	s.rooms.Set(replacementRoomID, room)
	s.releaseRoomCode(roomID)
	return ReplacedRoom{Created: created, Closed: closed}, nil
}

// SetViewerPassword commits a password change; it reports whether
// a password is now set. current is the room HostManagedRoom returned before
// the derivation.
func (s *Store) SetViewerPassword(
	roomID, hostToken string,
	material []byte,
	derived error,
	current *Room,
) (bool, error) {
	// Derivation failures return before rechecking authority; gate outcomes do not.
	if derived != nil && !isGateOutcome(derived) {
		return false, derived
	}
	if err := s.ensureInitialized(); err != nil {
		return false, err
	}
	currentRoom, err := s.getHostManagedRoom(roomID, hostToken)
	if err != nil {
		return false, err
	}
	if currentRoom != current || errors.Is(derived, errDerivationCancelled) {
		return false, codeError(CodeRoomAccessDenied)
	}
	if hasCode(derived, CodeRoomBusy) {
		return false, codeError(CodeRoomBusy)
	}
	err = s.writeDatabase(func() error {
		return s.database.SetViewerPassword(roomID, currentRoom.hostTokenDigest, material)
	})
	if err != nil {
		return false, err
	}
	currentRoom.viewerPasswordMaterial = material
	return material != nil, nil
}

// SetCodeEntryPolicy updates code admission under exact Host authority.
func (s *Store) SetCodeEntryPolicy(
	roomID string,
	policy protocol.CodeEntryPolicy,
	hostToken string,
) (CodeEntryUpdate, error) {
	if err := s.ensureInitialized(); err != nil {
		return CodeEntryUpdate{}, err
	}
	room, err := s.getHostManagedRoom(roomID, hostToken)
	if err != nil {
		return CodeEntryUpdate{}, err
	}
	err = s.writeDatabase(func() error {
		return s.database.SetCodeEntryPolicy(roomID, room.hostTokenDigest, policy)
	})
	if err != nil {
		return CodeEntryUpdate{}, err
	}
	room.codeEntryPolicy = policy
	return CodeEntryUpdate{
		CodeEntryPolicy:       policy,
		ViewerPasswordEnabled: room.viewerPasswordMaterial != nil,
	}, nil
}

// SetViewerGrant rotates or revokes invitations and removes grant-admitted Viewers.
func (s *Store) SetViewerGrant(
	roomID, action, hostToken string,
) (ViewerGrantUpdate, error) {
	if err := s.ensureInitialized(); err != nil {
		return ViewerGrantUpdate{}, err
	}
	room, err := s.getHostManagedRoom(roomID, hostToken)
	if err != nil {
		return ViewerGrantUpdate{}, err
	}
	previousGeneration := room.viewerAuthorizationGeneration
	viewerGrant := ""
	if action == "rotate" {
		if viewerGrant, err = s.createViewerGrant(); err != nil {
			return ViewerGrantUpdate{}, err
		}
	}

	var revokedViewers []RevokedViewer
	for _, viewer := range room.viewers.Values() {
		if viewer.admittedBy == admittedByGrant {
			revokedViewers = append(revokedViewers, RevokedViewer{
				PeerID:    viewer.peerID,
				SessionID: viewer.sessionID,
			})
		}
	}
	var viewerGrantDigest []byte
	if viewerGrant != "" {
		viewerGrantDigest = digest(viewerGrant)
	} else {
		if viewerGrantDigest, err = s.randomDigest(); err != nil {
			return ViewerGrantUpdate{}, err
		}
	}
	generation, err := s.newAuthorizationGeneration()
	if err != nil {
		return ViewerGrantUpdate{}, err
	}
	err = s.writeDatabase(func() error {
		return s.database.SetViewerGrant(
			roomID, room.hostTokenDigest, viewerGrantDigest, generation)
	})
	if err != nil {
		return ViewerGrantUpdate{}, err
	}
	room.viewerGrantDigest = viewerGrantDigest
	room.viewerAuthorizationGeneration = generation
	wasOccupied := roomOccupied(room)
	// ordered.Map.All permits removal without skipping surviving entries.
	for clientID, viewer := range room.viewers.All() {
		if viewer.admittedBy == admittedByGrant {
			room.viewers.Delete(clientID)
		}
	}
	if wasOccupied && !roomOccupied(room) {
		room.emptySinceMs = s.now()
	}
	return ViewerGrantUpdate{
		ViewerGrant:                           viewerGrant,
		ViewerAuthorizationGeneration:         room.viewerAuthorizationGeneration,
		PreviousViewerAuthorizationGeneration: previousGeneration,
		RevokedViewers:                        revokedViewers,
	}, nil
}

// ConnectParticipant authenticates a Host token, Viewer grant or open code entry.
func (s *Store) ConnectParticipant(input ConnectParticipantInput) (ConnectedParticipant, error) {
	if err := s.ensureInitialized(); err != nil {
		return ConnectedParticipant{}, err
	}
	room, err := s.getAvailableRoom(input.RoomID)
	if err != nil {
		if input.Role == protocol.RoleViewer && input.ViewerGrant == "" &&
			hasCode(err, CodeInvalidToken) {
			return ConnectedParticipant{}, codeError(CodeRoomNotFound)
		}
		return ConnectedParticipant{}, err
	}
	if input.Role == protocol.RoleHost {
		if !verifyDigest(input.Token, room.hostTokenDigest) {
			return ConnectedParticipant{}, codeError(CodeInvalidToken)
		}
		return s.connectHost(room, input)
	}

	if input.ViewerGrant != "" {
		if !viewerGrantIsValid(room, input.ViewerGrant) {
			return ConnectedParticipant{}, codeError(CodeInvalidToken)
		}
		return s.connectViewer(room, input.ClientID, input.SessionID, admittedByGrant)
	}
	if room.codeEntryPolicy != protocol.CodeEntryOpen {
		return ConnectedParticipant{}, codeError(CodeInvalidToken)
	}
	return s.connectViewer(room, input.ClientID, input.SessionID, admittedByCode)
}

// ViewerGrantMayEnter validates an invitation without admitting a participant.
func (s *Store) ViewerGrantMayEnter(roomID, grant string) (bool, error) {
	if err := s.ensureInitialized(); err != nil {
		return false, err
	}
	room, err := s.getAvailableRoom(roomID)
	if err != nil {
		var roomError *Error
		if errors.As(err, &roomError) {
			return false, nil
		}
		return false, err
	}
	return viewerGrantIsValid(room, grant), nil
}

// ViewerPasswordChallenge is the locked first half of password admission:
// it returns the salt to derive against, a copy of the material to compare with
// and the room reference to re-check afterwards. A missing room and a room
// without a private password both answer with the same 48 zero
// bytes so the derivation cost does not reveal which. An uninitialized store
// fails before this check.
func (s *Store) ViewerPasswordChallenge(
	roomID string,
) (salt, expectedMaterial []byte, room *Room, err error) {
	if err := s.ensureInitialized(); err != nil {
		return nil, nil, nil, err
	}
	found, err := s.getAvailableRoom(roomID)
	if err != nil {
		found = nil
	}
	expectedMaterial = make([]byte, viewerPasswordMaterialBytes)
	if found != nil && found.codeEntryPolicy == protocol.CodeEntryPrivate &&
		found.viewerPasswordMaterial != nil {
		copy(expectedMaterial, found.viewerPasswordMaterial)
	}
	return expectedMaterial[:viewerPasswordSaltBytes], expectedMaterial, found, nil
}

// ConnectViewerWithPassword commits password admission after derivation.
// derived is the DeriveViewerPassword result; expectedMaterial and room come
// from ViewerPasswordChallenge; mayConnect is evaluated with the lock held.
func (s *Store) ConnectViewerWithPassword(
	input ConnectViewerWithPasswordInput,
	derived, expectedMaterial []byte,
	room *Room,
	mayConnect func() bool,
) (ConnectedParticipant, error) {
	if err := s.ensureInitialized(); err != nil {
		return ConnectedParticipant{}, err
	}
	matches := subtle.ConstantTimeCompare(
		derived, expectedMaterial[viewerPasswordSaltBytes:]) == 1

	currentRoom, err := s.getAvailableRoom(input.RoomID)
	if err != nil {
		var roomError *Error
		if errors.As(err, &roomError) {
			return ConnectedParticipant{}, codeError(CodeRoomNotFound)
		}
		return ConnectedParticipant{}, err
	}
	if room == nil || currentRoom != room ||
		currentRoom.codeEntryPolicy != protocol.CodeEntryPrivate ||
		currentRoom.viewerPasswordMaterial == nil ||
		!matches ||
		subtle.ConstantTimeCompare(currentRoom.viewerPasswordMaterial, expectedMaterial) != 1 ||
		!mayConnect() {
		return ConnectedParticipant{}, codeError(CodeInvalidToken)
	}
	connected, err := s.connectViewer(
		currentRoom, input.ClientID, input.SessionID, admittedByCode)
	if hasCode(err, CodeRoomFull) {
		return ConnectedParticipant{}, codeError(CodeInvalidToken)
	}
	return connected, err
}

// DisconnectParticipant clears only the matching session and returns nil when
// the room, peer or current session no longer matches.
func (s *Store) DisconnectParticipant(
	roomID, peerID, sessionID string,
) (*DisconnectedParticipant, error) {
	if err := s.ensureInitialized(); err != nil {
		return nil, err
	}
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return nil, nil
	}

	if room.host != nil && room.host.peerID == peerID {
		if room.host.sessionID != sessionID {
			return nil, nil
		}
		room.host.sessionID = ""
		if !roomOccupied(room) {
			room.emptySinceMs = s.now()
		}
		return &DisconnectedParticipant{
			RoomID: roomID, Role: protocol.RoleHost, PeerID: peerID}, nil
	}

	viewer := findViewerByPeerID(room, peerID)
	if viewer == nil || viewer.sessionID != sessionID {
		return nil, nil
	}
	viewer.sessionID = ""
	if !roomOccupied(room) {
		room.emptySinceMs = s.now()
	}
	return &DisconnectedParticipant{
		RoomID: roomID, Role: protocol.RoleViewer, PeerID: peerID}, nil
}

// RemoveDisconnectedViewer removes a Viewer only if it has no current session.
func (s *Store) RemoveDisconnectedViewer(roomID, peerID string) bool {
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return false
	}
	viewer := findViewerByPeerID(room, peerID)
	if viewer == nil || viewer.sessionID != "" {
		return false
	}
	return room.viewers.Delete(viewer.clientID)
}

// GetConnectedHost returns only a Host with a current session.
func (s *Store) GetConnectedHost(roomID string) (ConnectedPeer, bool) {
	room, ok := s.rooms.Get(roomID)
	if !ok || room.host == nil || room.host.sessionID == "" {
		return ConnectedPeer{}, false
	}
	return ConnectedPeer{PeerID: room.host.peerID, SessionID: room.host.sessionID}, true
}

// GetConnectedViewer returns only a Viewer with a current session.
func (s *Store) GetConnectedViewer(roomID, peerID string) (ConnectedPeer, bool) {
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return ConnectedPeer{}, false
	}
	viewer := findViewerByPeerID(room, peerID)
	if viewer == nil || viewer.sessionID == "" {
		return ConnectedPeer{}, false
	}
	return ConnectedPeer{PeerID: peerID, SessionID: viewer.sessionID}, true
}

// GetViewerPeerIDs is getViewerPeerIds, in viewer insertion order.
func (s *Store) GetViewerPeerIDs(roomID string) []string {
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return nil
	}
	peerIDs := make([]string, 0, room.viewers.Len())
	for _, viewer := range room.viewers.Values() {
		peerIDs = append(peerIDs, viewer.peerID)
	}
	return peerIDs
}

// GetConnectedViewers is getConnectedViewers, in viewer insertion order.
func (s *Store) GetConnectedViewers(roomID string) []ConnectedPeer {
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return nil
	}
	var connected []ConnectedPeer
	for _, viewer := range room.viewers.Values() {
		if viewer.sessionID != "" {
			connected = append(connected, ConnectedPeer{
				PeerID: viewer.peerID, SessionID: viewer.sessionID})
		}
	}
	return connected
}

// AbandonRoom retires room authority, returning nil if the room is already absent.
func (s *Store) AbandonRoom(roomID string) (*ClosedRoom, error) {
	closed, err := s.abandonRooms([]string{roomID})
	if err != nil || len(closed) == 0 {
		return nil, err
	}
	return &closed[0], nil
}

// Retire a batch atomically before releasing codes. One SQLite transaction
// avoids thousands of fsyncs under the signaling lock after a restart.
func (s *Store) abandonRooms(roomIDs []string) ([]ClosedRoom, error) {
	if err := s.ensureInitialized(); err != nil {
		return nil, err
	}
	var authorities []StoredRoomAuthority
	var closed []ClosedRoom
	for _, roomID := range roomIDs {
		if room, ok := s.rooms.Get(roomID); ok {
			authorities = append(authorities, StoredRoomAuthority{RoomID: roomID, HostTokenDigest: room.hostTokenDigest})
			closed = append(closed, ClosedRoom{RoomID: roomID, SessionIDs: connectedSessionIDs(room)})
		}
	}
	if len(closed) == 0 {
		return nil, nil
	}
	err := s.writeDatabase(func() error {
		return s.database.deleteRooms(authorities)
	})
	if err != nil {
		return nil, err
	}
	for _, room := range closed {
		s.rooms.Delete(room.RoomID)
		s.releaseRoomCode(room.RoomID)
	}
	return closed, nil
}

// AbandonAllRooms is abandonAllRooms, in room insertion order.
func (s *Store) AbandonAllRooms() ([]ClosedRoom, error) {
	return s.abandonRooms(s.rooms.Keys())
}

func (s *Store) connectHost(
	room *Room, input ConnectParticipantInput,
) (ConnectedParticipant, error) {
	current := room.host
	if current != nil && current.sessionID != "" && current.clientID != input.ClientID {
		return ConnectedParticipant{}, codeError(CodeHostAlreadyConnected)
	}

	joining := current
	if current == nil || current.clientID != input.ClientID {
		peerID, err := s.newPeerID(room)
		if err != nil {
			return ConnectedParticipant{}, err
		}
		joining = &participant{
			clientID: input.ClientID, peerID: peerID, admittedBy: admittedByCode}
	}
	replacedSessionID := joining.sessionID
	joining.sessionID = input.SessionID
	room.host = joining

	return connectedParticipant(
		room, joining.peerID, protocol.RoleHost, replacedSessionID, input.SessionID), nil
}

func (s *Store) connectViewer(
	room *Room, clientID, sessionID, admittedBy string,
) (ConnectedParticipant, error) {
	joining, ok := room.viewers.Get(clientID)
	if !ok && room.viewers.Len() >= s.maxViewersPerRoom {
		return ConnectedParticipant{}, codeError(CodeRoomFull)
	}
	if !ok {
		peerID, err := s.newPeerID(room)
		if err != nil {
			return ConnectedParticipant{}, err
		}
		joining = &participant{clientID: clientID, peerID: peerID, admittedBy: admittedBy}
	}
	replacedSessionID := joining.sessionID
	joining.sessionID = sessionID
	joining.admittedBy = admittedBy
	// ordering: Map.set keeps the position of an existing key.
	room.viewers.Set(clientID, joining)
	return connectedParticipant(
		room, joining.peerID, protocol.RoleViewer, replacedSessionID, sessionID), nil
}

func connectedParticipant(
	room *Room, peerID string, role protocol.Role, replacedSessionID, sessionID string,
) ConnectedParticipant {
	if replacedSessionID == sessionID {
		replacedSessionID = ""
	}
	return ConnectedParticipant{
		RoomID:                        room.roomID,
		Role:                          role,
		PeerID:                        peerID,
		HostOnline:                    room.host != nil && room.host.sessionID != "",
		ReplacedSessionID:             replacedSessionID,
		CodeEntryPolicy:               room.codeEntryPolicy,
		ViewerPasswordEnabled:         room.viewerPasswordMaterial != nil,
		ViewerAuthorizationGeneration: room.viewerAuthorizationGeneration,
	}
}

func (s *Store) getAvailableRoom(roomID string) (*Room, error) {
	room, ok := s.rooms.Get(roomID)
	if !ok {
		return nil, codeError(CodeInvalidToken)
	}
	return room, nil
}

func (s *Store) getHostManagedRoom(roomID, hostToken string) (*Room, error) {
	room, err := s.getAvailableRoom(roomID)
	if err != nil {
		return nil, err
	}
	if !verifyDigest(hostToken, room.hostTokenDigest) {
		return nil, codeError(CodeInvalidToken)
	}
	return room, nil
}

func (s *Store) newPeerID(room *Room) (string, error) {
	return s.uniqueID(16, func(candidate string) bool {
		if room.host != nil && room.host.peerID == candidate {
			return true
		}
		for _, viewer := range room.viewers.Values() {
			if viewer.peerID == candidate {
				return true
			}
		}
		return false
	})
}

func (s *Store) takeRoomCode(preferredRoomID string) (string, error) {
	if len(s.freeRoomCodes) == 0 {
		return "", codeError(CodeRoomLimit)
	}
	if preferredRoomID != "" {
		if index := slices.Index(s.freeRoomCodes, preferredRoomID); index >= 0 {
			return s.takeRoomCodeAt(index), nil
		}
	}
	index, err := uniformIndex(len(s.freeRoomCodes), s.random)
	if err != nil {
		return "", err
	}
	return s.takeRoomCodeAt(index), nil
}

// uniformIndex draws a uniform index below count from 8 random bytes, rejecting
// the incomplete final bucket of the 2^64 possible values.
// (MaxUint64 % count + 1) % count computes 2^64 % count without overflowing.
func uniformIndex(count int, random func(size int) []byte) (int, error) {
	span := uint64(count)
	remainder := (math.MaxUint64%span + 1) % span
	for attempt := 0; attempt < 16; attempt++ {
		value := random(8)
		if len(value) != 8 {
			return 0, errors.New("Room code random source must return 8 bytes")
		}
		if remainder != 0 &&
			binary.BigEndian.Uint64(value) >= math.MaxUint64-remainder+1 {
			continue
		}
		return int(binary.BigEndian.Uint64(value) % span), nil
	}
	return 0, errors.New("Unable to select a room code uniformly")
}

// takeRoomCodeAt removes the code at index by swapping the last code into it.
func (s *Store) takeRoomCodeAt(index int) string {
	roomID := s.freeRoomCodes[index]
	last := len(s.freeRoomCodes) - 1
	lastRoomID := s.freeRoomCodes[last]
	s.freeRoomCodes = s.freeRoomCodes[:last]
	if index < last {
		s.freeRoomCodes[index] = lastRoomID
	}
	return roomID
}

func (s *Store) releaseRoomCode(roomID string) {
	s.freeRoomCodes = append(s.freeRoomCodes, roomID)
}

func (s *Store) uniqueID(size int, exists func(candidate string) bool) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		value := s.random(size)
		if len(value) != size {
			return "", fmt.Errorf("Identifier random source must return %d bytes", size)
		}
		candidate := base64.RawURLEncoding.EncodeToString(value)
		if !exists(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("Unable to allocate a unique identifier")
}

func viewerGrantIsValid(room *Room, grant string) bool {
	if grant == "" || !protocol.ValidViewerGrant(grant) {
		return false
	}
	return verifyDigest(grant, room.viewerGrantDigest)
}

func (s *Store) createViewerGrant() (string, error) {
	secret := s.random(16)
	if len(secret) != 16 {
		return "", errors.New("Viewer grant random source must return 16 bytes")
	}
	return base64.RawURLEncoding.EncodeToString(secret), nil
}

func (s *Store) newRoom(
	roomID string,
	policy protocol.CodeEntryPolicy,
	material []byte,
) (*Room, CreatedRoom, error) {
	hostTokenBytes := s.random(32)
	if len(hostTokenBytes) != 32 {
		return nil, CreatedRoom{}, errors.New("Host token random source must return 32 bytes")
	}
	hostToken := base64.RawURLEncoding.EncodeToString(hostTokenBytes)
	viewerGrant, err := s.createViewerGrant()
	if err != nil {
		return nil, CreatedRoom{}, err
	}
	generation, err := s.newAuthorizationGeneration()
	if err != nil {
		return nil, CreatedRoom{}, err
	}
	room := &Room{
		roomID:                        roomID,
		hostTokenDigest:               digest(hostToken),
		viewerGrantDigest:             digest(viewerGrant),
		viewerPasswordMaterial:        material,
		viewerAuthorizationGeneration: generation,
		codeEntryPolicy:               policy,
		emptySinceMs:                  s.now(),
	}
	return room, CreatedRoom{
		RoomID:          roomID,
		HostToken:       hostToken,
		CodeEntryPolicy: policy,
		ViewerGrant:     viewerGrant,
	}, nil
}

func (s *Store) randomDigest() ([]byte, error) {
	value := s.random(32)
	if len(value) != 32 {
		return nil, errors.New("Viewer grant random source must return 32 bytes")
	}
	return bytes.Clone(value), nil
}

func (s *Store) newAuthorizationGeneration() (string, error) {
	value := s.random(16)
	if len(value) != 16 {
		return "", errors.New("Authorization generation random source must return 16 bytes")
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func (s *Store) ensureInitialized() error {
	if !s.initialized {
		return errors.New("RoomStore stable authority is not initialized")
	}
	return nil
}

// writeDatabase runs a stable-authority write when a database is configured.
func (s *Store) writeDatabase(write func() error) error {
	if s.database == nil {
		return nil
	}
	return write()
}

func storedRoomAuthority(room *Room) StoredRoomAuthority {
	return StoredRoomAuthority{
		RoomID:                        room.roomID,
		HostTokenDigest:               room.hostTokenDigest,
		ViewerGrantDigest:             room.viewerGrantDigest,
		ViewerAuthorizationGeneration: room.viewerAuthorizationGeneration,
		CodeEntryPolicy:               room.codeEntryPolicy,
		ViewerPasswordMaterial:        room.viewerPasswordMaterial,
	}
}

func findViewerByPeerID(room *Room, peerID string) *participant {
	for _, viewer := range room.viewers.Values() {
		if viewer.peerID == peerID {
			return viewer
		}
	}
	return nil
}

func connectedSessionIDs(room *Room) []string {
	var sessionIDs []string
	if room.host != nil && room.host.sessionID != "" {
		sessionIDs = append(sessionIDs, room.host.sessionID)
	}
	for _, viewer := range room.viewers.Values() {
		if viewer.sessionID != "" {
			sessionIDs = append(sessionIDs, viewer.sessionID)
		}
	}
	return sessionIDs
}

func digest(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func verifyDigest(value string, expectedDigest []byte) bool {
	return subtle.ConstantTimeCompare(digest(value), expectedDigest) == 1
}
