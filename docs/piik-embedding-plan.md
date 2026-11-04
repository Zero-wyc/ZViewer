# 屏幕共享「完全由 Piik 实现」落地评估

> 结论先行：现在的 ZViewer 是「Piik 的转发内核 + 自研控制面 + 半移植客户端」，
> 不是「由 Piik 实现」。要做到后者，只有两条路：把 Piik 源码搬进来（代码嵌套），
> 或让 Piik 作为独立进程跑起来（进程嵌套）。两者工作量差一个数量级。

## 1. 现状审计

### 1.1 服务端

| Piik 目录 | 非测试行数 | ZViewer 对应 | 状态 |
|---|---|---|---|
| `internal/media/forwarding` | 3,065 | `internal/share/forwarding` | **同源**，27 个同名文件里 10 个逐字节一致 |
| `internal/media/encoded` | — | `internal/share/encoded` | 同源 |
| `internal/server/route` | 6,090 | `internal/share/route.go`（749 行） | **重写**，语义对齐、实现不同 |
| `internal/server/signal` | 6,746 | `internal/share/service.go` + `session.go` | **重写**，跑在 socket.io 上 |
| `internal/server/protocol` | 4,788 | `internal/share/protocol.go`（520 行） | **重写**，保留了判别式与错误码 |
| `internal/server/sfu` | 2,154 | `internal/share/relay.go`（692 行） | **重写** |

`forwarding` 的 README 也写明了：那是从 Piik 移植的，改动只有 import 路径和
`AdditionalProbeDemand` 字段。但对照源码发现一处**功能性删减**：

```go
// Piik: audio 与 video 都接受
audio := strings.EqualFold(options.Codec.MimeType, webrtc.MimeTypeOpus) ...
// ZViewer: 只收视频
if options.Codec.ClockRate != 90_000 || (!H264 && !VP8) { return nil, errors.New("forwarded video source is invalid") }
```

即 `share/forwarding/source.go` 砍掉了音频转发；Piik 的 `audio_output.go`
（音频出站）整个文件没有移植。

### 1.2 客户端

Piik 的 `src/client/media/` 有 27 个模块，ZViewer 同名的只有 3 个
（`capture-devices` / `quality` / `viewer-audio`），另有 14 个是 ZViewer 自研
（`host-session` / `viewer-session` / `share-client` / `relay-media` / `peer-quality`…）。

同名文件的差异也不是「小改」：

| 文件 | Piik | ZViewer | diff 行数 |
|---|---|---|---|
| `host-peer.ts` | 1,006 | 968 | 1,744 |
| `viewer-peer.ts` | 759 | 551 | 1,192 |
| `viewer-relay.ts` | 709 | 195 | 878 |
| `stats.ts` | 1,178 | 750 | 1,889 |
| `quality.ts` | 545 | 466 | 903 |

`viewer-relay` 只剩 Piik 的 27%，`stats` 剩 64%，说明中继与质量口径都是另一套。

### 1.3 一句话

- 媒体面（包转发、编码、NAT 预测、codec 预检）：**是 Piik 的**。
- 控制面（信令、路由、会话、协议）：**是 ZViewer 照 Piik 语义另写的**。
- 表现面（peer 编排、统计、播放、UI）：**基本是 ZViewer 自己的**。

## 2. 两条路

### A. 代码嵌套（vendor 源码，单进程）

把 Piik 的服务端包搬进 `backend-go/internal/piik/`，客户端 `webrtc` +
`media` + `sfu` + `lib/{signaling,session,api}` 搬进 `frontend/src/piik/`，
import 重写，外面套一层适配器把 ZViewer 的房间/身份/UI 接进去。

已确认可行：`go list -deps ./internal/server/route ./internal/server/signal`
的 Piik 内依赖闭包**只有 13 个包**，全部自包含：

```
internal/{diagnostics, tlsconfig}
internal/media/{encoded, forwarding, inputroute}
internal/server/{config, ordered, protocol, room, route, sfu, signal}
internal/thirdparty/livekit/sendsidebwe
```

- 工作量：搬迁 ~30k 行（服务端 19.8k 非测试行 + 客户端 12.6k），适配层另算。
- 周期：按每天推进一个可验证切片，**3–6 周**；回归面覆盖整条共享链路。
- 结果：单进程、单套房间模型、ZViewer 的 UI 与产品语义不变。
- 代价：Piik 上游更新要靠手工 merge（vendor 子树无版本管理）。

### B. 进程嵌套（piik-server 作为组件）

像 livekit / frpc 一样把 `piik-server` 打进组件库、按需下载、由后端拉起，
监听 `127.0.0.1:<随机端口>`；ZViewer 房间 ↔ Piik 房间做映射，前端用面板
承载 Piik 页面。

- 工作量：组件下载器（可复用 `internal/livekit/component.go`）+ 房间映射 +
  入口 UI，**3–5 天出可用版本**。
- 结果：屏幕共享 100% 是 Piik 跑的，ZViewer 不再维护这条链路。
- 代价：两套房间/成员模型（ZViewer 房间 vs Piik 房间码），两套 UI；
  Piik 页面是独立 origin，登录态、主题、语言都要单独处理。

## 3. 硬约束（两条路都绕不开）

1. **`internal/` 不可 import**。Piik 的包全在 `internal/` 下、模块路径是
   `github.com/TNTcraftHIM/Piik`，`go get` 拿不到。只能 vendor + 重写 import，
   ZViewer 对 `thirdparty/livekit/sendsidebwe` 已经是这个做法。
2. **Piik 客户端是绝对路径**。`/api`、`/signal`、`/assets` 都写死在根，
   要在子路径下部署（`/share-app/`）必须改 Vite `base` 并重编 web assets，
   否则只能给它一个独立 origin（B 方案的做法）。
3. **许可**。Piik 是 MIT，嵌套合法；需要在 `LICENSE` / `NOTICE` 里保留
   Piik 版权声明（现在 `share/forwarding/README.md` 已有，扩到整棵子树）。

## 4. 如果走 A：切片顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| S0 ✅ | vendor 13 个服务端包到 `internal/piik/`，import 重写 | 已完成：`go build ./...` 通过，`internal/piik` 全部测试通过 |
| S1 ✅ | 用 Piik 的 `signal` 起 `/signal` WebSocket，ZViewer 侧只做房间/身份适配 | 已完成：握手 + `authenticate` → `authenticated`，房主/观众/越权三条路径都有用例 |
| S2 ✅ | 用 Piik 的 `route` 控制器替换 `route.go` + 手写树形逻辑 | 已完成：`share.Session` 的直连选路全部走控制器，串行铺路 / 观众互助 / 候选超时都有用例 |
| S3a ✅ | 语音链路改由 Piik 的 `room-voice-*` 承载（服务端本就内建，本次补客户端） | 已完成：房主进语音/发布、观众等待、边下发三条路径都有服务端用例；前端按同一份授权建多连接 P2P；浏览器实测双向音频 |
| S3b-0 ✅ | 用 Piik 原生协议在 `/signal` 上跑通共享会话（服务端可行性） | 已完成：房主 `roomOnly+roomSession` → `start-sharing` → `sharing-started`，观众拿到 `route-update` 的候选边 |
| S3b-1 ✅ | 前端共享的信令通道从 socket.io 换到 `/signal`（`modules/piik-share`） | 已完成：探针页里房主开播、观众收到 1200×676 音视频，SDP 全程走 `signal` 帧 |
| S3b-2 ✅ | 观众互助与换父接上 `route-update` 的候选边 | 互助已通（第 4 人挂到第 3 人，中间节点转发）；换父实测通过（关掉中间节点，子节点 12–15 秒内重挂到别的观众） |
| S3b-3 ✅ | 把产品界面切到新链路 | 默认已切到 Piik：开播、观看、混音、换源、暂停、自动降档、参数覆盖提示都通；`?shareBackend=sfu` 留作逃生舱，删旧实现并入 S5 |
| S4 | 客户端 `webrtc` + `media` + `sfu` 替换 `core/*`，保留 ZViewer 组件层 | 共享、观看、中继、统计面板逐项回归 |
| S5 | 删掉旧实现，去掉双跑开关 | 全量回归 + 打包 |

S0 实际落地的东西：

- `backend-go/internal/piik/`：155 个文件、50,543 行（含上游测试），2.1 MB
- `backend-go/tests/fixtures/wire-samples.json`：Piik 协议样例，`protocol` / `route` 的夹具测试用它
- `internal/piik/{README.md,LICENSE,sync-from-piik.sh}`：来源、许可、同步脚本（幂等，可重跑）
- 与上游三处改动（import 路径、`AdditionalProbeDemand` 字段、删 `recovery_test.go`），
  另加一处新增：`server/signal/zbridge_api.go` 把「校验房主/观众凭证、结束房间」
  开成方法，母本在 `internal/piik/patch/`，同步脚本会重新落位

S1 实际落地的东西（`backend-go/internal/share/piikbridge`）：

- `/signal` 端点，挂在 SPA 回退之前。信令本身是 Piik 的 `signal.Server`，
  内存房间（`room.New`，不另开 SQLite）。
- 房间映射：`POST /api/share/piik/session` 按当前身份签发凭证。身份取自
  `session` 表的活跃角色（房主优先于观众），房主拿 `token`，观众拿
  `viewerGrant`，没进房直接 403。`DELETE` 同路径为房主关房。
- 站点通行证：Piik 的 site access 换成 10 分钟 HttpOnly cookie
  （`zv_piik_site`，`Path=/signal`，HMAC 签名）。WebSocket 升级带不了
  Authorization 头，cookie 是唯一能复述「已通过 ZViewer 鉴权」的通道。
- Origin：Piik 的允许来源是构造期固定集合，ZViewer 会在 127.0.0.1、内网 IP、
  反代域名下被访问，没有启动期白名单。判定改在桥接层做（同源 / CORS 白名单 /
  `*`），命中后把 Origin 规范化再交给 Piik，语义等价。
- 空房回收靠 Piik 的 10 分钟超时；缓存的 token/grant 每次都先校验，
  房间被回收后房主拿新房间码、观众收到 409，不会撞到 `INVALID_TOKEN`。
- 天花板：Piik 单房间观众上限是协议常量 20（`MaxViewersPerRoomLimit`），
  ZViewer 侧不再额外收紧；超过 20 的房间在 S3 需要分层或换成 SFU 模式。

S1 到 S3 之间任何一步都能停，旧实现继续可用（双跑开关）。

### S2 落地的东西（`backend-go/internal/share/piikroute`）

`share.Session` 不再自己算树：直连模式下每一步「谁挂谁」都由
`route.Controller` 决定，`Session.routes` 退化成控制器状态的投影——只记
「我们告诉过客户端什么」（connectionId、阶段、信令往哪转）。中继模式没有
P2P 拓扑，仍走原来的整场扇出。

默认参数 `HostChildren=3 / ViewerChildren=2 / MaxDepth=3`：20 人的满房刚好
铺满（房主 3 + 第二层 6 + 第三层 12）。`SHARE_TREE_*` 可覆盖。

接线时定下的三件事：

1. **接受串行铺路**。控制器一次只开一条候选，后面的人等前面那位结算。
   好处是每个端点的直连拷贝数天然不超预算（协议上限 3），坏处是房间刚开
   时观众是排队上屏的。为此给会话加了候选超时：一条候选 8 秒不回报就作废
   并推下一位，否则一个人卡住会冻住整屋。
2. **不超额**。没有可用上游时不再让房主硬扛，控制器的候选列表空了就报
   `route-exhausted`。树上腾出位置后（有人离开、或某位观众出首帧），下一轮
   调度会重新给这个观众发候选，客户端从失败态自动恢复。
3. **深度用容量表达**。Piik 的控制器只有深度排序，没有 `MaxDepth` 闸门。
   实现在调用方：深度到顶的观众，其 `EffectiveDownstreamCapacity` 置 0。

其余接线细节：

- 端点拷贝预算传协议上限 3（`MaxEndpointMediaCopyCapacity`），否则
  `effectiveCapacity` 会把 `HostChildren=3` clamp 成 2。
- 参与者按入座顺序登记进控制器（`joinOrder`）。控制器按 join order 决定
  先服务谁，遍历 map 的随机顺序会让同一房间每次分配的树都不一样。
- 候选的结算栅栏只看 `connectionId`，不看 revision：revision 是会话级的，
  串行调度下每开一条边就要刷新一次在途候选的版本，反而容易把合法的
  route-ready 挡在栅栏外。connectionId 是每轮新铸的，粒度更细。
- `share.restart{rebuild=true}` 映射成一次候选失败（换上游）；`rebuild=false`
  保留连接身份，交给客户端做 ICE restart。

**天花板**：树容量是 21 人。超过的房间在第 22 位观众加入时必然报
`route-exhausted`——要覆盖更多人就调 `SHARE_TREE_VIEWER_CHILDREN`，或者
整场切到中继。

### S3a 落地的东西（语音）

Piik 的语音实现（`server/signal/voice*.go`，1060 行）随 S0 一起进了子树，
本阶段只是把它接出来：

- **凭证**：`POST /api/voice/piik/session`，与共享用同一间 Piik 房间。分开
  成两个端点只因失败语义不同（共享是「房主还没开播」，语音是「房主还没进
  语音」）。
- **拓扑**：语音复用共享的那棵 route 树——`room-voice-state.connections`
  就是控制器快照里的边。中间节点收到上游音频后原样转给下游，服务端不复制
  媒体。
- **房主是树根**：`roomVoice.enabled()` 要求房主已 join，房主不进语音时
  其他人会收到 `not-enabled`。这是 Piik 的产品语义，没有绕过。
- **端点拷贝预算**调成协议上限 3（原来是默认的 2）：语音的中间节点要多占
  一条上游边，2 条下游撑不满 20 人的房间。

前端新增 `modules/piik-voice`（约 900 行）：

| 文件 | 职责 |
|---|---|
| `protocol.ts` | 线上形状与判定（谁是 offerer、边是否属于我、publication 归属） |
| `signal.ts` | `/signal` 的最小客户端：换凭证、握手、重连、分发 |
| `endpoint.ts` | 一连接一 PC，按 `send`/`receive` 挂轨，中间节点做转发 |
| `usePiikVoice.ts` | 实现 `VoiceChatController`，与 SFU 版共用面板 |

选择哪条链路由 `/api/voice/status` 的 `backend` 决定，两条实现都挂着，
未被选中的那条靠 `enabled=false` 空转（React 要求 hook 序列稳定）。

**能力缺口**（Piik 的语音命令只能作用于本人）：

- 房主不能禁言他人，也不能把成员移出语音。面板上「禁言」退化成「我本地
  不听他」，「移出」直接返回失败提示。要补这两个能力得改 Piik 的协议，
  属于 S5 之后的事。
- 语音与共享必须共用同一条 `/signal` 连接，否则房主的 `authenticate`（带
  `roomOnly`）会把共享停掉。当前共享还在 socket.io 上，两者互不影响；
  S3b 切共享时要先把两条链路合成一条连接。

### 端到端实测（2026-11-03）

S1/S2/S3a 之前只有单测，没有一次真实浏览器联调。这次补齐，顺带发现两个真问题。

| 场景 | 结果 |
|---|---|
| 房主开播 + 1 观众 | 1920×1080 / 20fps / 948 Kbps，直连，观众端播放中 |
| 房主 + 4 观众 | 房主 3 条直连边；第 4 位观众的远端端口等于第 3 位观众的本地端口——观众互助成立 |
| 语音 2 人 | 双向音频，两端 `audioSentBytes`/`audioRecvBytes` 对称增长 |

**修掉的问题**：

1. **观众上行轨被自己摘掉**。`endpoint.reconcile` 把音轨解析器当参数往下传，
   却从没存进成员字段 `this.sourceTrack`；`receiveSignal` 回 answer 前用成员
   字段挂发送轨，拿到的是默认空解析器，于是把它刚挂上的轨 `replaceTrack(null)`
   + `removeTrack` 掉了。表现是「观众能听见房主，房主听不见观众」。
   上一轮那句修复只加了调用、没加赋值，等于把轨摘得更干净。
2. **开发环境的 `/signal` 没有代理**。vite 只代理了 `/api`、`/socket.io`、
   `/live`，升级请求落到 vite 自己身上，浏览器直接连不上 Piik 信令。

### S3b-0：服务端可行性已验证

用 Node 脚本冒充 Piik 客户端直连 `/signal`（不走前端），把共享会话跑通了：

```
房主  authenticate { roomOnly: true, roomSession: true, routePolicy }
      → authenticated { peerId, hostOnline: true }
      → start-sharing { shareGeneration, routePolicy }
      → sharing-started { routeRevision, routeAssignment, qualitySettings }
观众  authenticate { role: "viewer", viewerGrant }
      → route-update { revision: 1, phase: "prepare",
                       assignment: { upstream: { kind: "peer", peerId: 房主 } },
                       candidate: { connectionId: "route_…" } }
房主  → route-update { revision: 1, assignment: { childPeerIds: [观众] },
                       candidate: { connectionId: "route_…" } }
```

**这就够了**：S2 里 `piikroute.Engine` 手算的那套树，Piik 的 router 原生就会算，
而且把候选边连同 `connectionId` 一起下发给两端。共享不再需要 socket.io 的
`share` 事件。

三条协议细节（都踩过）：

- **`roomOnly` + `roomSession` 是「先进房、后开播」的唯一组合**。只传
  `roomSession` 时，认证会自动把 `shareGeneration` 填成 sessionID，随后的
  `start-sharing` 撞上「已有一个 generation」，回 `sharing-start-failed`；
  只传 `roomOnly` 会被 `start-sharing` 拒绝（`Persistent room session is not
  enabled`）。`roomOnly` 还要求同时带 `roomSession`，且认证时会清掉已有共享
  ——这正是「共享和语音必须同一条连接」的根因。
- **`start-sharing` 的 `routePolicy` 是必填字段**，缺了整帧被判 `INVALID_MESSAGE`
  并断连（1008）。
- **服务端会把 `peerOnly` 强制成 `true`**（`sharing-started` 回包里的
  `routePolicy.peerOnly` 与请求值不同）。走这条链路的共享只能是直连模式；
  中继（SFU）要么另开 SFU 会话，要么在桥接层调 `router.sfuOnly`。

**顺带发现的结构性问题**：现在有**两棵互不相干的 route 树**——
`piikroute.Engine` 自己在 S2 里 `route.New()` 了一棵（给共享用），
`signal.Server` 的 `router` 里还有一棵（给语音用）。两边都叫「Piik 的控制器」，
但彼此不知道对方。S3b 之前，同一个观众的共享边和语音边是分别算的，
「语音复用共享那棵树」这句话只是概念上同构，不是同一份状态。

S3b 的真实工作量因此拆成三段（见第 4 节的表格）：

1. `modules/piik-share`：把 `host-session`/`viewer-session` 的信令换成
   `/signal` 上的 `signal` / `route-*` 帧，与 `piik-voice` 共用一条连接；
2. 观众互助与换父按 `route-update` 的 `candidate` 落地（这块 Piik 已经算好，
   客户端只需照做）；
3. 删掉 `service.go`、`session.go`、`route.go`、`piikroute`，共享只留一条链路。

风险点：前端的 `host-peer`/`viewer-peer`（约 1500 行）是自己管 offer/answer
的，接上 Piik 之后「谁该 offer」改由 `route-update` 的父子关系决定，
这一层要重写而不是适配。

### S3b-1：共享跑在 `/signal` 上了

新增两个前端模块：

| 模块 | 职责 |
|---|---|
| `modules/piik-signal/` | `/signal` 的连接层（握手、重连、帧分发）+ 共享与语音共用的线上类型 |
| `modules/piik-share/` | 共享会话：换凭证、`start-sharing`、按 `route-update` 建边 |

`piik-voice/signal.ts` 改成复用 `piik-signal` 的连接层，行为不变（318 项测试全绿）。

验证入口是 `frontend/piik-share-probe.html`（dev 专用，不进构建产物）：

```
房主 /piik-share-probe.html?room=<roomId>&role=host
观众 /piik-share-probe.html?room=<roomId>
```

实测结果：房主采集 1200×676 屏幕流后 `start-sharing` 成功，观众收到
`route-update` 的候选边、收到 offer/answer/candidate、`route-transport-connected`
结算，画面正常播放。整条链路**没有用到 socket.io 的 `share` 事件**。

三个新踩的坑：

- **候选的 `transport` 是 `direct`，不是 `peer`**。语音的 `room-voice-state.connections`
  用 `peer`，共享的 `route-update.candidate` 用 `direct`，两条消息族各有一套枚举。
  照抄语音的类型判断会让所有候选被静默跳过，表现是「两端都收到 route-update，
  但一条 offer 也不发」。
- **观众比房主先到是常态**。房主没 `start-sharing` 之前 Piik 房间还没建，
  REST 对观众一直回 409。客户端不能当成致命错误，要退避重试（上限 30 次）。
- **`roomOnly` 会清掉已有共享**，所以房主必须在**同一条连接**上先 `roomOnly`
  进房、再 `start-sharing`。分两条连接会互相踢。

### S3b-2：观众互助也通了

第 4 位观众在探针里挂到了第 3 位观众下面，画面正常（首帧分辨率从 336 爬到 450，
是 H.264 的自适应起播，不是卡住）。

要凑齐这条链路还差两件事，都是「不发就静默不动」的类型：

- **`route-ready` 才是结算**。`route-transport-connected` 只把候选推进到「传输就绪」，
  真正让 controller 认下这条边的是 `route-ready { revision, phase: "prepare" }`。
  只发前者时房主的 `childPeerIds` 一直是空的，后续观众要等 15 秒操作超时才轮到。
- **观众必须发 `relay-capacity`**。不发的话服务端把它的下游容量当 0，树永远只有
  房主一层，第 4 位观众一直排队等不到候选。
- 中间节点要自己转发：观众当父节点时，offer 里挂的是**上游推过来的轨**（`incoming`），
  不是本地流。首帧晚于 offer 的情况下还要等 `ontrack` 再补 `addTrack`。

换父（父节点离开后重挂）也已验证：4 个观众形成 3+1，关掉中间的观众，
它的子节点在 12–15 秒内收到新的 `prepare`、旧边关闭、新父（另一个观众）
发来 offer、画面从 336 恢复到 450。这段时间几乎全花在 ICE 判死
（`disconnected` → `failed`）上，不是选路本身慢。

换父这条路上还有两个容易写错的地方：

- **关旧边不能报 `route-failed`**。旧父掉线时 PC 会失败，但如果这时候
  还照常上报，controller 会把刚做的重新分配一起判死，子节点反复重连不上。
  Piik 上游的 `reportActivePeerRouteFailure` 只在「当前上游仍是这条边的
  对端」时才发，这里照这个语义实现：换父后旧边静默关闭。
- **`incoming` 必须随换父复位**。中间节点转发给下游的是上游的 `MediaStream`；
  换父后旧流已经作废，不复位的话下游会一直收到冻结的最后一帧。

## 5. 如果走 B：最小可用链路

1. 组件库加 `piik_<ver>_windows_amd64.zip`（约 30 MB，含 web assets）。
2. `internal/piik/component.go`：下载、解压、拉起、健康检查（照抄 livekit 那套）。
3. 后端：`POST /api/share/piik/room` 调 Piik `/api/rooms` 建房，返回房间码与邀请链接。
4. 前端：共享页新增「Piik 共享」子模式，iframe 载入 `http://127.0.0.1:<port>/r/<code>`。
5. 房间关闭时回收 Piik 房间。

### S3b-3：产品页切到新链路（默认已换）

`WebrtcSharePage` / `WebrtcWatchPage` 各加了一个同形的 hook
（`usePiikShareHost` / `usePiikShareViewer`），两条链路并存，默认仍走旧的
socket.io。开关是 `?shareBackend=piik` 或 localStorage，坑在于
`/share/<id>` 会被重定向到 `/room/<id>`，query 活不过重定向——开关必须在
`main.tsx` 里、路由之前落到 localStorage。

产品页实测（真实 `/room/<id>` 与 `/watch/<id>`）：

- 房主本地预览 1920×1080 播放中，观众 480×270 → 640×360 自适应上升
- 开麦克风后两端都出现 `audio:live`（`HostAudio` 的输出轨）
- 换源走 `replaceTrack`，观众端无感；暂停发 `set-sharing-paused`

原先切默认缺的两块已经补上（都不走 Piik 的 `sender-quality-evidence`，
改用本机采样，理由见下）：

- **自动降档**：`ShareHealthMonitor` 每 2 秒采一次**每条出边**的
  `outbound-rtp.framesEncoded` 与 `media-source.frames`，复用旧链路那份
  稳态判据（`core/encoder-health`）；连续两个窗口编不动就降一档，每个
  代际最多降一档。降档只改发送参数里的 `scaleResolutionDownBy`，**不重新
  采集**——共享屏幕重开会再弹一次画面选择器，观众端还要黑一帧。
- **编码参数覆盖检测**：`applyEncoding` 改走 `configureVideoSender`
  （自带 setParameters 回读），把 `mismatches` 汇总进 `parameterOverride`，
  页面沿用 `parameterOverrideText` 的提示。

为什么不用 Piik 的 `sender-quality-evidence`：那是一条要经过服务端转发、
由观众上报的通道，链路还没在共享面上打通；而编码器跟不跟得上只有房主
本机的编码统计能回答（CPU 受限也是本地 `qualityLimitationReason` 的硬证据），
先落地本地采样不影响以后接证据通道。

### 切默认做了什么

`shareBackend()` 的默认值从 `sfu` 改成 `piik`，`?shareBackend=sfu` 仍然有效
（落 localStorage，逃生舱留一个版本）。单纯改默认值是不够的：Piik 桥接层是
进程内起的，起不来（端口被占、组件缺失）时 `/signal` 只回 503，默认切过去就
等于「所有人都不能共享」。所以补了两层：

- 后端 `GET /api/share/capabilities` 回 `{ piik: bool }`，只看桥接层是否挂上，
  不需要鉴权、不含凭证。
- 前端 `useShareBackend` 在挂载后探一次：**只有回报 `piik: false` 才退回旧链路**
  并提示一句；返回 null（断网、老服务端没这个端点）按「不知道」处理，继续用
  默认链路——探不到就降级等于把偶发网络抖动变成链路漂移。
- 用户显式指定过（query / localStorage）就不覆盖：他要排查哪条链路，就该跑
  哪条，哪怕跑不通。

切换后暴露的一个老问题也顺手修了：**观众比房主先到不该算错误**。Piik 的凭证
端点在没有房间时回 409，原先连接层一律当致命错误上报，观众一进房就是红字
（旧链路里这是「等待房主开始共享」）。现在 409 带 `HOST_NOT_SHARING`，
凭证错误类据此标 `retriable`，连接层只退避重试、不报错，页面停在「等待房主
开始共享」；重试到上限（30 次，约两分钟）才把话说明白。

已知限制：逃生舱是**每台浏览器**的开关。房主切回 `sfu` 而观众仍是默认 `piik`
时，观众会一直等（拿不到 Piik 房间）。回滚要房主和观众一起切，或者直接把
代码回退——这也是删旧实现之前要先跑一个观察期的原因。

删旧实现没有跟着做：`service.go` / `session.go` / `piikroute` / 前端
`core/host-*.ts`、`core/viewer-*.ts` 是一整块（约 3.4 万行），旧链路的
socket.io 服务端与 `piikroute` 互相引用，拆一半会让两边都编译不过。它跟着
S5 一起走，前置条件是默认切换后跑过一个版本的观察期。

### S5 删除清单（留给观察期之后）

拆不动的原因是这几块互相咬住，删一半两边都编译不过。逐项点清之后规模如下：

**后端**（约 6.5k 行含测试）

| 删 | 保留 |
|---|---|
| `internal/share/{service,session,route,relay,protocol,sfu_handlers}.go` 及同名测试 | `internal/share/piikbridge`（新链路） |
| `internal/share/{forwarding,encoded,ordered}/` | `internal/share/sfu`——**不能跟着删**：`internal/voicertc` 的语音中继也在用它 |
| `internal/share/piikroute`（只被 `share/route.go` 引用） | `internal/piik/`（vendor 的上游） |

咬住的点只有四处，都在装配层：

- `internal/room/state.go`：`shareSvc` 字段、`share.NewService`、`Share()` 访问器、
  关房时的 `DropRoom`、`deps.ShareRelay.SetRouteFailed`
- `internal/room/handlers.go`：断线时 `s.shareSvc.Detach(socketID)`
- `internal/room/webrtc_handlers.go`：旧信令入口
- `cmd/zviewer-server/main.go`：`share.NewRelay`、`share.TreePolicy`、socket 事件 `share.Event`

**前端**（约 5.2k 行）

`modules/screen-sharing/core/{host-peer,host-session,viewer-peer,viewer-session,stats,nat-prediction,presentation,connection-op}.ts`
与 `hooks/{useShareHost,useShareViewer}.ts`。组件层（`WebrtcSharePage` /
`WebrtcWatchPage` / 控制栏 / 统计面板）、`core/{capture,audio-mix,quality,encoder-health}`、
`hooks/useJoinRoom`（房间层）都留——新链路也在用。

顺序建议：后端先删（前端已经有 `?shareBackend=sfu` 的降级路径，后端删掉后
旧链路自然不可达），再删前端的那 10 个文件与 `useShareBackend` 里的 sfu 分支，
最后去掉 `backend.ts` 与开关本身。

## 6. 待定

- 走 A（已定：S0/S1 按 A 推进）。
- 信令通道（已定：新增 `/signal` 端点，不往 socket.io 里塞 Piik 帧）。
- S3b 起要回答的：
  - Piik 的 `room.Store` 当前是纯内存，ZViewer 重启后所有映射失效。是否接
    `room.NewDatabase`（另开一个 SQLite 文件），还是接受「重启即重新开播」。
  - ZViewer 房间容量上限（`maxViewers` 可配）与 Piik 的 20 人协议常量冲突，
    超过 20 人的房间要么分片、要么强制走 SFU 模式。
  - 房间删除/关闭目前只靠空房超时回收，`room.Service` 里没有可订阅的关闭事件；
    S3b 接房间生命周期时补一个显式 `Release`。
  - 语音的「房主禁言/移出」需要扩展 Piik 的 `RoomVoiceCommand`（现在是
    只对本人生效的五个动作），改上游还是走桥接层的旁路要定一下。
