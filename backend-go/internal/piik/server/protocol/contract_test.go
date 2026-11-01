package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestRuntimeCapabilities(t *testing.T) {
	for _, test := range []struct {
		data string
		want RuntimeCapabilities
	}{
		{`{}`, RuntimeCapabilities{}},
		{`{"sfu":true,"extra":{"enabled":true}}`, RuntimeCapabilities{Sfu: true}},
		{`{"sfu":true,"sfuOnly":true}`, RuntimeCapabilities{Sfu: true, SfuOnly: true}},
		{`{"natPrediction":true,"SFU":true}`, RuntimeCapabilities{NatPrediction: true}},
		{`{"sfu":true,"natPrediction":true}`, RuntimeCapabilities{Sfu: true, NatPrediction: true}},
		{`{"sfu":"ignored duplicate","sfu":true}`, RuntimeCapabilities{Sfu: true}},
		{`{"roomReactionIds":["heart","future-effect"]}`, RuntimeCapabilities{RoomReactionIDs: []string{"heart", "future-effect"}}},
		{`{"roomReactionIds":[]}`, RuntimeCapabilities{RoomReactionIDs: []string{}}},
	} {
		got := RuntimeCapabilities{Sfu: true, NatPrediction: true}
		if err := json.Unmarshal([]byte(test.data), &got); err != nil || !reflect.DeepEqual(got, test.want) {
			t.Errorf("decode %s = %+v, %v; want %+v", test.data, got, err, test.want)
		}
	}
	for _, data := range []string{
		`null`, `[]`, `true`, `{"sfu":null}`, `{"sfu":"true"}`, `{"sfuOnly":null}`, `{"sfuOnly":"true"}`,
		`{"natPrediction":null}`, `{"natPrediction":1}`,
		`{"roomReactionIds":null}`, `{"roomReactionIds":"heart"}`, `{"roomReactionIds":["bad id"]}`,
		`{"roomReactionIds":[true]}`, `{"roomReactionIds":[""]}`,
	} {
		var got RuntimeCapabilities
		if err := json.Unmarshal([]byte(data), &got); err == nil {
			t.Errorf("expected %s to be rejected", data)
		}
	}
}

func TestAdvertisedRoomReactionsAreRegisteredCommands(t *testing.T) {
	for _, id := range append(append([]string{}, RoomReactionIDs...), "future-effect") {
		_, err := DecodeClientMessage([]byte(fmt.Sprintf(`{"type":"send-room-interaction","requestId":"request_1234","payload":{"kind":"reaction","reaction":%q,"targetPeerId":"target_peer_1234"}}`, id)))
		if (err == nil) != (id != "future-effect") {
			t.Errorf("reaction %q: %v", id, err)
		}
	}
}

func TestStrictMemberNamesCannotPopulateForbiddenOrOptionalFields(t *testing.T) {
	for _, sample := range []struct {
		name   string
		data   string
		target any
	}{
		{"none upstream with folded empty peer", `{"kind":"none","peerid":""}`, &MediaRouteUpstream{}},
		{"host diagnostic with folded zero ordinal", `{"kind":"host","Ordinal":0}`, &RouteDiagnosticParent{}},
		{"host presence with folded false ready", `{"role":"host","peerId":"host_12345678","displayName":"Host","upstream":{"kind":"none"},"mediaready":false}`, &ParticipantPresenceEntry{}},
		{"viewer presence with folded false ready", `{"role":"viewer","peerId":"viewer_12345678","displayName":"Viewer","upstream":{"kind":"none"},"mediaready":false}`, &ParticipantPresenceEntry{}},
	} {
		t.Run(sample.name, func(t *testing.T) {
			if err := json.Unmarshal([]byte(sample.data), sample.target); err == nil {
				t.Fatal("a noncanonical member must not populate a schema field")
			}
		})
	}
	assertServerMessage(t, "folded route policy cannot be ignored by its default",
		object(with(drop(authenticatedHost(), "routePolicy"), member{"routepolicy", testRoutePolicy})), false)
}

// member is one JSON object key with its raw encoded value, so the tests can
// reproduce the exact wire shapes from tests/protocol.test.ts (including key
// presence, which a Go map cannot express).
type member struct {
	key string
	raw string
}

func object(members []member) []byte {
	var builder strings.Builder
	builder.WriteByte('{')
	for index, entry := range members {
		if index > 0 {
			builder.WriteByte(',')
		}
		fmt.Fprintf(&builder, "%q:%s", entry.key, entry.raw)
	}
	builder.WriteByte('}')
	return []byte(builder.String())
}

func with(base []member, changes ...member) []member {
	out := append([]member(nil), base...)
	for _, change := range changes {
		replaced := false
		for index := range out {
			if out[index].key == change.key {
				out[index] = change
				replaced = true
				break
			}
		}
		if !replaced {
			out = append(out, change)
		}
	}
	return out
}

func drop(base []member, keys ...string) []member {
	out := make([]member, 0, len(base))
	for _, entry := range base {
		remove := false
		for _, key := range keys {
			if entry.key == key {
				remove = true
			}
		}
		if !remove {
			out = append(out, entry)
		}
	}
	return out
}

const (
	testAssignmentNone = `{"upstream":{"kind":"none"},"childPeerIds":[],` +
		`"sfuPublicationGeneration":null}`
	testQualitySettings = `{"resolution":{"width":1920,"height":1080},"maxFramerate":60,"maxBitrate":8000000,` +
		`"degradationPreference":"maintain-resolution"}`
	testRoutePolicy = `{"peerOnly":false,"topologyOptimization":true,"natPrediction":false}`
	testIceConfig   = `{"iceServers":[],"natPredictionStunUrls":[]}`
)

func authenticatedHost() []member {
	return []member{
		{"type", `"authenticated"`},
		{"protocol", `"piik-v24"`},
		{"peerId", `"host_12345678"`},
		{"maxViewers", `8`},
		{"endpointMediaCopyCapacity", `2`},
		{"hostOnline", `true`},
		{"connectionId", `null`},
		{"iceConfig", testIceConfig},
		{"routePolicy", testRoutePolicy},
		{"codeEntryPolicy", `"open"`},
		{"viewerAuthorizationGeneration", `"viewer_generation_12345678"`},
		{"mediaMode", `"peer-assisted"`},
		{"shareGeneration", `"share_generation_12345678"`},
		{"routeRevision", `0`},
		{"routeAssignment", testAssignmentNone},
		{"qualitySettings", testQualitySettings},
		{"role", `"host"`},
		{"viewerPasswordEnabled", `false`},
	}
}

func assertServerMessage(t *testing.T, name string, data []byte, want bool) {
	t.Helper()
	t.Run(name, func(t *testing.T) {
		_, err := DecodeServerMessage(data)
		if want && err != nil {
			t.Fatalf("expected %s to decode, got %v", data, err)
		}
		if !want && err == nil {
			t.Fatalf("expected %s to be rejected", data)
		}
	})
}

func TestFutureReactionEventsKeepPayloadAndAuthorityBounds(t *testing.T) {
	for _, role := range []string{"host", "viewer", "", "HOST", "admin"} {
		assertServerMessage(t, "sender role "+role, []byte(
			`{"type":"room-interaction","id":"event_future_1234","requestId":"request_future_1234","occurredAt":1,`+
				`"sender":{"peerId":"sender_peer_1234","role":"`+role+`","displayName":"Friend"},"payload":{"kind":"reaction","reaction":"future-effect"}}`),
			role == RoleHost || role == RoleViewer)
	}
	for _, payload := range []string{
		`{"kind":"reaction","reaction":""}`,
		`{"kind":"reaction","reaction":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`,
		`{"kind":"reaction","reaction":"future effect"}`,
		`{"kind":"reaction","reaction":"👋"}`,
		`{"kind":"reaction","reaction":"future-effect","targetPeerId":"bad"}`,
		`{"kind":"reaction","reaction":"future-effect","text":"hidden command"}`,
		`{"kind":"reaction","reaction":"tomato"}`,
		`{"kind":"future-kind","reaction":"wave"}`,
	} {
		raw := `{"type":"room-interaction","id":"event_future_1234","requestId":"request_future_1234","occurredAt":1,` +
			`"sender":{"peerId":"sender_peer_1234","role":"viewer","displayName":"Friend"},"payload":` + payload + `}`
		assertServerMessage(t, payload, []byte(raw), false)
	}
	assertServerMessage(t, "future reaction with invalid sender", []byte(
		`{"type":"room-interaction","id":"event_future_1234","requestId":"request_future_1234","occurredAt":1,`+
			`"sender":{"peerId":"bad","role":"viewer","displayName":"Friend"},"payload":{"kind":"reaction","reaction":"future-effect"}}`), false)
}

func assertClientMessage(t *testing.T, name string, data []byte, want bool) {
	t.Helper()
	t.Run(name, func(t *testing.T) {
		_, err := DecodeClientMessage(data)
		if want && err != nil {
			t.Fatalf("expected %s to decode, got %v", data, err)
		}
		if !want && err == nil {
			t.Fatalf("expected %s to be rejected", data)
		}
	})
}

// "accepts dynamic viewer limits within the protocol boundary" and
// "rejects viewer limit %s outside the protocol boundary".
func TestAuthenticatedViewerLimits(t *testing.T) {
	for _, sample := range []struct {
		raw  string
		want bool
	}{{`1`, true}, {`8`, true}, {`20`, true}, {`0`, false}, {`1.5`, false}, {`21`, false}} {
		assertServerMessage(t, "maxViewers "+sample.raw,
			object(with(authenticatedHost(), member{"maxViewers", sample.raw})), sample.want)
	}
}

// "requires the authenticated endpoint capacity to be 1, 2, or 3".
func TestAuthenticatedEndpointCapacity(t *testing.T) {
	for _, sample := range []struct {
		raw  string
		want bool
	}{{`1`, true}, {`2`, true}, {`3`, true}, {`0`, false}, {`4`, false}, {`1.5`, false}} {
		assertServerMessage(t, "capacity "+sample.raw,
			object(with(authenticatedHost(),
				member{"endpointMediaCopyCapacity", sample.raw})), sample.want)
	}
	assertServerMessage(t, "capacity absent",
		object(drop(authenticatedHost(), "endpointMediaCopyCapacity")), false)
}

// "scopes password configuration state to authenticated Hosts".
func TestAuthenticatedPasswordStateIsHostScoped(t *testing.T) {
	assertServerMessage(t, "host carries the flag", object(authenticatedHost()), true)
	assertServerMessage(t, "host without the flag",
		object(drop(authenticatedHost(), "viewerPasswordEnabled")), false)

	viewer := drop(with(authenticatedHost(),
		member{"role", `"viewer"`}, member{"peerId", `"viewer_12345678"`}),
		"viewerPasswordEnabled")
	assertServerMessage(t, "viewer without the flag", object(viewer), true)
	assertServerMessage(t, "viewer with the flag",
		object(with(viewer, member{"viewerPasswordEnabled", `true`})), false)
	assertServerMessage(t, "viewer with hostPaused",
		object(with(viewer, member{"hostPaused", `true`})), true)
}

func TestAuthenticatedRoomRevision(t *testing.T) {
	assertServerMessage(t, "revision at the ceiling",
		object(with(authenticatedHost(), member{"routeRevision", `9007199254740991`})), true)
	assertServerMessage(t, "revision past the ceiling",
		object(with(authenticatedHost(), member{"routeRevision", `9007199254740992`})), false)
	assertServerMessage(t, "absent route assignment",
		object(drop(authenticatedHost(), "routeAssignment")), false)
	assertServerMessage(t, "absent media mode",
		object(drop(authenticatedHost(), "mediaMode")), false)
	assertServerMessage(t, "quality settings past the numeric representation",
		object(with(authenticatedHost(), member{"qualitySettings",
			`{"resolution":{"width":1920,"height":1080},"maxFramerate":60,"maxBitrate":4294967296,` +
				`"degradationPreference":"maintain-resolution"}`})), false)
}

// "accepts only STUN URLs in the authenticated peer ICE config" and
// "requires the v20 NAT observation configuration".
func TestAuthenticatedIceConfig(t *testing.T) {
	for _, sample := range []struct {
		name string
		raw  string
		want bool
	}{
		{"empty", `{"iceServers":[],"natPredictionStunUrls":[]}`, true},
		{"one stun url", `{"iceServers":[{"urls":"stun:stun.example.test:3478"}],` +
			`"natPredictionStunUrls":[]}`, true},
		{"a list of stun urls", `{"iceServers":[{"urls":["stun:a.example.test:3478",` +
			`"stun:b.example.test:3478"]}],"natPredictionStunUrls":[]}`, true},
		{"missing nat prediction urls", `{"iceServers":[]}`, false},
		{"turn url", `{"iceServers":[{"urls":"turn:relay.example.test:3478?transport=udp"}],` +
			`"natPredictionStunUrls":[]}`, false},
		{"turn credentials", `{"iceServers":[{"urls":"turn:relay.example.test:3478",` +
			`"username":"1787076000","credential":"credential"}],` +
			`"natPredictionStunUrls":[]}`, false},
		{"stuns url", `{"iceServers":[{"urls":"stuns:stun.example.test:5349"}],` +
			`"natPredictionStunUrls":[]}`, false},
		{"too many nat prediction urls", `{"iceServers":[],"natPredictionStunUrls":` +
			`["stun:a.example.test:3478","stun:b.example.test:3478",` +
			`"stun:c.example.test:3478"]}`, false},
	} {
		assertServerMessage(t, "iceConfig "+sample.name,
			object(with(authenticatedHost(), member{"iceConfig", sample.raw})), sample.want)
	}
}

// "keeps Viewer route status as a strict crossed union".
func TestRouteStatusCrossedUnion(t *testing.T) {
	for _, sample := range []struct {
		name string
		raw  string
		want bool
	}{
		{"waiting on admission",
			`{"type":"route-status","revision":3,"state":"waiting","reason":"sfu-admission"}`, true},
		{"failed on exhaustion",
			`{"type":"route-status","revision":4,"state":"failed","reason":"route-exhausted"}`, true},
		{"waiting on exhaustion",
			`{"type":"route-status","revision":3,"state":"waiting","reason":"route-exhausted"}`, false},
		{"failed on admission",
			`{"type":"route-status","revision":3,"state":"failed","reason":"sfu-admission"}`, false},
		{"with a retry hint",
			`{"type":"route-status","revision":3,"state":"waiting","reason":"sfu-admission",` +
				`"retryAfterMs":1000}`, false},
		{"with a peer id",
			`{"type":"route-status","revision":3,"state":"waiting","reason":"sfu-admission",` +
				`"peerId":"private-peer-id"}`, false},
	} {
		assertServerMessage(t, sample.name, []byte(sample.raw), sample.want)
	}
}

// "accepts a strict, unique and bounded Viewer presence snapshot".
func TestViewerPresence(t *testing.T) {
	const viewer = `{"role":"viewer","peerId":"viewer_12345678","displayName":"小明",` +
		`"upstream":{"kind":"peer","peerId":"viewer_parent_12345678"}}`
	for _, sample := range []struct {
		name string
		raw  string
		want bool
	}{
		{"sfu upstream with mediaReady",
			`{"type":"viewer-presence","viewers":[{"role":"viewer","peerId":"viewer_12345678",` +
				`"displayName":"小明","upstream":{"kind":"sfu"},"mediaReady":true}]}`, true},
		{"mediaReady false", `{"type":"viewer-presence","viewers":[{"role":"viewer",` +
			`"peerId":"viewer_12345678","displayName":"小明",` +
			`"upstream":{"kind":"peer","peerId":"viewer_parent_12345678"},` +
			`"mediaReady":false}]}`, false},
		{"duplicate peer ids",
			`{"type":"viewer-presence","viewers":[` + viewer + `,` + viewer + `]}`, false},
		{"leaked topology", `{"type":"viewer-presence","viewers":[{"role":"viewer",` +
			`"peerId":"viewer_12345678","displayName":"小明",` +
			`"upstream":{"kind":"none"},"mediaTopology":"peer-relay"}]}`, false},
		{"leaked address", `{"type":"viewer-presence","viewers":[{"role":"viewer",` +
			`"peerId":"viewer_12345678","displayName":"小明",` +
			`"upstream":{"kind":"none"},"ip":"203.0.113.1"}]}`, false},
		{"host entry", `{"type":"viewer-presence","viewers":[` + viewer + `,` +
			`{"role":"host","peerId":"host_12345678","displayName":"分享者",` +
			`"upstream":{"kind":"none"}}]}`, true},
		{"host entry with an upstream", `{"type":"viewer-presence","viewers":[` +
			`{"role":"host","peerId":"host_12345678","displayName":"分享者",` +
			`"upstream":{"kind":"sfu"}}]}`, false},
		{"host entry with mediaReady", `{"type":"viewer-presence","viewers":[` +
			`{"role":"host","peerId":"host_12345678","displayName":"分享者",` +
			`"upstream":{"kind":"none"},"mediaReady":true}]}`, false},
	} {
		assertServerMessage(t, sample.name, []byte(sample.raw), sample.want)
	}
}

func TestViewerPresenceConstructors(t *testing.T) {
	host := HostPresenceEntry("host_12345678", "分享者")
	if host.Upstream != NoUpstream() || host.MediaReady {
		t.Fatalf("host presence entry must carry {kind:\"none\"} and no mediaReady: %+v", host)
	}
	encoded, err := marshalJSON(NewViewerPresenceEntry(
		"viewer_12345678", "小明", SfuUpstream(), false))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("mediaReady")) {
		t.Fatalf("mediaReady must be omitted when false: %s", encoded)
	}
	encoded, err = marshalJSON(NewViewerPresenceEntry(
		"viewer_12345678", "小明", SfuUpstream(), true))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"mediaReady":true`)) {
		t.Fatalf("mediaReady must be emitted when true: %s", encoded)
	}
}

// "accepts only the privacy-safe route snapshot payload" plus the superRefine.
func TestRouteDiagnosticSnapshot(t *testing.T) {
	const childOne = `{"ordinal":1,"parent":{"kind":"host"},"effectiveCapacity":2,` +
		`"childCount":1,"demandAgeMs":100,"queueWaitMs":10,"candidateStartMs":20,` +
		`"firstDecodedFrameMs":80,"finalMs":80,"finalRoute":"direct","rejectionBucket":"none",` +
		`"quality":{"eligibleWindows":3,"eligibleDurationMs":6000,"freezeWindows":1,` +
		`"freezeCount":1,"freezeDurationMs":250,"pauseCount":0,"pauseDurationMs":0}}`
	childTwo := func(parent string) string {
		return `{"ordinal":2,"parent":` + parent + `,"effectiveCapacity":0,"childCount":0,` +
			`"demandAgeMs":90,"queueWaitMs":null,"candidateStartMs":null,` +
			`"firstDecodedFrameMs":null,"finalMs":null,"finalRoute":"waiting",` +
			`"rejectionBucket":"sfu-admission","quality":null}`
	}
	snapshot := func(children, operation string) []byte {
		return []byte(`{"type":"route-diagnostic-snapshot","snapshot":{"children":` +
			children + `,"operation":` + operation + `}}`)
	}
	const operation = `{"childOrdinal":2,"reason":"join","stage":"admission",` +
		`"cursor":1,"candidateCount":2}`

	assertServerMessage(t, "full snapshot",
		snapshot(`[`+childOne+`,`+childTwo(`{"kind":"viewer","ordinal":1}`)+`]`, operation), true)
	assertServerMessage(t, "empty snapshot", snapshot(`[]`, `null`), true)
	assertServerMessage(t, "leaked peer id",
		[]byte(`{"type":"route-diagnostic-snapshot","snapshot":{"children":[],`+
			`"operation":null,"peerId":"viewer_private_12345678"}}`), false)
	assertServerMessage(t, "leaked connection id",
		snapshot(`[{"ordinal":1,"parent":{"kind":"host"},"effectiveCapacity":2,"childCount":1,`+
			`"demandAgeMs":100,"queueWaitMs":10,"candidateStartMs":20,`+
			`"firstDecodedFrameMs":80,"finalMs":80,"finalRoute":"direct",`+
			`"rejectionBucket":"none","quality":null,`+
			`"connectionId":"connection_private_12345678"}]`, `null`), false)
	assertServerMessage(t, "negative freeze count",
		snapshot(`[{"ordinal":1,"parent":{"kind":"host"},"effectiveCapacity":2,"childCount":1,`+
			`"demandAgeMs":100,"queueWaitMs":10,"candidateStartMs":20,`+
			`"firstDecodedFrameMs":80,"finalMs":80,"finalRoute":"direct",`+
			`"rejectionBucket":"none","quality":{"eligibleWindows":3,`+
			`"eligibleDurationMs":6000,"freezeWindows":1,"freezeCount":-1,`+
			`"freezeDurationMs":250,"pauseCount":0,"pauseDurationMs":0}}]`, `null`), false)
	assertServerMessage(t, "self parent",
		snapshot(`[`+childOne+`,`+childTwo(`{"kind":"viewer","ordinal":2}`)+`]`, `null`), false)
	assertServerMessage(t, "unknown parent ordinal",
		snapshot(`[`+childOne+`,`+childTwo(`{"kind":"viewer","ordinal":7}`)+`]`, `null`), false)
	assertServerMessage(t, "duplicate ordinals",
		snapshot(`[`+childOne+`,`+childOne+`]`, `null`), false)
	assertServerMessage(t, "operation names an absent child",
		snapshot(`[`+childOne+`]`, operation), false)
	assertServerMessage(t, "cursor past the candidate count",
		snapshot(`[`+childOne+`,`+childTwo(`{"kind":"viewer","ordinal":1}`)+`]`,
			`{"childOrdinal":2,"reason":"join","stage":"admission","cursor":2,`+
				`"candidateCount":2}`), false)
	assertServerMessage(t, "raw rejection bucket on the operation",
		snapshot(`[`+childOne+`,`+childTwo(`{"kind":"viewer","ordinal":1}`)+`]`,
			`{"childOrdinal":2,"reason":"join","stage":"admission","cursor":1,`+
				`"candidateCount":2,"rejectionBucket":"raw-error"}`), false)
	assertServerMessage(t, "parent ordinal on a host parent",
		snapshot(`[{"ordinal":1,"parent":{"kind":"host","ordinal":1},"effectiveCapacity":2,`+
			`"childCount":1,"demandAgeMs":null,"queueWaitMs":null,"candidateStartMs":null,`+
			`"firstDecodedFrameMs":null,"finalMs":null,"finalRoute":"direct",`+
			`"rejectionBucket":"none","quality":null}]`, `null`), false)
}

// "keeps route messages strict alongside the single authenticated mode" and
// "accepts every bounded hybrid upstream shape".
func TestParticipantRouteAssignment(t *testing.T) {
	children := make([]string, MaxViewersPerRoomLimit+1)
	for index := range children {
		children[index] = fmt.Sprintf(`"child_%08d"`, index)
	}
	routeUpdate := func(assignment string) []byte {
		return []byte(`{"type":"route-update","revision":9,"phase":"active","assignment":` +
			assignment + `}`)
	}
	for _, sample := range []struct {
		name       string
		assignment string
		want       bool
	}{
		{"no upstream", testAssignmentNone, true},
		{"peer upstream", `{"upstream":{"kind":"peer","peerId":"parent_12345678"},` +
			`"childPeerIds":["child_12345678","child_87654321"],` +
			`"sfuPublicationGeneration":null}`, true},
		{"sfu upstream", `{"upstream":{"kind":"sfu"},"childPeerIds":[],` +
			`"sfuPublicationGeneration":"generation_12345678"}`, true},
		{"sfu upstream without a generation", `{"upstream":{"kind":"sfu"},` +
			`"childPeerIds":[],"sfuPublicationGeneration":null}`, false},
		{"peer upstream owning a generation",
			`{"upstream":{"kind":"peer","peerId":"parent_12345678"},"childPeerIds":[],` +
				`"sfuPublicationGeneration":"generation_12345678"}`, false},
		{"too many children", `{"upstream":{"kind":"none"},"childPeerIds":` +
			`[` + strings.Join(children, ",") + `],` +
			`"sfuPublicationGeneration":null}`, false},
		{"duplicate children", `{"upstream":{"kind":"none"},` +
			`"childPeerIds":["child_12345678","child_12345678"],` +
			`"sfuPublicationGeneration":null}`, false},
		{"absent generation key", `{"upstream":{"kind":"none"},"childPeerIds":[]}`, false},
		{"peer id on a none upstream", `{"upstream":{"kind":"none",` +
			`"peerId":"parent_12345678"},"childPeerIds":[],` +
			`"sfuPublicationGeneration":null}`, false},
	} {
		assertServerMessage(t, "assignment "+sample.name,
			routeUpdate(sample.assignment), sample.want)
	}

	assertServerMessage(t, "prepare without a candidate",
		[]byte(`{"type":"route-update","revision":9,"phase":"prepare","assignment":`+
			testAssignmentNone+`}`), false)
	assertServerMessage(t, "active with a candidate",
		[]byte(`{"type":"route-update","revision":9,"phase":"active","assignment":`+
			testAssignmentNone+`,"candidate":{"childPeerId":"child_12345678",`+
			`"connectionId":"connection_12345678","transport":"direct","qualityProbe":false}}`),
		false)
	assertServerMessage(t, "prepare with a room-wide field",
		[]byte(`{"type":"route-update","revision":9,"phase":"prepare","assignment":`+
			testAssignmentNone+`,"roomAssignments":[]}`), false)
}

// "accepts only bounded connection-attempt progress on a prepared route".
func TestPreparedRouteCandidate(t *testing.T) {
	prepared := func(candidate string) []byte {
		return []byte(`{"type":"route-update","revision":9,"phase":"prepare","assignment":` +
			testAssignmentNone + `,"candidate":` + candidate + `}`)
	}
	const base = `"childPeerId":"child_12345678","connectionId":"connection_12345678",` +
		`"transport":"direct","qualityProbe":false`
	for _, sample := range []struct {
		attempt string
		want    bool
	}{
		{`{"current":1,"total":3}`, true},
		{`{"current":2,"total":3}`, true},
		{`{"current":3,"total":3}`, true},
		{`{"current":0,"total":3}`, false},
		{`{"current":4,"total":3}`, false},
		{`{"current":1,"total":4}`, true},
		{`{"current":4,"total":4}`, true},
		{`{"current":5,"total":4}`, false},
		{`{"current":1,"total":5}`, true},
		{`{"current":1,"total":0}`, false},
		{`{"current":1,"total":9007199254740992}`, false},
		{`{"current":1.5,"total":3}`, false},
	} {
		assertServerMessage(t, "connectionAttempt "+sample.attempt,
			prepared(`{`+base+`,"connectionAttempt":`+sample.attempt+`}`), sample.want)
	}
	assertServerMessage(t, "candidate without an attempt", prepared(`{`+base+`}`), true)
	assertServerMessage(t, "candidate with an unknown key",
		prepared(`{`+base+`,"unexpected":null}`), false)
	assertServerMessage(t, "candidate with a null attempt",
		prepared(`{`+base+`,"connectionAttempt":null}`), false)
}

// "accepts only canonical server-derived viewer evidence envelopes" and
// "keeps route messages strict" for sfu-config.
func TestForwardedEvidenceAndSfuConfig(t *testing.T) {
	const metrics = `{"natTraversalPath":"ordinary","width":null,"height":null,` +
		`"framesPerSecond":null,"bitrateKbps":null,"packetsReceivedDelta":null,` +
		`"packetsLostDelta":null,"rttMs":null,"jitterMs":null,"framesDecodedDelta":null,` +
		`"framesDroppedDelta":null,"decodeMsPerFrame":null,"freezeCountDelta":null,` +
		`"freezeDurationMsDelta":null,"pauseCountDelta":null,"pauseDurationMsDelta":null,` +
		`"codec":null,"codecProfile":null,"codecParameters":null,"audioBitrateKbps":null,` +
		`"audioPacketLossPercent":null,"audioJitterMs":null,"audioVideoPlayoutDeltaMs":null,` +
		`"videoJitterBufferDelayMs":null,"audioJitterBufferDelayMs":null,` +
		`"audioConcealedSamplesPercent":null,"audioConcealmentEventsDelta":null,` +
		`"audioCodec":null}`
	forwarded := func(extra string, upstream string) []byte {
		return []byte(`{"type":"viewer-quality-evidence","viewerPeerId":"viewer_12345678",` +
			`"upstream":` + upstream + `,"guard":{"connectionId":"connection_12345678",` +
			`"routeRevision":0,"presentationEpoch":0},"sequence":0,"windowMs":2000,` +
			`"metrics":` + metrics + extra + `}`)
	}
	assertServerMessage(t, "peer upstream",
		forwarded("", `{"kind":"peer","peerId":"host_12345678"}`), true)
	assertServerMessage(t, "sfu upstream", forwarded("", `{"kind":"sfu"}`), true)
	assertServerMessage(t, "no upstream", forwarded("", `{"kind":"none"}`), false)
	assertServerMessage(t, "leaked room id",
		forwarded(`,"roomId":"1234"`, `{"kind":"sfu"}`), false)
	assertServerMessage(t, "missing upstream",
		[]byte(`{"type":"viewer-quality-evidence","viewerPeerId":"viewer_12345678",`+
			`"guard":{"connectionId":"connection_12345678","routeRevision":0,`+
			`"presentationEpoch":0},"sequence":0,"windowMs":2000,"metrics":`+metrics+`}`), false)

	assertServerMessage(t, "sfu config",
		[]byte(`{"type":"sfu-config","revision":9,"publicationGeneration":"publication_12345678","connectionId":"connection_12345678"}`), true)
	assertServerMessage(t, "sfu config missing connection fence",
		[]byte(`{"type":"sfu-config","revision":9,"publicationGeneration":"publication_12345678"}`), false)
}

// zod's z.number().int() accepts an integral JSON number in any spelling.
func TestIntAcceptsIntegralNumberForms(t *testing.T) {
	for _, sample := range []struct {
		raw  string
		want bool
	}{
		{`7`, true}, {`7.0`, true}, {`7e0`, true}, {`1e3`, true},
		{`7.5`, false}, {`"7"`, false}, {`true`, false},
	} {
		assertClientMessage(t, "revision "+sample.raw,
			[]byte(`{"type":"route-media-unavailable","revision":`+sample.raw+`}`), sample.want)
	}
}

// JSON.parse keeps the last occurrence of a duplicate key.
func TestDuplicateKeysKeepTheLastOccurrence(t *testing.T) {
	message, err := DecodeClientMessage(
		[]byte(`{"type":"relay-capacity","downstreamEdges":9,"downstreamEdges":2}`))
	if err != nil {
		t.Fatalf("the last occurrence must win: %v", err)
	}
	if capacity, ok := message.(RelayCapacityMessage); !ok || capacity.DownstreamEdges != 2 {
		t.Fatalf("decoded %#v, want downstreamEdges 2", message)
	}
	if _, err := DecodeClientMessage(
		[]byte(`{"type":"relay-capacity","downstreamEdges":2,"downstreamEdges":9}`)); err == nil {
		t.Fatal("the last occurrence must be the one validated")
	}
	// A duplicated object is replaced, not merged.
	if _, err := DecodeClientMessage(
		[]byte(`{"type":"set-quality-settings","qualitySettings":{"resolution":{"width":854,"height":480}},` +
			`"qualitySettings":` + testQualitySettings + `}`)); err != nil {
		t.Fatalf("a duplicated object must be replaced wholesale: %v", err)
	}
}

// JSON.stringify does not escape "<", ">" or "&"; display names may hold them.
func TestEncodeServerMessageDoesNotEscapeHTML(t *testing.T) {
	encoded, err := EncodeServerMessage(ViewerPresenceMessage{
		Type: "viewer-presence",
		Viewers: []ParticipantPresenceEntry{
			HostPresenceEntry("host_12345678", "a<b>&c"),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"displayName":"a<b>&c"`)) {
		t.Fatalf("display name must survive unescaped: %s", encoded)
	}
	if bytes.HasSuffix(encoded, []byte("\n")) {
		t.Fatalf("the encoder newline must be dropped: %q", encoded)
	}
}

// Empty collections encode as [] the way the TypeScript literals do.
func TestEncodeServerMessageEmitsEmptyArrays(t *testing.T) {
	encoded, err := EncodeServerMessage(ViewerPresenceMessage{Type: "viewer-presence"})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"type":"viewer-presence","viewers":[]}` {
		t.Fatalf("got %s", encoded)
	}
	encoded, err = EncodeServerMessage(RouteDiagnosticSnapshotMessage{
		Type: "route-diagnostic-snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) !=
		`{"type":"route-diagnostic-snapshot","snapshot":{"children":[],"operation":null}}` {
		t.Fatalf("got %s", encoded)
	}
}

// The authenticated key order follows the object literal in signaling.ts.
func TestAuthenticatedKeyOrder(t *testing.T) {
	paused := true
	encoded, err := EncodeServerMessage(AuthenticatedViewerMessage{
		Type: "authenticated", Protocol: SignalingProtocol, PeerID: "viewer_12345678",
		MaxViewers: 8, EndpointMediaCopyCapacity: 2, HostOnline: true, HostPaused: &paused,
		IceConfig: IceConfig{}, RoutePolicy: DefaultRoutePolicy, CodeEntryPolicy: CodeEntryOpen,
		ViewerAuthorizationGeneration: "viewer_generation_12345678",
		MediaMode:                     "peer-assisted", RouteRevision: 0,
		QualitySettings: DefaultQualitySettings, Role: RoleViewer,
	})
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	if _, err := decoder.Token(); err != nil {
		t.Fatal(err)
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			t.Fatal(err)
		}
		order = append(order, key.(string))
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{
		"type", "protocol", "peerId", "maxViewers",
		"endpointMediaCopyCapacity", "hostOnline", "hostPaused", "connectionId",
		"iceConfig", "routePolicy", "codeEntryPolicy", "viewerAuthorizationGeneration",
		"mediaMode", "shareGeneration", "routeRevision", "routeAssignment",
		"qualitySettings", "role",
	}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("key order\n got: %v\nwant: %v", order, want)
	}
}

// Optional keys reject an explicit null; nullable keys reject absence.
func TestOptionalAndNullableAreExact(t *testing.T) {
	for _, sample := range []struct {
		name string
		raw  string
		want bool
	}{
		{"null optional shareGeneration",
			`{"type":"stop-sharing","shareGeneration":null}`, false},
		{"absent optional shareGeneration", `{"type":"stop-sharing"}`, true},
		{"null optional targetPeerId",
			`{"type":"restart-request","targetPeerId":null,` +
				`"connectionId":"connection_12345678","rebuild":true}`, false},
		{"null optional qualityApproved",
			`{"type":"route-ready","revision":1,"phase":"prepare","qualityApproved":null}`, false},
		{"null nullable connectionId",
			`{"type":"route-failed","revision":1,"phase":"active","connectionId":null}`, true},
		{"absent nullable connectionId",
			`{"type":"route-failed","revision":1,"phase":"active"}`, false},
	} {
		assertClientMessage(t, sample.name, []byte(sample.raw), sample.want)
	}
}

// A host authenticate without routePolicy takes DEFAULT_ROUTE_POLICY.
func TestAuthenticateAppliesTheRoutePolicyDefault(t *testing.T) {
	message, err := DecodeClientMessage([]byte(
		`{"type":"authenticate","protocol":"piik-v24","roomId":"1234","role":"host",` +
			`"token":"` + repeat("a", 43) + `","clientId":"client_12345678"}`))
	if err != nil {
		t.Fatal(err)
	}
	host, ok := message.(AuthenticateHostMessage)
	if !ok {
		t.Fatalf("decoded %#v, want AuthenticateHostMessage", message)
	}
	if host.RoutePolicy != DefaultRoutePolicy {
		t.Fatalf("routePolicy = %+v, want %+v", host.RoutePolicy, DefaultRoutePolicy)
	}
}

func TestAuthenticateAcceptsPersistentRoomSessionOptIn(t *testing.T) {
	message, err := DecodeClientMessage([]byte(
		`{"type":"authenticate","protocol":"piik-v24","roomId":"1234","role":"host",` +
			`"token":"` + repeat("a", 43) + `","clientId":"client_12345678","roomSession":true,"roomOnly":true}`))
	if err != nil {
		t.Fatal(err)
	}
	host, ok := message.(AuthenticateHostMessage)
	if !ok || !host.RoomSession || !host.RoomOnly {
		t.Fatalf("decoded %#v, want room-session opt-in and room-only state", message)
	}
	if _, err := DecodeClientMessage([]byte(
		`{"type":"authenticate","protocol":"piik-v24","roomId":"1234","role":"host",` +
			`"token":"` + repeat("a", 43) + `","clientId":"client_12345678","roomOnly":true}`)); err == nil {
		t.Fatal("accepted roomOnly without roomSession opt-in")
	}
}

func TestStartSharingRequiresAnOpaqueGenerationAndRoutePolicy(t *testing.T) {
	message, err := DecodeClientMessage([]byte(
		`{"type":"start-sharing","shareGeneration":"share_12345678",` +
			`"routePolicy":{"peerOnly":true,"topologyOptimization":false,"natPrediction":false}}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := message.(StartSharingMessage); !ok {
		t.Fatalf("decoded %#v, want StartSharingMessage", message)
	}
	for _, raw := range []string{
		`{"type":"start-sharing","shareGeneration":"short","routePolicy":{"peerOnly":true,"topologyOptimization":false,"natPrediction":false}}`,
		`{"type":"start-sharing","shareGeneration":"share_12345678"}`,
	} {
		if _, err := DecodeClientMessage([]byte(raw)); err == nil {
			t.Errorf("accepted invalid start-sharing message %s", raw)
		}
	}
}

// The sealed unions accept nothing outside their own message structs.
func TestDecodeRejectsUnknownEnvelopes(t *testing.T) {
	for _, raw := range []string{`{}`, `[]`, `null`, `"authenticate"`, `{"type":42}`,
		`{"type":"unknown"}`, `{"kind":"signal"}`} {
		if _, err := DecodeClientMessage([]byte(raw)); err == nil {
			t.Errorf("client decode accepted %s", raw)
		}
		if _, err := DecodeServerMessage([]byte(raw)); err == nil {
			t.Errorf("server decode accepted %s", raw)
		}
	}
}
