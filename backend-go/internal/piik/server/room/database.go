package room

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	// The pure-Go driver supports builds with CGO_ENABLED=0.
	_ "modernc.org/sqlite"

	"zviewer/backend/internal/piik/server/protocol"
)

// Database identity and the single current schema are checked before adopting
// room authority. The application ID is ASCII "SCRN".
const (
	roomDatabaseApplicationID = 0x5343524e
	roomDatabaseSchemaVersion = 2
)

// roomSchema stores durable authority only, never presence or media state.
const roomSchema = `
        CREATE TABLE rooms (
          room_id TEXT PRIMARY KEY NOT NULL
            CHECK (room_id GLOB '[1-9][0-9][0-9][0-9]'),
          host_token_digest BLOB NOT NULL
            CHECK (typeof(host_token_digest) = 'blob' AND length(host_token_digest) = 32),
          viewer_grant_digest BLOB NOT NULL
            CHECK (typeof(viewer_grant_digest) = 'blob' AND length(viewer_grant_digest) = 32),
          viewer_authorization_generation TEXT NOT NULL
            CHECK (
              length(viewer_authorization_generation) = 22 AND
              viewer_authorization_generation NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          code_entry_policy TEXT NOT NULL
            CHECK (code_entry_policy IN ('open', 'private')),
          viewer_password_material BLOB NULL
            CHECK (
              viewer_password_material IS NULL OR
              (typeof(viewer_password_material) = 'blob' AND length(viewer_password_material) = 48)
            )
        ) STRICT;
        PRAGMA application_id = 1396920910;
        PRAGMA user_version = 2;
      `

// The current schema only inserts/deletes rooms; updates retain rowid. Reading
// its insertion order keeps oldest-empty allocation stable across restarts,
// without persisting presence or adding a creation-time schema migration.
const selectStoredRooms = `SELECT
         room_id,
         host_token_digest,
         viewer_grant_digest,
         viewer_authorization_generation,
         code_entry_policy,
         viewer_password_material
       FROM rooms
       ORDER BY rowid`

const insertStoredRoom = `INSERT INTO rooms (
         room_id,
         host_token_digest,
         viewer_grant_digest,
         viewer_authorization_generation,
         code_entry_policy,
         viewer_password_material
       ) VALUES (?, ?, ?, ?, ?, ?)`

const deleteRoomStatement = "DELETE FROM rooms WHERE room_id = ? AND host_token_digest = ?"

// StoredRoomAuthority excludes transient sessions and presence.
type StoredRoomAuthority struct {
	RoomID                        string
	HostTokenDigest               []byte
	ViewerGrantDigest             []byte
	ViewerAuthorizationGeneration string
	CodeEntryPolicy               protocol.CodeEntryPolicy
	ViewerPasswordMaterial        []byte
}

// Database is RoomDatabase: the SQLite stable authority. It holds one
// connection for its lifetime, because `PRAGMA locking_mode = EXCLUSIVE` is a
// connection property that a recycled pool connection would silently drop.
type Database struct {
	path string
	db   *sql.DB
	conn *sql.Conn
}

// NewDatabase is the RoomDatabase constructor.
func NewDatabase(path string) (*Database, error) {
	if path == "" || path == ":memory:" {
		return nil, errors.New("Room database path must identify a file")
	}
	return &Database{path: path}, nil
}

// Initialize opens the file, takes the exclusive lock, creates or verifies the
// schema and restores all stored room authority.
func (d *Database) Initialize() (restored []StoredRoomAuthority, err error) {
	if d.conn != nil {
		return nil, errors.New("Room database is already initialized")
	}

	// `new DatabaseSync(this.path, { timeout: 0 })`: a lock conflict must fail
	// immediately instead of waiting.
	db, err := sql.Open("sqlite", "file:"+uriPath(d.path)+"?_pragma=busy_timeout(0)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)
	conn, err := db.Conn(context.Background())
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	d.db, d.conn = db, conn
	defer func() {
		if err != nil {
			d.closeHandles()
		}
	}()

	// The pragma answers "exclusive" even when another process owns the file;
	// the BEGIN EXCLUSIVE below is what actually takes the lock.
	var lockingMode string
	if err = d.conn.QueryRowContext(
		context.Background(), "PRAGMA main.locking_mode = EXCLUSIVE").Scan(&lockingMode); err != nil {
		return nil, err
	}
	if lockingMode != "exclusive" {
		return nil, errors.New("Room database could not acquire exclusive locking mode")
	}
	if _, err = d.exec("BEGIN EXCLUSIVE"); err != nil {
		return nil, err
	}
	restored, err = d.recover()
	if err != nil {
		d.rollback()
		return nil, err
	}
	if _, err = d.exec("COMMIT"); err != nil {
		d.rollback()
		return nil, err
	}
	return restored, nil
}

// uriPath is the literal path `new DatabaseSync(this.path)` opened, written for
// the driver's URI DSN: the driver splits on the first `?` and SQLite decodes
// `%HH` and stops at `#`, so those three characters are escaped.
func uriPath(path string) string {
	return strings.NewReplacer("%", "%25", "#", "%23", "?", "%3F").Replace(filepath.ToSlash(path))
}

func (d *Database) recover() ([]StoredRoomAuthority, error) {
	if err := d.ensureExactSchema(); err != nil {
		return nil, err
	}
	if err := d.assertDatabaseIntegrity(); err != nil {
		return nil, err
	}
	return d.readStoredRooms()
}

// InsertRoom persists one validated authority record atomically.
func (d *Database) InsertRoom(room StoredRoomAuthority) error {
	if err := assertStoredRoom(room); err != nil {
		return err
	}
	return d.transaction(func() error {
		changes, err := d.exec(insertStoredRoom,
			room.RoomID,
			room.HostTokenDigest,
			room.ViewerGrantDigest,
			room.ViewerAuthorizationGeneration,
			room.CodeEntryPolicy,
			room.ViewerPasswordMaterial)
		if err != nil {
			return err
		}
		return assertSingleChange(changes, "insert")
	})
}

// SetViewerPassword updates the exact Host's room; nil material clears the password.
func (d *Database) SetViewerPassword(
	roomID string, hostTokenDigest, viewerPasswordMaterial []byte,
) error {
	if err := assertRoomIdentity(roomID, hostTokenDigest); err != nil {
		return err
	}
	if err := assertPasswordMaterial(viewerPasswordMaterial); err != nil {
		return err
	}
	return d.transaction(func() error {
		changes, err := d.exec(
			`UPDATE rooms
              SET viewer_password_material = ?
            WHERE room_id = ? AND host_token_digest = ?`,
			viewerPasswordMaterial, roomID, hostTokenDigest)
		if err != nil {
			return err
		}
		return assertSingleChange(changes, "password update")
	})
}

// SetCodeEntryPolicy persists code admission for the exact Host's room.
func (d *Database) SetCodeEntryPolicy(
	roomID string, hostTokenDigest []byte, codeEntryPolicy protocol.CodeEntryPolicy,
) error {
	if err := assertRoomIdentity(roomID, hostTokenDigest); err != nil {
		return err
	}
	if !validCodeEntryPolicy(codeEntryPolicy) {
		return errors.New("Room code-entry policy is invalid")
	}
	return d.transaction(func() error {
		changes, err := d.exec(
			`UPDATE rooms
              SET code_entry_policy = ?
            WHERE room_id = ? AND host_token_digest = ?`,
			codeEntryPolicy, roomID, hostTokenDigest)
		if err != nil {
			return err
		}
		return assertSingleChange(changes, "code-entry policy update")
	})
}

// SetViewerGrant atomically replaces the grant digest and authorization generation.
func (d *Database) SetViewerGrant(
	roomID string, hostTokenDigest, viewerGrantDigest []byte,
	viewerAuthorizationGeneration string,
) error {
	if err := assertRoomIdentity(roomID, hostTokenDigest); err != nil {
		return err
	}
	if err := assertDigest(viewerGrantDigest, "Viewer grant"); err != nil {
		return err
	}
	if err := assertAuthorizationGeneration(viewerAuthorizationGeneration); err != nil {
		return err
	}
	return d.transaction(func() error {
		changes, err := d.exec(
			`UPDATE rooms
              SET viewer_grant_digest = ?,
                  viewer_authorization_generation = ?
            WHERE room_id = ? AND host_token_digest = ?`,
			viewerGrantDigest, viewerAuthorizationGeneration, roomID, hostTokenDigest)
		if err != nil {
			return err
		}
		return assertSingleChange(changes, "Viewer grant update")
	})
}

func (d *Database) deleteRooms(rooms []StoredRoomAuthority) error {
	for _, room := range rooms {
		if err := assertRoomIdentity(room.RoomID, room.HostTokenDigest); err != nil {
			return err
		}
	}
	return d.transaction(func() error {
		for _, room := range rooms {
			changes, err := d.exec(deleteRoomStatement, room.RoomID, room.HostTokenDigest)
			if err != nil {
				return err
			}
			if err := assertSingleChange(changes, "delete"); err != nil {
				return err
			}
		}
		return nil
	})
}

// ReplaceRoom is replaceRoom: the new room and the removal of the old one are
// one authority transition.
func (d *Database) ReplaceRoom(
	oldRoomID string, oldHostTokenDigest []byte, replacement StoredRoomAuthority,
) error {
	if err := assertRoomIdentity(oldRoomID, oldHostTokenDigest); err != nil {
		return err
	}
	if err := assertStoredRoom(replacement); err != nil {
		return err
	}
	if replacement.RoomID == oldRoomID {
		return errors.New("Replacement room ID must be different")
	}
	return d.transaction(func() error {
		inserted, err := d.exec(insertStoredRoom,
			replacement.RoomID,
			replacement.HostTokenDigest,
			replacement.ViewerGrantDigest,
			replacement.ViewerAuthorizationGeneration,
			replacement.CodeEntryPolicy,
			replacement.ViewerPasswordMaterial)
		if err != nil {
			return err
		}
		if err := assertSingleChange(inserted, "replacement insert"); err != nil {
			return err
		}
		deleted, err := d.exec(deleteRoomStatement, oldRoomID, oldHostTokenDigest)
		if err != nil {
			return err
		}
		return assertSingleChange(deleted, "replacement delete")
	})
}

// Close closes the connection; it is safe on a database that never opened one.
func (d *Database) Close() error {
	return d.closeHandles()
}

func (d *Database) closeHandles() error {
	conn, db := d.conn, d.db
	d.conn, d.db = nil, nil
	var connError error
	if conn != nil {
		connError = conn.Close()
	}
	if db != nil {
		if err := db.Close(); err != nil {
			return err
		}
	}
	return connError
}

func (d *Database) ensureExactSchema() error {
	applicationID, err := d.readPragmaInteger("application_id")
	if err != nil {
		return err
	}
	schemaVersion, err := d.readPragmaInteger("user_version")
	if err != nil {
		return err
	}
	schemaObjects, err := d.readSchemaObjects()
	if err != nil {
		return err
	}

	if applicationID == 0 && schemaVersion == 0 && len(schemaObjects) == 0 {
		_, err := d.conn.ExecContext(context.Background(), roomSchema)
		return err
	}

	if applicationID != roomDatabaseApplicationID {
		return errors.New("Room database application identity does not match")
	}
	if schemaVersion != roomDatabaseSchemaVersion {
		return errors.New("Room database schema version does not match")
	}
	if len(schemaObjects) != 1 ||
		schemaObjects[0][0] != "table" || schemaObjects[0][1] != "rooms" {
		return errors.New("Room database schema objects do not match")
	}
	return d.assertExactColumns()
}

func (d *Database) readSchemaObjects() ([][2]string, error) {
	rows, err := d.conn.QueryContext(context.Background(),
		`SELECT type, name
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var objects [][2]string
	for rows.Next() {
		var object [2]string
		if err := rows.Scan(&object[0], &object[1]); err != nil {
			return nil, err
		}
		objects = append(objects, object)
	}
	return objects, rows.Err()
}

func (d *Database) assertDatabaseIntegrity() error {
	rows, err := d.conn.QueryContext(context.Background(), "PRAGMA quick_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	var results []string
	for rows.Next() {
		var result string
		if err := rows.Scan(&result); err != nil {
			return err
		}
		results = append(results, result)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(results) != 1 || results[0] != "ok" {
		return errors.New("Room database integrity check failed")
	}
	return nil
}

func (d *Database) assertExactColumns() error {
	expected := [...]struct {
		name       string
		columnType string
		notNull    int
		primaryKey int
	}{
		{"room_id", "TEXT", 1, 1},
		{"host_token_digest", "BLOB", 1, 0},
		{"viewer_grant_digest", "BLOB", 1, 0},
		{"viewer_authorization_generation", "TEXT", 1, 0},
		{"code_entry_policy", "TEXT", 1, 0},
		{"viewer_password_material", "BLOB", 0, 0},
	}
	rows, err := d.conn.QueryContext(context.Background(), "PRAGMA table_info(rooms)")
	if err != nil {
		return err
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var (
			cid          int
			name         string
			columnType   string
			notNull      int
			defaultValue sql.NullString
			primaryKey   int
		)
		if err := rows.Scan(
			&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return err
		}
		if index >= len(expected) || name != expected[index].name ||
			columnType != expected[index].columnType ||
			notNull != expected[index].notNull ||
			primaryKey != expected[index].primaryKey {
			return errors.New("Room database columns do not match the current schema")
		}
		index++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if index != len(expected) {
		return errors.New("Room database columns do not match the current schema")
	}
	return nil
}

func (d *Database) readStoredRooms() ([]StoredRoomAuthority, error) {
	rows, err := d.conn.QueryContext(context.Background(), selectStoredRooms)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var stored []StoredRoomAuthority
	for rows.Next() {
		var (
			room     StoredRoomAuthority
			policy   string
			material []byte
		)
		if err := rows.Scan(
			&room.RoomID,
			&room.HostTokenDigest,
			&room.ViewerGrantDigest,
			&room.ViewerAuthorizationGeneration,
			&policy,
			&material); err != nil {
			return nil, err
		}
		if err := readDigest(room.HostTokenDigest, "Host token"); err != nil {
			return nil, err
		}
		if err := readDigest(room.ViewerGrantDigest, "Viewer grant"); err != nil {
			return nil, err
		}
		if !validCodeEntryPolicy(policy) {
			return nil, errors.New("Room database contains an invalid code-entry policy")
		}
		room.CodeEntryPolicy = policy
		if material != nil {
			if len(material) != viewerPasswordMaterialBytes {
				return nil, errors.New("Room database contains invalid Viewer password material")
			}
			room.ViewerPasswordMaterial = material
		}
		if err := assertStoredRoom(room); err != nil {
			return nil, err
		}
		stored = append(stored, room)
	}
	return stored, rows.Err()
}

func (d *Database) readPragmaInteger(name string) (int64, error) {
	var value int64
	if err := d.conn.QueryRowContext(
		context.Background(), "PRAGMA "+name).Scan(&value); err != nil {
		return 0, fmt.Errorf("Room database %s is invalid", name)
	}
	if value < -protocol.MaxSafeInteger || value > protocol.MaxSafeInteger {
		return 0, fmt.Errorf("Room database %s is invalid", name)
	}
	return value, nil
}

func (d *Database) transaction(operation func() error) error {
	if d.conn == nil {
		return errors.New("Room database is not initialized")
	}
	if _, err := d.exec("BEGIN IMMEDIATE"); err != nil {
		return err
	}
	if err := operation(); err != nil {
		d.rollback()
		return err
	}
	if _, err := d.exec("COMMIT"); err != nil {
		d.rollback()
		return err
	}
	return nil
}

// SQLite may already have rolled back after an I/O or capacity error. An
// explicit rollback is harmless then; SQLite, not a Go mirror, owns that state.
// Preserve the original failure rather than replacing it with "no transaction".
func (d *Database) rollback() {
	_, _ = d.exec("ROLLBACK")
}

func (d *Database) exec(query string, args ...any) (int64, error) {
	result, err := d.conn.ExecContext(context.Background(), query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func assertStoredRoom(room StoredRoomAuthority) error {
	if !protocol.ValidRoomCode(room.RoomID) {
		return errors.New("Room database contains an invalid room ID")
	}
	if err := assertDigest(room.HostTokenDigest, "Host token"); err != nil {
		return err
	}
	if err := assertDigest(room.ViewerGrantDigest, "Viewer grant"); err != nil {
		return err
	}
	if err := assertAuthorizationGeneration(room.ViewerAuthorizationGeneration); err != nil {
		return err
	}
	if !validCodeEntryPolicy(room.CodeEntryPolicy) {
		return errors.New("Room database contains an invalid code-entry policy")
	}
	if err := assertPasswordMaterial(room.ViewerPasswordMaterial); err != nil {
		return err
	}
	return nil
}

func assertRoomIdentity(roomID string, hostTokenDigest []byte) error {
	if !protocol.ValidRoomCode(roomID) {
		return errors.New("Room ID is invalid")
	}
	return assertDigest(hostTokenDigest, "Host token")
}

func readDigest(value []byte, name string) error {
	if len(value) != 32 {
		return fmt.Errorf("Room database contains an invalid %s digest", name)
	}
	return nil
}

func assertDigest(value []byte, name string) error {
	if len(value) != 32 {
		return fmt.Errorf("%s digest must contain 32 bytes", name)
	}
	return nil
}

func assertPasswordMaterial(value []byte) error {
	if value != nil && len(value) != viewerPasswordMaterialBytes {
		return errors.New("Viewer password material must contain 48 bytes")
	}
	return nil
}

func assertAuthorizationGeneration(value string) error {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 16 ||
		base64.RawURLEncoding.EncodeToString(decoded) != value {
		return errors.New("Viewer authorization generation is invalid")
	}
	return nil
}

func assertSingleChange(changes int64, operation string) error {
	if changes != 1 {
		return fmt.Errorf("Room database %s did not match current authority", operation)
	}
	return nil
}

func validCodeEntryPolicy(policy protocol.CodeEntryPolicy) bool {
	return policy == protocol.CodeEntryOpen || policy == protocol.CodeEntryPrivate
}
