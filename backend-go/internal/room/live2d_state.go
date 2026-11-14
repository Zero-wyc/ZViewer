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
	// live2dMinActionGap 是单连接触发动作（表情/动作）的最小间隔。
	//
	// 表情是「点一下播一次」的低频动作，但按钮可以被按住连点：120ms 既
	// 留出连点的手感，又保证一个人最多 8Hz，不会让房间里的 N-1 个人
	// 每人每秒收几十条广播。动作同步也走这条门限：只在 idle 动作切换时
	// 发，实际频率是每几秒一次，远低于上限。
	live2dMinActionGap = 120 * time.Millisecond
	// live2dMaxExpressionIndex 是表情下标上限。一个模型的表情数极少超过 20，
	// 63 只是把「有人传巨大下标」挡在外面。
	live2dMaxExpressionIndex = 63
	// live2dMaxMotionIndex 是动作下标上限（一个动作组里的条目数）。
	live2dMaxMotionIndex = 63
	// live2dMaxMotionGroupLen 是动作组名长度上限（motions 的 key，如 "Idle"）。
	live2dMaxMotionGroupLen = 32

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
	// live2dDefaultEyes 是「没在做动捕」时的睁眼程度（1 = 全睁）。
	live2dDefaultEyes = 1.0
	// live2dFaceTTL 是「多久没收到面部数据就不再转发 m/e」的时限。
	//
	// 不转发（而不是转发 0/1）是必须的：客户端收到 m/e 就会接管模型的嘴与眼，
	// 全房间都被接管成"永远不眨眼"，比不动捕还假。客户端也有同样量级的 TTL，
	// 两者叠加出一条 1 秒出头的释放时间。
	live2dFaceTTL = 600 * time.Millisecond

	// live2dMinDragGap 是拖拽偏移上报的最小间隔。
	//
	// 拖动是连续的手势，客户端按 60ms 节流发送、松手时再补一帧终值，所以
	// 40ms 的门限只用来挡「有人写个循环把房间打满」；真正压带宽的是 100ms
	// 一次的下行合并。
	live2dMinDragGap = 40 * time.Millisecond

	// 拖拽偏移的钳制范围（相对视口宽/高的比例，正数向右/向下）。
	//
	// 与前端 core/drag.ts 里的 LIVE2D_DRAG_* 是同一组值，改一处必须改另一处。
	// 纵向只留很小的下沉余量：模型的锚点在脚底，再往下推只会把人推出画面，
	// 手感上会像"拖不动"。
	live2dDragXLimit = 0.45
	live2dDragYMin   = -0.55
	live2dDragYMax   = 0.10
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

	// Mouth/Eyes 是摄像头动捕算出来的面部姿态：张嘴幅度 0~1、
	// 睁眼程度 0~1。服务端只做转发与钳制，不理解语义。
	//
	// 这两项**只在动捕开着时才有意义**，关掉后客户端不再上报，值就冻在
	// 最后一帧（脸上不会突然张嘴/闭眼）。判定"是否该由动捕接管"是客户端的
	// 事——它按「多久没收到面部数据」处理（见前端 LIVE2D_FACE_TTL_MS）。
	Mouth float64
	Eyes  float64
	// faceAt 是最近一次收到面部数据的时刻，只用于判断「要不要继续转发 m/e」。
	faceAt time.Time

	// DragX/DragY 是相对「槽位基准位置」的拖拽偏移（视口宽/高的比例，
	// 正数向右/向下）。
	//
	// 为什么不改成绝对坐标：基准位置由 Ord 决定，有人进出时会重排；偏移量
	// 跟着人走才能保证「我把角色挪到左边一点」在所有人眼里都是同样的相对
	// 位置，而不是"某人在第 3 个槽位、却被钉死在屏幕 20% 处"。
	DragX float64
	DragY float64
	// dragAt 只用于拖拽上报的频控，不参与下发。
	dragAt time.Time

	// pendingAdd 表示「这一轮 flush 要以 add 行下发」。
	// 新成员、换过模型的成员都置位；只动指针的成员走 upd 行。
	pendingAdd bool
	dirty      bool
	// dirtyDrag 表示「这一轮 flush 要补一条拖拽行」。
	//
	// 与 dirty 分开：指针/面部走 u 行、拖拽走 d 行，两者形状不同；合成一种
	// 脏标记就只能二选一，拖动时指针会一起被当成"状态变了"重发。
	dirtyDrag  bool
	lastState  time.Time
	// lastAction 只用于表情频控，不参与下发。
	lastAction time.Time
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

// stateDirtyRow / dragDirtyRow 同理：TakeDirty 返回的是清位之前的拷贝，
// 所以这里读到的是「本轮要不要发这一类行」。
func (m live2dMember) stateDirtyRow() bool { return m.dirty }
func (m live2dMember) dragDirtyRow() bool  { return m.dirtyDrag }

type live2dStore struct {
	mu    sync.Mutex
	rooms map[string]*live2dRoom
	// policies 按房间存角色策略。和 rooms 分开：房内一个人都没声明模型时
	// rooms 里的条目会被删掉，但策略得留着。
	policies map[string]live2dPolicy
}

func newLive2DStore() *live2dStore {
	return &live2dStore{
		rooms:    make(map[string]*live2dRoom),
		policies: make(map[string]live2dPolicy),
	}
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
		// 保留排位、指针与面部状态：换模型不该让人在画面里换个位置站着，
		// 也不该在换模型的一瞬间闭眼。
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
	// Eyes 为零值意味着「构造时没填」，按全睁处理；真正的闭眼只可能来自
	// 动捕上报（走 UpdateState），不会经过这里。
	if m.Eyes <= 0 {
		m.Eyes = live2dDefaultEyes
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

// live2dStateUpdate 是一次指针上报的内容。
//
// Mouth/Eyes 用指针表示「这一帧带没带面部数据」：动捕关掉后客户端就不发了，
// 这时必须保持原值而不是清零——否则每次鼠标一动，模型就会突然把嘴闭上。
type live2dStateUpdate struct {
	X, Y, AR    float64
	Mouth, Eyes *float64
}

// UpdateState 写入指针位置（和面部姿态），返回 false 表示被丢弃（不在房 / 超出频率）。
func (st *live2dStore) UpdateState(roomID, socketID string, u live2dStateUpdate, now time.Time) bool {
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
	m.X = clampFloat(u.X, 0, 1)
	m.Y = clampFloat(u.Y, 0, 1)
	m.AR = clampFloat(u.AR, 0.2, 6)
	if u.Mouth != nil {
		m.Mouth = clampFloat(*u.Mouth, 0, 1)
	}
	if u.Eyes != nil {
		m.Eyes = clampFloat(*u.Eyes, 0, 1)
	}
	if u.Mouth != nil || u.Eyes != nil {
		m.faceAt = now
	}
	m.dirty = true
	return true
}

// SetDrag 写入拖拽偏移，返回 false 表示被丢弃（不在房 / 超出频率）。
//
// 偏移由**本人**决定：这里不做任何权限判断，socket id 就是归属——
// payload 里根本没有 sid，伪造不了别人的位置。
func (st *live2dStore) SetDrag(roomID, socketID string, dx, dy float64, now time.Time) bool {
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
	if !m.dragAt.IsZero() && now.Sub(m.dragAt) < live2dMinDragGap {
		return false
	}
	m.dragAt = now
	m.DragX = clampFloat(dx, -live2dDragXLimit, live2dDragXLimit)
	m.DragY = clampFloat(dy, live2dDragYMin, live2dDragYMax)
	m.dirtyDrag = true
	// 不动 updatedAt：它是「成员还活着」的证据，拖拽不是。
	return true
}

// AllowAction 判断这条连接现在能不能触发表情（120ms 门限）。//
// 顺便承担成员资格判断：没声明过模型的连接不该能广播动作。
func (st *live2dStore) AllowAction(roomID, socketID string, now time.Time) bool {
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
	if !m.lastAction.IsZero() && now.Sub(m.lastAction) < live2dMinActionGap {
		return false
	}
	m.lastAction = now
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
		if !m.dirty && !m.dirtyDrag {
			continue
		}
		cp := *m
		out = append(out, cp)
		m.dirty = false
		m.pendingAdd = false
		m.dirtyDrag = false
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
	delete(st.policies, roomID)
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

func (s *Service) Live2DUpdateState(roomID, socketID string, u live2dStateUpdate, now time.Time) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.UpdateState(roomID, socketID, u, now)
}

// Live2DSetDrag 写入拖拽偏移（本人），返回 false 表示被丢弃（不在房 / 超频）。
func (s *Service) Live2DSetDrag(roomID, socketID string, dx, dy float64) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.SetDrag(roomID, socketID, dx, dy, time.Now())
}

// Live2DAllowAction 是 AllowAction 的 Service 包装（频控 + 成员资格）。
func (s *Service) Live2DAllowAction(roomID, socketID string) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.AllowAction(roomID, socketID, time.Now())
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
			// add 行自带拖拽偏移，不必再补一条 d 行
			if m.pendingAddRow() {
				patch.Add = append(patch.Add, live2dRow(m))
				continue
			}
			if m.stateDirtyRow() {
				patch.Upd = append(patch.Upd, live2dStateRow(m, now))
			}
			if m.dragDirtyRow() {
				patch.Drag = append(patch.Drag, live2dDragRow(m))
			}
		}
		// 只改了拖拽的成员也会进 changed，但三类行都可能为空（例如读数与上次
		// 完全相同）：那时没必要发一条空 patch 让房间每人多解析一次。
		if len(patch.Upd) == 0 && len(patch.Add) == 0 && len(patch.Drag) == 0 && len(patch.Rem) == 0 {
			continue
		}
		s.Hub.EmitRoom(roomID, "live2d-patch", patch)
	}
}

func roundTo(v float64, digits int) float64 {
	pow := math.Pow10(digits)
	return math.Round(v*pow) / pow
}
