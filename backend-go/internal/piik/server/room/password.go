package room

import (
	"errors"
	"slices"
	"sync"

	"golang.org/x/crypto/scrypt"

	"zviewer/backend/internal/piik/server/protocol"
)

const (
	viewerPasswordSaltBytes     = 16
	viewerPasswordVerifierBytes = 32
	viewerPasswordMaterialBytes = viewerPasswordSaltBytes + viewerPasswordVerifierBytes

	viewerPasswordScryptN = 16_384
	viewerPasswordScryptR = 8
	viewerPasswordScryptP = 1

	// Scrypt at N=16384 costs ~16 MiB per derivation, so two concurrent
	// derivations bound the memory and CPU a room burst can claim, and sixteen
	// waiters bound the queue before the next caller is told ROOM_BUSY.
	gateActiveLimit  = 2
	gatePendingLimit = 16
)

// errDerivationCancelled means the queued caller lost authority before its
// derivation started. The caller maps it to the operation's error.
var errDerivationCancelled = errors.New("password derivation was cancelled")

// isGateOutcome identifies admission results that the commit boundary resolves
// after rechecking room authority. Other derivation errors return immediately.
func isGateOutcome(err error) bool {
	return errors.Is(err, errDerivationCancelled) || hasCode(err, CodeRoomBusy)
}

// DeriveViewerPasswordMaterial validates the password, draws a fresh salt and
// returns salt||verifier. Call it without the caller's lock held and pass both
// results to CreateRoom, ReplaceRoom or SetViewerPassword unchanged so those
// commits can recheck authority before reporting busy/cancelled admission.
// A nil mayStart permits derivation once the gate admits it.
func (s *Store) DeriveViewerPasswordMaterial(
	password string, mayStart func() bool,
) ([]byte, error) {
	if !protocol.ValidViewerPassword(password) {
		return nil, codeError(CodeInvalidToken)
	}
	salt := s.random(viewerPasswordSaltBytes)
	if len(salt) != viewerPasswordSaltBytes {
		return nil, errors.New("Viewer password salt source must return 16 bytes")
	}
	verifier, err := s.deriveViewerPassword(password, salt, mayStart)
	if err != nil {
		return nil, err
	}
	return slices.Concat(salt, verifier), nil
}

// DeriveViewerPassword is the unlocked password-admission step: it derives the
// verifier for the salt ViewerPasswordChallenge returned. Gate failures return
// before the room commit; cancelled admission is reported as an invalid token.
func (s *Store) DeriveViewerPassword(
	password string, salt []byte, mayConnect func() bool,
) ([]byte, error) {
	if !protocol.ValidViewerPassword(password) {
		return nil, codeError(CodeInvalidToken)
	}
	derived, err := s.deriveViewerPassword(password, salt, mayConnect)
	if errors.Is(err, errDerivationCancelled) {
		return nil, codeError(CodeInvalidToken)
	}
	return derived, err
}

func (s *Store) deriveViewerPassword(
	password string, salt []byte, mayStart func() bool,
) ([]byte, error) {
	return s.gate.run(mayStart, func() ([]byte, error) {
		return scrypt.Key([]byte(password), salt,
			viewerPasswordScryptN, viewerPasswordScryptR, viewerPasswordScryptP,
			viewerPasswordVerifierBytes)
	})
}

// gate admits at most limit concurrent derivations and at most
// pendingLimit wait, first in first out. A saturated gate answers ROOM_BUSY.
type gate struct {
	mu           sync.Mutex
	active       int
	waiters      []chan struct{}
	limit        int
	pendingLimit int
}

func (g *gate) run(mayStart func() bool, task func() ([]byte, error)) ([]byte, error) {
	if !g.acquire() {
		return nil, codeError(CodeRoomBusy)
	}
	defer g.release()
	if mayStart != nil && !mayStart() {
		return nil, errDerivationCancelled
	}
	return task()
}

func (g *gate) acquire() bool {
	g.mu.Lock()
	if g.active < g.limit {
		g.active++
		g.mu.Unlock()
		return true
	}
	if len(g.waiters) >= g.pendingLimit {
		g.mu.Unlock()
		return false
	}
	wake := make(chan struct{})
	g.waiters = append(g.waiters, wake)
	g.mu.Unlock()
	<-wake
	return true
}

// release transfers the active slot to the first waiter, keeping new callers
// behind already queued derivations.
func (g *gate) release() {
	g.mu.Lock()
	if len(g.waiters) > 0 {
		wake := g.waiters[0]
		g.waiters = g.waiters[1:]
		g.mu.Unlock()
		close(wake)
		return
	}
	g.active--
	g.mu.Unlock()
}
