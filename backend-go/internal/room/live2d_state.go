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
	// live2dDefaultPose 是表情细节/歪头的中性值。
	//
	// 这三项在协议里是 0~1 编码（0.5 = 中性），所以「没动捕」必须给 0.5 而不是
	// 0——0 的含义是「撇嘴 + 皱眉 + 向左歪到底」，会让新进房的人一脸苦相。
	live2dDefaultPose = 0.5
	// 姿态数组的两种长度。
	//
	// 定长而不是对象：这条走 15Hz 热路径，字段名加起来比数据本身还长。
	// 老客户端只发前 3 项（嘴形/眉毛/滚转），新客户端追加 9 项（3D 头部与
	// 眼球）：服务端按「≥ 3 就吃前 3 项，≥ 12 再吃后面的」解析，两种都能用。
	//
	// 为什么不用 map 或者定长 12 硬校验：老客户端仍在发 3 项，硬校验会让
	// 它们升级前彻底失去表情——这是最不该出现的"升级即坏掉"。
	live2dPoseBaseLen = 3
	live2dPoseFullLen = 12
	// live2dPoseFlagsLen 是「带位掩码」的长度：12 个值 + 1 个标记。
	live2dPoseFlagsLen = 13
	// live2dFaceTTL 是「多久没收到面部数据就不再转发 m/e」的时限。
	//
	// 不转发（而不是转发 0/1）是必须的：客户端收到 m/e 就会接管模型的嘴与眼，
	// 全房间都被接管成"永远不眨眼"，比不动捕还假。客户端也有同样量级的 TTL，
	// 两者叠加出一条 1 秒出头的释放时间。
	live2dFaceTTL = 600 * time.Millisecond

	// live2dMinPokeGap 是「戳一下」的最小间隔。
	//
	// 比动作门限宽得多：动作是自己身上的表情，连点最多是脸抽筋；戳是**对别人**
	// 的动作，连点就变成骚扰。一次互动本来就该是一下。
	live2dMinPokeGap = 600 * time.Millisecond

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
	// Identity 是「这个人是谁」的稳定标识（`u:<userId>` / `g:<guestId>`，空串
	// 表示无法识别）。名册按 socket 组织，但**一个用户只能有一个角色**：
	// 同一 Identity 重新声明时顶替旧记录（见 live2dStore.Set）。
	//
	// 不进任何下发：客户端只需要 socketId，身份留在服务端。
	Identity string
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
	// Form/Brow/Roll 是动捕算出的**表情细节与歪头**，与 Mouth/Eyes 同时上报，
	// 同样只在动捕开着时才有意义。全部按 0~1 编码（0.5 = 中性）：
	//   Form = 嘴形（小→笑/撇嘴）、Brow = 眉毛（皱眉→挑眉）、Roll = 歪头（左→右）。
	//
	// 服务端不理解语义，只做长度校验与钳制；映射到 Cubism 参数是各客户端的事。
	Form float64
	Brow float64
	Roll float64
	// HeadX/HeadY 是 3D 头部偏航/俯仰（0~1，0.5 = 正对镜头），
	// OffX/OffY/Depth 是 6DOF 平移视差（0.5 = 标定位置），
	// GazeX/GazeY 是眼球指向（0.5 = 居中），EyeL/EyeR 是左右眼睁开程度（1 = 全睁）。
	//
	// 这些是**追加字段**：老客户端不发，服务端保持默认中值，下发时也只按
	// 数组长度决定带不带——不需要版本协商。
	HeadX float64
	HeadY float64
	OffX  float64
	OffY  float64
	Depth float64
	GazeX float64
	GazeY float64
	EyeL  float64
	EyeR  float64
	// PoseFlags 是「这两个通道这一帧有效」的位掩码（1 = 3D 头部，2 = 眼球）。
	//
	// 必须显式传：关掉 3D 的客户端仍会发中值 0.5，接收端若照写就会把头部钉死
	// 在正前方；不传标记时接收端只能二选一，两种都会错。
	PoseFlags int
	// faceAt 是最近一次收到面部数据的时刻，只用于判断「要不要继续转发 m/e/p」。
	faceAt time.Time

	// VoiceMouth / voiceAt 是**语音口型**：只驱动嘴，不动眼、表情和歪头。
	//
	// 为什么不复用 Mouth/faceAt：
	//   - 语义上语音只对应"张嘴幅度"，没有睁眼/挑眉的对应物。走面部通路就等于
	//     声称"他的眼睛和眉毛也归动捕管"，客户端一旦接管，整个说话期间模型
	//     都不再眨眼，比不动捕还假；
	//   - 下行形状也不同：面部是 m+e+p 五项一起发，语音只发 m 一项，客户端
	//     按行长度区分三种状态（纯视线 / 语音张嘴 / 整脸动捕）。老客户端读到
	//     长度 5 的行会当作"没有面部数据"直接忽略，既不跳也不闪。
	VoiceMouth float64
	voiceAt    time.Time

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
	dirtyDrag bool
	lastState time.Time
	// lastAction 只用于表情频控，不参与下发。
	lastAction time.Time
	// lastPoke 只用于「戳别人」的频控，与自己的动作各算各的：
	// 共用一个时间戳会让「戳完立刻做个表情」被吞掉。
	lastPoke  time.Time
	updatedAt time.Time
}

type live2dRoom struct {
	models map[string]*live2dMember
	// replaced 是「被同一用户的另一个连接顶替掉」的 socketId，等下一轮 flush
	// 以 rem 行下发。
	//
	// 为什么不在这里直接广播：store 不认识 Hub（它在锁内不能回调 Service）。
	// 攒到 FlushLive2D 与 PruneStale 的结果合并成一条 patch，顺带也能被
	// 「房间里没人收」的分支一起清掉。
	replaced []string
}

// TakeReplaced 取出并清空被顶替的 socketId（调用方负责下发 rem 行）。
func (st *live2dStore) TakeReplaced(roomID string) []string {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.rooms[roomID]
	if r == nil || len(r.replaced) == 0 {
		return nil
	}
	out := r.replaced
	r.replaced = nil
	return out
}

// nextOrdLocked 取最小的未占用排位（调用方必须已持锁）。
//
// 为什么不是"单调递增"：隐藏角色 = 从名册里删掉，显示 = 重新声明。单调递增
// 会让「隐藏再显示」的人排到队尾，画面上表现成"我的角色跑到最右边去了"；
// 人一多还会把自己挤出前 N 个渲染名额（前端只画 ord 最小的若干个），于是
// 变成"我明明有角色，却看不见自己"——没有任何提示，最难自查的一种故障。
//
// 取最小空闲位让"回到原位"成为常态，也顺带让长期运行的房间里的 ord 不会
// 无限膨胀。代价是新人会填进刚离开者留下的空位；这本来就无法避免——槽位
// 是按人数均分的，人一多一少，所有人的位置都会重算。
func (r *live2dRoom) nextOrdLocked() int64 {
	used := make(map[int64]struct{}, len(r.models))
	for _, m := range r.models {
		used[m.Ord] = struct{}{}
	}
	for ord := int64(1); ; ord++ {
		if _, taken := used[ord]; !taken {
			return ord
		}
	}
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
//
// **一个用户只能有一个角色**：同一个 Identity 已经用别的 socket 声明过时，
// 旧记录当场被顶替（新的接住旧排位），旧 socketId 进 replaced 队列等下一轮
// flush 下发 rem。没有这一步，重连窗口里（旧连接还没被服务端判死、新连接
// 已经声明）同一个人会站在两个位置——每个人的屏幕上都多出一个"我自己"。
func (st *live2dStore) Set(roomID string, m live2dMember, now time.Time) bool {
	st.mu.Lock()
	defer st.mu.Unlock()

	r := st.roomLocked(roomID)
	// 先归并同身份记录，再判容量——顶替会腾出一个名额，不该因为"满了"
	// 把这次声明挡回去。
	if m.Identity != "" {
		for id, old := range r.models {
			if id == m.SocketID || old.Identity != m.Identity {
				continue
			}
			// 接住旧排位：换设备/重连不该让位置跳到队尾（队尾还可能掉出
			// 前端的前 N 个渲染名额，表现为"我明明有角色却看不见自己"）。
			m.Ord = old.Ord
			delete(r.models, id)
			r.replaced = append(r.replaced, id)
			break
		}
	}

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
	if m.Ord == 0 {
		m.Ord = r.nextOrdLocked()
	}
	if m.AR <= 0 {
		m.AR = live2dDefaultAR
	}
	// Eyes 为零值意味着「构造时没填」，按全睁处理；真正的闭眼只可能来自
	// 动捕上报（走 UpdateState），不会经过这里。
	if m.Eyes <= 0 {
		m.Eyes = live2dDefaultEyes
	}
	// 表情细节同理：零值在协议里是「撇嘴 + 皱眉 + 歪到底」，不是中性。
	// 这里只在字段完全没填（正好为 0）时补中性值——真的是 0 的读数来自
	// UpdateState，不走这条路径。
	if m.Form == 0 {
		m.Form = live2dDefaultPose
	}
	if m.Brow == 0 {
		m.Brow = live2dDefaultPose
	}
	if m.Roll == 0 {
		m.Roll = live2dDefaultPose
	}
	// 3D/眼球同理：零值是"没填"，不是"转到极限"。眼睁开程度的中性是 1。
	if m.HeadX == 0 {
		m.HeadX = live2dDefaultPose
	}
	if m.HeadY == 0 {
		m.HeadY = live2dDefaultPose
	}
	if m.OffX == 0 {
		m.OffX = live2dDefaultPose
	}
	if m.OffY == 0 {
		m.OffY = live2dDefaultPose
	}
	if m.Depth == 0 {
		m.Depth = live2dDefaultPose
	}
	if m.GazeX == 0 {
		m.GazeX = live2dDefaultPose
	}
	if m.GazeY == 0 {
		m.GazeY = live2dDefaultPose
	}
	if m.EyeL <= 0 {
		m.EyeL = live2dDefaultEyes
	}
	if m.EyeR <= 0 {
		m.EyeR = live2dDefaultEyes
	}
	m.pendingAdd = true
	m.dirty = true
	m.updatedAt = now
	r.models[m.SocketID] = &m
	return true
}

// DropModel 把「正在使用这个公共库模型」的成员全部摘掉，返回 roomID → 被摘掉的 socketId。
//
// 公共库是全局的：删模型的人可能不在用它的房间里，甚至根本不在线。所以清理只能
// 由服务端扫全量房间完成——客户端无从知道自己删掉的模型正被谁用着。
//
// 只动 kind=room 的记录：同名 id 不会出现在 builtin（字符集不同）或 url（是完整
// 地址）里，多一道判断是为了将来加类型时不会误伤。
func (st *live2dStore) DropModel(modelID string) map[string][]string {
	st.mu.Lock()
	defer st.mu.Unlock()

	out := make(map[string][]string)
	for roomID, r := range st.rooms {
		var gone []string
		for sid, m := range r.models {
			if m.Kind != "room" || m.ModelID != modelID {
				continue
			}
			delete(r.models, sid)
			gone = append(gone, sid)
		}
		if len(gone) == 0 {
			continue
		}
		if len(r.models) == 0 {
			delete(st.rooms, roomID)
		}
		sort.Strings(gone)
		out[roomID] = gone
	}
	return out
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
// Pose 同理：nil 表示这一帧没有表情细节（老客户端、或这一帧没取到 blendshape）。
type live2dStateUpdate struct {
	X, Y, AR    float64
	Mouth, Eyes *float64
	// Pose 是 [嘴形, 眉毛, 歪头]，0~1 编码。长度不等于 3 时整条忽略。
	Pose []float64
	// VoiceMouth 是「只有嘴型」的上报（语音口型）。
	//
	// 与 Mouth 分开而不是复用：Mouth 一出现就意味着"整脸归动捕管"，而语音
	// 只该动嘴。客户端两者互斥发送（动捕优先），服务端只负责按各自的通道
	// 记录与转发，不做优先级判断——优先级在客户端算得比这里准（它知道
	// 摄像头此刻到底有没有检测到脸）。
	VoiceMouth *float64
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
	// 长度不对就整条忽略（而不是逐项尽力而为）：错位的数组会把嘴形写进眉毛，
	// 用户看到的是"脸抽筋"，比不动捕难查得多。
	//
	// 前 3 项是老协议，必定在上面；后 9 项只在长度够时才读——只发 3 项的老
	// 客户端不该把 3D 通道写成 0（0 的含义是"头向左转到底 + 贴左 + 贴镜头"）。
	if len(u.Pose) >= live2dPoseBaseLen {
		m.Form = clampFloat(u.Pose[0], 0, 1)
		m.Brow = clampFloat(u.Pose[1], 0, 1)
		m.Roll = clampFloat(u.Pose[2], 0, 1)
		// 先归零：这一帧没带掩码就等于"3D/眼球都不接管"。不归零的话，用户
		// 切回老客户端/关掉开关后，接收端会一直按上一帧的"有效"继续写头部。
		m.PoseFlags = 0
	}
	if len(u.Pose) >= live2dPoseFullLen {
		m.HeadX = clampFloat(u.Pose[3], 0, 1)
		m.HeadY = clampFloat(u.Pose[4], 0, 1)
		m.OffX = clampFloat(u.Pose[5], 0, 1)
		m.OffY = clampFloat(u.Pose[6], 0, 1)
		m.Depth = clampFloat(u.Pose[7], 0, 1)
		m.GazeX = clampFloat(u.Pose[8], 0, 1)
		m.GazeY = clampFloat(u.Pose[9], 0, 1)
		m.EyeL = clampFloat(u.Pose[10], 0, 1)
		m.EyeR = clampFloat(u.Pose[11], 0, 1)
		// 第 13 位是可用性位掩码；老客户端没有这一位，按 0（都不接管）处理。
		if len(u.Pose) >= live2dPoseFlagsLen {
			m.PoseFlags = int(clampFloat(u.Pose[12], 0, 3))
		}
	}
	if u.VoiceMouth != nil {
		m.VoiceMouth = clampFloat(*u.VoiceMouth, 0, 1)
		m.voiceAt = now
	}
	if u.Mouth != nil || u.Eyes != nil || len(u.Pose) >= live2dPoseBaseLen {
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

// AllowPoke 判定「这个人现在能不能戳别人」并记录时间。
//
// 同时兼作成员资格检查：没在名册里（没声明模型 / 已删除角色）就没有戳的资格。
// 这条规则刻意与表情/动作一致——一个人如果连角色都没有，他的"戳"在别人屏幕上
// 找不到任何可以解释的来源。
func (st *live2dStore) AllowPoke(roomID, socketID string, now time.Time) bool {
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
	if !m.lastPoke.IsZero() && now.Sub(m.lastPoke) < live2dMinPokeGap {
		return false
	}
	m.lastPoke = now
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
		// 空房间不占内存：下次重建即可（排位从 1 重新分配）
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

// Live2DAllowPoke 是「戳别人」的频控 + 成员资格判定。
func (s *Service) Live2DAllowPoke(roomID, socketID string) bool {
	if s == nil || s.live2d == nil {
		return false
	}
	return s.live2d.AllowPoke(roomID, socketID, time.Now())
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

// Live2DModelRemoved 是「公共库模型被删掉」之后的房间侧收尾：
// 摘掉正在用它的人、关掉指向它的统一角色，并把结果广播给受影响的房间。
//
// 由 api 层在删除成功后调用。放在这里而不是 api：只有这里同时拿着名册、策略
// 与 Hub，而这三样都是纯内存、锁边界很清楚（api 层没有名册，也无权广播）。
func (s *Service) Live2DModelRemoved(modelID string) {
	if s == nil || s.live2d == nil {
		return
	}
	dropped := s.live2d.DropModel(modelID)
	unifiedOff := s.live2d.ClearUnifiedModel(modelID)
	if s.Hub == nil {
		return
	}
	for roomID, sids := range dropped {
		// 先让画面消失（rem），再说明原因：只发 rem 的话，本人只会看到自己的
		// 角色凭空不见，还以为是自己掉线或对方网络问题。
		s.Hub.EmitRoom(roomID, "live2d-patch", live2dPatchOut{RoomID: roomID, Rem: sids})
		s.Hub.EmitRoom(roomID, "live2d-model-removed", live2dModelRemovedOut{
			RoomID:  roomID,
			ModelID: modelID,
		})
	}
	for _, roomID := range unifiedOff {
		// 读策略必须放在锁外：ClearUnifiedModel 已经返回并解锁，这里再取一次。
		s.Hub.EmitRoom(roomID, "live2d-policy", live2dPolicyOut{
			RoomID: roomID,
			Policy: s.Live2DPolicy(roomID),
		})
	}
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
		removed := s.live2d.TakeReplaced(roomID)
		removed = append(removed, s.live2d.PruneStale(roomID, s.Hub.Connected, live2dStaleAfter, now)...)
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
