package sfu

// Ported from tests/sfu-resource-admission.test.ts.

import (
	"slices"
	"strings"
	"testing"
)

func TestSubscriptionDrainReleasesOnlyExactConnection(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 2})
	publication := PublicationFence{RoomID: "ROOM1234", ShareGeneration: "share_12345678", PublicationGeneration: "publication_12345678"}
	old := SubscriptionFence{PublicationFence: publication, ViewerPeerID: "viewer_12345678", ConnectionID: "old_12345678"}
	current := old
	current.ConnectionID = "new_12345678"
	if !admission.ReservePublication(publication) || !admission.ReserveSubscription(old) {
		t.Fatal("initial admission failed")
	}
	if _, ok := admission.CommitPublication(publication); !ok {
		t.Fatal("publication commit failed")
	}
	if !admission.ReserveSubscription(current) {
		t.Fatal("candidate connection was not charged independently")
	}
	if admission.Usage().Egress != 2 {
		t.Fatal("two physical handles must remain charged")
	}
	if !admission.BeginSubscriptionDrain(old) || !admission.CompleteSubscriptionDrain(old) {
		t.Fatal("exact subscription drain failed")
	}
	if admission.CompleteSubscriptionDrain(old) || !admission.HasSubscription(current) || admission.Usage().Egress != 1 {
		t.Fatal("stale retirement changed the candidate")
	}
}

func publicationFence(roomID string, publicationGeneration string) PublicationFence {
	return PublicationFence{
		RoomID:                roomID,
		ShareGeneration:       "share_" + roomID,
		PublicationGeneration: publicationGeneration,
	}
}

func subscriptionFence(fence PublicationFence, viewerPeerID string) SubscriptionFence {
	return SubscriptionFence{PublicationFence: fence, ViewerPeerID: viewerPeerID}
}

func expectPanic(t *testing.T, want string, run func()) {
	t.Helper()
	defer func() {
		recovered := recover()
		message, _ := recovered.(string)
		if recovered == nil || !strings.Contains(message, want) {
			t.Fatalf("panic = %v, want it to contain %q", recovered, want)
		}
	}()
	run()
}

func expectUsage(t *testing.T, admission *Admission, ingress int, egress int) {
	t.Helper()
	if usage := admission.Usage(); usage != (Usage{Ingress: ingress, Egress: egress}) {
		t.Fatalf("usage = %+v, want {Ingress:%d Egress:%d}", usage, ingress, egress)
	}
}

func expectDrained(t *testing.T, drained []PublicationFence, ok bool, want ...PublicationFence) {
	t.Helper()
	if !ok {
		t.Fatal("commit was refused, want it accepted")
	}
	if !slices.Equal(drained, want) {
		t.Fatalf("drained = %v, want %v", drained, want)
	}
}

func TestAdmissionRequiresExplicitCapacities(t *testing.T) {
	// Number.MAX_SAFE_INTEGER + 1 and 0; the TypeScript third case, 1.5, cannot
	// be expressed by Go's int.
	for _, ingressCapacity := range []int{0, maxSafeInteger + 1} {
		expectPanic(t, "positive safe integer", func() {
			NewAdmission(AdmissionOptions{IngressCapacity: ingressCapacity, EgressCapacity: 1})
		})
	}
	expectPanic(t, "positive safe integer", func() {
		NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 0})
	})
}

func TestAdmissionEnforcesIngressAndEgressIndependently(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 2, EgressCapacity: 2})
	first := publicationFence("1", "publication_first")
	second := publicationFence("2", "publication_second")

	if !admission.ReservePublication(first) || !admission.ReservePublication(second) {
		t.Fatal("both publications must fit the ingress capacity")
	}
	if admission.ReservePublication(publicationFence("3", "publication_third")) {
		t.Fatal("a third publication must exceed the ingress capacity")
	}
	if !admission.ReserveSubscription(subscriptionFence(first, "viewer_a")) ||
		!admission.ReserveSubscription(subscriptionFence(first, "viewer_b")) {
		t.Fatal("both subscriptions must fit the egress capacity")
	}
	if admission.ReserveSubscription(subscriptionFence(second, "viewer_c")) {
		t.Fatal("a third subscription must exceed the egress capacity")
	}
	expectUsage(t, admission, 2, 2)
}

func TestAdmissionKeepsExactOperationsIdempotent(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 1})
	active := publicationFence("1", "publication_active")
	viewer := subscriptionFence(active, "viewer_a")

	if !admission.ReservePublication(active) || !admission.ReservePublication(active) {
		t.Fatal("an exact publication reservation must be idempotent")
	}
	if !admission.ReserveSubscription(viewer) || !admission.ReserveSubscription(viewer) {
		t.Fatal("an exact subscription reservation must be idempotent")
	}
	if admission.CommitSubscription(viewer) {
		t.Fatal("a subscription must not commit before its publication")
	}
	drained, ok := admission.CommitPublication(active)
	expectDrained(t, drained, ok)
	drained, ok = admission.CommitPublication(active)
	expectDrained(t, drained, ok)
	if !admission.CommitSubscription(viewer) {
		t.Fatal("the exact subscription must commit after its publication")
	}
	expectUsage(t, admission, 1, 1)

	stale := publicationFence("1", "publication_stale")
	if admission.ReserveSubscription(subscriptionFence(stale, "viewer_a")) {
		t.Fatal("a stale generation must not admit a subscription")
	}
	if _, ok := admission.CommitPublication(stale); ok {
		t.Fatal("a stale generation must not commit")
	}
	if admission.CommitSubscription(subscriptionFence(active, "viewer_b")) {
		t.Fatal("an unreserved viewer must not commit")
	}
	if admission.BeginSubscriptionDrain(subscriptionFence(active, "viewer_b")) {
		t.Fatal("an unreserved viewer must not drain")
	}
	if admission.BeginDrain(stale) {
		t.Fatal("a stale generation must not drain")
	}
}

func TestAdmissionDoesNotCommitWithoutFirstSubscription(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 1})
	pending := publicationFence("1", "publication_pending")

	if !admission.ReservePublication(pending) {
		t.Fatal("the publication must reserve")
	}
	if _, ok := admission.CommitPublication(pending); ok {
		t.Fatal("a publication without a reserved subscription must not commit")
	}
	if !admission.BeginDrain(pending) || !admission.CompleteDrain(pending) {
		t.Fatal("the reserved publication must drain")
	}
	expectUsage(t, admission, 0, 0)
}

func TestAdmissionCommitsNewGenerationBeforeDrainingTheOld(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 2, EgressCapacity: 3})
	first := publicationFence("1", "publication_first")
	second := publicationFence("1", "publication_second")
	firstViewer := subscriptionFence(first, "viewer_a")

	if !admission.ReservePublication(first) || !admission.ReserveSubscription(firstViewer) {
		t.Fatal("the first generation must reserve")
	}
	drained, ok := admission.CommitPublication(first)
	expectDrained(t, drained, ok)

	if !admission.ReservePublication(second) ||
		!admission.ReserveSubscription(subscriptionFence(second, "viewer_b")) ||
		!admission.ReserveSubscription(subscriptionFence(second, "viewer_c")) {
		t.Fatal("the second generation must reserve alongside the first")
	}
	expectUsage(t, admission, 2, 3)

	drained, ok = admission.CommitPublication(second)
	expectDrained(t, drained, ok, first)
	if !admission.CommitSubscription(subscriptionFence(second, "viewer_b")) {
		t.Fatal("the new generation's subscription must commit")
	}
	if admission.ReservePublication(first) {
		t.Fatal("the draining generation must not be reserved again")
	}
	if admission.ReserveSubscription(firstViewer) {
		t.Fatal("the draining generation must not admit a subscription")
	}

	if !admission.CompleteDrain(first) {
		t.Fatal("the drained generation must complete")
	}
	if admission.CompleteDrain(first) {
		t.Fatal("a completed drain must not repeat")
	}
	expectUsage(t, admission, 1, 2)
}

func TestAdmissionKeepsReleasedReservedSubscriptionCharged(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 2})
	active := publicationFence("1", "publication_active")
	first := subscriptionFence(active, "viewer_a")
	candidate := subscriptionFence(active, "viewer_b")

	if !admission.ReservePublication(active) || !admission.ReserveSubscription(first) {
		t.Fatal("the publication and its first viewer must reserve")
	}
	drained, ok := admission.CommitPublication(active)
	expectDrained(t, drained, ok)

	if !admission.ReserveSubscription(candidate) {
		t.Fatal("the candidate must reserve")
	}
	expectUsage(t, admission, 1, 2)
	if !admission.BeginSubscriptionDrain(candidate) ||
		!admission.BeginSubscriptionDrain(candidate) {
		t.Fatal("the subscription drain must be idempotent")
	}
	if admission.CommitSubscription(candidate) {
		t.Fatal("a draining subscription must not commit")
	}
	expectUsage(t, admission, 1, 2)
	if admission.ReserveSubscription(subscriptionFence(active, "viewer_c")) {
		t.Fatal("the draining subscription still holds its egress charge")
	}
	if !admission.BeginDrain(active) || !admission.CompleteDrain(active) {
		t.Fatal("the publication must drain")
	}
	expectUsage(t, admission, 0, 0)
}

func TestAdmissionDoesNotReviveAConnectionDuringPhysicalClose(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 1})
	active := publicationFence("1", "publication_active")
	viewer := subscriptionFence(active, "viewer_a")

	if !admission.ReservePublication(active) || !admission.ReserveSubscription(viewer) {
		t.Fatal("the publication and its viewer must reserve")
	}
	drained, ok := admission.CommitPublication(active)
	expectDrained(t, drained, ok)
	if !admission.BeginSubscriptionDrain(viewer) {
		t.Fatal("the subscription must begin draining")
	}
	expectUsage(t, admission, 1, 1)

	if admission.ReserveSubscription(viewer) {
		t.Fatal("a draining connection cannot be revived")
	}
	expectUsage(t, admission, 1, 1)
	if admission.ReserveSubscription(subscriptionFence(active, "viewer_b")) {
		t.Fatal("the charge must still block another viewer")
	}
	if !admission.CompleteSubscriptionDrain(viewer) {
		t.Fatal("physical close must release the charge")
	}
	viewer.ConnectionID = "replacement_12345678"
	if !admission.ReserveSubscription(viewer) || !admission.CommitSubscription(viewer) {
		t.Fatal("a new connection must reserve after physical close")
	}
	expectUsage(t, admission, 1, 1)
}

func TestAdmissionKeepsDepartedSubscriptionChargedUntilDrainProof(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 1})
	active := publicationFence("1", "publication_active")
	viewer := subscriptionFence(active, "viewer_a")

	if !admission.ReservePublication(active) || !admission.ReserveSubscription(viewer) {
		t.Fatal("the publication and its viewer must reserve")
	}
	drained, ok := admission.CommitPublication(active)
	expectDrained(t, drained, ok)
	if !admission.BeginSubscriptionDrain(viewer) {
		t.Fatal("the subscription must begin draining")
	}
	if admission.ReserveSubscription(subscriptionFence(active, "viewer_b")) {
		t.Fatal("the departed viewer still holds its egress charge")
	}
	if !admission.BeginDrain(active) || !admission.BeginDrain(active) {
		t.Fatal("the publication drain must be idempotent")
	}
	expectUsage(t, admission, 1, 1)
	if !admission.CompleteDrain(active) {
		t.Fatal("the publication must complete its drain")
	}
	expectUsage(t, admission, 0, 0)
}

func TestAdmissionDrainsEveryGenerationExactlyOnce(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 3, EgressCapacity: 4})
	active := publicationFence("1", "publication_active")
	replacement := publicationFence("1", "publication_replacement")
	other := publicationFence("2", "publication_other")

	if !admission.ReservePublication(active) ||
		!admission.ReserveSubscription(subscriptionFence(active, "viewer_a")) {
		t.Fatal("the active generation must reserve")
	}
	drained, ok := admission.CommitPublication(active)
	expectDrained(t, drained, ok)
	if !admission.ReservePublication(replacement) ||
		!admission.ReserveSubscription(subscriptionFence(replacement, "viewer_b")) ||
		!admission.ReservePublication(other) ||
		!admission.ReserveSubscription(subscriptionFence(other, "viewer_c")) {
		t.Fatal("the replacement and the other room must reserve")
	}

	// Insertion order, not map order: the drain tasks are created from it.
	firstRoom := admission.BeginDrainRoom("1")
	if !slices.Equal(firstRoom, []PublicationFence{active, replacement}) {
		t.Fatalf("beginDrainRoom = %v, want [active replacement]", firstRoom)
	}
	if repeated := admission.BeginDrainRoom("1"); !slices.Equal(repeated, firstRoom) {
		t.Fatalf("repeated beginDrainRoom = %v, want %v", repeated, firstRoom)
	}
	all := admission.BeginDrainAll()
	if !slices.Equal(all, []PublicationFence{active, replacement, other}) {
		t.Fatalf("beginDrainAll = %v, want [active replacement other]", all)
	}
	expectUsage(t, admission, 3, 3)

	for _, fence := range []PublicationFence{active, replacement, other} {
		if !admission.CompleteDrain(fence) {
			t.Fatalf("%s must complete its drain", fence.PublicationGeneration)
		}
		if admission.CompleteDrain(fence) {
			t.Fatalf("%s must not complete twice", fence.PublicationGeneration)
		}
	}
	expectUsage(t, admission, 0, 0)
}

func TestAdmissionRejectsInvalidFences(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 1})
	valid := publicationFence("1", "publication_active")

	expectPanic(t, "SFU resource fence is invalid", func() {
		admission.ReservePublication(PublicationFence{ShareGeneration: "s", PublicationGeneration: "p"})
	})
	expectPanic(t, "SFU resource fence is invalid", func() {
		admission.BeginDrain(PublicationFence{RoomID: "1", PublicationGeneration: "p"})
	})
	expectPanic(t, "SFU subscription fence is invalid", func() {
		admission.ReserveSubscription(subscriptionFence(valid, ""))
	})
	expectPanic(t, "SFU resource room ID is invalid", func() {
		admission.BeginDrainRoom("")
	})
}

// TestAdmissionAssertsNoUnderflow reaches the accounting assertion the public
// state machine cannot reach, by corrupting the egress counter first.
func TestAdmissionAssertsNoUnderflow(t *testing.T) {
	admission := NewAdmission(AdmissionOptions{IngressCapacity: 1, EgressCapacity: 1})
	active := publicationFence("1", "publication_active")
	if !admission.ReservePublication(active) ||
		!admission.ReserveSubscription(subscriptionFence(active, "viewer_a")) ||
		!admission.BeginDrain(active) {
		t.Fatal("the publication must reserve and drain")
	}
	admission.egressInUse = 0
	expectPanic(t, "SFU resource accounting underflow", func() {
		admission.CompleteDrain(active)
	})
}
