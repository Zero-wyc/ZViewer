package sfu

import (
	"zviewer/backend/internal/share/ordered"
)

type AdmissionOptions struct {
	IngressCapacity int
	EgressCapacity  int
}

type resourceState string

const (
	stateReserved  resourceState = "reserved"
	stateCommitted resourceState = "committed"
	stateDraining  resourceState = "draining"
)

type subscriptionEntry struct {
	fence SubscriptionFence
	state resourceState
}

type publicationEntry struct {
	fence PublicationFence
	state resourceState
	// Subscriptions are counted and looked up by exact connection; their
	// iteration order does not affect drain order.
	subscriptions map[string]*subscriptionEntry
}

// Publication insertion order determines the router's physical drain order.
type roomPublications = ordered.Map[string, *publicationEntry]

// Admission tracks reserved, committed and draining SFU capacity. The signaling
// server serializes access under its mutex; capacity stays charged until physical
// retirement is confirmed through CompleteDrain or CompleteSubscriptionDrain.
type Admission struct {
	// BeginDrainAll also preserves room insertion order.
	rooms           ordered.Map[string, *roomPublications]
	ingressCapacity int
	egressCapacity  int
	ingressInUse    int
	egressInUse     int
}

// NewAdmission requires capacities from validated configuration.
func NewAdmission(options AdmissionOptions) *Admission {
	assertPositiveSafeInteger(options.IngressCapacity, "SFU ingress capacity")
	assertPositiveSafeInteger(options.EgressCapacity, "SFU egress capacity")
	return &Admission{
		ingressCapacity: options.IngressCapacity,
		egressCapacity:  options.EgressCapacity,
	}
}

func (admission *Admission) ReservePublication(fence PublicationFence) bool {
	assertFence(fence)
	room, _ := admission.rooms.Get(fence.RoomID)
	var existing *publicationEntry
	if room != nil {
		existing, _ = room.Get(publicationKey(fence))
	}
	if existing != nil {
		return existing.state != stateDraining && existing.fence == fence
	}
	if admission.ingressInUse >= admission.ingressCapacity {
		return false
	}
	if room != nil {
		for _, publication := range room.All() {
			if publication.state == stateReserved {
				return false
			}
		}
	}

	resources := room
	if resources == nil {
		resources = &roomPublications{}
	}
	resources.Set(publicationKey(fence), &publicationEntry{
		fence:         fence,
		state:         stateReserved,
		subscriptions: map[string]*subscriptionEntry{},
	})
	admission.rooms.Set(fence.RoomID, resources)
	admission.ingressInUse++
	return true
}

func (admission *Admission) ReserveSubscription(fence SubscriptionFence) bool {
	assertSubscriptionFence(fence)
	publication := admission.publication(fence.PublicationFence)
	if publication == nil || publication.state == stateDraining {
		return false
	}
	key := fence.ViewerPeerID + "\x00" + fence.ConnectionID
	if existing, ok := publication.subscriptions[key]; ok {
		return existing.fence == fence && existing.state != stateDraining
	}
	if admission.egressInUse >= admission.egressCapacity {
		return false
	}

	publication.subscriptions[key] = &subscriptionEntry{
		fence: fence,
		state: stateReserved,
	}
	admission.egressInUse++
	return true
}

// CommitPublication promotes the reserved publication and subscriptions and
// returns older committed publications for physical retirement. The boolean
// reports acceptance; a repeated commit succeeds without scheduling another drain.
func (admission *Admission) CommitPublication(fence PublicationFence) ([]PublicationFence, bool) {
	assertFence(fence)
	room, _ := admission.rooms.Get(fence.RoomID)
	var publication *publicationEntry
	if room != nil {
		publication, _ = room.Get(publicationKey(fence))
	}
	if room == nil || publication == nil || publication.fence != fence {
		return nil, false
	}
	if publication.state == stateCommitted {
		return nil, true
	}
	if publication.state != stateReserved {
		return nil, false
	}
	reserved := false
	for _, subscription := range publication.subscriptions {
		if subscription.state == stateReserved {
			reserved = true
			break
		}
	}
	if !reserved {
		return nil, false
	}

	var draining []PublicationFence
	for _, other := range room.All() {
		if other == publication || other.state != stateCommitted {
			continue
		}
		markDraining(other)
		draining = append(draining, other.fence)
	}
	publication.state = stateCommitted
	for _, subscription := range publication.subscriptions {
		if subscription.state == stateReserved {
			subscription.state = stateCommitted
		}
	}
	return draining, true
}

func (admission *Admission) CommitSubscription(fence SubscriptionFence) bool {
	assertSubscriptionFence(fence)
	publication := admission.publication(fence.PublicationFence)
	if publication == nil || publication.state != stateCommitted {
		return false
	}
	subscription, ok := publication.subscriptions[fence.ViewerPeerID+"\x00"+fence.ConnectionID]
	if !ok || subscription.fence != fence {
		return false
	}
	if subscription.state == stateCommitted {
		return true
	}
	if subscription.state != stateReserved {
		return false
	}
	subscription.state = stateCommitted
	return true
}

func (admission *Admission) BeginSubscriptionDrain(fence SubscriptionFence) bool {
	assertSubscriptionFence(fence)
	publication := admission.publication(fence.PublicationFence)
	if publication == nil {
		return false
	}
	subscription, ok := publication.subscriptions[fence.ViewerPeerID+"\x00"+fence.ConnectionID]
	if !ok || subscription.fence != fence {
		return false
	}
	subscription.state = stateDraining
	return true
}

func (admission *Admission) BeginDrain(fence PublicationFence) bool {
	assertFence(fence)
	publication := admission.publication(fence)
	if publication == nil {
		return false
	}
	markDraining(publication)
	return true
}

func (admission *Admission) HasPublication(fence PublicationFence) bool {
	publication := admission.publication(fence)
	return publication != nil && publication.state != stateDraining
}

func (admission *Admission) HasSubscription(fence SubscriptionFence) bool {
	publication := admission.publication(fence.PublicationFence)
	if publication == nil || publication.state == stateDraining {
		return false
	}
	entry := publication.subscriptions[fence.ViewerPeerID+"\x00"+fence.ConnectionID]
	return entry != nil && entry.fence == fence && entry.state != stateDraining
}

// In-process closure revokes this exact connection; no reusable token remains.
func (admission *Admission) CompleteSubscriptionDrain(fence SubscriptionFence) bool {
	publication := admission.publication(fence.PublicationFence)
	if publication == nil {
		return false
	}
	key := fence.ViewerPeerID + "\x00" + fence.ConnectionID
	entry := publication.subscriptions[key]
	if entry == nil || entry.fence != fence || entry.state != stateDraining {
		return false
	}
	delete(publication.subscriptions, key)
	admission.subtractEgress(1)
	return true
}

func (admission *Admission) CompleteDrain(fence PublicationFence) bool {
	assertFence(fence)
	room, _ := admission.rooms.Get(fence.RoomID)
	key := publicationKey(fence)
	var publication *publicationEntry
	if room != nil {
		publication, _ = room.Get(key)
	}
	if room == nil || publication == nil ||
		publication.state != stateDraining || publication.fence != fence {
		return false
	}

	room.Delete(key)
	admission.ingressInUse--
	admission.subtractEgress(len(publication.subscriptions))
	admission.assertNoUnderflow()
	if room.Len() == 0 {
		admission.rooms.Delete(fence.RoomID)
	}
	return true
}

func (admission *Admission) BeginDrainRoom(roomID string) []PublicationFence {
	if roomID == "" {
		panic("SFU resource room ID is invalid")
	}
	room, _ := admission.rooms.Get(roomID)
	if room == nil {
		return nil
	}
	for _, publication := range room.All() {
		markDraining(publication)
	}
	fences := make([]PublicationFence, 0, room.Len())
	for _, publication := range room.All() {
		fences = append(fences, publication.fence)
	}
	return fences
}

func (admission *Admission) BeginDrainAll() []PublicationFence {
	var fences []PublicationFence
	for _, roomID := range admission.rooms.Keys() {
		fences = append(fences, admission.BeginDrainRoom(roomID)...)
	}
	return fences
}

func (admission *Admission) Usage() Usage {
	return Usage{Ingress: admission.ingressInUse, Egress: admission.egressInUse}
}

func (admission *Admission) publication(fence PublicationFence) *publicationEntry {
	room, ok := admission.rooms.Get(fence.RoomID)
	if !ok {
		return nil
	}
	publication, ok := room.Get(publicationKey(fence))
	if !ok || publication.fence != fence {
		return nil
	}
	return publication
}

func (admission *Admission) subtractEgress(count int) {
	admission.egressInUse -= count
	admission.assertNoUnderflow()
}

func (admission *Admission) assertNoUnderflow() {
	if admission.ingressInUse < 0 || admission.egressInUse < 0 {
		panic("SFU resource accounting underflow")
	}
}

func markDraining(publication *publicationEntry) {
	publication.state = stateDraining
	for _, subscription := range publication.subscriptions {
		subscription.state = stateDraining
	}
}

func publicationKey(fence PublicationFence) string {
	return fence.ShareGeneration + "\x00" + fence.PublicationGeneration
}

func assertFence(fence PublicationFence) {
	if fence.RoomID == "" || fence.ShareGeneration == "" ||
		fence.PublicationGeneration == "" {
		panic("SFU resource fence is invalid")
	}
}

func assertSubscriptionFence(fence SubscriptionFence) {
	assertFence(fence.PublicationFence)
	if fence.ViewerPeerID == "" {
		panic("SFU subscription fence is invalid")
	}
}

func assertPositiveSafeInteger(value int, name string) {
	if value <= 0 || int64(value) > maxSafeInteger {
		panic(name + " must be a positive safe integer")
	}
}

func validResourceFence(fence PublicationFence) bool {
	return validPublicationFence(fence)
}
