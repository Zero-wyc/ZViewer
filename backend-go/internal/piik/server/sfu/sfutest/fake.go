// Package sfutest provides deterministic physical-media effects for router tests.
package sfutest

import (
	"context"
	"errors"
	"slices"
	"sync"

	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/server/sfu"
)

type FakeMedia struct {
	mu            sync.Mutex
	publications  map[sfu.ResourceFence]string
	created       []sfu.ResourceFence
	deleted       []sfu.ResourceFence
	drained       []sfu.SubscriptionFence
	drainAttempts []sfu.SubscriptionFence
	deleteErr     error
	drainBarrier  <-chan struct{}
}

func New() *FakeMedia { return &FakeMedia{publications: make(map[sfu.ResourceFence]string)} }
func (media *FakeMedia) HasPublication(fence sfu.ResourceFence, connectionID string) bool {
	media.mu.Lock()
	defer media.mu.Unlock()
	return media.publications[fence] == connectionID && connectionID != ""
}
func (media *FakeMedia) PreparePublication(fence sfu.ResourceFence, connectionID string, _ sfu.PublicationMedia) error {
	media.mu.Lock()
	defer media.mu.Unlock()
	media.publications[fence] = connectionID
	media.created = append(media.created, fence)
	return nil
}
func (*FakeMedia) AcceptPublisherOffer(sfu.ResourceFence, string, webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	return webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: "answer"}, nil
}
func (*FakeMedia) AddPublisherICE(sfu.ResourceFence, string, webrtc.ICECandidateInit) error {
	return nil
}
func (*FakeMedia) UpdatePublication(sfu.ResourceFence, string, sfu.PublicationMedia) error {
	return nil
}
func (*FakeMedia) PublicationDemand(sfu.ResourceFence, string) (int, error) { return 1, nil }
func (*FakeMedia) PrepareSubscriber(context.Context, sfu.SubscriptionFence, string) (webrtc.SessionDescription, error) {
	return webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "offer"}, nil
}
func (*FakeMedia) ApplySubscriberAnswer(sfu.SubscriptionFence, string, webrtc.SessionDescription) error {
	return nil
}
func (*FakeMedia) AddSubscriberICE(sfu.SubscriptionFence, string, webrtc.ICECandidateInit) error {
	return nil
}
func (*FakeMedia) RestartSubscriber(sfu.SubscriptionFence, string) (webrtc.SessionDescription, error) {
	return webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "restart"}, nil
}
func (media *FakeMedia) CloseSubscription(fence sfu.SubscriptionFence, _ string) error {
	media.mu.Lock()
	media.drainAttempts = append(media.drainAttempts, fence)
	barrier := media.drainBarrier
	media.mu.Unlock()
	if barrier != nil {
		<-barrier
	}
	media.mu.Lock()
	defer media.mu.Unlock()
	media.drained = append(media.drained, fence)
	return nil
}
func (media *FakeMedia) ClosePublication(fence sfu.ResourceFence) error {
	media.mu.Lock()
	defer media.mu.Unlock()
	if media.deleteErr != nil {
		return media.deleteErr
	}
	delete(media.publications, fence)
	media.deleted = append(media.deleted, fence)
	return nil
}
func (media *FakeMedia) SetFailDelete(fail bool) {
	media.mu.Lock()
	defer media.mu.Unlock()
	media.deleteErr = nil
	if fail {
		media.deleteErr = errors.New("test media close failed")
	}
}
func (media *FakeMedia) SetSubscriptionDrainBarrier(barrier <-chan struct{}) {
	media.mu.Lock()
	defer media.mu.Unlock()
	media.drainBarrier = barrier
}
func (media *FakeMedia) Created() []sfu.ResourceFence {
	media.mu.Lock()
	defer media.mu.Unlock()
	return slices.Clone(media.created)
}
func (media *FakeMedia) Deleted() []sfu.ResourceFence {
	media.mu.Lock()
	defer media.mu.Unlock()
	return slices.Clone(media.deleted)
}
func (media *FakeMedia) DrainedSubscriptions() []sfu.SubscriptionFence {
	media.mu.Lock()
	defer media.mu.Unlock()
	return slices.Clone(media.drained)
}
func (media *FakeMedia) SubscriptionDrainAttempts() []sfu.SubscriptionFence {
	media.mu.Lock()
	defer media.mu.Unlock()
	return slices.Clone(media.drainAttempts)
}
