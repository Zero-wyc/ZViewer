// Package room owns room codes, Host/Viewer credentials, participant membership
// and persistent room authority. Durable mutations write SQLite before memory;
// participants and live connections remain process-only.
//
// # Locking And Password Work
//
// Store has no mutex. The caller holds the signaling server's global lock for
// store operations, except password derivation, which must run unlocked.
//
// Password changes use a locked begin, unlocked derive, then locked commit.
// Pass both material and error from DeriveViewerPasswordMaterial unchanged;
// the commit revalidates room ownership/capacity before mapping gate outcomes.
// Viewer login instead returns derivation errors before committing credentials.
//
// A derivation admission predicate runs outside the signaling lock and must
// acquire that lock when consulting room/session state. ConnectViewerWithPassword
// also calls its predicate during the locked commit, so that call needs the
// already-locked form. Both must express the same current-session condition.
//
// HostManagedRoom and ViewerPasswordChallenge return a room reference for
// identity checks after unlocked work. A removed room is never reused as its
// replacement; a stale reference cannot authorize mutation of the new room.
// Do not inspect a retained room's mutable state without the lock.
//
// Options.Random is used under the caller's lock and by derivation goroutines,
// so it must be concurrency-safe; crypto/rand satisfies this requirement.
package room
