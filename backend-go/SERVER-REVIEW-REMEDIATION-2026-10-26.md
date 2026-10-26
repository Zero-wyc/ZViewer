# 本地服务端排查与修复方案（2026-10-26）

> 后续实施：S01～S15 及配套图片合同已于 2026-10-26 修复，见 [实施与验收记录](RESOURCE-REMEDIATION-2026-10-26.md)。下文保留原始审查结论和当时证据。

## 1. 基准、结论与交付状态

**本次以本地服务端为唯一程序基准，包含未合并 PR 的改动。本文是已验证问题与修复方案，尚未实施这些修复。**

| 项目 | 审查基准 |
| --- | --- |
| 服务端目录 | `E:/Codex-bulid/ZViewer/ZViewer-source code` |
| 本地分支 | `fix/music-runtime-client-contracts-20261026` |
| 本地程序提交 | `31bbad137646c405e5e305a737fe57273881e0b1` |
| 客户端程序提交 | `a35456f440483549c514a41894211cd4637efc6a`，Android/HarmonyOS 2.2.5 / 226 |
| 上游信息，仅作背景 | 检查时 main 为 `a34db94d8547c3fb292a442cbbf767922ab16129`；[PR #33](https://github.com/Zero-wyc/ZViewer/pull/33) 仍未合并 |
| 配套客户端文档 | [客户端排查与修复方案](<../../ZViewer-client/docs/client-server-review-remediation-2026-10-26.md>) |

本地已有的 GUI 网易云组件、B站解析准入、播放 metadata 和 B站音乐封面修复都计入基准，不因上游未合并而重复报缺失。保留已有分支，未覆盖源码、未合并 PR、未推送、未更新 GUI/NAS，也未构建客户端安装包。文档提交只改变文档，不改变上述程序基准。

发现 **15 项已确认服务端问题**，另列条件性风险与配套网页/客户端图片残留。证据分为真实本地进程、真实本地 HTTP/RTMP、受控 Handler/SQLite 探针、实际客户端函数和源码确认。没有以“测试全绿”替代业务判断，也没有把未测试项目写为正常。

优先级：P1 为权限边界、文件/内容暴露、主要播放链路或流生命周期问题；P2 为条件性地址错误和配置/选源错配。优先级不是线上事故已发生的证明。

## 2. localhost 同类问题的结果

| 组件 | 结果 | 解释 |
| --- | --- | --- |
| B站一起听封面 | 本地已有修复；本轮正向对照通过 | 原图元数据经当前查看者连接重新代理；不重复列为待修 |
| Emby/Jellyfin 一起看封面 | **S01，仍存在** | 影片 cover 接收绝对代理地址；移动端入列只去私有通道，仍保存添加者访问域名；系统媒体路径不重新绑定 |
| OBS 下载配置 | **S02，仍存在** | 只取请求 Host，忽略转发域名；反代 Host 为 localhost 时写出 localhost 推流地址 |
| Socket 添加内网挂载影片 | **S12，仍存在** | REST 会强制改为服务端转发；Socket 不执行相同规则，能保存 localhost 直链 |
| 普通非直链挂载影片 | 当前创建流程使用相对流地址 | `Movies.Create` 写 `/api/{source}/stream?movieId=...`，不是把 NCM/媒体内部端口下发给手机 |
| NCM 回环 API | 正常的服务端内部地址 | 客户端访问 `/api/music/...`，服务端访问私有 NCM；不能全局替换这些回环配置 |
| LiveKit 管理回环地址 | 默认解析链未发现相同错误 | 本轮 `ResolveClientURL` 正向对照返回转发域名对应的 wss 地址；显式 external URL 由管理员决定 |
| NMS HTTP-FLV 回环地址 | 是后端反代上游 | 浏览器使用 `/live/...`；它与 OBS 的 RTMP 对外地址是两个用途 |
| CLI 本地代理 | 有意指向访问者本机 | 不能将所有 127.0.0.1 一律改成服务器地址，否则会破坏本机 CLI |
| 上传头像、字幕同步 | 未发现新生成 localhost 的路径 | 头像保存相对路径；字幕主要传内容/轨道。其权限、上传类型和大小问题另见 S07～S09、S14～S15 |

## 3. 已确认问题总表

| 编号 | 优先级 | 问题 | 客户端关联 |
| --- | --- | --- | --- |
| S01 | P2 | Emby/Jellyfin 影片封面仍携带添加设备访问地址 | 双端系统媒体封面需要同步改造 |
| S02 | P2 | OBS 配置不使用转发域名 | 下载/导入 OBS 配置受影响，触发取决于部署 |
| S03 | P2 | 无端口的 IPv6 Host 生成缺方括号的 RTMP URL | 使用生成配置时受影响 |
| S04 | P1 | 通用代理不跟随常规 302，且不给客户端 Location | 各端经此代理的重定向媒体可能无法播放 |
| S05 | P1 | OBS 与待审批 ACK 过早下发推流码，发布/观看能力未分离 | 房间响应与推流/拉流合同需一起调整 |
| S06 | P1 | Emby/Jellyfin 匿名海报接口不验证资源访问能力 | 不能简单给 img 接口加 Bearer 要求 |
| S07 | P1 | 未入房游客可按路径读取注册根内非媒体文件 | 应迁移到影片/能力范围内的播放接口 |
| S08 | P1 | 文件根检查只作字符串路径约束，junction 可穿出根 | 后端修复；双端不应负责判断真实文件系统边界 |
| S09 | P1 | 头像可伪装图片上传 HTML，并以本站 HTML 提供 | 网页受影响；客户端文件选择限制不能修复服务端 |
| S10 | P1 | 通用媒体代理允许未入房游客请求任意回环目标 | 播放代理要保留合法 NAS 路径并限制任意目标 |
| S11 | P2 | 显式选择同用户第二个同址挂载仍绑定第一个 | 挂载选择 UI 正确也可能使用错误账号 |
| S12 | P2 | REST/Socket 添加影片的内网直链规则不一致 | 当前双端 addMovie 走 REST，不能称为必现移动故障 |
| S13 | P1 | 同码 RTMP 双发布者并存，旧连接断开删除新流 | 观看侧掉线，客户端无限重试不能解决 |
| S14 | P1 | 字幕接口允许已入房观众读取关联影片范围外的非字幕文本 | 字幕选择/浏览合同需要同步限制 |
| S15 | P2 | 本地字幕读取没有执行 2 MiB 上限 | 双端应处理超限错误；不应尝试解析超大正文 |

### S01：影片封面地址不具备跨连接可移植性

定位：[`movie.go` 的 cover DTO/写入](internal/api/movie.go#L83)、[`Movies.Create`](internal/store/movie.go#L210)，以及客户端 `MoviePushPanel.tsx:597,768,790`、`embyApi.ts:11`、`useSystemMediaSession.ts:14`。

本轮受控 SQLite/REST 验证：提交 `http://localhost:3333/api/emby/mounts/1/image?itemId=fixture`，影片 DTO 原样返回。实际移动函数验证：localhost、旧私有通道、其他访问域名的 Emby/Jellyfin cover 经过 `systemArtworkUrl` 后仍不变。新添加封面通过 `logicalConnectionUrl` 去掉通道后仍是添加者的绝对访问地址；另一域名访问同一服务端时不会改为查看者通道。B站封面在同一探针中正确重绑，是本地已有修复的正向对照。

影响是条件性的图片不可达：其他设备访问添加者 localhost、LAN 地址或已失效通道；同机使用证书例外时，系统媒体也可能绕过已建立的连接通道。没有做新一轮实体设备通知栏/锁屏验收。

修复：对服务端自有海报建立可移植的资源描述/规范相对端点，在读取历史行时兼容已确认的旧端点；客户端展示和系统媒体输出才绑定当前连接。**仅凭路径中含 `/api/` 就改写任意外站 URL 不安全**，也不能把真正的 Emby 上游 API Key 放进 cover。若按 S06 改成签名能力，应保存资源身份，读取时重新签发。

验收：网页 localhost 添加→手机公网观看、手机 LAN 添加→另一手机公网观看、代理路径前缀、证书例外、重新连接换端口/通道、Emby 与 Jellyfin、旧行兼容；同时保持 B站、网易云、其他外站图片及手动封面语义。

### S02 / S03：OBS 对外地址与 IPv6 拼接

定位：[`handleObsConfig`](internal/api/streampush.go#L34)、[`RtmpServerURL` / `hostOnly`](internal/nms/nms.go#L118)。

已复现：`Host=localhost:3333`，同时传 `X-Forwarded-Host=public.example.invalid`，结果仍为 `rtmp://localhost:3334/live`。在另一电脑导入时，localhost 指向那台电脑。仅当反代改变 Host 且没有有效 `SERVER_HOST` 覆盖等条件成立时触发，不能据此认定当前用户部署已中招。

另复现：`[2001:db8::1]`（无端口）生成 `rtmp://2001:db8::1:3334/live`；`[2001:db8::1]:3333` 则正确。`hostOnly` 的错误分支移除了 IPv6 方括号。

修复：保留显式对外 RTMP 主机配置的优先级；只在可信反代边界内采用经过校验的转发主机，并用统一的主机/端口拼接处理 IPv6。网页域名并不自动代表 RTMP 可达，HTTP 隧道不能因此视为已承载 TCP 推流；必要时应明确配置独立 RTMP 入口。

验收：直连 IPv4/域名、反代 Host 被改写、显式配置、IPv6 有/无请求端口、无效/多值转发头。不能为了修地址而改动推流密钥或任意信任外部 Forwarded 头。

### S04：常规代理的 302 链路中断

定位：[`attemptState.fetch`](internal/proxy/upstream.go#L276)、[`defaultClient`](internal/proxy/upstream.go#L322)。

HTTP Client 关闭自动重定向；fetch 只有 `PublicOnly=true` 才逐跳处理重定向。普通图片/媒体/部分挂载代理使用默认 false，收到 302 就返回；外层将它按非 2xx 处理，正文置空，且没有回传 Location。

本轮真实本地 HTTP：`/redirect → 302 /final`，调用 `/api/stream/proxy` 后客户端得到 **302、0 字节、无 Location**，`/final` 没有被访问。不是猜测客户端播放器兼容性。PublicOnly 源的重定向已有独立逻辑，本项不代表所有代理都坏。

修复：让重定向处理与目标安全策略解耦，为每跳应用该端点的准入/域名/凭证策略，限制跳数，保持 Range 和相对 HLS 基地址正确。图片白名单不能只检查第一跳；跨域跳转不应无条件携带敏感凭证。**不能全局打开自动跟随并跳过校验，也不能把全部 NAS 代理改为 PublicOnly。**

验收：301/302/303/307/308、相对 Location、循环、超过跳数、取消、Range、最终 URL 的 HLS 相对分片、白名单跳出与内网重定向拒绝、允许的真实内网挂载。

### S05：推流码准入与发布能力边界

定位：[`handleObsConfig`](internal/api/streampush.go#L34)、[`request-join` 待审批 ACK](internal/room/handlers.go#L655)、[`onPublish`](internal/nms/rtmp_session.go#L206)、`/live` 拉流处理。

已确认的三个环节：

1. 普通游客持合法游客令牌、没有房间会话，也能下载测试房间 OBS 配置并取得推流码；房间为 active、closed 均复现。此端点只做全局登录校验、存在/模式检查，没有房间控制权限检查。
2. 独立服务进程中，游客收到“等待分享端确认”的 ACK 时已拿到相同推流码；同一时刻请求该房间片单为 403，证明还没有获得入房权限。**本轮没有测试拒绝后的状态，不把它写成已复现。**
3. 内置 RTMP 对任意非空码启动发布，未区分房主的发布能力与观众的观看能力。使用本地 RTMP 测试客户端证实任意测试码可发布。未对真实推流房间实施冒充或窃听。

修复应同时覆盖 REST、Socket 和媒体面：OBS 配置按房间管理/发布权限下发；待审批阶段不给媒体能力；观看票据与发布凭证分离，限定房间、方向、期限与失效条件。媒体服务通过注入授权回调等方式验证有效发布者，不能只隐藏网页按钮。关闭/踢出/撤销后的媒体能力也需明确失效策略。

兼容注意：当前观众用 streamKey 构造 FLV 地址，不能简单删除所有已批准观众的字段而不提供新观看合同。修复验收须包含 root/房主、普通成员、待审批、未入房、关闭房间、授权撤销、直接 RTMP 与 `/live` 入口。

### S06：匿名海报没有验证其宣称的保护条件

定位：[`registerEmbyRoutes`](internal/api/emby.go#L44)、[`handleEmbyMountImage`](internal/api/emby.go#L658)、[`ItemImage`](internal/emby/client.go#L630)。

接口免认证，按整数 mountId 读取挂载凭证；tag 可空，既不强制存在，也不在本地验证。它被作为图片缓存参数转给上游，不能当访问凭证。

受控上游验证：Emby 和 Jellyfin 都在**无登录、无 tag**时取得测试海报，上游收到挂载所有者的测试 API Key。错误 tag 在本次假上游中也被放行；这证明后端不校验，不能推论所有真实 Emby 服务都会忽略错误 tag。未发现 API Key 被直接返回给请求者。

修复：按挂载所有者或房间影片准入签发短期图片能力，绑定资源、尺寸上限和用途；或使用受认证的图片获取方式。不能只要求 tag 非空。网页 img、移动 WebView、原生系统媒体通常不能自动带业务 Authorization，协议必须配套，避免一加鉴权就让全部海报消失。

验收：缺能力/伪造/过期/跨挂载/跨条目拒绝；合法所有者、已准入观众、系统媒体和目录海报回退正常；服务端凭证不进入响应 URL。

### S07：本地文件播放入口越过房间准入

定位：[`registerServerFilesRoutes`](internal/api/serverfiles.go#L29)、[`handleSFResolve` / `handleSFProxy`](internal/api/serverfiles.go#L538)。

`/resolve`、`/proxy` 只要求任意有效令牌，后者直接使用 path 读取注册根目录中的文件，不核对影片、房间会话或媒体类型。本轮未入房游客成功读到隔离 uploads 内已知路径的 `private-note.txt`，返回 200 和原文。

实际范围是**已注册的根目录及进程可读范围**，不应表述成无条件可读全盘；普通路径 `..` 已有词法检查，另有 S08 真实链接边界问题。未扫描真实用户目录。

修复：观众播放以 movieId/受限播放能力映射到权威文件，复用房间准入；原始路径型入口限制到相应管理身份或显式文件分享策略。单加扩展名白名单不能代替授权。保留 HEAD、Range、原生 AVPlayer 及根目录 readonly 的已有语义。

验收：游客/未入房/待审批/已结束会话/他房成员拒绝；合法房主和已准入观众可播放、seek；已注册但未分享文件不可借播放接口读取。

### S08：junction/符号链接逃出文件根

定位：[`ResolveSafePath`](internal/serverfiles/paths.go#L149)，以及使用它的读写/字幕入口。

该函数只用 Join/Rel 做词法约束，不约束操作系统最终跟随的链接。Windows 隔离目录内创建 `root/link → sibling outside` 的 junction 后，`uploads:/link/sentinel.txt` 被当作合法根内路径，实际读到了根外的测试哨兵文件。

普通 `os.Symlink` 测试因 Windows 权限不足跳过，**junction 真实读取验证通过**；没有将跳过项目记成通过。没有链接到任何真实配置或用户文件。

修复：文件操作应使用受根约束的真实文件系统访问；不仅检查现有文件，也检查创建目标的父路径。需考虑 Windows junction/reparse point、只读根、根自身为链接的既有布局与检查到使用间的替换。不要对用户整盘做递归清理。

验收：读/字幕/上传/新建/改名/删除各入口，合法根内链接、根外链接、父目录链接、路径替换竞争和跨卷情况；拒绝结果不能删除或覆盖原文件。

### S09：头像伪装图片可作为本站 HTML 提供

定位：[`handleUploadAvatar`](internal/api/profile.go#L216)、[`avatarExtPattern`](internal/api/profile.go#L44)、[`avatarsHandler`](internal/api/static.go#L17)。

后端只信 multipart 声明的 `image/png` 等 MIME，文件名允许任意 1～8 位字母数字后缀。真实上传无脚本的测试 HTML、文件名 `.html`、声明 `image/png` 后成功；匿名访问返回 200、`Content-Type: text/html; charset=utf-8` 和原始 HTML。

这是同源存储型主动内容风险。**本轮只用惰性 HTML 标记，不执行脚本、不验证账号接管**；img 标签本身也不等于会执行 HTML，危险入口是把资源作为本站页面打开等情形。

修复：按实际内容验证受支持图片格式，并由可信格式决定后缀与输出类型；必要时安全解码/重编码。保留 GIF/WebP/JPEG/PNG 的产品支持，不能仅按客户端扩展名。增加防嗅探/主动内容隔离作为补充，并关闭头像目录列表。旧可疑文件应按可审查规则处置，不能在审查时直接批量删除用户文件。

验收：合法多种图片、伪造 MIME、HTML/SVG/脚本后缀、空文件、超限、旧资源、上传失败不破坏旧头像。

### S10：通用媒体代理可访问任意服务端回环目标

定位：[`handleStreamMediaProxy`](internal/api/proxy.go#L111)。

`/api/stream/proxy?url=...` 只要求全局令牌，既未绑定影片也未限制目标；未入房游客通过它成功访问本轮受控回环 HTTP 监听并读取测试正文。相同目标走 anime 公网源代理返回 403，形成正向防护对照。

影响是后端可达 HTTP 资源的探测/读取能力；本轮没有探测 NAS、系统管理端口、云元数据或任何真实凭证。不能仅凭此认定已有信息泄露事故。

修复：任意 URL 的公网媒体代理应做逐跳公网检查；合法内网 NAS 走影片/挂载授权的专用路径或受限能力。不能为了阻止游客扫描而全局阻断已授权内网 WebDAV/OpenList/Emby 播放，也不能只在移动客户端拦 localhost。

验收：回环、私网、链路本地、IPv6、域名解析到内网、内网重定向、真实合法内网挂载、普通 B站 CDN 与公开直链。

### S11：明确选择的同址挂载被忽略

定位：[`movieBody` / `handleCreateMovie`](internal/api/movie.go#L247)、[`resolveSourceMountID`](internal/store/movie.go#L490)、更新时的 `SourceMountIDTouched`。

同一测试用户创建两个相同 serverUrl/type、不同用户名的挂载，提交 `sourceMountId=第二个 ID` 添加影片，返回的 sourceMountId 却是第一个。创建路径没有将显式 ID 传入仓库；仓库只遍历 type/serverUrl 并选第一个归属本用户的记录。

本地前轮“不同用户之间不能借用挂载”保护仍存在，本项是**同用户多账号**的选源错配，不能混为跨用户问题。自动填充凭证和后续解析必须与同一明确挂载绑定。

修复：校验显式 ID 的归属、类型及服务器，再使用该 ID；仅对没有 ID 的旧数据走有定义的兼容路径。删除/改密后不得静默绑定另一个挂载，直链和登录缓存仍按有效凭证隔离。

验收：同用户同址双账号选择各自正确；其他用户 ID、错误类型/地址拒绝；旧数据、挂载删除、换账号密码、房管添加与房主读取按明确规则处理。

### S12：Socket 路径绕过 REST 的内网直链规范化

定位：[`handleCreateMovie`](internal/api/movie.go#L325)、[`handleAddMovie` / `parseMovieInput`](internal/room/movie_handlers.go#L58)、[`Movies.Create`](internal/store/movie.go#L210)。

独立本地服务、真实 Socket.IO：同一份 WebDAV localhost 元数据，REST 添加得到 `directLink=false` 和相对影片流 URL；`add-movie` 添加却保存 `directLink=true`、`http://localhost:8096/...` 原地址。

当前 Android/HarmonyOS 共享 roomStore 的 addMovie 使用 REST，因此不能表述为当前客户端每次添加必然发生；旧客户端、其他 Socket 调用仍能把坏地址写入队列。

修复：将挂载准入、内网直链降级、凭证绑定和必要输入校验放在共享服务/仓库前的统一边界，REST 与 Socket 共同调用。不要无差别改写原生/CLI 的合法本机代理源。

验收：同载荷经两种入口得到相同规范结果；公网直链、各挂载源、显式 false、空/非法载荷、影片 DTO 与广播一致。

### S13：重复 RTMP 发布者互相删除流

定位：[`onPublish` / `unpublish`](internal/nms/rtmp_session.go#L206)、[`streamHub.start` / `stop`](internal/nms/streamhub.go#L55)。

两个真实本地 RTMP 客户端同时以同一个测试码发布，均被接受。后一个 start 重置同一条流的缓存，但没有发布者身份/代次隔离；前一个连接断开后 `stop(key)` 直接删除该流，第二个连接还活着却已无可用流。

这是旧 OBS 断线/快速重连也可能触发的生命周期错误，不需要先发生恶意操作。实际验证了流被删除，没有把真实 OBS 图像混流或用户掉线记为已发生。

修复：每条流只允许一个有效发布者，定义“拒绝后来者”或“新连接接管并关闭旧连接”的策略；start 返回发布租约/代次，stop 和写帧只允许当前租约操作，旧连接退出不能清理新流。

验收：双连接同码、不同码、旧先断/新先断、快速重连、旧连接迟到帧、观看订阅保持/重建和关闭服务。S05 的授权修复不能代替本项代次保护。

### S14：字幕能力超出获准影片范围

定位：[`handleSubtitleBrowse` / `handleSubtitleLoad`](internal/api/subtitles.go)、[`BrowseMovieDirectory`](internal/subtitle/service.go#L446)、[`LoadSubtitleFile`](internal/subtitle/service.go#L577)。

影片准入检查本身存在且可拒绝未入房用户，但通过后接受任意 path；load 计算扩展名作返回值，没有要求是字幕。已入房普通观众获准读取 `shared/video.mp4` 的测试房间后，成功经字幕 load 取得另一个 `private/note.txt` 的正文，200。测试文件仍在隔离根内，不依赖 S08 链接逃逸。

远程 WebDAV/OpenList/FTP 分支在源码中也接受用户提供的 filePath 并使用影片对应凭证；本轮没有连接真实远程挂载，不能把远程全库读取写为实测结果。

修复：分离“能看影片”和“能浏览/读取整个挂载”；字幕限定为经房主授权的文件/目录范围和真实支持的格式。房主合法跨目录选字幕可通过显式关联/受限能力保留，观众不应因此取得整个库的读取能力。单独挡 `.txt` 仍不能防止读取其他未分享字幕，必须同时限定范围。

验收：未准入拒绝、已准入只读关联字幕、跨目录/跨根/跨挂载拒绝、格式伪造拒绝、合法房主选择、同步已有字幕内容、各远程源与本地源统一规则。

### S15：本地字幕大小约束未执行

定位：[`LoadSubtitleFile` 的 server-files 分支](internal/subtitle/service.go#L585)。

远程分支使用有界读取，本地分支直接 `os.ReadFile`；声明的 `MaxSubtitleBytes=2 MiB` 没有执行。本轮隔离 `.srt` 文件 **2,097,153 字节**经 API 全部返回 200。

修复：Stat 可提前拒绝明显超限，但还需读取 max+1 字节的硬上限防止文件变化，统一返回有明确 code 的超限错误。客户端不应继续解析或 Socket 广播超限内容。不要将上限加在所有视频流上。

验收：刚低于/等于/超过上限、文件在读取时增长、不同源、取消、旧字幕保留；错误响应不伪装成功空字幕。

## 4. 配套网页与双端仍有的图片处理残留

本地网页和移动共享源都有以下残留，详见客户端文档 C02：

- `MusicTopNav` 两处直接使用 `loginStatus.avatarUrl`，没有使用统一网易云 HTTPS/回退处理。
- `AddToPlaylistModal`、`NcmSearchModal` 直接拼 `?param=...`，已有查询参数时会形成错误的尺寸查询，也没有统一 HTTP→HTTPS。

这是源码确认的条件性残留，不是 localhost 问题；不宣称所有运行时都会禁止 HTTP 图片或所有 CDN 都会拒绝错误查询。不能因为已有封面测试通过就写成所有入口已统一。

## 5. 条件性风险与尚待单独验证的边界

| 编号 | 观察与证据 | 结论边界及建议 |
| --- | --- | --- |
| R01：CORS/浏览器凭证 | 默认 `CORS_ORIGIN` 空值允许所有 Origin，并反射 Origin + credentials；本地进程和 Handler 都返回了该结果 | 是否能跨站读到真实身份取决于 Cookie 的 SameSite、浏览器策略和部署。没有做浏览器攻击实测。应明确可信网页/原生 Origin 与 CSRF 策略；不能直接关闭移动端所需跨域能力 |
| R02：DNS 检查与实际连接 | PublicOnly 先解析检查，后续 Transport 独立拨号；没有把已验证地址固定到实际连接 | 存在 DNS 重绑定/检查使用分离的设计风险；没有复现 DNS 攻击。需在逐跳实际拨号边界限制目标，保留 Host/SNI 和取消语义 |
| R03：资源上限与连接复用 | NCM/Emby 有未统一限定体积的 `io.ReadAll`；通用代理默认每次新建 Transport | 未做压力测试，不能报告已发生 OOM/泄漏。需按端点配置响应上限/并发预算，流媒体不能套普通 JSON 上限；连接池复用与关闭也应独立验证 |
| R04：外置 LiveKit HTTPS | `/rtc` 的上游解析只取主机和端口，之后固定 HTTP/明文 TCP，缺端口回退 3336 | 默认本地 HTTP 路径正常；显式 TLS/路径前缀配置不是通用支持。未实测外置 TLS，应明确支持范围或实现协议保持，不能改变默认本地部署 |
| R05：首次启动部署安全 | 自举管理员使用固定默认口令，登录后提示修改 | 这是当前既有设计。本轮只在隔离环境启动。对外监听前应有首次初始化/强制更换策略；不读取或重置任何现有用户密码 |

## 6. 逐类覆盖与本轮未发现新异常的部分

“未发现新异常”仅代表下表覆盖内，不表示组件无缺陷。功能/权限缺口已在 S/R 表中登记的，不因既有测试通过而覆盖掉。

| 类别 | 本轮检查与结果 | 边界 |
| --- | --- | --- |
| 运行装配、配置、新库和 metadata 迁移 | 独立全新数据目录启动成功；配置、db/cmd 测试通过 | 不操作用户现有库；旧库迁移以已有受控测试为证据 |
| 账号、刷新、撤销、管理角色 | auth、profile/admin 集成测试通过；HTTP 与 Socket 每包鉴权代码复核 | 头像主动内容和 CORS 另报 S09/R01 |
| 房间准入、会话、踢人、转交 | 现有 room/store 测试通过，前轮隔离修复仍在本地 | 推流/本地文件等旁路另报；不能等同于每个媒体入口都正确 |
| Socket 协议与注册 | 65/65 历史事件注册；真实 WebSocket、create-room、add-movie、request-join 成功执行 | S05/S12 证明事件存在不等于业务规则正确 |
| 一起看快照、心跳、删片、清理 | 现有播放 metadata、删除、缓存 revision/并发回归通过 | 本轮未重做双实体设备长时间观影；未完成 race 检查 |
| 一起听、FM、队列封面 | room/music/store 与 10 项音乐回归通过；客户端 B站旧代理重绑正向通过 | Emby 影片封面与其他网易云入口另报 |
| B站借用房主解析 | 本地权限修复及其 13 场景已有测试通过，仍先准入再展开/读凭证 | 使用受控上游；未验证会员实播 |
| OpenList/WebDAV/FTP 与直链缓存 | 现有凭证隔离、并发等待者、取消、改密回归通过；复核影片流相对端点 | 选挂载 S11、302 S04、Socket S12；没有真实 NAS 逐源验收 |
| Emby/Jellyfin、HLS 版本资源 | 现有 DTO/版本/HLS 子资源边界测试通过 | 海报 S01/S06；真实服务资源/解码未逐项复测 |
| 代理、Range、取消、HLS | proxy/range 测试及 15 项媒体回归通过；本地 HTTP 验证重定向缺口 | 已有范围/取消测试不代表实际所有源支持 Range |
| 字幕、弹幕、评论、批注 | subtitle/danmaku/room 既有测试通过，代码复核主要准入与同步 | S08/S14/S15；未逐源在线抓取 |
| CMS、Anime、AniSubs、Kazumi、抓取 | 对应包测试通过；复核 API 注册、超时与公共源代理限制 | 动态规则/站点存活、资源体积和 DNS 风险未全网验收 |
| 文件操作与更新 | serverfiles/updater/db 测试通过；复核路径、只读根、解压与落盘入口 | S07/S08；未执行更新脚本覆盖运行目录、未做真实升级 |
| 语音、RTC、NMS | voice/livekit/nms 既有测试通过；语音 URL 正向对照；新增真实 RTMP 竞争验证 | S02/S03/S05/S13/R04；没有新实体设备语音/OBS 编解码验收 |
| GUI 和组件交付 | 读取本地已完成的随包 NCM 与构建入口，未把它们当缺失 | 未替换 GUI 安装文件，未重跑整套桌面构建和进程树故障演练 |
| 统计、缓存、日志、限流、证书 | 对应 Go 测试通过，vet 无报告；并发重点以既有专项回归复验 | 没有压测或第三方依赖 CVE 全量扫描，不声称达到安全认证 |

## 7. 本轮验证与证据

| 验证 | 实际结果 |
| --- | --- |
| `go test -count=1 ./...` | 33 个有测试包通过，另有 5 个包无测试文件 |
| `go vet ./...` | 通过 |
| `go build ... ./cmd/zviewer-server` | 通过；产物仅用于仓库外隔离验证 |
| `go test -race ./...` | **本轮未完成**：当前环境 CGO 未启用且未发现可用 C 编译器；初次命令报 `-race requires cgo`。不能引用前轮 race 结果充当本轮结果 |
| 网页媒体/音乐回归 | 15/15、10/10 通过 |
| Android/HarmonyOS 共享维护回归和类型检查 | 76/76、typecheck 通过；未重新打包、未安装实体设备 |
| 历史 HTTP 路由探测 | 独立本地服务 189/189 没有落入“接口不存在”兜底；大量受保护请求被 401 拦截，本项仅证明注册覆盖 |
| 历史 Socket 事件 | 静态快照 65/65 有注册；少数关键业务另做真实 Socket 检查 |
| 新增诊断探针 | 受控 HTTP/SQLite、惰性 HTML、Windows junction、真实 RTMP、实际客户端函数重现本文问题；symlink 权限不足的用例单独标记跳过 |
| 在线与设备边界 | 没有 NAS SSH、没有线上变更、没有真实账户请求、没有第三方会员/手机解码/系统通知栏实测 |

本地证据集中在仓库外 `E:/Codex-bulid/ZViewer/tools/server-review-20261026/`：

- `audit_observations_test.go`、`nms_observations_test.go`、`overlay.json`：通过 Go overlay 加载诊断，不写入生产 Go 源文件。
- `probes.log`、`mount-probes.log`、`subtitle-probes.log`、`nms-probes.log`：各问题的受控观察。
- `runtime-probes.mjs`、`runtime-observations.json`、`runtime-server.log`：独立服务、真实 Socket 及待审批测试；进程结束状态已记录。
- `client-address-probes.mjs`、`client-address-observations.json`：直接加载客户端实际地址函数，未替代为手写实现。
- `go-test.log`、`go-vet.log`、`route-audit.log`：基础结果。

这些是**现状诊断**：探针通过代表观察到所描述的现状，可能正是缺陷复现，不代表缺陷修复通过。后续实施时要把它们转为断言目标行为的仓库回归测试，不应原封不动当作防回归测试提交。一次性脚本和隔离运行数据不随源码发布。

## 8. 修复顺序与避免连带错误的要求

1. 先补 S05/S06/S07/S08/S09/S10/S14 的资源与权限边界，分别保留正常房主/观众对照；签名/能力合同先定清楚，再同步客户端，不能仅隐藏 UI。
2. 将 S01 与 S06 一起设计封面资源身份和当前连接解析；独立修 S11 挂载选择与 S12 两种写入口一致性，保留前轮跨用户隔离。
3. 单独修 S04 重定向策略和 S13 发布者代次；各自验证本地/公网/挂载正常路径，再做小范围组合回归。
4. 修 S02/S03 对外地址与 IPv6，S15 字幕大小；补网页和双端 C02 图片入口。条件性 R 项不与核心权限补丁混成一次无边界重构。
5. 不改变音视频同步时钟、数据库主体结构、客户端登录保留逻辑、B站已有准入和音乐旧封面兼容；确需合同/列变更时写明确迁移与兼容方案。
6. 每项修复用最小补丁和对应回归，完成版本构建后本地 Git 提交。Android/HarmonyOS 若修改运行代码，须同步两份维护架构文档；没有指示不构建 iOS。
7. 服务端修复提交时按项目规则整理上游 PR。本轮只提交两仓库的审查文档，不代表已发布或部署上述修复。

本报告覆盖当前本地基准下的主要模块、调用边界和已有回归；仍需按列出的实际部署与设备边界完成修复后的验收，不能据此保证服务端不存在其他潜在缺陷。
