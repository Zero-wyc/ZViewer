package sfu

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"

	"zviewer/backend/internal/share/forwarding"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// LayerFormat 是一层的尺寸与码率。别名转出，免得调用方还要 import forwarding。
type LayerFormat = forwarding.LayerFormat

// PublicationMedia is metadata from the authorized publisher, not a quality ladder.
type PublicationMedia struct {
	Codec        string
	RIDs         []string
	Formats      []forwarding.LayerFormat
	Audio        bool
	AudioBitrate uint32
}

type MediaEvent struct {
	Fence        PublicationFence
	ViewerPeerID string // Empty for the publisher.
	ConnectionID string
	Candidate    *webrtc.ICECandidateInit // Nil with StateUnknown ends ICE gathering.
	State        webrtc.PeerConnectionState
	ActiveCount  *int
}

type MediaOptions struct {
	// Settings can contain the application-owned UDP mux. Media never closes it.
	Settings webrtc.SettingEngine
	// Events run without media locks and hand exact handles back to room authority.
	// Physical close must be scheduled asynchronously from these callbacks.
	Events func(MediaEvent)
}

// Runtime is the physical boundary injected into the room router and its tests.
type Runtime interface {
	HasPublication(PublicationFence, string) bool
	PreparePublication(PublicationFence, string, PublicationMedia) error
	UpdatePublication(PublicationFence, string, PublicationMedia) error
	PublicationDemand(PublicationFence, string) (int, error)
	AcceptPublisherOffer(PublicationFence, string, webrtc.SessionDescription) (webrtc.SessionDescription, error)
	AddPublisherICE(PublicationFence, string, webrtc.ICECandidateInit) error
	PrepareSubscriber(context.Context, SubscriptionFence, string) (webrtc.SessionDescription, error)
	ApplySubscriberAnswer(SubscriptionFence, string, webrtc.SessionDescription) error
	AddSubscriberICE(SubscriptionFence, string, webrtc.ICECandidateInit) error
	RestartSubscriber(SubscriptionFence, string) (webrtc.SessionDescription, error)
	CloseSubscription(SubscriptionFence, string) error
	ClosePublication(PublicationFence) error
}

// Media owns physical resources already authorized by the room's Admission.
// It does not admit rooms, issue credentials, retry, or choose route candidates.
type Media struct {
	options      MediaOptions
	mu           sync.Mutex
	publications map[PublicationFence]*mediaPublication
	closed       bool
	closeOnce    sync.Once
	closeErr     error
}

type mediaPublication struct {
	owner        *Media
	fence        PublicationFence
	connectionID string
	metadata     PublicationMedia
	pc           *webrtc.PeerConnection
	source       *forwarding.Source
	audio        *webrtc.TrackLocalStaticRTP
	ready        chan struct{}
	readyOnce    sync.Once
	mu           sync.Mutex
	signaling    sync.Mutex
	layers       []bool
	audioBound   bool
	subscribers  map[subscriptionKey]*mediaSubscription
	closed       bool
	failure      error
	readers      sync.WaitGroup
	prepares     sync.WaitGroup
	closeOnce    sync.Once
	closeErr     error
	demandWake   chan struct{}
	demandStop   chan struct{}
	demandDone   chan struct{}
}

type subscriptionKey struct {
	peerID       string
	connectionID string
}

type mediaSubscription struct {
	key subscriptionKey
	// Admission belongs to the room edge; its video transport can be replaced.
	resourceConnectionID string
	transport            *forwarding.Transport
	signaling            sync.Mutex
	ctx                  context.Context
	cancel               context.CancelFunc
	prepared             chan struct{}
	closeOnce            sync.Once
	closeErr             error
}

func NewMedia(options MediaOptions) *Media {
	return &Media{options: options, publications: make(map[PublicationFence]*mediaPublication)}
}

func (media *Media) HasPublication(fence PublicationFence, connectionID string) bool {
	_, err := media.publication(fence, connectionID)
	return err == nil
}

func validPublicationMedia(metadata PublicationMedia) bool {
	if (metadata.Codec != "h264" && metadata.Codec != "vp8") ||
		len(metadata.Formats) < 1 || len(metadata.Formats) > 3 ||
		len(metadata.RIDs) != len(metadata.Formats) ||
		(metadata.Audio && metadata.AudioBitrate == 0) {
		return false
	}
	for index, format := range metadata.Formats {
		// These are this SFU's admission bounds, not the descriptive wire format.
		// Forward the full current Browser/Native bitrate range without transcoding.
		if format.Width == 0 || format.Width > 8192 || format.Height == 0 || format.Height > 8192 ||
			format.Bitrate == 0 || format.Bitrate > 240_000_000 ||
			len(metadata.RIDs[index]) > 16 ||
			(metadata.RIDs[index] == "" && len(metadata.RIDs) != 1) ||
			slices.Contains(metadata.RIDs[:index], metadata.RIDs[index]) {
			return false
		}
	}
	return true
}

// PreparePublication is called only after ReservePublication succeeds.
// Repeated preparation never replaces a live publication.
func (media *Media) PreparePublication(fence PublicationFence, connectionID string, metadata PublicationMedia) error {
	if !validPublicationFence(fence) || connectionID == "" || !validPublicationMedia(metadata) {
		return errors.New("SFU publication media is invalid")
	}
	media.mu.Lock()
	defer media.mu.Unlock()
	if media.closed || media.publications[fence] != nil {
		return errors.New("SFU publication is unavailable")
	}
	metadata.Formats = slices.Clone(metadata.Formats)
	metadata.RIDs = slices.Clone(metadata.RIDs)
	publication := &mediaPublication{
		owner: media, fence: fence, connectionID: connectionID, metadata: metadata,
		ready: make(chan struct{}), layers: make([]bool, len(metadata.Formats)),
		subscribers: make(map[subscriptionKey]*mediaSubscription),
		demandWake:  make(chan struct{}, 1), demandStop: make(chan struct{}), demandDone: make(chan struct{}),
	}
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		return err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		return err
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(media.options.Settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	publication.pc = pc
	if metadata.Audio {
		// 只有声明了音频才建轨：无条件创建会让纯视频共享也多出一条 m=audio，
		// 观众 answer 里就必须声明 maxaveragebitrate，否则订阅直接被拒。
		publication.audio, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
		}, "audio", fence.PublicationGeneration)
		if err != nil {
			_ = pc.Close()
			return err
		}
	}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		var value *webrtc.ICECandidateInit
		if candidate != nil {
			encoded := candidate.ToJSON()
			value = &encoded
		}
		publication.emit(MediaEvent{Candidate: value})
	})
	pc.OnConnectionStateChange(publication.connectionStateChanged)
	pc.OnTrack(publication.consumeTrack)
	media.publications[fence] = publication
	go publication.runDemand()
	return nil
}

func (publication *mediaPublication) connectionStateChanged(state webrtc.PeerConnectionState) {
	if state == webrtc.PeerConnectionStateFailed {
		publication.fail(errors.New("SFU publisher transport failed"))
		return
	}
	publication.emit(MediaEvent{State: publication.pc.ConnectionState()})
}

func (publication *mediaPublication) wakeDemand() {
	select {
	case publication.demandWake <- struct{}{}:
	default:
	}
}

func (publication *mediaPublication) requiredActiveCount() int {
	publication.mu.Lock()
	if publication.closed || publication.failure != nil {
		publication.mu.Unlock()
		return 0
	}
	count, bootstrap := len(publication.metadata.Formats), false
	transports := make([]*forwarding.Transport, 0, len(publication.subscribers))
	for _, subscriber := range publication.subscribers {
		if subscriber.ctx.Err() != nil {
			continue
		}
		if subscriber.transport == nil {
			bootstrap = true
		} else {
			transports = append(transports, subscriber.transport)
		}
	}
	publication.mu.Unlock()
	if bootstrap {
		return count
	}
	active := 0
	for _, transport := range transports {
		switch transport.PC.ConnectionState() {
		case webrtc.PeerConnectionStateNew, webrtc.PeerConnectionStateConnecting:
			return count
		case webrtc.PeerConnectionStateConnected, webrtc.PeerConnectionStateDisconnected:
			active = max(active, transport.RequiredActiveCount())
		}
	}
	return min(active, count)
}

func (publication *mediaPublication) runDemand() {
	defer close(publication.demandDone)
	previous := -1
	for {
		select {
		case <-publication.demandStop:
			return
		case <-publication.demandWake:
			active := publication.requiredActiveCount()
			if active != previous {
				previous = active
				publication.emit(MediaEvent{ActiveCount: &active})
			}
		}
	}
}

func (media *Media) PublicationDemand(fence PublicationFence, connectionID string) (int, error) {
	publication, err := media.publication(fence, connectionID)
	if err != nil {
		return 0, err
	}
	return publication.requiredActiveCount(), nil
}

func (media *Media) publication(fence PublicationFence, connectionID string) (*mediaPublication, error) {
	media.mu.Lock()
	defer media.mu.Unlock()
	publication := media.publications[fence]
	if media.closed || publication == nil ||
		(connectionID != "" && publication.connectionID != connectionID) {
		return nil, errors.New("SFU publication media is unavailable")
	}
	return publication, nil
}

func (publication *mediaPublication) emit(event MediaEvent) {
	publication.mu.Lock()
	ended := publication.closed || publication.failure != nil && event.State != webrtc.PeerConnectionStateFailed
	publication.mu.Unlock()
	if ended {
		return
	}
	owner := publication.owner
	owner.mu.Lock()
	current := !owner.closed && owner.publications[publication.fence] == publication
	owner.mu.Unlock()
	if current && owner.options.Events != nil {
		event.Fence = publication.fence
		if event.ConnectionID == "" {
			event.ConnectionID = publication.connectionID
		}
		owner.options.Events(event)
	}
}

func (publication *mediaPublication) emitSubscriber(subscriber *mediaSubscription, event MediaEvent) {
	publication.mu.Lock()
	current := !publication.closed && publication.failure == nil &&
		publication.subscribers[subscriber.key] == subscriber && subscriber.ctx.Err() == nil
	publication.mu.Unlock()
	if current {
		event.ViewerPeerID = subscriber.key.peerID
		event.ConnectionID = subscriber.key.connectionID
		publication.emit(event)
	}
}

func (media *Media) AcceptPublisherOffer(fence PublicationFence, connectionID string,
	offer webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	publication, err := media.publication(fence, connectionID)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	publication.signaling.Lock()
	defer publication.signaling.Unlock()
	if offer.Type != webrtc.SDPTypeOffer {
		return webrtc.SessionDescription{}, errors.New("SFU publisher requires an offer")
	}
	publication.mu.Lock()
	if publication.closed {
		publication.mu.Unlock()
		return webrtc.SessionDescription{}, errors.New("SFU publication is closed")
	}
	publication.mu.Unlock()
	if err = publication.pc.SetRemoteDescription(offer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	videoCount, audioCount := 0, 0
	for _, transceiver := range publication.pc.GetTransceivers() {
		if transceiver.Direction() != webrtc.RTPTransceiverDirectionRecvonly &&
			transceiver.Direction() != webrtc.RTPTransceiverDirectionSendrecv {
			continue
		}
		name := webrtc.MimeTypeOpus
		if transceiver.Kind() == webrtc.RTPCodecTypeVideo {
			videoCount++
			name = "video/" + publication.metadata.Codec
		} else {
			audioCount++
		}
		parameters := transceiver.Receiver().GetParameters()
		selected := slices.DeleteFunc(slices.Clone(parameters.Codecs), func(codec webrtc.RTPCodecParameters) bool {
			return !strings.EqualFold(codec.MimeType, name)
		})
		if len(selected) == 0 {
			return webrtc.SessionDescription{}, errors.New("SFU publisher codec does not match its declaration")
		}
		if transceiver.Kind() == webrtc.RTPCodecTypeAudio {
			selected[0].SDPFmtpLine = "minptime=10;useinbandfec=1;stereo=1;usedtx=0;maxaveragebitrate=" + strconv.Itoa(audioBitrateCeiling)
		}
		if err = transceiver.SetCodecPreferences(forwarding.WithRTX(selected[0], parameters.Codecs)); err != nil {
			return webrtc.SessionDescription{}, err
		}
	}
	if videoCount != 1 || audioCount > 1 || publication.metadata.Audio && audioCount != 1 {
		return webrtc.SessionDescription{}, errors.New("SFU publisher track count does not match its declaration")
	}
	answer, err := publication.pc.CreateAnswer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err = publication.pc.SetLocalDescription(answer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	return answer, nil
}

func (media *Media) AddPublisherICE(fence PublicationFence, connectionID string, candidate webrtc.ICECandidateInit) error {
	publication, err := media.publication(fence, connectionID)
	if err != nil {
		return err
	}
	return forwarding.AddICECandidate(publication.pc, candidate)
}

func (media *Media) UpdatePublication(fence PublicationFence, connectionID string, metadata PublicationMedia) error {
	publication, err := media.publication(fence, connectionID)
	if err != nil {
		return err
	}
	publication.signaling.Lock()
	defer publication.signaling.Unlock()
	publication.mu.Lock()
	defer publication.mu.Unlock()
	if publication.closed || publication.failure != nil || !validPublicationMedia(metadata) ||
		metadata.Codec != publication.metadata.Codec || !slices.Equal(metadata.RIDs, publication.metadata.RIDs) {
		return errors.New("SFU media update changed the publication identity")
	}
	if publication.source != nil {
		if err := publication.source.UpdateFormats(metadata.Formats); err != nil {
			return err
		}
	}
	metadata.Formats, metadata.RIDs = slices.Clone(metadata.Formats), slices.Clone(metadata.RIDs)
	publication.metadata = metadata
	publication.wakeDemand()
	return nil
}

func (publication *mediaPublication) consumeTrack(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	video := track.Kind() == webrtc.RTPCodecTypeVideo
	publication.mu.Lock()
	layer := slices.Index(publication.metadata.RIDs, track.RID())
	if publication.closed || publication.failure != nil {
		publication.mu.Unlock()
		return
	}
	if video && (layer < 0 || publication.layers[layer] ||
		!strings.EqualFold(track.Codec().MimeType, "video/"+publication.metadata.Codec)) ||
		!video && (publication.audio == nil || publication.audioBound ||
			!strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) || track.Codec().ClockRate != 48_000) {
		publication.mu.Unlock()
		publication.fail(errors.New("unexpected SFU publisher track"))
		return
	}
	if video {
		if publication.source == nil {
			var err error
			publication.source, err = forwarding.NewSource(forwarding.SourceOptions{
				ID: publication.fence.PublicationGeneration, StreamID: publication.fence.PublicationGeneration,
				Codec: track.Codec(), Formats: publication.metadata.Formats,
				HeaderExtensions: receiver.GetParameters().HeaderExtensions,
				OnRTCP: func(_ int, packets []rtcp.Packet) {
					// Pion's ingress interceptors already own NACK and receiver reports.
					for _, packet := range packets {
						switch packet.(type) {
						case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
							_ = publication.pc.WriteRTCP([]rtcp.Packet{packet})
						}
					}
				},
			})
			if err != nil {
				publication.mu.Unlock()
				publication.fail(err)
				return
			}
		}
		if err := publication.source.BindLayer(layer, uint32(track.SSRC()), receiver.GetParameters()); err != nil {
			publication.mu.Unlock()
			publication.fail(err)
			return
		}
		publication.layers[layer] = true
	} else {
		publication.audioBound = true
	}
	source := publication.source
	publication.readers.Add(2)
	if source != nil {
		publication.readyOnce.Do(func() { close(publication.ready) })
	}
	publication.mu.Unlock()
	go publication.readRTCP(track, receiver, source, layer)
	defer publication.readers.Done()
	for {
		packet, _, err := forwarding.ReadRTP(track)
		if err != nil {
			return
		}
		if video {
			err = source.WriteRTP(layer, packet)
		} else {
			// Extensions are negotiated per PC; downstream interceptors own theirs.
			packet.Extension, packet.ExtensionProfile, packet.Extensions = false, 0, nil
			// A connecting/retired subscriber owns its write failure, not the publisher.
			_ = publication.audio.WriteRTP(packet)
		}
		if err != nil {
			publication.fail(err)
			return
		}
	}
}

func (publication *mediaPublication) readRTCP(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver,
	source *forwarding.Source, layer int) {
	defer publication.readers.Done()
	for {
		var packets []rtcp.Packet
		var err error
		if track.RID() == "" {
			packets, _, err = receiver.ReadRTCP()
		} else {
			packets, _, err = receiver.ReadSimulcastRTCP(track.RID())
		}
		if err != nil {
			return
		}
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			for _, packet := range packets {
				if report, ok := packet.(*rtcp.SenderReport); ok && report.SSRC == uint32(track.SSRC()) {
					_ = source.SenderReport(layer, report)
				}
			}
		}
	}
}

func (publication *mediaPublication) fail(err error) {
	publication.mu.Lock()
	if publication.closed || publication.failure != nil {
		publication.mu.Unlock()
		return
	}
	publication.failure = err
	publication.readyOnce.Do(func() { close(publication.ready) })
	publication.mu.Unlock()
	// The callback may retire this handle; do not wait for the current reader in it.
	go func() {
		_ = publication.pc.Close()
		publication.readers.Wait()
		publication.emit(MediaEvent{State: webrtc.PeerConnectionStateFailed})
	}()
}

// PrepareSubscriber follows ReserveSubscription. Its context is the existing
// route operation deadline, not a second media timeout.
func (media *Media) PrepareSubscriber(ctx context.Context, fence SubscriptionFence,
	connectionID string) (_ webrtc.SessionDescription, err error) {
	publication, err := media.publication(fence.PublicationFence, "")
	if err != nil || fence.ViewerPeerID == "" || connectionID == "" {
		return webrtc.SessionDescription{}, errors.New("SFU subscription media is unavailable")
	}
	key := subscriptionKey{peerID: fence.ViewerPeerID, connectionID: connectionID}
	// The route-operation context bounds preparation, not committed media lifetime.
	lifetime, cancel := context.WithCancel(context.Background())
	subscriber := &mediaSubscription{key: key, resourceConnectionID: fence.ConnectionID,
		ctx: lifetime, cancel: cancel, prepared: make(chan struct{})}
	publication.mu.Lock()
	if publication.closed || publication.failure != nil || publication.subscribers[key] != nil {
		publication.mu.Unlock()
		cancel()
		return webrtc.SessionDescription{}, errors.New("SFU subscription media is unavailable")
	}
	publication.subscribers[key] = subscriber
	publication.wakeDemand()
	publication.prepares.Add(1)
	publication.mu.Unlock()
	defer func() {
		close(subscriber.prepared)
		if err != nil {
			_ = publication.closeSubscriber(subscriber)
		}
		publication.prepares.Done()
	}()
	select {
	case <-publication.ready:
	case <-ctx.Done():
		return webrtc.SessionDescription{}, ctx.Err()
	case <-lifetime.Done():
		return webrtc.SessionDescription{}, lifetime.Err()
	}
	publication.mu.Lock()
	valid := !publication.closed && publication.failure == nil && publication.source != nil &&
		publication.subscribers[key] == subscriber && ctx.Err() == nil && lifetime.Err() == nil
	source := publication.source
	failure := publication.failure
	metadata := publication.metadata
	publication.mu.Unlock()
	if !valid {
		return webrtc.SessionDescription{}, errors.Join(errors.New("SFU publication media is unavailable"), failure)
	}
	var audio webrtc.TrackLocal
	if publication.audio != nil {
		audio = publication.audio
	}
	transport, err := forwarding.NewTransport(forwarding.TransportOptions{
		Source: source, Settings: media.options.Settings, ConnectionID: fence.ViewerPeerID + ":" + connectionID,
		InitialBitrate: int(metadata.Formats[len(metadata.Formats)-1].Bitrate), Audio: audio,
		OnDemandChanged: publication.wakeDemand,
	})
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	publication.mu.Lock()
	if publication.closed || publication.failure != nil || publication.subscribers[key] != subscriber || ctx.Err() != nil || lifetime.Err() != nil {
		publication.mu.Unlock()
		_ = transport.Close()
		return webrtc.SessionDescription{}, errors.New("SFU subscription media is unavailable")
	}
	subscriber.transport = transport
	publication.mu.Unlock()
	transport.PC.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		var value *webrtc.ICECandidateInit
		if candidate != nil {
			encoded := candidate.ToJSON()
			value = &encoded
		}
		publication.emitSubscriber(subscriber, MediaEvent{Candidate: value})
	})
	transport.PC.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		publication.subscriberStateChanged(subscriber, state)
	})
	offer, err := transport.PC.CreateOffer(nil)
	if err == nil {
		err = transport.PC.SetLocalDescription(offer)
	}
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	return offer, nil
}

func (publication *mediaPublication) subscriberStateChanged(subscriber *mediaSubscription, state webrtc.PeerConnectionState) {
	publication.mu.Lock()
	current := !publication.closed && publication.failure == nil && publication.subscribers[subscriber.key] == subscriber && subscriber.ctx.Err() == nil
	publication.mu.Unlock()
	if !current {
		return
	}
	// Failed still belongs to the route's terminal failure owner. Other queued
	// states describe current readiness, never permission to attach an old PC.
	if state != webrtc.PeerConnectionStateFailed {
		state = subscriber.transport.PC.ConnectionState()
	}
	if state == webrtc.PeerConnectionStateConnected {
		if err := subscriber.transport.SetConnected(); err != nil {
			state = webrtc.PeerConnectionStateFailed
		}
	}
	publication.emitSubscriber(subscriber, MediaEvent{State: state})
	publication.wakeDemand()
}

func (media *Media) subscriber(fence SubscriptionFence, connectionID string) (*mediaSubscription, error) {
	publication, err := media.publication(fence.PublicationFence, "")
	if err != nil {
		return nil, err
	}
	publication.mu.Lock()
	defer publication.mu.Unlock()
	subscriber := publication.subscribers[subscriptionKey{peerID: fence.ViewerPeerID, connectionID: connectionID}]
	if publication.closed || publication.failure != nil || subscriber == nil || subscriber.transport == nil || subscriber.ctx.Err() != nil {
		return nil, errors.New("SFU subscription media is unavailable")
	}
	return subscriber, nil
}

func (media *Media) ApplySubscriberAnswer(fence SubscriptionFence, connectionID string, answer webrtc.SessionDescription) error {
	subscriber, err := media.subscriber(fence, connectionID)
	if err != nil {
		return err
	}
	subscriber.signaling.Lock()
	defer subscriber.signaling.Unlock()
	if answer.Type != webrtc.SDPTypeAnswer {
		return errors.New("SFU subscriber requires an answer")
	}
	if subscriber.transport.AudioSender != nil {
		if err := forwarding.CheckAudioReceiveLimit(answer.SDP, audioBitrateCeiling); err != nil {
			return err
		}
	}
	return subscriber.transport.PC.SetRemoteDescription(answer)
}

// RestartSubscriber keeps the committed transport and asks ICE to recover it.
func (media *Media) RestartSubscriber(fence SubscriptionFence, connectionID string) (webrtc.SessionDescription, error) {
	subscriber, err := media.subscriber(fence, connectionID)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	subscriber.signaling.Lock()
	defer subscriber.signaling.Unlock()
	offer, err := subscriber.transport.PC.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err == nil {
		err = subscriber.transport.PC.SetLocalDescription(offer)
	}
	return offer, err
}

func (media *Media) AddSubscriberICE(fence SubscriptionFence, connectionID string, candidate webrtc.ICECandidateInit) error {
	subscriber, err := media.subscriber(fence, connectionID)
	if err != nil {
		return err
	}
	return forwarding.AddICECandidate(subscriber.transport.PC, candidate)
}

func (media *Media) CloseSubscription(fence SubscriptionFence, connectionID string) error {
	publication, err := media.publication(fence.PublicationFence, "")
	if err != nil {
		return nil
	}
	key := subscriptionKey{peerID: fence.ViewerPeerID, connectionID: connectionID}
	publication.mu.Lock()
	var subscribers []*mediaSubscription
	for _, subscriber := range publication.subscribers {
		if subscriber.key == key || connectionID == fence.ConnectionID &&
			subscriber.key.peerID == fence.ViewerPeerID && subscriber.resourceConnectionID == connectionID {
			subscribers = append(subscribers, subscriber)
		}
	}
	publication.mu.Unlock()
	var closeErr error
	for _, subscriber := range subscribers {
		closeErr = errors.Join(closeErr, publication.closeSubscriber(subscriber))
	}
	return closeErr
}

func (publication *mediaPublication) closeSubscriber(subscriber *mediaSubscription) error {
	subscriber.closeOnce.Do(func() {
		subscriber.cancel()
		<-subscriber.prepared
		if subscriber.transport != nil {
			subscriber.closeErr = subscriber.transport.Close()
		}
	})
	publication.mu.Lock()
	if publication.subscribers[subscriber.key] == subscriber {
		delete(publication.subscribers, subscriber.key)
		publication.wakeDemand()
	}
	publication.mu.Unlock()
	return subscriber.closeErr
}

func (media *Media) ClosePublication(fence PublicationFence) error {
	media.mu.Lock()
	publication := media.publications[fence]
	media.mu.Unlock()
	if publication == nil {
		return nil
	}
	err := publication.close()
	media.mu.Lock()
	if media.publications[fence] == publication {
		delete(media.publications, fence)
	}
	media.mu.Unlock()
	return err
}

// RetirePublication detaches only the identified video publisher. Its logical
// room reservation remains admitted; a replacement may be prepared immediately.
// The caller owns scheduling and joining the returned physical close.
func (media *Media) RetirePublication(fence PublicationFence, connectionID string) func() error {
	media.mu.Lock()
	defer media.mu.Unlock()
	publication := media.publications[fence]
	if publication == nil || publication.connectionID != connectionID {
		return nil
	}
	delete(media.publications, fence)
	return publication.close
}

func (publication *mediaPublication) close() error {
	publication.closeOnce.Do(func() {
		publication.mu.Lock()
		publication.closed = true
		close(publication.demandStop)
		publication.readyOnce.Do(func() { close(publication.ready) })
		var transports []*forwarding.Transport
		var subscribers []*mediaSubscription
		for _, subscriber := range publication.subscribers {
			subscriber.cancel()
			subscribers = append(subscribers, subscriber)
			if subscriber.transport != nil {
				transports = append(transports, subscriber.transport)
			}
		}
		source := publication.source
		publication.mu.Unlock()
		publication.closeErr = publication.pc.Close()
		for _, transport := range transports {
			_ = transport.PC.Close()
		}
		for _, subscriber := range subscribers {
			publication.closeErr = errors.Join(publication.closeErr, publication.closeSubscriber(subscriber))
		}
		if source != nil {
			source.Close()
		}
		publication.prepares.Wait()
		publication.readers.Wait()
		<-publication.demandDone
	})
	return publication.closeErr
}

func (media *Media) Close() error {
	media.closeOnce.Do(func() {
		media.mu.Lock()
		media.closed = true
		publications := media.publications
		media.publications = nil
		media.mu.Unlock()
		for _, publication := range publications {
			media.closeErr = errors.Join(media.closeErr, publication.close())
		}
	})
	return media.closeErr
}
