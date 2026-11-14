package room

import (
	"math"
	"sort"
	"sync"
	"time"
)

// Live2D 房间悬浮层的运行时状态。
//
// 为什么单独一个 store 而不是塞进 RuntimeState：
//   - 这是**高频**数据（每客户端 15Hz），写路径不能和播放状态/字幕抢
//     Service.mu——那把锁后面挂着 Playback.Advanced 这类带 DB 的操作；
//   - 它天然按 socket 组织（一人一个模型），和按房间组织的一份 RuntimeState
//     结构不同；
//   - 它重启即丢（模型选择由前端本地设置记住），不需要落库。
//
// 因此这里的锁只保护自己，任何 handler 在持锁期间不得调用 Service 的方法。
const (
	// live2dMaxModels 是房间内模型数量上限。按视频区宽度估算，超过 12 个
	// 无论如何也摆不开，而且下行带宽会线性增长。
	live2dMaxModels = 12
	// live2dMaxURLLen 是自定义模型地址长度上限（512 足够放下带查询串的 CDN 地址）。
	live2dMaxURLLen = 512
	// live2dStaleAfter 是「连接已断但没来得及清理」的兜底剔除时间。
	//
	// 正常路径是 handleDisconnect 立即删；这条只防「socket 半死、断开事件
	// 没到」的漏网情况，所以给得比较短。
	live2dStaleAfter = 20 * time.Second
	// live2dMinStateGap 是单连接上报指针的最小间隔（25Hz 上限）。
	// 客户端按 15Hz 发，超频的一律丢弃，避免有人写个循环把房间打满。
	live2dMinStateGap = 40 * time.Millisecond
	// live2dFlushInterval 是服务端合并下行的间隔。
	//
	// 为什么要合并而不是来一帧发一帧：internal/sio 的 Broadcast.Emit
	// 对每个目标连接**同步** ws.WriteText，没有发送队列。15Hz × N 人直发，
	// 一个卡在 TCP 背压上的观众就会拖住整个房间的写循环。
	live2dFlushInterval = 100 * time.Millisecond

	live2dMinScale = 0.2
	live2dMaxScale = 4.0
	// live2dDefaultAR 是默认宽高比（16:9），只用于还没上报过指针的成员。
	live2dDefaultAR = 1.78
)

// live2dMember 是一个成员在当前房间里的模型状态。
type live2dMember struct {
	SocketID string
	Name     string
	Kind     string // builtin | url | room（room = 房主上传到本房间的模型）
	ModelID  string
	Scale    float64
	// Ord 是排位序号：客户端据此等距摆位，各端布局才会一致。
	// 服务端在成员首次 set 时分配，房间内单调递增。
	Ord int64

	// X/Y 是归一化注视目标（0~1，相对整个视口）；AR 是上报者的宽高比。
	X  float64
	Y  float64
	AR float64

	// pendingAdd 表示「这一轮 flush 要以 add 行下发」。
	// 新成员、换过模型的成员都置位；只动指针的成员走 upd 行。
	pendingAdd bool
	dirty      bool
	lastState  time.Time
	updatedAt  time.Time
}

type live2dRoom struct {
	models  map[string]*live2dMember
	nextOrd int64
}

// pendingAddRow 表示这一轮要以 add 行下发（新成员，或换过模型）。
//
// TakeDirty 返回的是清位之前的拷贝，所以这里读到的是「本轮要不要 add」。
func (m live2dMember) pendingAddRow() bool { return m.pendingAdd }

type live2dStore struct {
	mu    sync.Mutex
	rooms map[string]*live2dRoom
}

func newLive2DStore() *live2dStore {
	return &live2dStore{rooms: make(map[string]*live2dRoom)}
}

func (st *live2dStore) roomLocked(roomID string) *live2dRoom {
	r := st.rooms[roomID]
	if r == nil {
		r = &live2dRoom{models: make(map[string]*live2dMember)}
		st.rooms[roomID] = r
	}
	return r
}

// Set 写入/更新一个成员的模型声明，返回 false 表示房间已满。
//
// 更新已有成员永远允许（不能因为满了就连换模型都不让改）。
func (st *live2dStore) Set(roomID string, m live2dMember, now time.Time) bool {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.roomLocked(roomID)
	if existing := r.models[m.SocketID]; existing != nil {
		// 保留排位与指针状态：换模型不该让人在画面里换个位置站着。
		existing.Name = m.Name
		existing.Kind = m.Kind
		existing.ModelID = m.ModelID
		existing.Scale = m.Scale
		existing.pendingAdd = true
		existing.dirty = true
		existing.updatedAt = now
		return true
	}
	if len(r.models) >= live2dMaxModels {
		return false
	}
	r.nextOrd++
	m.Ord = r.nextOrd
	if m.AR <= 0 {
		m.AR = live2dDefaultAR
	}
	m.pendingAdd = true
	m.dirty = true
	m.updatedAt = now
	r.models[m.SocketID] = &m
	return true
}

// Has 是热路径上的成员资格判断：不查库、不碰 Service.mu。
func (st *live2dStore) Has(roomID, socketID string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	r := st.rooms[roomID]
	if r == nil {
		return false
	}
	_, ok := r.models[socketID]
	return ok
}

// UpdateState 写入指针位置，返回 false 表示被丢弃（不在房 / 超出频率）。
func (st *live2dStore) UpdateState(roomID, socketID string, x, y, ar float64, now time.Time) bool {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.rooms[roomID]
	if r == nil {
		return false
	}
	m := r.models[socketID]
	if m == nil {
		return false
	}
	if !m.lastState.IsZero() && now.Sub(m.lastState) < live2dMinStateGap {
		return false
	}
	m.lastState = now
	m.X = clampFloat(x, 0, 1)
	m.Y = clampFloat(y, 0, 1)
	m.AR = clampFloat(ar, 0.2, 6)
	m.dirty = true
	return true
}

func (st *live2dStore) Remove(roomID, socketID string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.rooms[roomID]
	if r == nil {
		return false
	}
	if _, ok := r.models[socketID]; !ok {
		return false
	}
	delete(r.models, socketID)
	if len(r.models) == 0 {
		// 空房间不占内存：只剩 nextOrd 没有意义，下次重建即可
		delete(st.rooms, roomID)
	}
	return true
}

// Snapshot 返回按 Ord 升序的成员列表（各端据此排位）。
func (st *live2dStore) Snapshot(roomID string) []live2dMember {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.rooms[roomID]
	if r == nil {
		return nil
	}
	out := make([]live2dMember, 0, len(r.models))
	for _, m := range r.models {
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ord < out[j].Ord })
	return out
}

// TakeDirty 取出并清空本轮变更；pendingAdd 的成员会被标成「已通告」。
func (st *live2dStore) TakeDirty(roomID string) []live2dMember {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.rooms[roomID]
	if r == nil {
		return nil
	}
	var out []live2dMember
	for _, m := range r.models {
		if !m.dirty {
			continue
		}
		cp := *m
		out = append(out, cp)
		m.dirty = false
		m.pendingAdd = false
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ord < out[j].Ord })
	return out
}

// Rooms 返回当前有模型状态的房间（合并下发时遍历用）。
func (st *live2dStore) Rooms() []string {
	st.mu.Lock()
	defer st.mu.Unlock()

	out := make([]string, 0, len(st.rooms))
	for id := range st.rooms {
		out = append(out, id)
	}
	return out
}

// PruneStale 剔除「连接已断且很久没动静」的成员，返回被删的 socketID。
func (st *live2dStore) PruneStale(roomID string, online func(string) bool, ttl time.Duration, now time.Time) []string {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.rooms[roomID]
	if r == nil {
		return nil
	}
	var removed []string
	for id, m := range r.models {
		stale := now.Sub(m.updatedAt) > ttl
		if online != nil && online(id) {
			continue
		}
		if !stale {
			continue
		}
		delete(r.models, id)
		removed = append(removed, id)
	}
	if len(r.models) == 0 {
		delete(st.rooms, roomID)
	}
	return removed
}

func (st *live2dStore) DeleteRoom(roomID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.rooms, roomID)
}

func (st *live2dStore) Count(roomID string) int {
	st.mu.Lock()
	defer st.mu.Unlock()
	if r := st.rooms[roomID]; r != nil {
		return len(r.models)
	}
	return 0
}

func clampFloat(v, lo, hi float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return lo
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ---------------------------------------------------------------------------
// Service 侧包装 + 合并下发
// ---------------------------------------------------------------------------

// Live2DSet 声明/更新一个成员的模型，返回 false 表示房间已满。
func (s *Service) Live2DSet(roomID string, m live2dMember) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.Set(roomID, m, time.Now())
}

func (s *Service) Live2DRemove(roomID, socketID string) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.Remove(roomID, socketID)
}

func (s *Service) Live2DHas(roomID, socketID string) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.Has(roomID, socketID)
}

func (s *Service) Live2DUpdateState(roomID, socketID string, x, y, ar float64, now time.Time) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.UpdateState(roomID, socketID, x, y, ar, now)
}

func (s *Service) Live2DSnapshot(roomID string) []live2dMember {
	if s == nil || s.live2d == nil {
		return nil
	}
	return s.live2d.Snapshot(roomID)
}

func (s *Service) Live2DCount(roomID string) int {
	if s == nil || s.live2d == nil {
		return 0
	}
	return s.live2d.Count(roomID)
}

// FlushLive2D 把这一轮累积的变更合并成一条 live2d-patch 下发。
//
// 由 Broadcaster 每 live2dFlushInterval 调一次；空房间直接跳过（同
// broadcaster.go 里 server-heartbeat 的判断：没人收就不要序列化）。
func (s *Service) FlushLive2D() {
	if s == nil || s.Hub == nil || s.live2d == nil {
		return
	}
	now := time.Now()
	for _, roomID := range s.live2d.Rooms() {
		if s.Hub.MemberCount(roomID) == 0 {
			// 没人收：把脏标记清掉，否则人回来时会一次性涌出几百帧
			s.live2d.TakeDirty(roomID)
			continue
		}
		removed := s.live2d.PruneStale(roomID, s.Hub.Connected, live2dStaleAfter, now)
		changed := s.live2d.TakeDirty(roomID)
		if len(changed) == 0 && len(removed) == 0 {
			continue
		}
		patch := live2dPatchOut{RoomID: roomID, Rem: removed}
		for _, m := range changed {
			row := live2dRow(m)
			if m.pendingAddRow() {
				patch.Add = append(patch.Add, row)
				continue
			}
			patch.Upd = append(patch.Upd, []any{
				m.SocketID, roundTo(m.X, 3), roundTo(m.Y, 3), roundTo(m.AR, 2),
			})
		}
		s.Hub.EmitRoom(roomID, "live2d-patch", patch)
	}
}

func roundTo(v float64, digits int) float64 {
	pow := math.Pow10(digits)
	return math.Round(v*pow) / pow
}
