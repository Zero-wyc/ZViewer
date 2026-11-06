# internal/piik —— Piik 服务端媒体面（原样搬迁）

本目录是 [Piik](https://github.com/TNTcraftHIM/Piik)（MIT）服务端共享链路的
**完整子树**，上游提交 `72ca6f2bc97df88e216a392721250309aa53bc39`。
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

## 注意

- 这是**并行存在**的子树：旧的 `internal/share/*` 仍在服务当前线上链路，
  两边会同时编译。迁移完成后再删旧实现，别提前互相引用。
- 上游 Piik 的 `route` / `signal` 是围绕它自己的 `room`、`config`、WebSocket
  会话设计的，接进 ZViewer 需要一层适配（房间映射、身份、事件桥），
  适配代码不要写进本目录，放在 `internal/share/piikbridge`。
