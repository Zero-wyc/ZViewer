package db

import "testing"

func TestPlaybackMetadataUpgradeRetainsLegacyRows(t *testing.T) {
	conn, _ := openTemp(t)
	if _, err := conn.Exec(`CREATE TABLE "playback_states" ("roomId" text PRIMARY KEY, "sourceUrl" text); INSERT INTO "playback_states" VALUES ('room','legacy-url')`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := EnsurePlaybackMetadata(conn); err != nil {
			t.Fatal(err)
		}
	}
	var url string
	var metadata any
	if err := conn.QueryRow(`SELECT "sourceUrl","metadata" FROM "playback_states" WHERE "roomId"='room'`).Scan(&url, &metadata); err != nil {
		t.Fatal(err)
	}
	if url != "legacy-url" || metadata != nil {
		t.Fatal("legacy data changed")
	}
}
