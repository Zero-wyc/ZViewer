# ZViewer 代码结构与质量分析报告

> 生成时间：2026-10-17 · 分析范围：frontend/src + backend/src（合计约 5.5 万行 TS/TSX）

---

## 一、整体结构与依赖关系

### 1.1 目录职责现状

| 层 | 位置 | 现状 |
|---|---|---|
| 前端页面层 | `frontend/src/pages` | 8 个页面，多数是薄壳；`AdminPage`(2515行)、`ProfilePage`(1399行) 例外，内部堆满业务 |
| 前端业务模块 | `frontend/src/modules/*`（26 个） | music 独大（84 文件 / 31588 行，超过其余模块之和 3 倍）；room/watch-together 实际承担了"共享层"角色 |
| 前端通用层 | `components`、`hooks`、`lib`、`store` | 基本健康；但 `components` 有 4 个文件反向依赖业务模块 |
| 后端路由层 | `backend/src/routes`（24 文件） | **普遍"路由+业务+数据访问"三层混写**，14 个文件直接操作 `AppDataSource` |
| 后端服务层 | `backend/src/services`、`modules` | `services/bilibili/*` 拆分良好（正面样板）；`modules/voice-chat` 反向导出路由层（违例） |

### 1.2 依赖关系要点

**健康的部分：**
- `services/bilibili/`（client/video/playurl/pgc/cdn/wbi/credential/subtitle 各一职），resolver 通过参数收 cookie 不碰 DB，依赖方向正确；
- 前端 `webdav/openlist/ftp` 三者的 Browser 是 29 行薄壳，统一复用 `mounts/MountBrowserBase`；`openlistApi` 由 `createMountApi` 工厂生成；`JellyfinBrowser` 直接复用 `EmbyBrowser`；
- 前端 `bilibiliApi.ts` 是纯 HTTP 客户端，B站解析逻辑未在前端重复实现（除个别常量，见重复代码节）。

**被破坏的部分（6 组前端循环依赖）：**

| 环 | 触点 |
|---|---|
| room ↔ bilibili | `bilibili/useBilibiliQuality.ts:19` import room 的 movie-source-resolver |
| music ↔ room | `room/RoomPage.tsx:25` import music；music/store、useListenTogether import room/watch-together |
| playback-memory ↔ sync-playback | `useServerHeartbeat.ts:26` ↔ `useViewerSync.ts:33` |
| mounts ↔ webdav/openlist/ftp | `MountFormModal.tsx:16-37` import 各源 api；各源 Browser 反向 import MountBrowserBase |
| kazumi/cms/anisubs ↔ room | 各 Selector import room 的 AnimeSourceBrowser，room 又反向 import Selector |
| components → modules（通用层反向依赖业务） | `CommentPanel`、`DanmakuLayer`、`VideoPlayer/SettingsPanel`、`VideoStatsMenu` 依赖 room/danmaku/screen-sharing/player |

**后端依赖违例：**
- `routes/admin.ts:9 → '../index'`：**唯一的真循环依赖**（index import adminRoutes，admin 反向取 `deleteRoomAndRelations` 和 re-export 的 `getSystemSettings`）；
- `modules/voice-chat/index.ts:7` 反向 `export { voiceRoutes } from '../../routes/voice.routes'`（模块层依赖路由层，方向颠倒）;
- `routes/serverFiles.ts:49 → routes/stream/helpers`（路由横向依赖）；
- `store/roomStore.ts`(783行) 被 pages/components/hooks/modules 共 45+ 文件消费，是隐形全局耦合总线。

---

## 二、问题一：单文件过大、职责过多

### 2.1 前端 Top 榜（问题严重度排序）

| 文件 | 行数 | 核心问题 |
|---|---|---|
| `modules/music/pages/MusicBilibiliPage.tsx` | 3577 | 至少 6 块职责：localStorage 持久化层(114-479)、SWR 缓存+取数引擎(481-584)、主组件(769-3025，约40个 useState)、3 个弹窗子组件(3027-3577)。文件内两组拖拽 handler 逐行同构(1228-1290 vs 1398-1460)，三套"词列表增删+scope切换"逻辑同构 |
| `modules/room/components/MoviePushPanel.tsx` | 2941 | **耦合最严重**：import 横跨 11 个媒体源模块 + 3 个 store；293 行的 `handleAddMovie` 含 8 个 sourceType 分支；470 行内联 JSX 渲染函数；B站扫码登录块(242-391)与 ProfilePage 几乎逐行相同；CLI 解析回退 try-catch 模板在文件内出现 5 次(~250行) |
| `modules/music/hooks/useListenTogether.ts` | 2530 | 5 块职责：B站音频 TTL 缓存层(84-279)、音频元素生命周期(378-961)、队列推进引擎(611-803)、私人FM集成、房间同步协议(6个 socket 事件单 effect 277行)。21 个 useRef / 36 个 useCallback |
| `pages/AdminPage.tsx` | 2515 | **30 个 useState 平铺、零子组件**，两个 tab 约 1350 行 JSX 全内联；SSE 流解析逻辑内部重复实现两遍；4 个房间管理 handler 结构完全一致 |
| `modules/room/watch-together/WatchTogetherCore.tsx` | 2069 | **27 个 useEffect**（六文件之最）；观众 seek/pause/play 三套申请审批是同一模板的三次实例化(可省~400行)；弹幕系统(~250行)、控制栏显隐状态机(120行)均可独立成 hook；SettingsPanel 传入 28 个 props |
| `pages/ProfilePage.tsx` | 1399 | B站/网易云 Cookie 登录两套完全平行实现(~280行)；B站扫码块与 MoviePushPanel 重复(~300行×2)；28 个 useState、无子组件 |
| `components/Header.tsx` | 1159 | 顶栏里塞了主题设置面板(~300行)、用户菜单、后端地址弹窗(~190行，含混合内容检测与运维文档 JSX)三块无关职责 |
| `modules/subtitles/mkv-embedded.ts` | 1334 | 职责单一、质量最高；仅稀疏 worker 循环重复两遍(612-650 vs 1193-1244)、时间码格式化重复 |

### 2.2 后端 Top 榜

| 文件 | 行数 | 核心问题 |
|---|---|---|
| `routes/stream/bilibili-auth.ts` | 1775 | 实际是"B站账号域完整业务层"错放在 routes/：含 70 处 B站 API 调用、**5 个模块级手写缓存**、URL 解析器、短链展开。同目录 `resolve.ts` 已示范正确做法（v2 重构），此文件未跟进 |
| `routes/music.ts` | 1409 | 无 music.service，REST 业务全堆路由里：手写 TTL 缓存×2（`utils/ttl-cache.ts` 已存在却不用）、`optionalAuth` 复制 auth 中间件、135 行 NCM 代理网关、100 行 VIP 三档判定写在路由回调里、**FLAC 二进制解析**(1252-1274)这种最底层逻辑也在路由文件 |
| `services/bilibili/resolver.ts` | 1113 | 分层正确但 UGC(760-1096) 与 PGC(418-755) 两条 ~340 行平行分支：MP4 回退、降级重试、CDN 选择、错误文案各写两遍 |
| `services/updater/index.ts` | 1110 | 三个巨型脚本字符串模板(160行bat + 139行sh + 112行sh)，Docker/Linux 版 ~70% 相同；版本比较未处理 prerelease 后缀（NaN 静默当 0 的 bug） |
| `routes/serverFiles.ts` | 945 | multer 配置、通用流式下载器 `downloadToFile`、`/bilibili-download` 完整业务编排(807-943) 全在一个路由文件 |
| `routes/index.ts`（根启动文件） | 711 | 级联删除服务(108-157)、定时清理任务、种子数据、流量日志中间件、LiveKit 字节隧道、手写 cookie 解析器、优雅停机全塞在启动文件 |

---

## 三、问题二：代码质量（可读性 / 可维护性 / 耦合）

### 3.1 后端分层破坏（最高优先级）

1. **admin.ts ↔ index.ts 循环依赖**：`deleteRoomAndRelations`（操作 7 张表的房间域业务）应迁入 `modules/room/`，斩断唯一真循环依赖。
2. **14 个路由文件直接 `AppDataSource.getRepository(...)` 写库**：如 `music.ts:782/811/1057`、`emby.ts:70-72`（GET 请求里回写 DB）、`subtitles.ts:106-109`（跨用户查凭证）。
3. **缓存散落无统一层**：TtlCache/手写 Map 分布在 6+ 文件（bilibili-auth ×5、music ×2、openlist、kazumi…），淘汰策略各自为政；`music.ts` 两套手写缓存与已有 `utils/ttl-cache.ts` 重复。

### 3.2 前端结构问题

1. **room/watch-together 与 room/components 实为共享层却放在业务模块里**，是 6 组模块循环依赖的根因（bilibili/music/kazumi/cms/anisubs 都要 import 它）。
2. **`components/` 通用层反向依赖业务模块**（弹幕/房间域 4 个文件）。
3. **store 作为全局总线**：roomStore 被 45+ 文件消费，修改其结构影响面不可控。
4. **React 反模式**：AdminPage 30 个平铺 useState 无拆分；WatchTogetherCore 27 个 effect；MoviePushPanel 手写 Switch（项目已有 `ui/Switch` 组件）。
5. **潜在 bug**：`updater/index.ts` 的 `compareVersions`(205-216) 对 `1.2.0-beta.1` 会 NaN 静默当 0。

---

## 四、问题三：重复代码（按规模排序）

### 4.1 死代码（先删再说）

- `modules/webdav/WebDAVMountPanel.tsx`(422行) + `modules/openlist/OpenListMountPanel.tsx`(424行)：**互为拷贝且全仓库零引用**，已被 `mounts/MountFormModal` + `MountManager` 取代。合计 846 行。

### 4.2 前端重复

| 重复项 | 位置 | 规模 |
|---|---|---|
| B站扫码登录轮询全套 | `MoviePushPanel.tsx:242-391` ≈ `ProfilePage.tsx:80-395` | ~300 行 × 2 |
| B站/网易云 Cookie 登录平行实现 | `ProfilePage.tsx:180-390 + 981-1131` | ~280 行 |
| 观众申请审批模板 ×3 | `WatchTogetherCore.tsx`（seek/pause/play 三套） | 可省 ~400 行 |
| CLI 解析失败回退 try-catch | `MoviePushPanel.tsx` 内 5 处 | ~250 行 |
| 防盗链代理 URL 构造 `buildXxxProxyUrl` | kazumi/api.ts:103、cms/api.ts:125、anisubs/api.ts:107、room/watch-together/resolveSource.ts:187、player/url-proxy.ts:215、serverFilesApi.ts:174、directLinkApi.ts:25 | 5+ 份近乎逐字拷贝 |
| kazumi ≈ anisubs ≈ cms 三个 api.ts | getSources/search/getEpisodes/resolveEpisode 全同构 | ~350 行 |
| embyApi ↔ jellyfinApi 手写九函数对 | 未用现成的 `createMountApi` 工厂 | ~190 行 |
| 两套评论面板平行实现 | `SongCommentsPanel.tsx`(1327行,网易云) vs `BiliCommentsPanel.tsx`(670行,B站)：state 集、双通道拉取、卡片组件逐段对应 | ~500 行 |
| AdminPage SSE 解析 ×2 | handleApplyUpdate(435-491) ≈ handleFileUpload(566-616) | ~110 行 |
| B站计数格式化 ×4 | MusicBilibiliPage:92、BiliCommentsPanel:66、BiliSearchModal:44、DanmakuSearchModal:39 | 各 ~10 行 |
| 秒→mm:ss 格式化 ×3 | `lib/utils.ts formatDuration`(规范版)、MusicBilibiliPage:84、VideoStatsMenu:153 | — |
| Fisher-Yates 洗牌 ×2 | MusicBilibiliPage:907 ≈ useListenTogether:282 | — |
| VIP_ONLY_QNS 常量 ×3 | backend permission.ts:17、frontend bilibiliApi.ts:11、BilibiliDownloadModal.tsx:53 | 前后端镜像且 `filterQualitiesByVip` 已分叉 |
| 内网 IP 判断前后端镜像 | frontend openlist/isInternal.ts vs backend network-utils.ts | 靠注释维系一致 |

### 4.3 后端重复

| 重复项 | 位置 | 规模 |
|---|---|---|
| emby.ts ↔ jellyfin.ts ~80% 相同 | 归一化 diff 仅差 352 行（session 解析/entry 映射/挂载 CRUD/转码 URL 拼装逐对对应） | 可删 ~500 行 |
| kazumi.ts ↔ cms.ts `/proxy` | **逐字相同**（含 SSRF 注释），/search、/sources、/resolve 同构 | — |
| webdav.ts(工厂) ↔ openlist.ts 挂载 CRUD 五端点 | `resolveDirectLinkWithInternalCheck` 逐字相同(103-111 vs 176-184) | ~250 行 |
| `StreamMovieError` 收尾块 ×4 | webdav:703 / openlist:826 / emby:696 / jellyfin 同款 | — |
| 状态码映射三元 ×12+ | openlist 6 处、webdav 2 处、emby/jellyfin 同款 | — |
| music.ts /stream 与 /song-quality | 凭证回退链、QUALITY_CHAIN 降级循环、freeTrialInfo→VIP_REQUIRED 错误分类三大段复制(1049-1116 vs 1313-1360) | ~120 行 |
| `expandBiliShortLink` 两份实现 | bilibili-auth.ts:822 vs resolver.ts:237（行为还不同：一个抛错一个静默） | — |
| `loadRootRegistry` 两份 | subtitles.ts:74 vs services/server-files/pathResolver.ts 导出版 | — |
| updater 脚本模板 | Docker 版与 Linux 版 ~70% 相同 | ~300 行 |

---

## 五、优化建议（按优先级路线图）

### P0 — 低风险高收益（半天内可完成）

1. **删除死代码**：`WebDAVMountPanel.tsx` + `OpenListMountPanel.tsx`（-846 行）。
2. **斩断 admin.ts ↔ index.ts 环**：`deleteRoomAndRelations` 移入 `modules/room/room-removal.service.ts`。
3. **修 `compareVersions` prerelease bug**（updater/index.ts:205）。
4. **统一格式化工具**：删 MusicBilibiliPage 的 formatSec/formatCount，改用 `lib/utils` + 新增 `lib/format.ts` 收编 4 份计数格式化。

### P1 — 消除最大重复（1-2 天）

5. **抽 `useBilibiliQrLogin()` hook**：合并 MoviePushPanel + ProfilePage 两套扫码登录（-300 行）。
6. **抽 `createEmbyLikeRouter` 工厂合并后端 emby/jellyfin**（-500 行）；同理合并 kazumi/cms 的 /proxy（放 `services/shared` 或公共中间件）。
7. **后端抽 `services/media/stream-utils.ts`**：`sendStreamError`、AUTH_FAILED/NOT_FOUND→状态码映射、Range 流收尾，替换 4 份拷贝。
8. **`buildXxxProxyUrl` 收敛到一处**（建议 `modules/player/services/url-proxy.ts` 导出，各源 api 引用）。
9. **music.ts 两套手写缓存换 `utils/ttl-cache.ts`**；/stream 与 /song-quality 的降级链抽 `services/music/resolve.service.ts`。

### P2 — 结构性拆分（按模块逐步，每步 tsc + eslint 验证）

10. **bilibili-auth.ts 拆分**（对齐 ai-subtitle 已验证模式）：登录/用户信息 → `services/bilibili/account.ts`，收藏夹/收藏写操作 → `favorite.ts`，评论 → `comment.ts`，合集/系列 → `space-lists.ts`，删除与 resolver 重复的短链展开；路由只剩参数校验。
11. **MoviePushPanel 按源拆子组件**（BilibiliSourceForm / MountSourceForm / EmbySourceForm…），抽 `resolveBilibiliWithCliFallback` 工具消除 5 处 try-catch 模板。
12. **AdminPage 拆 UsersTab/RoomsTab/SettingsTab + `useSystemUpdate()` hook**（合并两遍 SSE 解析）。
13. **WatchTogetherCore 抽 `useRequestChannel<T>()` 泛型 hook**（三套申请审批合一，-400 行）、`useDanmakuBridge`、`useControlBarVisibility`。
14. **useListenTogether 拆 `biliAudioCache.ts` / `useAudioEngine` / `useQueueAdvance` / `useMusicSync`**（边界已在分析中标注）。
15. **MusicBilibiliPage 拆 `biliStorage.ts` / `biliListCache.ts` / 弹窗子组件目录**，两组同构拖拽 handler 抽 `useDragSort<T>`。
16. **Header 拆 ThemeMenu / UserMenu / ServerUrlModal**，抽 `usePortalDropdown`。

### P3 — 架构级收敛（长期）

17. **建立 `modules/shared`（或提升 room/watch-together 中的纯逻辑到 lib）**，解 6 组前端循环依赖：movie-source-resolver、danmakuEngine、safePlay 等被多模块消费的代码不放在业务模块里。
18. **components 反向依赖清理**：DanmakuLayer/CommentPanel 依赖的 room 域类型与引擎下沉。
19. **index.ts 瘦身至纯装配（<300 行）**：级联删除、定时任务、种子数据、LiveKit 隧道、socket 鉴权中间件各归其位。
20. **VIP 清晰度过滤单一化**：以后端 permission.ts 为唯一事实源，前端只消费后端返回的过滤结果，删除前端两份拷贝。
21. **updater 脚本模板外置**到 resources/ 以占位符注入，Docker/Linux 参数化合并。

### 验证纪律（每项重构通用）

- 每搬一块立刻 `tsc`（`cd frontend && node ../node_modules/typescript/bin/tsc`）；
- eslint 口径：改动文件 0 错 0 警；
- 大文件重构坚持"纯搬迁零行为变更"，靠 noUnusedLocals 清 import；
- 同一文件禁止并行 Edit；Windows 下注意 CRLF（prettier 报 ␍ 时 `sed -i 's/\r$//'`）。

---

## 六、P4 — 剩余单体与业务下沉（已完成，2026-10-18）

P0~P3 完成后复盘的遗留热点：后端仍有"路由内写业务"，前端两个评论面板仍是平行实现，
解析器两条分支仍有复制段。P4 按"业务下沉 + 共用层"处理：

| 项 | 处理 | 结果 |
|---|---|---|
| `routes/music.ts`(1367) | 整套 REST 迁入 `modules/music/music.routes.ts`（256 行，仅注册+参数校验），业务拆为 `ncm-api-client` / `ncm-cookie.service`（cookie 解析合并、凭证回退链）/ `ncm-stream.service`（音质降级链、直链与音质缓存、FLAC 采样率探测、Range 转发）/ `ncm-stream.handlers`（stream、song-quality 端点）/ `ncm-account.service`（登录态 VIP 判定、专辑补齐）/ `ncm-forward.service`（/ncm 转发、云盘上传）；`optionalAuth` 提升为 `middleware/auth.ts` 的 `optionalAuthenticate` | 路由层不再碰 `AppDataSource` 与 NCM 协议细节；`routes/register.ts` 改装配 `createMusicRouter()` |
| `routes/serverFiles.ts`(945) | multer 存储配置与 `uniqueFilename` → `services/server-files/upload.ts`；`downloadToFile` → `download.service.ts`；`/bilibili-download` 全流程编排（NDJSON 进度、VIP 强校验、下载头、失败清理）→ `bilibili-download.service.ts`；服务层直接从 `getCredential` 取 Cookie（不再依赖 `routes/stream/helpers`） | 945→681，路由只剩目录/文件操作端点 |
| 评论面板 `SongCommentsPanel`(1327)+`BiliCommentsPanel`(667) | 新增 `components/comments/`：`style.ts`（ac-* 样式表唯一副本）、`CommentChrome.tsx`（FrameCorners / 分区标题 / 状态框 / LIKE_PATH）、`CommentsShell.tsx`（滚动容器+标题+HOT/LATEST+状态，headerExtra 插槽装输入区/游客提示）、`format.ts`（相对时间，秒/毫秒两种入参）、`comment-total-cache.ts`（徽章缓存与事件，斩断 B站 面板→网易云面板的反向依赖） | 1994→1561（-433），UI 骨架单点维护 |
| `services/bilibili/resolver.ts`(1113) | UGC/PGC 共用片段抽到模块级：`createEmitter`（进度事件）、`toResolveError`（PgcError→ResolveError 归一）、`cdnUnreachableError`（5 处统一文案/错误码）、`selectDashSources`（skipCdnCheck 直连 / 并行探测音视频可达地址，替换两处逐行相同的 CDN 选择块） | 行数持平，重复逻辑单点化；两条编排的**结构差异**（season 集定位 vs pages、试看语义）保留 |

验证：后端 `tsc --noEmit` + 真实进程冒烟（临时 PROJECT_ROOT，`/api/music/login/status`、`/ncm` 转发、
`/album/full`、`/stream` 的 206/302/直链缓存、`/server-files/{roots,upload,browse,bilibili-download}`、
`/stream/resolve-bilibili` 的 UGC 成功与 PGC 成功/地区限制错误分支）；前端 `tsc` + eslint（0 error）
+ `npm test -w frontend`（38 pass）+ `vite build`。

## 七、P4 后仍待处理（按价值排序）

1. `MusicBilibiliPage.tsx`(2362)：主组件仍有约 40 个 useState，"取数/筛选/收藏/分页"可继续下沉 hook。
2. `MoviePushPanel.tsx`(2346)：来源表单已拆，但面板仍聚合 11 个媒体源模块与 3 个 store。
3. `useListenTogether.ts`(1980)：`useMusicSync` 明确缓做（6 个 handler 横跨 ~18 个上游符号、零重复，强拆负价值），需先补同步协议端到端测试。
4. `MusicMyPage`(1582)/`MusicFmPage`(1201)/`MusicCloudPage`(1125)：列表页同构骨架可收敛。
5. `ProfilePage`(1313)：B站/网易云 Cookie 登录平行实现、28 个 useState。
6. 后端 `routes/{subtitles,openlist,webdav,admin}.ts`(928/902/732/834)：仍有路由内业务与直写仓库，按 music 的模式继续下沉。
7. kazumi/anisubs 前端 api 近逐行同构（各 ~110 行）、embyApi/jellyfinApi 九函数对：可用工厂合并，但需先确认响应类型差异。
8. 手测清单（播放核心未被本轮触及，仍需回归）：起播/暂停/seek、预载升格、无缝衔接、三模式切歌、B站懒解析连播、断线 vs 房间关闭。


## P5 进行中

- **P5-1 MoviePushPanel 提交器化（已完成，10d80f1+5271597）**：各来源添加流程迁 `components/movie-submit.ts`（SubmitMovieContext 上下文 + 六提交器，与 source-forms/ 对称）；B站解析/切清晰度/切分P 迁 `components/useBilibiliResolve.ts`。2346→1871，纯搬迁零行为变更（行多重集 diff 仅签名行/prettier 换行/hook return）。
- 经验：hook 返回的 setter 进入面板 effect 后，react-hooks 规则的「首个违规点」会后移——原 disable-next-line 注释会被 eslint --fix 当 unused 指令删除，需把 disable 移到新的首个违规行（本例 setOpenlist）。
