# 迁移清单

> 基线：`backend/src` 共 220 个 `.ts` / 42,653 行 / 约 300 个 HTTP 端点 / 16 张表。
> 本文件是执行台账：每完成一个单元就在状态列打勾，并写一句验收口径。

## 一、总体进度

| 维度 | 已完成 | 总量 | 覆盖率 |
|---|---:|---:|---:|
| 代码行 | ~1,600 | 42,653 | 3.8% |
| HTTP 端点 | 8 | ~300 | 2.7% |
| 数据库表 | 3（user / system_settings / audit_logs 只读为主） | 16 | 19% |

## 二、阶段 0：基座（已完成）

| 单元 | Go 包 | 状态 | 验收口径 |
|---|---|---|---|
| 环境变量与路径 | `internal/config` | ✅ | `PROJECT_ROOT` / `CONFIG_DIR` / `DATABASE_URL` 与 `services/paths.ts` 同结果 |
| `.env` 加载 | `internal/config` | ✅ | 不覆盖已有 env，支持 `export` 与引号 |
| SQLite 连接 | `internal/db` | ✅ | 能只读打开现有 `dev.sqlite`，16 表全识别 |
| Schema 守卫 | `internal/db` | ✅ | 缺表/缺列时启动失败并列出差异，不自行建表 |
| JWT | `internal/auth` | ✅ | Node 与 Go 双向验签通过（`scripts/compat-smoke.sh`） |
| bcrypt | `internal/auth` | ✅ | 校验 bcryptjs `$2b$` 哈希（`tokens_test.go`） |
| Cookie 语义 | `internal/auth` | ✅ | HTTP 不写 cookie；HTTPS 同站 Lax / 跨站 None+Secure |
| CORS / 日志 / panic 恢复 | `internal/api` | ✅ | 反射 Origin + credentials；`/api/` 访问日志 |
| 健康检查 | `internal/api` | ✅ | `startedAt` 为毫秒数字 |
| 静态资源 + SPA 回退 | `internal/api` | ✅ | 头像 7d、`/ffmpeg/` 1y；未知 `/api/` 返回 404 JSON |
| 鉴权接口 | `internal/api` | ✅ | login / register / guest / refresh / logout / me / registration-mode / public-settings |

## 三、阶段 1：鉴权收尾（下一步，约 3 人日）

| 单元 | 源文件 | 状态 | 备注 |
|---|---|---|---|
| 修改密码 | `routes/auth.ts` PATCH `/password` | ⏳ | 必须同时更新 `tokenInvalidBefore` 并吊销旧 token |
| 修改资料 | PATCH `/profile` | ⏳ | 用户名唯一性校验与现有逻辑一致 |
| 头像上传/删除 | POST `/avatar`、DELETE | ⏳ | 依赖 multipart，落盘 `<AVATARS_DIR>/<id>-<ts>.<ext>` |
| 登录失败锁 | `middleware/rate-limit.ts` | ⏳ | 默认关闭（`ENABLE_LOGIN_LOCK`），可最后做 |
| 管理员用户管理 | `routes/admin.ts` | ⏳ | 与 admin 模块一起迁，勿单独拆 |

## 四、阶段 2：无状态解析（约 45 人日）

这些模块**不碰库**（B 站凭证通过后续的 credential 接口拿），最适合先迁，
风险低、收益直接（占后端 CPU 与带宽的大头）。

| 单元 | TS 行数（估） | Go 包（拟） | 状态 |
|---|---:|---|---|
| HTTP 反代 + 防抖代理 | ~1,240 | `internal/proxy` | ⏳ |
| B 站解析（wbi/playurl/pgc/vip/cdn/弹幕/字幕） | ~5,900 | `internal/bilibili` | ⏳ |
| 动漫源（kazumi 规则引擎 / anime / anisubs / cms） | ~5,400 | `internal/anime` | ⏳ |
| 弹幕源（bilibili / bahamut / dandanplay） | ~1,460 | `internal/danmaku` | ⏳ |
| 字幕源 | ~1,000 | `internal/subtitle` | ⏳ |
| LiveKit WS 隧道 + 凭证 | ~1,200 | `internal/voice` | ⏳ |

## 五、阶段 3：实时核心（约 60 人日，最重）

| 单元 | TS 行数（估） | 状态 | 卡点 |
|---|---:|---|---|
| Socket.IO 兼容层 | （基础，非业务） | ⏳ | **Go 侧 v4 协议需先做 spike 验证** |
| 房间 / 权限 / 成员 | ~2,300 | ⏳ | |
| 影片列表 / 当前播放 | ~1,100 | ⏳ | |
| 观众端同步状态机 | ~1,800 | ⏳ | 必须走 `resolveViewerEffectiveState` |
| 评论 / 弹幕广播 | ~1,200 | ⏳ | |
| 共享播放记忆 | ~1,550 | ⏳ | |
| WebRTC 信令 | ~280 | ⏳ | |
| 推流（NMS → mediamtx/lal） | ~580 | ⏳ | 需复刻推流鉴权与 `stream-status` |

## 六、阶段 4：挂载源与系统（约 50 人日）

| 单元 | TS 行数（估） | 状态 |
|---|---:|---|
| WebDAV / OpenList / FTP | ~2,300 | ⏳ |
| Emby / Jellyfin 协议仿真 | ~1,250 | ⏳ |
| 服务器文件浏览 | ~1,200 | ⏳ |
| 一起听音乐（含 NCM） | ~3,170 | ⏳ |
| 管理端 / 统计 / 客户端日志 | ~900 | ⏳ |
| 更新器（下载/解压/sha256） | ~1,400 | ⏳ |
| ACME / 自签证书 | ~1,020 | ⏳ |
| CLI 代理端点 | ~280 | ⏳ |

---

## 七、必须保留的行为不变量

重写最容易丢的不是代码，是**为什么这么写**。以下每条都对应一处曾经踩过的坑，
移植时不得"顺手优化"掉：

| 不变量 | 出处 | 后果 |
|---|---|---|
| VIP 清晰度过滤的唯一事实源在后端 `permission.ts`，前端不再二次过滤 | `services/bilibili/permission.ts` | 前端再过滤会导致会员可用清晰度被误杀 |
| 观众端挂载必须走 `resolveViewerEffectiveState` | `modules/viewer` | 绕过它会让观众看到与房主不一致的源 |
| 新增影响引擎/源的 state 字段时，`isStateEqual` 必须比较它 | 同步状态机 | 否则观众端广播被判定"等价"而跳过，不重挂载 |
| 解析身份默认锚定房主（`useHostCookie=true`） | `services/bilibili/credential.ts` | 改成观众身份会让普通用户解析失败 |
| PGC 试看：badge 非空且非大会员时强制 MP4，时长取 `durl[0].length` | `services/bilibili/pgc.ts` | 否则试看片段时长显示错误 |
| CLI `/resolve` 的 UGC 分支必须有 cid，只给 bvid 直接 400 | `ZViewerCLI`（独立仓库） | 去掉这步首解析必然失败并回退服务器端 |
| 影片级 `serverProxy` / `playsvideoEnabled` 改动后要触发源重载 | `MovieRuntimeSettings` | 否则开关改了不生效 |
| 三类数据源（anime/kazumi/cms）都有 `serverProxy`；Kazumi 必须落 `sourceMeta` | 添加影片流程 | 缺 meta 只能靠 URL 解包回退，Referer/UA 会丢 |
| 推流鉴权按 `streamKey` 查 Room 且校验为 `stream-push` 子模式 | `modules/stream-push` | 直接用 roomId 会泄露房间号且无法独立轮换密钥 |
| 语音通道不设 UDP/TCP 开关，服务端恒发两条候选 | `livekit` 配置 | 加开关会让本该走 UDP 的场景退化 |
| HTTP 请求不写 auth cookie | `middleware/auth.ts` | 非 Secure 的 `SameSite=None` 会被浏览器丢弃，登录死循环 |
| 桌面托管时 `/api/system/update/*` 返回 409 | `services/desktop-runtime.ts` | 网页更新只换后端产物，会与 GUI 整包版本脱节 |

## 八、每个单元的完成定义（DoD）

1. `go build ./...` 与 `go vet ./...` 干净；
2. 有单元测试覆盖核心分支（尤其是错误分支）；
3. 与 Node 版对同一输入的响应**逐字段相等**（含错误文案）；
4. 涉及的库表读写不改变 schema；
5. 在 `MIGRATION.md` 的状态列打勾，并补一句验收口径。

## 九、切换检查单（阶段 5）

- [ ] 全部端点覆盖，Go 侧 `/api/*` 无 404 兜底命中
- [ ] 停 Node 进程 → 仅 Go 运行 24h 无告警
- [ ] `config/` 目录双向兼容验证：Go 写入后 Node 仍能读（回滚保障）
- [ ] 前端全链路回归（首页 / 房间 / 一起听 / 管理端）
- [ ] 桌面壳改为同进程内嵌，删除 `ZVIEWER_DESKTOP` 注入与 409 分支
- [ ] 删除 `backend/` 与 `node_modules`
