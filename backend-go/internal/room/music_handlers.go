package room

import (
	"context"
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// 一起听（listen-together）的 11 个上行事件。
//
// 事件契约与前端 `modules/music/hooks/useListenTogether.ts` 完全对齐，
// 字段名一律不可改动：
//   - music:queue-upsert    房主/房管加歌（append 尾部；afterCurrent 插当前曲目之后）
//   - music:queue-remove    删除条目（order 压实为 1..n）
//   - music:queue-reorder   拖拽排序（ids 必须与队列多重集一致）
//   - music:queue-clear     清空队列
//   - music:queue-changed   下行广播（完整队列，按 order 升序）
//   - music:sync-state      房主广播状态 → 写基线 → socket.to(room) 转发
//   - music:host-heartbeat  房主 2s 心跳 → 合并基线（10s 节流落盘）→ 转发
//   - music:check-status    观众 10s 自检（±10s 容差）→ ack 权威状态
//   - music:control-request 观众申请控制 → 只转给房主
//   - music:control-response 房主应答 → 定向转给申请者
//   - music:sync-ack        观众切歌回执 → 只转给房主
//   - music:get-state       查询队列 + 最新状态（ack 附 serverTs / hostOnline）
//
// 权限模型复刻一起看：房主控制、观众观看、房管可管队列、观众控制需申请。

// musicControlActions 是合法的控制申请动作（与前端 MusicControlRequest 对齐）。
//
// addQueue = 申请加歌（带 item 载荷，房主端按「自动通过」开关决定代理入队）；
// seek = 申请调进度（带 positionSec，自动通过时房主端直接执行并应答）；
// playItem = 申请切到队列某条（带 item 载荷，房主端按 key 匹配后代理切歌）。
var musicControlActions = map[string]struct{}{
	"pause": {}, "play": {}, "next": {}, "prev": {},
	"addQueue": {}, "seek": {}, "playItem": {},
}

// musicQueueItemPayload 是队列条目的广播结构（addedBy 已解析成用户名）。
//
// biliBvid / biliCid 用指针 + omitempty：非 B站 条目在 Node 里是
// `undefined`（JSON 里整键消失），下发 null 会让前端 `item.biliCid ?? 0`
// 之外的判断多一种形态。recommended 恒存在（true/false）。
type musicQueueItemPayload struct {
	ID          int64   `json:"id"`
	RoomID      string  `json:"roomId"`
	SongID      int64   `json:"songId"`
	Name        string  `json:"name"`
	Artist      string  `json:"artist"`
	Album       string  `json:"album"`
	Cover       string  `json:"cover"`
	DurationMs  int64   `json:"durationMs"`
	VIP         bool    `json:"vip"`
	Order       int64   `json:"order"`
	AddedBy     string  `json:"addedBy"`
	BiliBvid    *string `json:"biliBvid,omitempty"`
	BiliCid     *int64  `json:"biliCid,omitempty"`
	Recommended bool    `json:"recommended"`
}

// musicQueueChangedPayload 是 music:queue-changed 的载荷。
type musicQueueChangedPayload struct {
	RoomID string                  `json:"roomId"`
	Items  []musicQueueItemPayload `json:"items"`
}

// musicGetStateOK 是 music:get-state 的成功应答。
//
// **不能用 AckResponse**：它的 Data 带 omitempty，而 get-state 是把
// queue / syncState / serverTs / hostOnline 直接摊在顶层，且 syncState
// 为 null 时键必须存在（前端据此区分「没在播」与「旧后端」）。
type musicGetStateOK struct {
	Success    bool                    `json:"success"`
	Queue      []musicQueueItemPayload `json:"queue"`
	SyncState  *MusicSyncState         `json:"syncState"`
	ServerTs   int64                   `json:"serverTs"`
	HostOnline bool                    `json:"hostOnline"`
}

// musicCheckStatusData 是 music:check-status 的 data 载荷。
type musicCheckStatusData struct {
	NeedsSync bool            `json:"needsSync"`
	ServerTs  int64           `json:"serverTs"`
	State     *MusicSyncState `json:"state,omitempty"`
}

// musicCheckStatusAck 是 music:check-status 的应答（成功包 data）。
type musicCheckStatusAck struct {
	Success bool                  `json:"success"`
	Message string                `json:"message,omitempty"`
	Data    *musicCheckStatusData `json:"data,omitempty"`
}

// musicUpsertItem 是 queue-upsert / control-request 携带的歌曲元数据。
//
// 用指针区分「缺失」与「零值」：Node 的 isUpsertItemValid 要求
// durationMs 是 number、vip 是 boolean，缺任何一个都判「歌曲信息不完整」；
// 若用值类型，缺失会静默变成 0/false 而被放行。
type musicUpsertItem struct {
	SongID      *int64   `json:"songId"`
	Name        *string  `json:"name"`
	Artist      *string  `json:"artist"`
	Album       *string  `json:"album"`
	Cover       *string  `json:"cover"`
	DurationMs  *float64 `json:"durationMs"`
	VIP         *bool    `json:"vip"`
	BiliBvid    *string  `json:"biliBvid"`
	BiliCid     *int64   `json:"biliCid"`
	Recommended *bool    `json:"recommended"`
}

// musicBvidPattern 是 B站 BV 号（与 Node 的 /^BV[0-9A-Za-z]{10}$/ 一致）。
var musicBvidPattern = regexp.MustCompile(`^BV[0-9A-Za-z]{10}$`)

// musicDigitsPattern 用于校验 sourceId 的后半段（cid）。
var musicDigitsPattern = regexp.MustCompile(`^\d+$`)

// valid 判断歌曲元数据是否完整。
//
// 网易云条目要求 songId 为正整数；B站 条目（biliBvid 合法）改为要求
// biliCid 为正整数且 songId 可以是 0。两条路径都要通过 common 校验。
func (it *musicUpsertItem) valid() bool {
	if it == nil || it.Name == nil || *it.Name == "" || it.Artist == nil ||
		it.Album == nil || it.DurationMs == nil || it.VIP == nil {
		return false
	}
	if math.IsNaN(*it.DurationMs) || math.IsInf(*it.DurationMs, 0) || *it.DurationMs < 0 {
		return false
	}
	if it.BiliBvid != nil && musicBvidPattern.MatchString(*it.BiliBvid) {
		return it.BiliCid != nil && *it.BiliCid > 0
	}
	return it.SongID != nil && *it.SongID > 0
}

// biliSourceID 返回 B站 条目的 sourceId（"bvid:cid"）；非 B站 返回空串。
func (it *musicUpsertItem) biliSourceID() string {
	if it == nil || it.BiliBvid == nil || !musicBvidPattern.MatchString(*it.BiliBvid) {
		return ""
	}
	cid := int64(0)
	if it.BiliCid != nil {
		cid = *it.BiliCid
	}
	return *it.BiliBvid + ":" + strconv.FormatInt(cid, 10)
}

// ===========================================================================
// 事件注册
// ===========================================================================

// bindMusic 注册一起听的全部事件。
func (s *Service) bindMusic(sc *sio.Socket) {
	sc.On("music:queue-upsert", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicQueueUpsert(sc, args, ack)
	})
	sc.On("music:queue-remove", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicQueueRemove(sc, args, ack)
	})
	sc.On("music:queue-clear", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicQueueClear(sc, args, ack)
	})
	sc.On("music:queue-reorder", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicQueueReorder(sc, args, ack)
	})
	sc.On("music:sync-state", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicSyncState(sc, args, ack)
	})
	sc.On("music:host-heartbeat", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicHostHeartbeat(sc, args, ack)
	})
	sc.On("music:check-status", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicCheckStatus(sc, args, ack)
	})
	sc.On("music:control-request", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicControlRequest(sc, args, ack)
	})
	sc.On("music:control-response", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicControlResponse(sc, args, ack)
	})
	sc.On("music:sync-ack", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicSyncAck(sc, args, ack)
	})
	sc.On("music:get-state", func(args []json.RawMessage, ack func(...any)) {
		s.handleMusicGetState(sc, args, ack)
	})
}

// ===========================================================================
// 队列读取与广播
// ===========================================================================

// musicLoadQueue 读取房间完整队列（按 order 升序），顺手清掉失效条目。
//
// 塞壬支持已移除：songId<=0 且非 B站 的历史行直接删掉且不返回。
func (s *Service) musicLoadQueue(ctx context.Context, roomID string) ([]*store.MusicQueueItem, error) {
	items, err := s.MusicQueue.ListByRoom(ctx, roomID)
	if err != nil {
		return nil, err
	}
	stale := make([]int64, 0, 4)
	kept := make([]*store.MusicQueueItem, 0, len(items))
	for _, it := range items {
		if it.SongID <= 0 && it.Source != "bili" {
			stale = append(stale, it.ID)
			continue
		}
		kept = append(kept, it)
	}
	if len(stale) > 0 {
		if err := s.MusicQueue.DeleteStale(ctx, stale); err != nil {
			s.Logger.Printf("[music] 清理失效队列条目失败 room=%s: %v", roomID, err)
		}
	}
	return kept, nil
}

// musicQueuePayload 构建广播队列（实体 → 前端契约；addedBy 解析为用户名）。
func (s *Service) musicQueuePayload(ctx context.Context, roomID string) ([]musicQueueItemPayload, error) {
	items, err := s.musicLoadQueue(ctx, roomID)
	if err != nil {
		return nil, err
	}

	// 批量解析用户名：队列十几条时逐条查库就是十几次往返。
	ids := make([]int64, 0, len(items))
	seen := make(map[int64]struct{}, len(items))
	for _, it := range items {
		if it.AddedBy <= 0 {
			continue
		}
		if _, ok := seen[it.AddedBy]; ok {
			continue
		}
		seen[it.AddedBy] = struct{}{}
		ids = append(ids, it.AddedBy)
	}
	names := map[int64]string{}
	if len(ids) > 0 && s.Users != nil {
		got, err := s.Users.UsernamesByIDs(ctx, ids)
		if err != nil {
			// 解析失败不阻断队列下发：回退文案比「整个队列拿不到」好。
			s.Logger.Printf("[music] 解析添加者用户名失败 room=%s: %v", roomID, err)
		} else {
			names = got
		}
	}

	out := make([]musicQueueItemPayload, 0, len(items))
	for _, it := range items {
		// 游客（0）固定「游客」；查不到的用户回退「用户#<id>」。
		addedBy := "游客"
		if it.AddedBy > 0 {
			if name, ok := names[it.AddedBy]; ok {
				addedBy = name
			} else {
				addedBy = "用户#" + strconv.FormatInt(it.AddedBy, 10)
			}
		}

		row := musicQueueItemPayload{
			ID:          it.ID,
			RoomID:      it.RoomID,
			SongID:      it.SongID,
			Name:        it.Name,
			Artist:      it.Artist,
			Album:       it.Album,
			Cover:       derefString(it.Cover),
			DurationMs:  it.DurationMs,
			VIP:         it.VIP,
			Order:       it.Order,
			AddedBy:     addedBy,
			Recommended: it.Recommended,
		}
		if it.Source == "bili" {
			bvid, cidStr := splitBiliSourceID(it.SourceID)
			row.BiliBvid = &bvid
			if musicDigitsPattern.MatchString(cidStr) {
				if cid, err := strconv.ParseInt(cidStr, 10, 64); err == nil {
					row.BiliCid = &cid
				}
			}
		}
		out = append(out, row)
	}
	return out, nil
}

// splitBiliSourceID 拆 "bvid:cid"。缺冒号时 cid 为空串（与 JS 解构一致）。
func splitBiliSourceID(sourceID *string) (string, string) {
	raw := derefString(sourceID)
	idx := strings.Index(raw, ":")
	if idx < 0 {
		return raw, ""
	}
	return raw[:idx], raw[idx+1:]
}

// musicBroadcastQueue 全房间广播完整队列。
func (s *Service) musicBroadcastQueue(ctx context.Context, roomID string) {
	items, err := s.musicQueuePayload(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music] 构建队列失败 room=%s: %v", roomID, err)
		return
	}
	s.Hub.EmitRoom(roomID, "music:queue-changed", musicQueueChangedPayload{
		RoomID: roomID,
		Items:  items,
	})
}

// ===========================================================================
// 队列管理（房主 / 房管）
// ===========================================================================

// musicRoomID 从 payload 取 roomId 并校验「非空字符串 + 在该房间」。
// 失败时已 ack，返回空串。
func (s *Service) musicRoomID(sc *sio.Socket, raw map[string]json.RawMessage, ack func(...any)) string {
	roomID, ok := jsonStringField(raw, "roomId")
	if !ok || roomID == "" || !sc.InRoom(roomID) {
		ackFail(ack, "不在该房间中")
		return ""
	}
	return roomID
}

func (s *Service) handleMusicQueueUpsert(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	if !s.canPerform(ctx, ack, sc, roomID, "musicQueue", "无权限：没有队列管理权限") {
		return
	}

	var payload struct {
		Item         *musicUpsertItem `json:"item"`
		AfterCurrent bool             `json:"afterCurrent"`
	}
	if len(args) == 0 || json.Unmarshal(args[0], &payload) != nil || !payload.Item.valid() {
		ackFail(ack, "歌曲信息不完整")
		return
	}
	item := payload.Item

	items, err := s.musicLoadQueue(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music:queue-upsert] 读取队列失败: %v", err)
		ackFail(ack, "添加歌曲失败")
		return
	}

	// 默认追加到队尾。afterCurrent 时按房间最新基线定位当前曲目，插到它后面。
	order := int64(1)
	if len(items) > 0 {
		order = items[len(items)-1].Order + 1
	}
	insertAfter := -1
	if payload.AfterCurrent {
		state, err := s.Music.GetRawState(ctx, roomID)
		if err != nil {
			s.Logger.Printf("[music:queue-upsert] 读取基线失败: %v", err)
		}
		insertAfter = musicFindCurrentIndex(items, state)
	}
	if insertAfter >= 0 {
		// 新条目位次 = 当前条目 order+1；右移从当前条目的**下一个**开始。
		//
		// 从当前条目自身开始右移会让它与新条目 order 相同，连续插入时整批
		// order 全部平局，队列排序退化成 rowid 随机序——表现就是「点下一首
		// 跳到推荐批次里的任意一首」。前端连续插入是倒序逐条调用的
		// （fresh.reverse()），修正后每条都精确落在当前条目之后一位。
		moved := make([]store.MusicOrderPair, 0, len(items)-insertAfter)
		for i := insertAfter + 1; i < len(items); i++ {
			items[i].Order++
			moved = append(moved, store.MusicOrderPair{ID: items[i].ID, Order: items[i].Order})
		}
		if err := s.MusicQueue.SetOrders(ctx, moved); err != nil {
			s.Logger.Printf("[music:queue-upsert] 右移位次失败: %v", err)
			ackFail(ack, "添加歌曲失败")
			return
		}
		order = items[insertAfter].Order + 1
	}

	row := &store.MusicQueueItem{
		RoomID:     roomID,
		Source:     "ncm",
		Name:       derefString(item.Name),
		Artist:     derefString(item.Artist),
		Album:      derefString(item.Album),
		Cover:      item.Cover,
		DurationMs: int64(math.Round(derefFloat(item.DurationMs))),
		VIP:        item.VIP != nil && *item.VIP,
		Order:      order,
		AddedBy:    0,
		// recommended 用 `=== true` 语义：只有显式 true 才算推荐条目。
		Recommended: item.Recommended != nil && *item.Recommended,
	}
	if item.SongID != nil {
		row.SongID = *item.SongID
	}
	if uid := socketUserID(sc); uid != nil {
		row.AddedBy = *uid
	}
	if sourceID := item.biliSourceID(); sourceID != "" {
		row.Source = "bili"
		row.SourceID = &sourceID
	}

	if _, err := s.MusicQueue.Insert(ctx, row); err != nil {
		s.Logger.Printf("[music:queue-upsert] 写入失败: %v", err)
		ackFail(ack, "添加歌曲失败")
		return
	}

	s.musicBroadcastQueue(ctx, roomID)
	ackOK(ack, nil)
}

// musicFindCurrentIndex 按基线定位「当前播放条目」在队列中的下标（-1 = 未找到）。
//
// bili: 开头按 sourceId（"bvid:cid"）匹配；否则优先 trackSongId，
// 缺失时再从 `ncm:<songId>` 反解。
func musicFindCurrentIndex(items []*store.MusicQueueItem, state *MusicSyncState) int {
	if state == nil {
		return -1
	}
	key := derefString(state.TrackKey)
	if strings.HasPrefix(key, "bili:") {
		sourceID := key[5:]
		for i, it := range items {
			if it.Source == "bili" && derefString(it.SourceID) == sourceID {
				return i
			}
		}
		return -1
	}
	var songID *int64
	if state.TrackSongID != nil {
		songID = state.TrackSongID
	} else if strings.HasPrefix(key, "ncm:") {
		if v, err := strconv.ParseInt(key[4:], 10, 64); err == nil {
			songID = &v
		}
	}
	if songID == nil {
		return -1
	}
	for i, it := range items {
		if it.SongID == *songID {
			return i
		}
	}
	return -1
}

func (s *Service) handleMusicQueueRemove(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	if !s.canPerform(ctx, ack, sc, roomID, "musicQueue", "无权限：没有队列管理权限") {
		return
	}

	id, ok := jsonIntField(raw, "id")
	if !ok {
		ackFail(ack, "参数无效")
		return
	}

	// where 同时限定 id + roomId，防跨房间删除。
	affected, err := s.MusicQueue.Delete(ctx, roomID, id)
	if err != nil {
		s.Logger.Printf("[music:queue-remove] 删除失败: %v", err)
		ackFail(ack, "删除歌曲失败")
		return
	}
	if affected == 0 {
		ackFail(ack, "歌曲不在队列中")
		return
	}

	// order 压实：剩余条目按现有顺序重排为 1..n。
	rest, err := s.musicLoadQueue(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music:queue-remove] 读取队列失败: %v", err)
		ackFail(ack, "删除歌曲失败")
		return
	}
	pairs := make([]store.MusicOrderPair, 0, len(rest))
	for i, it := range rest {
		if it.Order != int64(i+1) {
			pairs = append(pairs, store.MusicOrderPair{ID: it.ID, Order: int64(i + 1)})
		}
	}
	if err := s.MusicQueue.SetOrders(ctx, pairs); err != nil {
		s.Logger.Printf("[music:queue-remove] 压实位次失败: %v", err)
		ackFail(ack, "删除歌曲失败")
		return
	}

	s.musicBroadcastQueue(ctx, roomID)
	ackOK(ack, nil)
}

func (s *Service) handleMusicQueueClear(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	if !s.canPerform(ctx, ack, sc, roomID, "musicQueue", "无权限：没有队列管理权限") {
		return
	}

	if err := s.MusicQueue.DeleteByRoom(ctx, roomID); err != nil {
		s.Logger.Printf("[music:queue-clear] 清空失败: %v", err)
		ackFail(ack, "清空队列失败")
		return
	}
	s.musicBroadcastQueue(ctx, roomID)
	ackOK(ack, nil)
}

func (s *Service) handleMusicQueueReorder(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	if !s.canPerform(ctx, ack, sc, roomID, "musicQueue", "无权限：没有队列管理权限") {
		return
	}

	items, err := s.musicLoadQueue(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music:queue-reorder] 读取队列失败: %v", err)
		ackFail(ack, "调整顺序失败")
		return
	}

	ids, ok := jsonIntArrayField(raw, "ids")
	if !ok || !sameIDMultiset(ids, items) {
		ackFail(ack, "排序列表与队列不一致")
		return
	}

	byID := make(map[int64]*store.MusicQueueItem, len(items))
	for _, it := range items {
		byID[it.ID] = it
	}
	pairs := make([]store.MusicOrderPair, 0, len(ids))
	for idx, id := range ids {
		if _, ok := byID[id]; !ok {
			continue
		}
		pairs = append(pairs, store.MusicOrderPair{ID: id, Order: int64(idx + 1)})
	}
	if err := s.MusicQueue.SetOrders(ctx, pairs); err != nil {
		s.Logger.Printf("[music:queue-reorder] 写入失败: %v", err)
		ackFail(ack, "调整顺序失败")
		return
	}

	s.musicBroadcastQueue(ctx, roomID)
	ackOK(ack, nil)
}

// sameIDMultiset 判断 ids 与队列的**多重集**是否完全一致。
//
// 比长度不够：重复 id 会绕过长度校验，让某些条目丢掉 order 而另一些被写两次。
func sameIDMultiset(ids []int64, items []*store.MusicQueueItem) bool {
	if len(ids) != len(items) {
		return false
	}
	a := make([]int64, len(ids))
	copy(a, ids)
	b := make([]int64, len(items))
	for i, it := range items {
		b[i] = it.ID
	}
	sort.Slice(a, func(i, j int) bool { return a[i] < a[j] })
	sort.Slice(b, func(i, j int) bool { return b[i] < b[j] })
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ===========================================================================
// 播放状态同步（房主专属）
// ===========================================================================

func (s *Service) handleMusicSyncState(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	host, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[music:sync-state] 权限判定失败: %v", err)
		ackFail(ack, "同步状态转发失败")
		return
	}
	if !host {
		ackFail(ack, "无权限：仅房主可同步播放状态")
		return
	}
	state := musicStateFromPayload(raw)
	if state == nil {
		ackFail(ack, "同步状态无效")
		return
	}

	// 写入服务器基线（写侧补偿后锚定服务器时间轴）——观众进度统一读服务器
	// 推算值（music:sync-heartbeat）的前提。clientTs 缺省则不补偿。
	if err := s.Music.SetPlayback(ctx, roomID, *state, sc.ID, jsonIntFieldOr(raw, "clientTs", 0)); err != nil {
		s.Logger.Printf("[music:sync-state] 写入基线失败: %v", err)
		ackFail(ack, "同步状态转发失败")
		return
	}

	// 转发给房间内其他成员（不含发送者）：旧前端兼容路径 + 新前端
	// 「即时操作低延迟通道」，进度权威仍在服务器心跳。
	payload := map[string]any{"roomId": roomID}
	mergeMusicState(payload, *state)
	s.Hub.EmitRoomExcept(roomID, sc.ID, "music:sync-state", payload)
	ackOK(ack, nil)
}

func (s *Service) handleMusicHostHeartbeat(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	host, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[music:host-heartbeat] 权限判定失败: %v", err)
		ackFail(ack, "心跳转发失败")
		return
	}
	if !host {
		ackFail(ack, "无权限发送心跳")
		return
	}
	state := musicStateFromPayload(raw)
	if state == nil {
		ackFail(ack, "心跳状态无效")
		return
	}

	if err := s.Music.ApplyHostHeartbeat(ctx, roomID, *state, sc.ID, jsonIntFieldOr(raw, "clientTs", 0)); err != nil {
		s.Logger.Printf("[music:host-heartbeat] 合并基线失败: %v", err)
		ackFail(ack, "心跳转发失败")
		return
	}

	payload := map[string]any{"roomId": roomID}
	mergeMusicState(payload, *state)
	s.Hub.EmitRoomExcept(roomID, sc.ID, "music:host-heartbeat", payload)
	ackOK(ack, nil)
}

// mergeMusicState 把状态字段摊进 payload（不含 roomId）。
func mergeMusicState(dst map[string]any, st MusicSyncState) {
	dst["trackSongId"] = st.TrackSongID
	dst["trackKey"] = st.TrackKey
	dst["isPlaying"] = st.IsPlaying
	dst["positionSec"] = st.PositionSec
	dst["playMode"] = st.PlayMode
	dst["updatedAt"] = st.UpdatedAt
}

func (s *Service) handleMusicCheckStatus(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}

	pos, ok := jsNumber(raw["positionSec"])
	isPlaying, okPlaying := jsonBoolField(raw, "isPlaying")
	if !ok || !okPlaying || math.IsNaN(pos) || pos < 0 {
		ackFail(ack, "自检参数无效")
		return
	}

	serverTs := nowMillis()
	serverState, err := s.Music.GetAdvancedState(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music:check-status] 读取基线失败: %v", err)
		ackFail(ack, "自检失败")
		return
	}
	if serverState == nil {
		// 房间没有基线：明确告知「无需同步」，而不是报错——
		// 观众端在房主还没开播时会每 10s 打一次这个事件。
		ackRaw(ack, musicCheckStatusAck{
			Success: true,
			Data:    &musicCheckStatusData{NeedsSync: false, ServerTs: serverTs},
		})
		return
	}

	needsSync := NeedsProgressSync(NeedsProgressSyncParams{
		ClientCurrentTime:  pos,
		ClientIsPlaying:    isPlaying,
		ClientPlaybackRate: 1,
		ClientTs:           jsonIntFieldOr(raw, "clientTs", 0),
		ServerCurrentTime:  serverState.PositionSec,
		ServerIsPlaying:    serverState.IsPlaying,
	})
	data := &musicCheckStatusData{NeedsSync: needsSync, ServerTs: serverTs}
	if needsSync {
		data.State = serverState
	}
	ackRaw(ack, musicCheckStatusAck{Success: true, Data: data})
}

// ===========================================================================
// 观众申请制控制
// ===========================================================================

func (s *Service) handleMusicControlRequest(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}

	action, ok := jsonStringField(raw, "action")
	if !ok {
		ackFail(ack, "参数无效")
		return
	}
	if _, ok := musicControlActions[action]; !ok {
		ackFail(ack, "参数无效")
		return
	}

	var payload struct {
		Item         *musicUpsertItem `json:"item"`
		AfterCurrent bool             `json:"afterCurrent"`
		PositionSec  *float64         `json:"positionSec"`
	}
	if len(args) > 0 {
		_ = json.Unmarshal(args[0], &payload)
	}

	if (action == "addQueue" || action == "playItem") && !payload.Item.valid() {
		ackFail(ack, "歌曲信息不完整")
		return
	}
	// 原样保留客户端发来的 item（透传给房主端代理入队/切歌用）。
	var rawItem json.RawMessage
	if v, ok := raw["item"]; ok && !isJSONNull(v) {
		rawItem = v
	}
	// seek：目标进度必须是非负有限数且不超过一天（防误传毫秒）。
	if action == "seek" {
		pos, ok := jsNumber(raw["positionSec"])
		if !ok || math.IsNaN(pos) || pos < 0 || pos > 86400 {
			ackFail(ack, "进度参数无效")
			return
		}
	}

	// 房主在线才可申请：房主离线时前端走自主控制，根本不发这个事件。
	sharer, err := s.Sessions.FindActiveByRoomRole(ctx, roomID, store.SessionRoleSharer)
	if err != nil {
		s.Logger.Printf("[music:control-request] 查询房主失败: %v", err)
		ackFail(ack, "申请控制失败")
		return
	}
	if sharer == nil {
		ackFail(ack, "房主不在线")
		return
	}

	// from / username 一律以服务器侧 socket 身份为准（防伪造）。
	forward := map[string]any{
		"roomId": roomID,
		"action": action,
		"from":   sc.ID,
	}
	switch action {
	case "addQueue":
		// 用原始 JSON 转发，不用解析后的结构体：结构体序列化会把
		// biliBvid / biliCid / recommended 这些没传的字段补成 null，
		// 而 Node 侧是 `{ item: payload.item }` 原样透传（键直接不存在）。
		forward["item"] = rawItem
		forward["afterCurrent"] = payload.AfterCurrent
	case "playItem":
		forward["item"] = rawItem
	case "seek":
		pos, _ := jsNumber(raw["positionSec"])
		forward["positionSec"] = pos
	}
	if name := socketUsername(sc); name != nil {
		forward["username"] = *name
	}
	s.Hub.EmitTo(sharer.SocketID, "music:control-request", forward)
	ackOK(ack, nil)
}

func (s *Service) handleMusicControlResponse(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	host, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[music:control-response] 权限判定失败: %v", err)
		ackFail(ack, "应答转发失败")
		return
	}
	if !host {
		ackFail(ack, "无权限")
		return
	}

	from, okFrom := jsonStringField(raw, "from")
	action, okAction := jsonStringField(raw, "action")
	approved, okApproved := jsonBoolField(raw, "approved")
	_, known := musicControlActions[action]
	if !okFrom || from == "" || !okAction || !known || !okApproved {
		ackFail(ack, "参数无效")
		return
	}

	// 定向发给申请者；回传 from（申请者 socketId）供其校验是发给自己的。
	s.Hub.EmitTo(from, "music:control-response", map[string]any{
		"approved": approved,
		"action":   action,
		"from":     from,
	})
	ackOK(ack, nil)
}

func (s *Service) handleMusicSyncAck(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}

	sharer, err := s.Sessions.FindActiveByRoomRole(ctx, roomID, store.SessionRoleSharer)
	if err != nil {
		s.Logger.Printf("[music:sync-ack] 查询房主失败: %v", err)
		ackFail(ack, "同步回执转发失败")
		return
	}
	if sharer == nil {
		// 房主不在线时无处转发（观众此时自主控制，通常不会回执）：静默成功。
		ackOK(ack, nil)
		return
	}

	forward := map[string]any{"roomId": roomID}
	if name := socketUsername(sc); name != nil {
		forward["username"] = *name
	}
	s.Hub.EmitTo(sharer.SocketID, "music:sync-ack", forward)
	ackOK(ack, nil)
}

// ===========================================================================
// 初始状态查询
// ===========================================================================

func (s *Service) handleMusicGetState(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}

	queue, err := s.musicQueuePayload(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music:get-state] 构建队列失败: %v", err)
		ackFail(ack, "获取队列失败")
		return
	}
	// 服务器推算后的权威状态（内存未命中读 DB——后端重启后恢复续播的关键）。
	syncState, err := s.Music.GetAdvancedState(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music:get-state] 读取基线失败: %v", err)
		ackFail(ack, "获取队列失败")
		return
	}

	hostOnline := false
	if sharer, err := s.Sessions.FindActiveByRoomRole(ctx, roomID, store.SessionRoleSharer); err == nil && sharer != nil {
		hostOnline = true
	} else if err != nil {
		s.Logger.Printf("[music:get-state] 查询房主失败: %v", err)
	}

	ackRaw(ack, musicGetStateOK{
		Success:    true,
		Queue:      queue,
		SyncState:  syncState,
		ServerTs:   nowMillis(),
		HostOnline: hostOnline,
	})
}

// ===========================================================================
// payload 解析小工具
// ===========================================================================

// firstObject 把事件第一个参数解成「键 → 原始值」。
//
// 不用结构体统一解：这些事件里既有严格字段（isPlaying 必须是布尔），
// 又有「缺了就不补偿」的可选字段（clientTs），逐键判断比两套结构体更直观。
func firstObject(args []json.RawMessage) map[string]json.RawMessage {
	if len(args) == 0 {
		return nil
	}
	trimmed := strings.TrimSpace(string(args[0]))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(args[0], &out); err != nil {
		return nil
	}
	return out
}

// jsonStringField 取字符串字段（缺失 / null / 非字符串都返回 false）。
func jsonStringField(raw map[string]json.RawMessage, key string) (string, bool) {
	v, ok := raw[key]
	if !ok || isJSONNull(v) {
		return "", false
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return "", false
	}
	return s, true
}

// jsonBoolField 取布尔字段（必须是 JSON 布尔，不认 0/1）。
func jsonBoolField(raw map[string]json.RawMessage, key string) (bool, bool) {
	v, ok := raw[key]
	if !ok || isJSONNull(v) {
		return false, false
	}
	var b bool
	if err := json.Unmarshal(v, &b); err != nil {
		return false, false
	}
	return b, true
}

// jsonIntField 取整数字段（缺失 / null / 非整数返回 false）。
func jsonIntField(raw map[string]json.RawMessage, key string) (int64, bool) {
	v, ok := raw[key]
	if !ok || isJSONNull(v) {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(v, &f); err != nil {
		return 0, false
	}
	if f != math.Trunc(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return int64(f), true
}

// jsonIntFieldOr 取整数字段，缺失/非法时返回默认值（clientTs 这类可选字段）。
func jsonIntFieldOr(raw map[string]json.RawMessage, key string, fallback int64) int64 {
	if v, ok := jsonIntField(raw, key); ok {
		return v
	}
	return fallback
}

// jsonIntArrayField 取整数数组（任一元素不是整数即整体失败）。
func jsonIntArrayField(raw map[string]json.RawMessage, key string) ([]int64, bool) {
	v, ok := raw[key]
	if !ok || isJSONNull(v) {
		return nil, false
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(v, &arr); err != nil {
		return nil, false
	}
	out := make([]int64, 0, len(arr))
	for _, el := range arr {
		var f float64
		if err := json.Unmarshal(el, &f); err != nil {
			return nil, false
		}
		if f != math.Trunc(f) || math.IsInf(f, 0) {
			return nil, false
		}
		out = append(out, int64(f))
	}
	return out, true
}

// jsNumber 模拟 JS 的 `Number(x)`：数字直接取，null → 0，字符串按数值解析，
// 布尔 → 0/1，对象/数组 → 失败（NaN）。
//
// 与 check-status 的 `typeof payload.positionSec !== 'number'` 不同，
// seek 申请走的是 `Number(payload.positionSec)`，宽松得多——这里必须
// 复刻那份宽松，否则「前端用字符串传进度」这类历史行为会被突然拒掉。
func jsNumber(v json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(v))
	if trimmed == "" || trimmed == "null" {
		return 0, true
	}
	var f float64
	if err := json.Unmarshal(v, &f); err == nil {
		return f, true
	}
	var s string
	if err := json.Unmarshal(v, &s); err == nil {
		if s == "" {
			return 0, true
		}
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return parsed, true
		}
	}
	var b bool
	if err := json.Unmarshal(v, &b); err == nil {
		if b {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// derefFloat 解引用可空浮点（nil → 0）。
func derefFloat(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}
