package share

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"zviewer/backend/internal/share/sfu"

	"github.com/pion/webrtc/v4"
)

// sfuSubscribeTimeout 是一次中继订阅的等待上限。
//
// 订阅要等房主的上行真的送出第一帧（SFU 侧 OnTrack），房主采集慢或选择器
// 停留久了就会等很久。20s 与前端首连超时同量级，超过就当这条边失败。
const sfuSubscribeTimeout = 20 * time.Second

// sfuPayloadDescription 是 `kind=description` 的载荷。
//
// 房主的第一次 offer 必须带 `media`（编码与分层的声明），观众只带 description。
type sfuPayloadDescription struct {
	Description webrtc.SessionDescription `json:"description"`
	Media       *sfuPayloadMedia          `json:"media,omitempty"`
}

// sfuPayloadMedia 是房主对上行媒体的声明。
type sfuPayloadMedia struct {
	Codec        string             `json:"codec"`
	RIDs         []string           `json:"rids"`
	Formats      []sfuPayloadFormat `json:"formats"`
	Audio        bool               `json:"audio"`
	AudioBitrate int                `json:"audioBitrate"`
}

// sfuPayloadFormat 是一层的尺寸与码率。
type sfuPayloadFormat struct {
	Width   int `json:"width"`
	Height  int `json:"height"`
	Bitrate int `json:"bitrate"`
}

// toMetadata 把线上声明转成媒体层的元数据。
func (media sfuPayloadMedia) toMetadata() sfu.PublicationMedia {
	formats := make([]sfu.LayerFormat, 0, len(media.Formats))
	for _, format := range media.Formats {
		if format.Width < 0 || format.Height < 0 || format.Bitrate < 0 {
			// 负数在协议层就该被拒；这里再兜一次，避免转成巨大的 uint32。
			return sfu.PublicationMedia{}
		}
		formats = append(formats, sfu.LayerFormat{
			Width:   uint32(format.Width),
			Height:  uint32(format.Height),
			Bitrate: uint32(format.Bitrate),
		})
	}
	bitrate := 0
	if media.AudioBitrate > 0 {
		bitrate = media.AudioBitrate
	}
	return sfu.PublicationMedia{
		Codec:        media.Codec,
		RIDs:         media.RIDs,
		Formats:      formats,
		Audio:        media.Audio,
		AudioBitrate: uint32(bitrate),
	}
}

// RelayDeps 是装配中继需要的东西。
type RelayDeps struct {
	// Settings 是媒体端的 SettingEngine（含 UDP/TCP mux）。
	// Relay 用它创建自己的 Media 并把事件直接接到自己身上。
	Settings webrtc.SettingEngine
	// Media 可绕过 Settings 直接注入（测试用）。
	Media     *sfu.Media
	Admission *sfu.Admission
	// Emit 把消息推给某条连接（走 Hub.EmitTo）。
	Emit   func(socketID string, message ServerMessage)
	Logger *log.Logger
}

// Relay 把「房间里的共享代际」映射到「媒体层的发布与订阅」。
//
// 它**不**做权限判定：谁能发 start、谁的 connectionId 有效，全部由 Service
// 先用会话状态校验；这里只保证「已经授权的物理资源」不被伪造的身份取用。
type Relay struct {
	media     *sfu.Media
	admission *sfu.Admission
	emit      func(socketID string, message ServerMessage)
	routeFail func(roomID, viewerPeerID, connectionID string)
	logger    *log.Logger

	mu sync.Mutex
	// publications 以 roomID 为键：一个房间同一时刻只有一位房主在共享。
	publications map[string]*relayPublication
}

type relayPublication struct {
	fence    sfu.PublicationFence
	hostID   string
	prepared bool
	subs     map[string]*relaySubscription
	closed   bool
}

type relaySubscription struct {
	viewerPeerID string
	connectionID string
	cancel       context.CancelFunc
}

// NewRelay 构造中继面。
//
// 它自己持有 sfu.Media：媒体事件必须回到这里（候选要转给对端、失败要交回
// 控制面），而控制面的 Service 又要依赖 Relay——先建 Media 再接事件会绕成
// 环，所以事件回调直接绑在 Relay 上。
func NewRelay(deps RelayDeps) *Relay {
	logger := deps.Logger
	if logger == nil {
		logger = log.Default()
	}
	relay := &Relay{
		admission:    deps.Admission,
		emit:         deps.Emit,
		logger:       logger,
		publications: make(map[string]*relayPublication),
	}
	if deps.Media != nil {
		relay.media = deps.Media
	} else {
		relay.media = sfu.NewMedia(sfu.MediaOptions{Settings: deps.Settings, Events: relay.OnMediaEvent})
	}
	return relay
}

// SetRouteFailed 注入「这条边彻底失败」的回调。
//
// Service 在 Relay 之后构造（它需要 Relay），所以只能后置注入。
func (r *Relay) SetRouteFailed(fn func(roomID, viewerPeerID, connectionID string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.routeFail = fn
}

// Close 释放全部媒体资源。
func (r *Relay) Close() error {
	r.mu.Lock()
	publications := r.publications
	r.publications = make(map[string]*relayPublication)
	r.mu.Unlock()
	for roomID, publication := range publications {
		r.mu.Lock()
		r.releaseLocked(roomID, publication)
		r.mu.Unlock()
	}
	return r.media.Close()
}

// BindPublication 为一次共享代际准备发布身份。
//
// 只铸身份、占容量：真正的 PreparePublication 要等房主声明编码与分层
// （第一帧 offer 的 media 载荷），提前建 PC 没有任何可用的编码参数。
func (r *Relay) BindPublication(roomID, generation, hostSocketID string) (SFUConfigMessage, error) {
	fence := sfu.PublicationFence{
		RoomID:                roomID,
		ShareGeneration:       generation,
		PublicationGeneration: sfu.NewPublicationGeneration(),
	}
	if !fence.Valid() {
		return SFUConfigMessage{}, errors.New("share relay: publication identity is invalid")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.publications[roomID]; existing != nil && !existing.closed {
		// 同一房间重复 start 会走到这里；旧发布必须先退役，否则容量永久泄漏。
		r.releaseLocked(roomID, existing)
	}
	if r.admission != nil && !r.admission.ReservePublication(fence) {
		return SFUConfigMessage{}, errors.New("share relay: publication capacity is exhausted")
	}
	r.publications[roomID] = &relayPublication{
		fence:  fence,
		hostID: hostSocketID,
		subs:   make(map[string]*relaySubscription),
	}
	return SFUConfigMessage{
		T:                     TypeSFUConfig,
		RoomID:                roomID,
		PublicationGeneration: fence.PublicationGeneration,
		ConnectionID:          fence.PublicationGeneration,
	}, nil
}

// HostSocketID 返回该房间发布者的连接 id（没有发布时为空）。
func (r *Relay) HostSocketID(roomID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	publication := r.publications[roomID]
	if publication == nil || publication.closed {
		return ""
	}
	return publication.hostID
}

// CloseViewerSubscriptions 关掉某位观众在该房间的全部下行。
func (r *Relay) CloseViewerSubscriptions(roomID, viewerPeerID string) {
	r.mu.Lock()
	publication := r.publications[roomID]
	if publication == nil || publication.closed {
		r.mu.Unlock()
		return
	}
	subscription := publication.subs[viewerPeerID]
	r.mu.Unlock()
	if subscription == nil {
		return
	}
	r.CloseSubscription(roomID, viewerPeerID, subscription.connectionID)
}

// Publication 返回某房间当前的发布身份（没有则 ok=false）。
func (r *Relay) Publication(roomID string) (sfu.PublicationFence, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	publication := r.publications[roomID]
	if publication == nil || publication.closed {
		return sfu.PublicationFence{}, false
	}
	return publication.fence, true
}

// HostSignal 处理房主的 description / media / candidate。
//
// 返回要回给房主的消息（answer 或错误由调用方决定），以及是否需要继续处理。
func (r *Relay) HostSignal(roomID, hostSocketID string, message SFUSignalMessage) {
	publication, ok := r.publication(roomID, hostSocketID)
	if !ok {
		return
	}
	switch message.Kind {
	case "media":
		r.applyMedia(publication, message)
	case "description":
		r.acceptPublisherOffer(publication, message)
	case "candidate":
		var candidate webrtc.ICECandidateInit
		if err := json.Unmarshal(message.Payload, &candidate); err != nil {
			return
		}
		_ = r.media.AddPublisherICE(publication.fence, publication.fence.PublicationGeneration, candidate)
	default:
		// layers / subscribe 由房主发出来都是协议越界，静默丢弃。
	}
}

// applyMedia 处理房主单独声明的媒体参数。
func (r *Relay) applyMedia(publication *relayPublication, message SFUSignalMessage) {
	var payload sfuPayloadMedia
	if err := json.Unmarshal(message.Payload, &payload); err != nil {
		return
	}
	metadata := payload.toMetadata()
	if r.isPrepared(publication) {
		_ = r.media.UpdatePublication(publication.fence, publication.fence.PublicationGeneration, metadata)
		return
	}
	r.prepare(publication, metadata)
}

// acceptPublisherOffer 收下房主的 offer 并回 answer。
func (r *Relay) acceptPublisherOffer(publication *relayPublication, message SFUSignalMessage) {
	var payload sfuPayloadDescription
	if err := json.Unmarshal(message.Payload, &payload); err != nil {
		return
	}
	if payload.Description.Type != webrtc.SDPTypeOffer {
		return
	}
	if !r.isPrepared(publication) {
		if payload.Media == nil || !r.prepare(publication, payload.Media.toMetadata()) {
			return
		}
	}
	answer, err := r.media.AcceptPublisherOffer(
		publication.fence, publication.fence.PublicationGeneration, payload.Description)
	if err != nil {
		r.logger.Printf("[share] 中继发布端 offer 被拒 room=%s err=%v", publication.fence.RoomID, err)
		return
	}
	r.send(publication.hostID, SFUSignalMessage{
		T:                     TypeSFUSignal,
		RoomID:                publication.fence.RoomID,
		PublicationGeneration: publication.fence.PublicationGeneration,
		ConnectionID:          publication.fence.PublicationGeneration,
		Kind:                  "description",
		Payload:               mustJSON(sfuPayloadDescription{Description: answer}),
	})
}

// prepare 建立发布端的物理资源。
func (r *Relay) prepare(publication *relayPublication, metadata sfu.PublicationMedia) bool {
	if err := r.media.PreparePublication(
		publication.fence, publication.fence.PublicationGeneration, metadata); err != nil {
		r.logger.Printf("[share] 中继发布准备失败 room=%s err=%v", publication.fence.RoomID, err)
		return false
	}
	r.mu.Lock()
	if current := r.publications[publication.fence.RoomID]; current == publication {
		publication.prepared = true
	}
	r.mu.Unlock()
	return true
}

func (r *Relay) isPrepared(publication *relayPublication) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return publication.prepared && !publication.closed
}

// OpenSubscription 为一位观众准备下行。
//
// 阻塞在「房主的第一帧」上，所以异步跑：调用方（Service）已经校验过
// 「这条 connectionId 属于该观众」。
func (r *Relay) OpenSubscription(roomID, viewerPeerID, connectionID string) {
	publication, ok := r.publication(roomID, "")
	if !ok {
		return
	}
	r.mu.Lock()
	if _, exists := publication.subs[viewerPeerID]; exists {
		r.mu.Unlock()
		return
	}
	if r.admission != nil && !r.admission.ReserveSubscription(sfu.SubscriptionFence{
		PublicationFence: publication.fence, ViewerPeerID: viewerPeerID, ConnectionID: connectionID,
	}) {
		r.mu.Unlock()
		r.logger.Printf("[share] 中继下行容量已满 room=%s viewer=%s", roomID, viewerPeerID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), sfuSubscribeTimeout)
	publication.subs[viewerPeerID] = &relaySubscription{
		viewerPeerID: viewerPeerID, connectionID: connectionID, cancel: cancel,
	}
	r.mu.Unlock()

	fence := sfu.SubscriptionFence{
		PublicationFence: publication.fence, ViewerPeerID: viewerPeerID, ConnectionID: connectionID,
	}
	go func() {
		defer cancel()
		offer, err := r.media.PrepareSubscriber(ctx, fence, connectionID)
		if err != nil {
			r.logger.Printf("[share] 中继订阅准备失败 room=%s viewer=%s err=%v", roomID, viewerPeerID, err)
			r.CloseSubscription(roomID, viewerPeerID, connectionID)
			r.failRoute(roomID, viewerPeerID, connectionID)
			return
		}
		r.send(viewerPeerID, SFUSignalMessage{
			T:                     TypeSFUSignal,
			RoomID:                roomID,
			PublicationGeneration: publication.fence.PublicationGeneration,
			ConnectionID:          connectionID,
			Kind:                  "description",
			Payload:               mustJSON(sfuPayloadDescription{Description: offer}),
		})
	}()
}

// ViewerSignal 处理观众的 answer / candidate。
func (r *Relay) ViewerSignal(roomID, viewerPeerID, connectionID string, message SFUSignalMessage) {
	publication, ok := r.publication(roomID, "")
	if !ok {
		return
	}
	fence := sfu.SubscriptionFence{
		PublicationFence: publication.fence, ViewerPeerID: viewerPeerID, ConnectionID: connectionID,
	}
	switch message.Kind {
	case "description":
		var payload sfuPayloadDescription
		if err := json.Unmarshal(message.Payload, &payload); err != nil {
			return
		}
		if payload.Description.Type != webrtc.SDPTypeAnswer {
			return
		}
		if err := r.media.ApplySubscriberAnswer(fence, connectionID, payload.Description); err != nil {
			r.logger.Printf("[share] 中继订阅 answer 被拒 room=%s viewer=%s err=%v", roomID, viewerPeerID, err)
		}
	case "candidate":
		var candidate webrtc.ICECandidateInit
		if err := json.Unmarshal(message.Payload, &candidate); err != nil {
			return
		}
		_ = r.media.AddSubscriberICE(fence, connectionID, candidate)
	}
}

// Restart 让中继侧重启一条订阅（ICE restart），返回新 offer。
func (r *Relay) Restart(roomID, viewerPeerID, connectionID string) {
	publication, ok := r.publication(roomID, "")
	if !ok {
		return
	}
	fence := sfu.SubscriptionFence{
		PublicationFence: publication.fence, ViewerPeerID: viewerPeerID, ConnectionID: connectionID,
	}
	offer, err := r.media.RestartSubscriber(fence, connectionID)
	if err != nil {
		r.CloseSubscription(roomID, viewerPeerID, connectionID)
		r.failRoute(roomID, viewerPeerID, connectionID)
		return
	}
	r.send(viewerPeerID, SFUSignalMessage{
		T:                     TypeSFUSignal,
		RoomID:                roomID,
		PublicationGeneration: publication.fence.PublicationGeneration,
		ConnectionID:          connectionID,
		Kind:                  "description",
		Payload:               mustJSON(sfuPayloadDescription{Description: offer}),
	})
}

// CloseSubscription 释放一条下行。
func (r *Relay) CloseSubscription(roomID, viewerPeerID, connectionID string) {
	r.mu.Lock()
	publication := r.publications[roomID]
	if publication == nil || publication.closed {
		r.mu.Unlock()
		return
	}
	subscription := publication.subs[viewerPeerID]
	if subscription == nil || subscription.connectionID != connectionID {
		r.mu.Unlock()
		return
	}
	delete(publication.subs, viewerPeerID)
	fence := sfu.SubscriptionFence{
		PublicationFence: publication.fence, ViewerPeerID: viewerPeerID, ConnectionID: connectionID,
	}
	r.mu.Unlock()
	if subscription.cancel != nil {
		subscription.cancel()
	}
	_ = r.media.CloseSubscription(fence, connectionID)
	if r.admission != nil {
		r.admission.BeginSubscriptionDrain(fence)
		r.admission.CompleteSubscriptionDrain(fence)
	}
}

// ReleaseRoom 退役整个房间的发布（房主停止共享或离开）。
func (r *Relay) ReleaseRoom(roomID string) {
	r.mu.Lock()
	publication := r.publications[roomID]
	if publication == nil {
		r.mu.Unlock()
		return
	}
	r.releaseLocked(roomID, publication)
	r.mu.Unlock()
}

// releaseLocked 必须有 r.mu 才能调用。
func (r *Relay) releaseLocked(roomID string, publication *relayPublication) {
	publication.closed = true
	delete(r.publications, roomID)
	subscriptions := make([]*relaySubscription, 0, len(publication.subs))
	for viewerPeerID, subscription := range publication.subs {
		if subscription.cancel != nil {
			subscription.cancel()
		}
		_ = r.media.CloseSubscription(sfu.SubscriptionFence{
			PublicationFence: publication.fence,
			ViewerPeerID:     viewerPeerID,
			ConnectionID:     subscription.connectionID,
		}, subscription.connectionID)
		subscriptions = append(subscriptions, subscription)
	}
	publication.subs = make(map[string]*relaySubscription)
	_ = r.media.ClosePublication(publication.fence)
	if r.admission != nil {
		for _, subscription := range subscriptions {
			fence := sfu.SubscriptionFence{
				PublicationFence: publication.fence,
				ViewerPeerID:     subscription.viewerPeerID,
				ConnectionID:     subscription.connectionID,
			}
			r.admission.BeginSubscriptionDrain(fence)
			r.admission.CompleteSubscriptionDrain(fence)
		}
		r.admission.BeginDrain(publication.fence)
		r.admission.CompleteDrain(publication.fence)
	}
}

// OnMediaEvent 处理媒体层的事件：候选原样转给对端，失败交给控制面换候选。
func (r *Relay) OnMediaEvent(event sfu.MediaEvent) {
	if event.Candidate != nil {
		r.forwardCandidate(event)
	}
	if event.ActiveCount != nil {
		r.forwardDemand(event)
	}
	if event.State == webrtc.PeerConnectionStateFailed {
		r.handleFailure(event)
	}
}

func (r *Relay) forwardCandidate(event sfu.MediaEvent) {
	r.mu.Lock()
	publication := r.publications[event.Fence.RoomID]
	if publication == nil || publication.closed || publication.fence != event.Fence {
		r.mu.Unlock()
		return
	}
	target := publication.hostID
	if event.ViewerPeerID != "" {
		subscription := publication.subs[event.ViewerPeerID]
		if subscription == nil || subscription.connectionID != event.ConnectionID {
			r.mu.Unlock()
			return
		}
		target = event.ViewerPeerID
	}
	fence := publication.fence
	r.mu.Unlock()
	// 发布端（房主）的媒体事件不带 ConnectionID：协议里房主的 connectionId
	// 与 publicationGeneration 是同一个值，这里补齐，否则客户端会按「不是
	// 我的连接」把候选丢光，ICE 永远凑不齐配对。
	connectionID := event.ConnectionID
	if connectionID == "" {
		connectionID = fence.PublicationGeneration
	}
	r.send(target, SFUSignalMessage{
		T:                     TypeSFUSignal,
		RoomID:                fence.RoomID,
		PublicationGeneration: fence.PublicationGeneration,
		ConnectionID:          connectionID,
		Kind:                  "candidate",
		Payload:               mustJSON(*event.Candidate),
	})
}

func (r *Relay) forwardDemand(event sfu.MediaEvent) {
	r.mu.Lock()
	publication := r.publications[event.Fence.RoomID]
	if publication == nil || publication.closed || publication.fence != event.Fence {
		r.mu.Unlock()
		return
	}
	hostID := publication.hostID
	fence := publication.fence
	r.mu.Unlock()
	count := *event.ActiveCount
	r.send(hostID, SFUSignalMessage{
		T:                     TypeSFUSignal,
		RoomID:                fence.RoomID,
		PublicationGeneration: fence.PublicationGeneration,
		ConnectionID:          fence.PublicationGeneration,
		Kind:                  "layers",
		ActiveCount:           &count,
	})
}

func (r *Relay) handleFailure(event sfu.MediaEvent) {
	r.mu.Lock()
	publication := r.publications[event.Fence.RoomID]
	if publication == nil || publication.closed || publication.fence != event.Fence {
		r.mu.Unlock()
		return
	}
	if event.ViewerPeerID == "" {
		// 房主上行断了：整条中继都没有意义，交给控制面当作房主侧失败处理。
		r.mu.Unlock()
		r.failRoute(event.Fence.RoomID, "", "")
		return
	}
	subscription := publication.subs[event.ViewerPeerID]
	matches := subscription != nil && subscription.connectionID == event.ConnectionID
	r.mu.Unlock()
	if matches {
		r.failRoute(event.Fence.RoomID, event.ViewerPeerID, event.ConnectionID)
	}
}

// publication 返回某房间的发布。hostID 非空时要求房主身份一致。
func (r *Relay) publication(roomID, hostSocketID string) (*relayPublication, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	publication := r.publications[roomID]
	if publication == nil || publication.closed {
		return nil, false
	}
	if hostSocketID != "" && publication.hostID != hostSocketID {
		return nil, false
	}
	return publication, true
}

// failRoute 把失败交回控制面（回调可为空：单测里没有控制面）。
func (r *Relay) failRoute(roomID, viewerPeerID, connectionID string) {
	r.mu.Lock()
	fn := r.routeFail
	r.mu.Unlock()
	if fn != nil {
		fn(roomID, viewerPeerID, connectionID)
	}
}

func (r *Relay) send(socketID string, message SFUSignalMessage) {
	if r.emit == nil || socketID == "" {
		return
	}
	r.emit(socketID, message)
}

// mustJSON 把载荷序列化。序列化失败时返回 nil——协议层会把缺 payload 的消息拒掉，
// 这比把半个对象发出去安全。
func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}
