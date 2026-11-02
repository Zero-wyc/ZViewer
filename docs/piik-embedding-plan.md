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
| S2 | 用 Piik 的 `route` 控制器替换 `route.go` + 手写树形逻辑 | 引擎已建（`internal/share/piikroute`），**未接线**：等端点拷贝语义确认 |
| S3 | 用 Piik 的 `room` / `signal` 会话替换 `service.go` / `session.go` | 双端联调：房主开播、观众进房、换父、断线重连 |
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

### S2 现状：引擎已验证，接线卡在一个产品语义上

`internal/share/piikroute` 已经用 `route.Controller` 跑通 ZViewer 的选路场景
（4 项用例），但还没有接进 `share.Session`。原因是实测出一个绕不开的差别：

**Piik 每个端点的直连拷贝数上限是 3**（`protocol.MaxEndpointMediaCopyCapacity`，
控制器 `effectiveCapacity` 直接 clamp）。实测：

| 场景 | 结果 |
|---|---|
| 单层星形（`MaxDepth=1`，20 位观众） | 只有 2 位挂上，其余没有上游 |
| 树形（`HostChildren=3, ViewerChildren=3, MaxDepth=4`，20 位观众） | 20 位全部挂上，房主直连 2 条 |

也就是说 ZViewer 现在的默认策略（`HostChildren=0` 不限、观众不当父节点）在
Piik 的模型里**不存在**：房主直连超过 3 人就必须靠观众互助或 SFU。

连带的三处行为差别：

1. **串行铺路**：控制器一次只允许一个在途操作，第 3 位观众要等前两位之一提交。
   ZViewer 现在是「缺几条就同时发几条」。
2. **不超额**：没有可用上游时控制器让观众等着（Piik 会转 SFU），
   ZViewer 现在是「宁可让房主超额，也不让观众没画面」。
3. **深度不是硬上限**：Piik 只有深度排序，没有 `MaxDepth` 这种闸门；
   现在的做法是「超过 MaxDepth 就把该节点的下游容量设为 0」来模拟。

所以接线前要定的是策略而不是代码：默认树形参数取多少、超额时是等还是降级到
中继。这两条定下来，`Session` / `Service` 的改造才有唯一答案。

## 5. 如果走 B：最小可用链路

1. 组件库加 `piik_<ver>_windows_amd64.zip`（约 30 MB，含 web assets）。
2. `internal/piik/component.go`：下载、解压、拉起、健康检查（照抄 livekit 那套）。
3. 后端：`POST /api/share/piik/room` 调 Piik `/api/rooms` 建房，返回房间码与邀请链接。
4. 前端：共享页新增「Piik 共享」子模式，iframe 载入 `http://127.0.0.1:<port>/r/<code>`。
5. 房间关闭时回收 Piik 房间。

## 6. 待定

- 走 A（已定：S0/S1 按 A 推进）。
- 信令通道（已定：新增 `/signal` 端点，不往 socket.io 里塞 Piik 帧）。
- S2 起要回答的：
  - Piik 的 `room.Store` 当前是纯内存，ZViewer 重启后所有映射失效。是否接
    `room.NewDatabase`（另开一个 SQLite 文件），还是接受「重启即重新开播」。
  - ZViewer 房间容量上限（`maxViewers` 可配）与 Piik 的 20 人协议常量冲突，
    超过 20 人的房间要么分片、要么强制走 SFU 模式。
  - 房间删除/关闭目前只靠空房超时回收，`room.Service` 里没有可订阅的关闭事件；
    S3 接房间生命周期时补一个显式 `Release`。
