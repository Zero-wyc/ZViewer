# share/forwarding —— 从 Piik 移植的转发内核

本目录、`../encoded`、`../inputroute`、`../../diagnostics` 与
`../../thirdparty/livekit/sendsidebwe` 全部来自
[Piik](https://github.com/TNTcraftHIM/Piik)（MIT 许可）的
`internal/media/forwarding`、`internal/media/encoded`、`internal/media/inputroute`、
`internal/diagnostics`、`internal/thirdparty/livekit/sendsidebwe`。
`sendsidebwe` 上游是 LiveKit（Apache-2.0），`LICENSE` / `NOTICE` 一并保留在
`../../thirdparty/livekit/`。

改动只有两处：

1. import 路径从 `github.com/TNTcraftHIM/Piik/...` 改为 `zviewer/backend/...`。
2. `publication.go` 去掉了 `streamallocator.StreamAllocatorParams` 的
   `AdditionalProbeDemand` 字段——那是 Piik 用的 livekit-server 个人 fork 才有的
   扩展。ZViewer 依赖上游 `github.com/livekit/livekit-server v1.13.11`，没有该字段，
   影响仅是探测略保守：转发、带宽估计、分层分配路径与 Piik 一致。

Piik 自带的测试一并移植（`recovery_test.go` 除外，它依赖 Piik 桌面端的
`nativeaudio`）：`go test ./internal/share/forwarding/` 是这批代码的主要回归手段，
改动这里之前先跑它。
