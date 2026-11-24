# internal/piik —— Piik 服务端媒体面（原样搬迁）

本目录是 [Piik](https://github.com/TNTcraftHIM/Piik)（MIT）服务端共享链路的
**完整子树**，上游提交 `e79e658d5f2430e2b40534b1dfe20b2d20d344b0`（2026-11-25 同步）。
目标是把 ZViewer 屏幕共享的控制面从「照语义重写」换成「就跑 Piik 这份」。

## 收录范围

| 本目录 | 上游 |
|---|---|
| `server/protocol` | `internal/server/protocol` |
| `server/route` | `internal/server/route`（路由控制器、候选、树形策略） |
| `server/signal` | `internal/server/signal`（`/signal` WebSocket 信令） |
| `server/sfu` | `internal/server/sfu` |
| `server/room` | `internal/server/room`（房间与会话模型） |
| `server/config` | `internal/server/config` |
| `server/ordered` | `internal/server/ordered` |
| `media/forwarding` | `internal/media/forwarding`（含音频出站） |
| `media/encoded` | `internal/media/encoded` |
| `media/inputroute` | `internal/media/inputroute` |
| `tlsconfig` | `internal/tlsconfig` |
| `tests/fixtures`（在 `backend-go/tests/`） | `tests/fixtures` |

`internal/diagnostics` 与 `internal/thirdparty/livekit/sendsidebwe` 两项 ZViewer
本来就有且与上游逐字节一致，没有重复收录；import 已指到既有路径。

## 与上游的差异（三处修改 + 一处新增，全部是编译或路径原因）

1. import 路径：`github.com/TNTcraftHIM/Piik/internal/...` →
   `zviewer/backend/internal/piik/...`。
2. `media/forwarding/publication.go` 去掉 `AdditionalProbeDemand` 字段：
   该字段只存在于 Piik 钉的 livekit-server 伪版本，ZViewer 固定在
   `v1.13.11`。影响仅是编码器探测略保守，转发与带宽估计路径不变。
3. 删除 `media/forwarding/recovery_test.go`（依赖 `thesyncim/gopus`，
   会把 `go` 指令抬到 1.27）；测试夹具路径从 `../../../tests` 改为
   `../../../../tests`，因为子树多了一层 `piik/`。
4. 新增 `server/signal/zbridge_api.go`（母本在 `patch/zbridge_api.go.tmpl`）：
   把「房主凭证校验 / 观众 grant 校验 / 结束房间」三个动作开成方法。
   上游的 `*room.Store` 只在 `signal.Server.mu` 内安全，桥接层无法自己去碰，
   所以只能由这一侧开口；不改任何上游函数。

## 更新上游

```bash
./internal/piik/sync-from-piik.sh /path/to/Piik <commit>
```

脚本会重新拷贝、重写 import、修正夹具路径、落位上面第 4 条的新增文件，
然后你可以直接 `go test ./internal/piik/...` 看是否还对得上。

### 同步记录

| 日期 | 上游 commit | 带进来的东西 |
|---|---|---|
| 2026-11-25 | `e79e658d` | 中继志愿容量语义（`roomCapacity`、`settings`/`physicalCapacity`）、`SourceVideoReady` 参与观众 presence 与候选判定、中继断开后的房间重建、`peerRestartAuthorized` 收紧换父重启授权、UDP 媒体套接字 2 MB 收缓冲、pacing 余量常量化、候选淘汰的 debug 原因、超载子节点优先迁走 |

本次同步后与上游的差异仍是上面四条，没有新增（`AdditionalProbeDemand` 的形状
未变，`recovery_test.go` 仍被脚本删除）。协议版本保持 `piik-v24`，`wire-samples.json`
未变，前端 `piik-signal` 的下行是宽松解码，新增字段不会打断现有链路。

## 注意

- 桥接层（`internal/share/piikbridge`）只通过 `server/signal` 的公开面驱动本子树，
  不要反过来让本目录 import 桥接层——同步脚本会整目录覆盖，任何写在这里的
  本地逻辑都会在下次同步时丢掉。
- 上游 Piik 的 `route` / `signal` 是围绕它自己的 `room`、`config`、WebSocket
  会话设计的，接进 ZViewer 需要一层适配（房间映射、身份、事件桥），
  适配代码不要写进本目录，放在 `internal/share/piikbridge`。
