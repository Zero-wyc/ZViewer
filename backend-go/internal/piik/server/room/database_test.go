package room

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"zviewer/backend/internal/piik/server/protocol"
)

// The scenarios below are ported from tests/room-database.test.ts.

func databasePath(t *testing.T) string {
	t.Helper()
	// t.TempDir registers its removal before any store cleanup below, so the
	// database is always closed first; Windows will not remove an open file.
	return filepath.Join(t.TempDir(), "rooms.sqlite")
}

func stableStore(t *testing.T, path string, options Options) *Store {
	t.Helper()
	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if options.MaxRooms == 0 {
		options.MaxRooms = 8
	}
	options.MaxViewersPerRoom = 8
	options.Database = database
	store, err := New(options)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return store
}

func rawDatabase(t *testing.T, path string) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func rawExec(t *testing.T, path, statement string) {
	t.Helper()
	if _, err := rawDatabase(t, path).Exec(statement); err != nil {
		t.Fatalf("raw exec %q: %v", statement, err)
	}
}

func dbViewerInput(roomID, sessionID, viewerGrant string) ConnectParticipantInput {
	input := viewerInput(roomID, sessionID, viewerGrant)
	input.ClientID = "client-" + sessionID
	return input
}

func TestDoesNotPersistARoomWhenPasswordDerivationIsBusy(t *testing.T) {
	path := databasePath(t)
	first := stableStore(t, path, Options{MaxRooms: 1})

	withSaturatedGate(t, first, func() {
		_, err := tryCreateRoom(first, protocol.CodeEntryPrivate, "room-password", "4321")
		expectCode(t, err, CodeRoomBusy)
	})
	if first.Size() != 0 {
		t.Fatalf("size = %d, want 0", first.Size())
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, Options{MaxRooms: 1})
	if second.Size() != 0 {
		t.Fatalf("restored size = %d, want 0", second.Size())
	}
	if created := createRoom(t, second, protocol.CodeEntryPrivate, "", "4321"); created.RoomID != "4321" {
		t.Fatalf("room = %q, want 4321", created.RoomID)
	}
}

func TestRoomCreationStorageFailuresPreserveAuthority(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		install string
		remove  string
		code    int
	}{
		{
			name: "read-only connection", install: "PRAGMA query_only = ON",
			remove: "PRAGMA query_only = OFF", code: sqlite3.SQLITE_READONLY,
		},
		{
			// The room INSERT succeeds; a deferred constraint rejects COMMIT.
			// Temporary objects leave the production schema unchanged.
			name: "commit rejection",
			install: `PRAGMA foreign_keys = ON;
				CREATE TEMP TABLE fault_parent (id INTEGER PRIMARY KEY);
				CREATE TEMP TABLE fault_child (
					id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED
				);
				CREATE TEMP TRIGGER reject_commit AFTER INSERT ON main.rooms
				BEGIN INSERT INTO fault_child VALUES (1); END;`,
			remove: "DROP TRIGGER temp.reject_commit",
			code:   sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			path := databasePath(t)
			store := stableStore(t, path, Options{})
			createRoom(t, store, protocol.CodeEntryOpen, "", "4321")
			before, err := store.database.readStoredRooms()
			if err != nil {
				t.Fatal(err)
			}
			free := len(store.freeRoomCodes)
			if _, err := store.database.exec(testCase.install); err != nil {
				t.Fatal(err)
			}
			_, err = tryCreateRoom(store, protocol.CodeEntryOpen, "", "5678")
			var sqliteErr *sqlite.Error
			if !errors.As(err, &sqliteErr) || sqliteErr.Code() != testCase.code {
				t.Fatalf("create error = %v, want SQLite code %d", err, testCase.code)
			}
			after, err := store.database.readStoredRooms()
			if err != nil || !reflect.DeepEqual(before, after) || store.Size() != 1 || len(store.freeRoomCodes) != free {
				t.Fatalf("failed write changed authority: rooms=%d, free=%d, error=%v", store.Size(), len(store.freeRoomCodes), err)
			}
			if _, err := store.database.exec(testCase.remove); err != nil {
				t.Fatal(err)
			}
			created := createRoom(t, store, protocol.CodeEntryOpen, "", "5678")
			if created.RoomID != "5678" {
				t.Fatalf("failed write did not release room code: %s", created.RoomID)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			restored := stableStore(t, path, Options{})
			if restored.Size() != 2 {
				t.Fatalf("restored rooms = %d, want 2", restored.Size())
			}
			if _, err := restored.HostManagedRoom(created.RoomID, created.HostToken); err != nil {
				t.Fatalf("restored Host authority: %v", err)
			}
		})
	}
}

func TestDatabaseFullDoesNotConsumeRoomAuthorityOrPreventLaterWrites(t *testing.T) {
	path := databasePath(t)
	store := stableStore(t, path, Options{MaxRooms: 1000})
	initialFree := len(store.freeRoomCodes)
	pages, err := store.database.readPragmaInteger("page_count")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.database.exec(fmt.Sprintf("PRAGMA max_page_count = %d", pages)); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 1000; n++ {
		roomID := fmt.Sprintf("%04d", 1000+n)
		_, err := tryCreateRoom(store, protocol.CodeEntryOpen, "", roomID)
		if err == nil {
			continue
		}
		var sqliteErr *sqlite.Error
		if !errors.As(err, &sqliteErr) || sqliteErr.Code() != sqlite3.SQLITE_FULL {
			t.Fatalf("create error = %v, want SQLITE_FULL", err)
		}
		rows, err := store.database.readStoredRooms()
		if err != nil || len(rows) != n || store.Size() != n || len(store.freeRoomCodes) != initialFree-n {
			t.Fatalf("full database changed authority: rows=%d, rooms=%d, free=%d, error=%v", len(rows), store.Size(), len(store.freeRoomCodes), err)
		}
		if _, err := store.database.exec("PRAGMA max_page_count = 1000"); err != nil {
			t.Fatal(err)
		}
		created := createRoom(t, store, protocol.CodeEntryOpen, "", roomID)
		if created.RoomID != roomID {
			t.Fatalf("recovered room code = %s, want %s", created.RoomID, roomID)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
		restored := stableStore(t, path, Options{MaxRooms: 1000})
		if restored.Size() != n+1 {
			t.Fatalf("restored rooms = %d, want %d", restored.Size(), n+1)
		}
		if _, err := restored.HostManagedRoom(created.RoomID, created.HostToken); err != nil {
			t.Fatalf("restored Host authority: %v", err)
		}
		return
	}
	t.Fatal("bounded database did not reach SQLITE_FULL")
}

func TestRestoresTheExactAuthorityAggregateWithoutParticipants(t *testing.T) {
	path := databasePath(t)
	first := stableStore(t, path, Options{})
	room := createRoom(t, first, protocol.CodeEntryOpen, "", "4321")
	if _, err := first.SetCodeEntryPolicy(
		room.RoomID, protocol.CodeEntryPrivate, room.HostToken); err != nil {
		t.Fatalf("SetCodeEntryPolicy: %v", err)
	}
	if _, err := trySetViewerPassword(
		first, room.RoomID, "room-password", room.HostToken); err != nil {
		t.Fatalf("SetViewerPassword: %v", err)
	}
	rotated, err := first.SetViewerGrant(room.RoomID, "rotate", room.HostToken)
	if err != nil {
		t.Fatalf("SetViewerGrant: %v", err)
	}
	host := mustConnect(t, first, hostInput(room.RoomID, room.HostToken))
	oldViewer := mustConnect(t, first, dbViewerInput(room.RoomID, "old-viewer", rotated.ViewerGrant))
	if connected, ok := first.GetConnectedHost(room.RoomID); !ok || connected.PeerID != host.PeerID {
		t.Fatalf("host = %+v %v", connected, ok)
	}
	if _, ok := first.GetConnectedViewer(room.RoomID, oldViewer.PeerID); !ok {
		t.Fatal("viewer is not connected")
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, Options{})
	if second.Size() != 1 {
		t.Fatalf("restored size = %d, want 1", second.Size())
	}
	if _, ok := second.GetConnectedHost(room.RoomID); ok {
		t.Fatal("a restored room reported a connected host")
	}
	if viewers := second.GetConnectedViewers(room.RoomID); len(viewers) != 0 {
		t.Fatalf("restored viewers = %+v", viewers)
	}
	_, err = second.ConnectParticipant(dbViewerInput(room.RoomID, "revoked-grant", room.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)

	granted := mustConnect(t, second, dbViewerInput(room.RoomID, "current-grant", rotated.ViewerGrant))
	if granted.ViewerAuthorizationGeneration != rotated.ViewerAuthorizationGeneration {
		t.Fatalf("generation = %q, want %q",
			granted.ViewerAuthorizationGeneration, rotated.ViewerAuthorizationGeneration)
	}
	connected, err := tryConnectViewerWithPassword(second, ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "room-password",
		ClientID:  "password-client",
		SessionID: "password-session",
	}, nil)
	if err != nil || connected.CodeEntryPolicy != protocol.CodeEntryPrivate {
		t.Fatalf("password login = %+v, %v", connected, err)
	}
	_, err = second.ConnectParticipant(hostInput(room.RoomID, "wrong-token"))
	expectCode(t, err, CodeInvalidToken)
	mustConnect(t, second, hostInput(room.RoomID, room.HostToken, "recovered-host"))
	if err := second.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	raw := rawDatabase(t, path)
	rows, err := raw.Query("SELECT * FROM rooms")
	if err != nil {
		t.Fatalf("raw query: %v", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatalf("Columns: %v", err)
	}
	want := []string{
		"room_id", "host_token_digest", "viewer_grant_digest",
		"viewer_authorization_generation", "code_entry_policy",
		"viewer_password_material",
	}
	if strings.Join(columns, ",") != strings.Join(want, ",") {
		t.Fatalf("columns = %v", columns)
	}
	if !rows.Next() {
		t.Fatal("no stored room")
	}
	var (
		roomID      string
		hostDigest  []byte
		grantDigest []byte
		generation  string
		policy      string
		material    []byte
	)
	if err := rows.Scan(&roomID, &hostDigest, &grantDigest, &generation, &policy,
		&material); err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hostTokenDigest := sha256.Sum256([]byte(room.HostToken))
	if !bytes.Equal(hostDigest, hostTokenDigest[:]) {
		t.Fatal("stored Host token digest does not match")
	}
	grantTokenDigest := sha256.Sum256([]byte(rotated.ViewerGrant))
	if !bytes.Equal(grantDigest, grantTokenDigest[:]) {
		t.Fatal("stored Viewer grant digest does not match")
	}
	if len(material) != 48 {
		t.Fatalf("password material = %d bytes, want 48", len(material))
	}
	// Nothing reversible is stored: no token, grant or password appears.
	stored := roomID + generation + policy + string(hostDigest) + string(grantDigest) + string(material)
	for _, secret := range []string{room.HostToken, rotated.ViewerGrant, "room-password"} {
		if strings.Contains(stored, secret) {
			t.Fatal("a credential was stored verbatim")
		}
	}
}

func TestPreservesDisconnectedAuthorityAcrossRepeatedRestarts(t *testing.T) {
	path := databasePath(t)
	first := stableStore(t, path, Options{})
	room := createRoom(t, first, protocol.CodeEntryOpen, "", "5890")
	host := mustConnect(t, first, hostInput(room.RoomID, room.HostToken))
	if _, err := first.DisconnectParticipant(room.RoomID, host.PeerID, "host-session"); err != nil {
		t.Fatalf("DisconnectParticipant: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	for range 3 {
		restored := stableStore(t, path, Options{})
		if restored.Size() != 1 {
			t.Fatalf("size = %d, want 1", restored.Size())
		}
		viewer := mustConnect(t, restored, dbViewerInput(room.RoomID, "dormant-viewer", room.ViewerGrant))
		if viewer.HostOnline {
			t.Fatal("restored room reported an online host")
		}
		mustConnect(t, restored, hostInput(room.RoomID, room.HostToken))
		if err := restored.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	}
}

func TestPersistsExplicitRoomDeletionBeforeRecyclingItsCode(t *testing.T) {
	path := databasePath(t)
	first := stableStore(t, path, Options{})
	room := createRoom(t, first, protocol.CodeEntryOpen, "", "6789")
	closed, err := first.AbandonRoom(room.RoomID)
	if err != nil || closed == nil || closed.RoomID != room.RoomID {
		t.Fatalf("AbandonRoom = %v, %v", closed, err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, Options{})
	if second.Size() != 0 {
		t.Fatalf("size = %d, want 0", second.Size())
	}
	replacement := createRoom(t, second, protocol.CodeEntryOpen, "", room.RoomID)
	if replacement.RoomID != room.RoomID {
		t.Fatalf("replacement room = %q", replacement.RoomID)
	}
	if replacement.HostToken == room.HostToken || replacement.ViewerGrant == room.ViewerGrant {
		t.Fatal("the recycled code kept the old credentials")
	}
}

func TestPersistsRoomReplacementAsOneAuthorityTransition(t *testing.T) {
	path := databasePath(t)
	first := stableStore(t, path, Options{})
	original := createRoom(t, first, protocol.CodeEntryOpen, "", "4321")
	replacement, err := tryReplaceRoom(
		first, original.RoomID, original.HostToken, protocol.CodeEntryPrivate, "new-password")
	if err != nil {
		t.Fatalf("ReplaceRoom: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, Options{})
	if second.Size() != 1 {
		t.Fatalf("size = %d, want 1", second.Size())
	}
	_, err = second.ConnectParticipant(hostInput(original.RoomID, original.HostToken))
	expectCode(t, err, CodeInvalidToken)
	connected := mustConnect(t, second, dbViewerInput(
		replacement.Created.RoomID, "replacement-viewer", replacement.Created.ViewerGrant))
	if connected.RoomID != replacement.Created.RoomID {
		t.Fatalf("viewer joined %q", connected.RoomID)
	}
	withPassword, err := tryConnectViewerWithPassword(second, ConnectViewerWithPasswordInput{
		RoomID:    replacement.Created.RoomID,
		Password:  "new-password",
		ClientID:  "password-viewer",
		SessionID: "password-session",
	}, nil)
	if err != nil || withPassword.RoomID != replacement.Created.RoomID {
		t.Fatalf("password login = %+v, %v", withPassword, err)
	}
}

func TestRollsBackReplacementWhenOldAuthorityIsStale(t *testing.T) {
	path := databasePath(t)
	first := stableStore(t, path, Options{})
	createRoom(t, first, protocol.CodeEntryPrivate, "room-password", "4321")
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	before, err := database.Initialize()
	if err != nil || len(before) != 1 {
		t.Fatalf("Initialize = %v, %v", before, err)
	}
	replacement := before[0]
	replacement.RoomID = "5678"
	err = database.ReplaceRoom("4321", make([]byte, 32), replacement)
	if err == nil || err.Error() != "Room database replacement delete did not match current authority" {
		t.Fatalf("ReplaceRoom = %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	after, err := database.Initialize()
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("failed replacement changed durable authority: %v", err)
	}
}

// TestOpensThePathWithURIReservedCharactersLiterally: `new DatabaseSync(path)`
// opened the literal path, while the driver's DSN is a URI in which `%41`
// decodes to `A` and `#` ends the file name; the file must still be the
// configured one, and the busy-timeout pragma must survive the escaping.
func TestOpensThePathWithURIReservedCharactersLiterally(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rooms%41#1.sqlite")
	first := stableStore(t, path, Options{})
	createRoom(t, first, protocol.CodeEntryOpen, "", "4321")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the configured file was not the one opened: %v", err)
	}
	if second := stableStore(t, path, Options{}); second.Size() != 1 {
		t.Fatalf("restored size = %d, want 1", second.Size())
	}
}

func TestRejectsAnotherOwnerOfTheSameDatabase(t *testing.T) {
	path := databasePath(t)
	first, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := first.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	contender, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	_, err = contender.Initialize()
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "locked") {
		t.Fatalf("contender Initialize = %v, want a lock failure", err)
	}
	if err := contender.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	successor, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	restored, err := successor.Initialize()
	if err != nil || len(restored) != 0 {
		t.Fatalf("successor Initialize = %v, %v", restored, err)
	}
	if err := successor.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestRejectsAnUnknownDatabaseIdentity(t *testing.T) {
	for _, testCase := range []struct{ name, mutation string }{
		{"application identity", "PRAGMA application_id = 1"},
		{"schema version", "PRAGMA user_version = 99"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			path := databasePath(t)
			initial, err := NewDatabase(path)
			if err != nil {
				t.Fatalf("NewDatabase: %v", err)
			}
			if _, err := initial.Initialize(); err != nil {
				t.Fatalf("Initialize: %v", err)
			}
			if err := initial.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
			rawExec(t, path, testCase.mutation)

			reopened, err := NewDatabase(path)
			if err != nil {
				t.Fatalf("NewDatabase: %v", err)
			}
			_, err = reopened.Initialize()
			if err == nil || !strings.Contains(err.Error(), "does not match") {
				t.Fatalf("Initialize = %v", err)
			}
			if err := reopened.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
		})
	}
}

func TestRejectsAnAlteredCurrentVersionSchema(t *testing.T) {
	path := databasePath(t)
	initial, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := initial.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if err := initial.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	rawExec(t, path, "ALTER TABLE rooms ADD COLUMN unexpected TEXT")

	reopened, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	_, err = reopened.Initialize()
	if err == nil || err.Error() != "Room database columns do not match the current schema" {
		t.Fatalf("Initialize = %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestRejectsCorruptAuthorityRows(t *testing.T) {
	path := databasePath(t)
	initial := stableStore(t, path, Options{})
	createRoom(t, initial, protocol.CodeEntryOpen, "", "7890")
	if err := initial.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	raw := rawDatabase(t, path)
	if _, err := raw.Exec("PRAGMA ignore_check_constraints = ON"); err != nil {
		t.Fatalf("raw pragma: %v", err)
	}
	if _, err := raw.Exec("UPDATE rooms SET host_token_digest = zeroblob(31)"); err != nil {
		t.Fatalf("raw update: %v", err)
	}
	if err := raw.Close(); err != nil {
		t.Fatalf("raw close: %v", err)
	}

	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	reopened, err := New(Options{
		MaxRooms:          8,
		MaxViewersPerRoom: 8,
		Database:          database,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// The oracle accepts either rejection: this SQLite build reports the broken
	// row from PRAGMA quick_check before the digest length assertion runs.
	err = reopened.Initialize()
	if err == nil || (!strings.Contains(err.Error(), "Host token") &&
		!strings.Contains(err.Error(), "integrity")) {
		t.Fatalf("Initialize = %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// Invalid authority must be rejected before mutating SQLite.
func TestRejectsInvalidAuthorityArguments(t *testing.T) {
	valid := StoredRoomAuthority{
		RoomID:                        "1234",
		HostTokenDigest:               make([]byte, 32),
		ViewerGrantDigest:             make([]byte, 32),
		ViewerAuthorizationGeneration: "MzMzMzMzMzMzMzMzMzMzMw",
		CodeEntryPolicy:               protocol.CodeEntryOpen,
	}
	shortDigest := make([]byte, 31)
	for _, testCase := range []struct {
		name string
		run  func(*Database) error
		want string
	}{
		{"room ID", func(d *Database) error {
			room := valid
			room.RoomID = "0123"
			return d.InsertRoom(room)
		}, "Room database contains an invalid room ID"},
		{"host digest", func(d *Database) error {
			room := valid
			room.HostTokenDigest = shortDigest
			return d.InsertRoom(room)
		}, "Host token digest must contain 32 bytes"},
		{"grant digest", func(d *Database) error {
			room := valid
			room.ViewerGrantDigest = shortDigest
			return d.InsertRoom(room)
		}, "Viewer grant digest must contain 32 bytes"},
		{"generation", func(d *Database) error {
			room := valid
			room.ViewerAuthorizationGeneration = "MzMzMzMzMzMzMzMzMzMzMw=="
			return d.InsertRoom(room)
		}, "Viewer authorization generation is invalid"},
		{"policy", func(d *Database) error {
			room := valid
			room.CodeEntryPolicy = "public"
			return d.InsertRoom(room)
		}, "Room database contains an invalid code-entry policy"},
		{"password material", func(d *Database) error {
			room := valid
			room.ViewerPasswordMaterial = make([]byte, 47)
			return d.InsertRoom(room)
		}, "Viewer password material must contain 48 bytes"},
		{"identity", func(d *Database) error {
			return d.deleteRooms([]StoredRoomAuthority{{RoomID: "123", HostTokenDigest: make([]byte, 32)}})
		}, "Room ID is invalid"},
		{"update policy", func(d *Database) error {
			return d.SetCodeEntryPolicy("1234", make([]byte, 32), "public")
		}, "Room code-entry policy is invalid"},
		{"replacement identity", func(d *Database) error {
			return d.ReplaceRoom("1234", make([]byte, 32), valid)
		}, "Replacement room ID must be different"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			database, err := NewDatabase(databasePath(t))
			if err != nil {
				t.Fatalf("NewDatabase: %v", err)
			}
			if _, err := database.Initialize(); err != nil {
				t.Fatalf("Initialize: %v", err)
			}
			defer func() { _ = database.Close() }()
			if err := testCase.run(database); err == nil || err.Error() != testCase.want {
				t.Fatalf("error = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestRejectsAMemoryDatabasePath(t *testing.T) {
	for _, path := range []string{"", ":memory:"} {
		if _, err := NewDatabase(path); err == nil ||
			err.Error() != "Room database path must identify a file" {
			t.Fatalf("NewDatabase(%q) = %v", path, err)
		}
	}
}

func TestRejectsASecondInitialize(t *testing.T) {
	path := databasePath(t)
	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := database.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if _, err := database.Initialize(); err == nil ||
		err.Error() != "Room database is already initialized" {
		t.Fatalf("second Initialize = %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := database.InsertRoom(StoredRoomAuthority{
		RoomID:                        "1234",
		HostTokenDigest:               make([]byte, 32),
		ViewerGrantDigest:             make([]byte, 32),
		ViewerAuthorizationGeneration: "MzMzMzMzMzMzMzMzMzMzMw",
		CodeEntryPolicy:               protocol.CodeEntryOpen,
	}); err == nil || err.Error() != "Room database is not initialized" {
		t.Fatalf("InsertRoom after Close = %v", err)
	}
}
