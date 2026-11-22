# 爬虫引擎使用手册

本文档对应 Go 实现（`backend-go/internal/crawler`，2026-11-22 起）。引擎已并入后端进程：没有独立服务、没有 3789 端口、不需要 Python 或 Node。网页端与桌面控制台都通过 `/api/crawler/*` 访问，规则生成、搜索、播放解析、Agent 对话与离屏浏览器全部在后端内完成。

`crawler/` 目录现在只放「本机数据 + 文档」：`config.json`（大模型与 Agent 配置）、`data/rules`、`data/accounts.json`、`data/sessions`、`data/browser-profile`、`docs/engine.md`。

## 1. 运行环境

- 随 `zviewer-backend.exe` 一起分发，不需要安装 Python / Node，也没有独立进程。
- 脚本规则跑在内置 JavaScript 沙箱（goja）：支持 `async/await`、`Promise`、`fetch`、`URL`、`URLSearchParams`、`TextEncoder/TextDecoder`、`atob/btoa`、`setTimeout`。
- 离屏浏览器复用本机 Edge/Chrome（可用 `CRAWLER_BROWSER_BIN` 指定）；找不到时会跳过「浏览器兜底」这一步，其它解析方式不受影响。
- 规则、账号、会话、搜索日志、浏览器 profile 都在 `crawler/data/`；备份整个目录即可搬家。

## 1.1 权限

管理接口（规则、Agent、配置、浏览器登录）要求管理员身份。桌面控制台不是登录用户，改用后端启动时注入的壳内令牌：环境变量 `ZVIEWER_DESKTOP_TOKEN`，请求头 `X-Desktop-Token`。该令牌每次启动随机生成，仅在 GUI 托管（`ZVIEWER_DESKTOP=1`）时生效。

## 2. 配置

默认读取 `crawler/config.json`，不存在时使用内置默认值；写入为原子替换。

```json
{
  "llm": {
    "base_url": "https://api.deepseek.com/v1",
    "api_key": "",
    "model": "deepseek-chat",
    "temperature": 0.1,
    "max_tokens": 2048,
    "timeout_sec": 90
  },
  "browser": {
    "enabled": true,
    "bin": "",
    "debug_port": 9333,
    "profile_dir": ""
  },
  "agent": {
    "max_steps": 0,
    "auto_continue": 2,
    "custom_prompt": ""
  },
  "generation": {
    "max_steps": 12,
    "max_page_chars": 6000,
    "sample_keyword": "电影"
  },
  "submissions": {
    "auto_generate": false
  },
  "repair": {
    "enabled": true,
    "cooldown_sec": 600
  }
}
```

配置由 GUI 的「爬虫引擎 → 设置」写入，后端按文件修改时间热加载：改完 Key/模型/提示词不需要重启。

- `llm.base_url` 支持任何 OpenAI 兼容服务；填 `https://xxx/v1` 即可，引擎自动拼 `/chat/completions`。
- `agent.custom_prompt`：自定义提示词（≤4000 字），追加到「生成规则 / Agent 对话 / 自动修复」三套系统提示词的末尾；GUI「爬虫引擎 → 设置 → 自定义提示词」可直接编辑。
- 数据目录：`data/rules/*.json`、`data/accounts.json`、`data/sessions/*.json`、`data/search-log.json`、`data/browser-profile/`。账号文件权限 0600。

## 3. 规则结构

一条规则一个 JSON 文件，`id` 由 `name/site` 自动生成（slug，重复时加后缀）。完整结构：

```json
{
  "id": "example",
  "name": "示例站",
  "site": "example.com",
  "aliases": ["www.example.com"],
  "enabled": true,
  "visibility": "public",
  "allowed_rooms": [],
  "description": "说明",
  "search": {},
  "parse": {}
}
```

### 3.1 搜索（HTTP）

```json
"search": {
  "mode": "http",
  "request": {
    "method": "GET",
    "url": "https://example.com/search?q={keyword}",
    "headers": {"Referer": "https://example.com/"},
    "body": "",
    "body_type": "raw"
  },
  "encoding": "utf-8"
}
```

- `{keyword}` 会做 URL 编码后替换；POST 时 `body` 也支持 `{keyword}`。
- `body_type`：`raw` / `form` / `json`。
- 响应超过 `max_bytes` 会截断；5xx/429 自动重试。

### 3.2 解析（HTML）

```json
"parse": {
  "type": "html",
  "container": ".result-item",
  "fields": {
    "title": {"selector": ".title", "attr": "text"},
    "url": {"selector": "a", "attr": "href", "absolute": true},
    "cover": {"selector": "img", "attr": "src", "absolute": true},
    "description": {"selector": ".desc", "attr": "text"},
    "author": {"selector": ".author", "attr": "text"},
    "duration": {"selector": ".duration", "attr": "text"}
  },
  "dedupe_by": "url",
  "limit": 30
}
```

字段额外能力：`regex` + `group` 二次提取、`prefix` 拼前缀、`absolute` 把相对地址转绝对。`url` 与 `cover` 默认 `absolute=true`。至少要有 `title` 和 `url`，否则该条被跳过。

CSS 子集：标签、`*`、`#id`、`.class`、`[attr]` / `[attr=value]` / `^=` / `$=` / `~=`、空格后代、`>` 子代、逗号分组、`:first-child`、`:last-child`、`:nth-child(n)`、`:contains(text)`、`:not(selector)`。

### 3.3 解析（JSON）

```json
"parse": {
  "type": "json",
  "list_path": "data.list",
  "fields": {
    "title": {"path": "title"},
    "url": {"path": "play_url"},
    "cover": {"path": "pic"}
  },
  "dedupe_by": "url",
  "limit": 30
}
```

`list_path` 支持点号与 `[*]`（如 `result[*].items`）；`path` 支持 `a.b.c`。

### 3.4 脚本规则（JS 沙箱）

适合需要签名、加密参数、接口合并或页面由 JS 渲染的站点。脚本在内置 goja 沙箱中执行（不依赖 Node），注入 `fetch`、`URL`、`URLSearchParams`、`TextEncoder/TextDecoder`、`atob/btoa`、`setTimeout`、`console`。`runtime` 写 `"script"` 或 `"node"` 都可以（历史规则沿用了后者）。

搜索脚本（`search.mode="script"`）：

```json
"search": {
  "mode": "script",
  "account_id": "",
  "script": {
    "runtime": "script",
    "timeout_sec": 20,
    "source": "const sign = 'x'; return {request: {url: 'https://example.com/api/search?q=' + encodeURIComponent(input.keyword) + '&sign=' + sign, headers: {'Referer': 'https://example.com/'}}};"
  }
}
```

- `input` = `{keyword, site, rule, account}`。
- 返回 `{request:{url,method,headers,body}}`：引擎按该请求抓取，再交给 `parse`。
- 返回 `{items:[{title,url,cover,description,duration,author}]}`：跳过抓取，直接作为结果。
- 返回 `{items:[], skipped:N}` 可显式标记跳过数量。

解析脚本（`parse.type="script"`）：

```json
"parse": {
  "type": "script",
  "script": {
    "runtime": "script",
    "source": "return {items: [{title: input.keyword, url: input.url}]};"
  }
}
```

- `input` = `{html, url, keyword, rule, account}`。
- 必须返回 `{items:[...]}`，字段规则同上。

脚本失败、超时（默认 20s）或返回非 JSON 会抛 `RuleError`，搜索接口返回错误而不是崩溃。

### 3.5 播放解析（play）

规则可选写 `play` 段，把搜索结果里的详情页解析成播放器可用的地址。三种写法可组合，按优先级执行：

```json
{
  "play": {
    "headers": {"Referer": "https://www.example.com/"},
    "play_url_regex": "vodplay/(?P<vodId>\\d+)-(?P<playFrom>[a-z0-9]+)-(?P<index>\\d+)\\.html",
    "api": {
      "url": "https://www.example.com/api/play-url?vodId={vodId}&playFrom={playFrom}&index={index}",
      "headers": {"Referer": "https://www.example.com/"},
      "skipFrom": ["bilibili", "mgtv"]
    },
    "script": {
      "runtime": "script",
      "timeout_sec": 30,
      "source": "const slug=...; return {url, format, title, headers, episodes, note}"
    }
  }
}
```

- `play.script`：**最优先**。适合反爬站点——脚本里用 `fetch` 调站点自己的 `/api/*`，自己选线路，返回 `{url, format, title, headers, episodes:[{name,url}], note}`。入参 `{pageUrl,site,rule,headers,account}`，`account` 只在规则绑定账号时非空。解析器会再用 `Range: bytes=0-1` 探测 `url` 是否真的可拉，失败则静默降级到后续兜底。
- 清晰度（可选）：站点有多档清晰度时，脚本再返回 `qualities:[{name,url,format?,headers?}]`（name 取站点自己的叫法，如「标清」「高清」「1080P」；url 仍为默认档）。解析器按顺序探测，默认档不可拉时自动换下一档；返回值原样透传给前端，「一起看」播放器据此出清晰度下拉，切换时重新调用一次解析拿最新地址。能拿到几档给几档，拿不到就不要编造。
- 登录态：规则写 `play.account_id`（或沿用 `search.account_id`）后，解析会带上该账号的 `headers` 与 Cookie，脚本里用 `input.account` 读取 `{id,username,password,cookies,headers}`。绑定账号是用户的主动操作，即表示同意引擎在这条规则的搜索、播放解析与试播里使用这份登录态；没绑定就不会带账号信息。
- `play.api`：把 `play_url_regex` 的命名捕获组填进 URL 模板，逐条线路请求；返回 `{mode:"native",url}` 直接用，`mode:"iframe"` 记为兜底；带签名参数（`auth_key` 等）的地址会按时效稳定性降权。
- Agent 生成规则时会自动补 play 段：test_rule 通过后，用结果里的详情页调用 test_play 反复验证，直到返回 success=true 且 format 为 hls/mp4/flv 再保存；站点确实不可播（iframe/纯元数据）时如实汇报，不编造。工具签名：test_play(detail_url, rule?)——传 rule 可以测试尚未保存的 play 配置；规则绑定账号时 test_play 会带上该账号 Cookie（可验证会员/登录后才可用的线路）。
- 通用兜底：详情页/播放页 HTML 里的 `m3u8/mp4/flv`、`"url":"..."`、`player_aaaa`、选集链接；最后才用受控浏览器（`play.script`/`api`/`http` 都拿不到且页面依赖 JS 渲染时）打开播放页嗅探网络请求。

示例（虚构站点，服务端 `/api/*` 不被 Cloudflare 拦，直接脚本解析）：

```js
const m = String(input.pageUrl).match(/\/title\/([^\/?#]+)/);
const id = m[1].split('-')[0];
const H = {Referer: 'https://video.example.com/', 'User-Agent': '...'};
const d = await (await fetch('https://video.example.com/api/lines?title=' + id, {headers: H})).json();
// lines[].episodes[].url：直链 m3u8 直接用；/api/play?id=... 再 fetch 一次拿签名 mp4
return {url: bestUrl, format: 'hls', headers: H, episodes: [...]};
```

注意：受控浏览器（`browser_*`）在 Windows 上以 `--no-sandbox` 无头运行；没有这个参数时某些受限上下文里的 Edge 不会创建渲染进程，page 级 CDP 会一直超时。

### 3.6 账号绑定

账号存在 `data/accounts.json`，字段：`name`、`site`、`username`、`password`、`cookies`、`headers`、`notes`。列表/详情接口默认掩码密码与敏感头。

GUI 不再提供账号表单：在「设置 → 站点登录」填地址后点「显示登录窗口」，用可见浏览器人工登录，再点「保存登录态」即把该域名的 Cookie 写入账号库；大模型只看到账号 id/名称，拿不到 Cookie。

Agent 也能自己决定何时显示窗口：遇到登录墙时它会调用 `browser_show` 把浏览器窗口弹给用户人工登录，用户登录后它调用 `browser_save_login` 保存登录态，再用 `browser_hide` 收回后台（无头与可见模式共用同一 profile，登录态不丢）。

规则里写 `"search": {"account_id": "<账号 id>"}`：

- HTTP 模式自动合并账号 `headers`；没有显式 Cookie 时注入 `Cookie: <cookies>`。
- 脚本模式从 `input.account` 读取 `{id,username,password,cookies,headers}`。

播放解析同样支持账号：`"play": {"account_id": "<账号 id>"}`；没写时沿用 `search.account_id`（兼容旧规则）。绑定后 `test_play` 与线上播放解析都会带上该账号的 Cookie 与请求头，适合会员内容、或登录后才返回多档清晰度的站点（例如 B 站）。`bind_account` 会同时写入 `search.account_id` 和已有的 `play` 段，绑定前应先征得用户同意。

### 3.7 规则自动修复

搜索执行失败（请求异常或解析到 0 条）时，引擎会自动把规则交给大模型修复，然后用原关键词重试一次：

- 配置 `repair.enabled` 控制开关（GUI「设置」里也有同名开关），`cooldown_sec` 默认 600 秒。
- 同一规则在冷却期内最多修一次，避免每次搜索都打模型；修复成功后冷却记录清空。
- 修复流程：`get_rule` 读最新规则 → `fetch_page`/`browser_*` 实际查看站点 → 改 `search`/`parse` → `test_rule` 验证 → `update_rule` 更新同一个 id，不会新建规则。
- 搜索响应会带 `repair: {attempted,success,ruleId,error,steps,tookMs}` 与 `repaired` 字段，`warnings` 里也会说明是否修复成功。
- 没有配置 LLM API key、或修复失败时，返回原始搜索错误，不影响调用方。

### 3.8 可见性

- `visibility: "public"`：所有房间可用；`"root"`：仅管理员可用。
- `allowed_rooms: []`：所有房间；非空：只允许列表里的房间 ID。
- `enabled: false`：所有人不可见（管理端仍可见）。
- 搜索接口同时传 `roomId` 与 `role`，由引擎过滤；最终权限校验仍应由 backend-go 再做一次。

### 3.9 人机验证（challenge）

很多站点在搜索前会返回验证码、滑块或 403 验证页。引擎不会尝试绕过验证，而是把验证页转给人工完成，再用同一会话继续抓取：

~~~json
"challenge": {
  "enabled": true,
  "url_contains": ["/verify"],
  "title_contains": ["安全验证"],
  "keywords": ["人机验证", "请完成验证"],
  "selectors": ["#captcha", ".verify-box"],
  "statuses": [403, 429, 503],
  "wait_selector": "#results .item",
  "wait_seconds": 1.5,
  "note": "搜索前需要在弹出的窗口完成滑块"
}
~~~

- 检测顺序：URL 片段 → HTTP 状态码 → 选择器 → 标题 → 关键词 → 可选脚本（`challenge.script`，JS 沙箱）。
- 4xx/5xx 响应也会先按验证页判断（`_fetch_or_challenge_page`），不会直接当成网络错误。
- 命中后搜索返回 `code=challenge_required`，`details` 带 `challengeId`、`proxyUrl`、`pageUrl`、`note`，同时创建 30 分钟有效的验证会话。
- 验证页通过同源反代提供：HTML 里的链接/表单/静态资源自动改写到 `/api/crawler/challenge/{id}/site/...`，注入的 shim 会接管 `fetch`/`XHR`/`window.open`；上游 `Set-Cookie` 收进会话，浏览器只拿到带会话前缀的代理 Cookie。
- 打开 `proxyUrl` 时会 302 回触发验证的搜索地址（不是站点首页）。
- 用户完成后调用 `POST /api/crawler/challenge/{id}/verify`：引擎带会话 Cookie 重试搜索；仍被拦截返回 `challenge_required`，成功则标记完成并直接返回结果。
- 前端一起看搜索遇到 `challenge_required` 会弹 iframe 验证窗并轮询 verify；GUI 也可在「爬虫引擎 → 人机验证」打开系统浏览器完成。
- 自动修复不会把验证页误判为解析失效（`ChallengeError` 不触发修复）。

## 4. 手动添加与导入导出

### 4.1 规则怎么进来（三种部署形态）

| 形态 | 规则来源 | 落盘位置 |
|---|---|---|
| Windows 桌面版 | GUI「爬虫引擎 → 站点规则」生成后**直接生效** | `<运行包>/runtime/crawler/data/rules` |
| 单文件版 | 桌面版导出的 JSON → 网页「管理 → 全网搜片」导入，或命令行 `--import-rules` | `<exe 同级>/config/crawler/data/rules` |
| Docker | 同上；`docker cp` + `docker exec` 或管理页导入 | `/app/config/crawler/data/rules`（`config` 是命名卷，重建容器不丢） |

桌面版「即写即生效」不是导入动作：GUI 与后端本来就共用同一个规则目录。另外两种形态没有 GUI，需要把桌面版导出的规则包搬过去。

规则根目录的解析顺序：`CRAWLER_ROOT` 环境变量 → `exe/crawler` → `exe/runtime/crawler` → `cwd/crawler` → 上级目录的 `crawler`。全部落空时兜底到 `<CONFIG_DIR>/crawler` 并自动创建（启动日志会打印 `[crawler] 规则目录=…`）。桌面壳始终通过 `ZVIEWER_CRAWLER_ROOT` 显式下发，不受兜底影响。

**网页端导入（单文件 / Docker 主路径）**

「管理 → 全网搜片」：选择或粘贴规则包 → 「预检」先看报告 → 「确认导入」。合并（merge）按 `id` 或「名称 + 站点」匹配已有规则；替换（replace）会先把当前全部规则备份到 `<root>/backup-<时间>.json` 再清空。导入立即生效，不用重启——每条规则是独立 JSON 文件，搜索时现读。

**命令行导入（无人值守 / 脚本化部署）**

```bash
# 预检：只校验，不落盘
zviewer-backend --import-rules rules.json --dry-run
# 合并导入
zviewer-backend --import-rules rules.json
# 整体替换（自动备份原规则）
zviewer-backend --import-rules rules.json --mode replace
# 目标机没有源机的 Cookie，一次性清掉账号与房间引用
zviewer-backend --import-rules rules.json --clear-accounts --clear-rooms
# 反向导出
zviewer-backend --export-rules out.json
# 临时指定别的规则根
zviewer-backend --import-rules rules.json --root /data/crawler
```

Docker 里：

```bash
docker cp rules.json zviewer:/app/rules.json
docker exec zviewer ./zviewer-backend --import-rules /app/rules.json
```

命令行与网页端走同一个导入器，报告字段完全一致（`imported` / `updated` / `failed` / `items` / `warnings` / `backupFile`）。

**换机必看的两个引用**

规则里的 `search.account_id` / `play.account_id` 指向源机的 Cookie 资产，`allowed_rooms` 是源服务器的房间 ID。目标机对不上时导入仍会成功，但会出现「搜了必报账号不存在」或「只有管理员可见」。导入报告会逐条给 `warnings`；不想逐条处理就加 `--clear-accounts` / `--clear-rooms`（管理页对应两个勾选框）。

### 4.2 导出文件格式

```json
{
  "format": 1,
  "kind": "zviewer-crawler-rules",
  "exported_at": "2026-11-11T22:00:00+08:00",
  "count": 2,
  "rules": [ { "...完整规则...": true } ]
}
```

导入接受三种形态：上述 bundle、`{"rules":[...]}`、裸规则数组。导入会逐条校验；有失败时返回 `success=false` 并列出 `items[].error`，成功的条目仍会写入（除非 `dryRun`）。`kind` / `format` 对不上只记警告不拒绝——宁可导进来让人看见，也比一句「格式不对」强。单个规则包上限 8 MB。

## 5. HTTP API

路径前缀是网页服务的 `/api/crawler/*`（默认 `http://localhost:3333`）。管理接口要管理员登录态（`Authorization: Bearer`），桌面控制台用壳内令牌（`X-Desktop-Token`）代替。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/crawler/status` | 引擎状态（规则数、是否配置 Key、浏览器状态） |
| GET | `/api/crawler/sites?roomId=&role=` | 当前房间可见站点 |
| GET | `/api/crawler/sites/{id}` | 单条规则（admin） |
| POST | `/api/crawler/search` | `{site,keyword,roomId,role,limit}` |
| POST | `/api/crawler/play/resolve` | 详情页 → 播放地址：`{url,roomId,role}`，返回 `{success,title,format,url,headers,episodes,source,note,qualities?}` |
| GET | `/api/crawler/rules` | 规则列表（admin） |
| POST | `/api/crawler/rules` | 手动新增/保存（admin） |
| GET/PUT/DELETE | `/api/crawler/rules/{id}` | 查看/局部更新/删除（admin） |
| GET | `/api/crawler/rules/export?ids=a,b` | 导出（admin） |
| POST | `/api/crawler/rules/import` | `{bundle|rules, mode, dryRun}`（admin） |
| POST | `/api/crawler/generate` | 让 agent 生成并保存规则（admin） |
| GET/POST | `/api/crawler/submissions` | 成员提交的站点列表/新增（admin） |
| GET/DELETE | `/api/crawler/submissions/{id}` | 提交详情/删除（admin） |
| POST | `/api/crawler/submissions/{id}/run` | 与人工对话完全一致：缺省新建会话并发送一条「生成规则」消息，然后走 `/agent/runs` 流式通道；空闲时返回 `runId/sessionId/message/queued:false`，忙时返回 `{queued:true,position}`（admin） |
| POST | `/api/crawler/submissions/{id}/generate` | 兼容入口，语义同 `/run`（同样进串行队列）；GUI 已改用上面的 `/run`（admin） |
| GET/POST | `/api/crawler/accounts` | 账号列表/保存（admin，GUI 由站点登录生成） |
| GET/DELETE | `/api/crawler/accounts/{id}` | 账号详情/删除（admin） |
| GET | `/api/crawler/browser/status` | 离屏浏览器状态（admin） |
| POST | `/api/crawler/browser/open` | 无头打开页面 `{url}`（admin） |
| POST | `/api/crawler/browser/open-login` | 打开可见窗口供人工登录 `{url}`（admin） |
| POST | `/api/crawler/browser/show` | 把当前/指定页面显示成可见窗口，供用户登录 `{url?,waitSec?}`（admin） |
| POST | `/api/crawler/browser/hide` | 收起可见窗口，转回无头运行（admin） |
| POST | `/api/crawler/browser/save-login` | 保存该站点 Cookie 为账号 `{site,name}`（admin） |
| POST | `/api/crawler/browser/close` | 关闭浏览器（admin） |
| POST | `/api/crawler/browser/clear-profile` | 清空浏览器 profile（admin） |
| GET/POST | `/api/crawler/agent/sessions` | 会话列表/新建，body 可带 `model`、`reasoningEffort`（admin） |
| GET/PUT/DELETE | `/api/crawler/agent/sessions/{id}` | 会话详情/更新/删除，PUT 可改 `model`、`reasoningEffort`、`title`（admin） |
| POST | `/api/crawler/agent/chat` | `{sessionId,message,context,model?,reasoningEffort?}`（admin） |
| POST | `/api/crawler/agent/runs` | 流式运行 Agent：`{sessionId,message,images,context,model?,reasoningEffort?}`，返回 `runId`（admin） |
| GET | `/api/crawler/agent/runs/{runId}?cursor=N` | 增量读取运行事件（thinking/tool/step）与最终答复，返回 `{success, run:{status,events,nextCursor,done,reply,...}}`（admin） |
| POST | `/api/crawler/agent/runs/{runId}/cancel` | 取消运行（admin） |
| GET/PUT | `/api/crawler/config` | 读/改配置，API key 掩码（admin） |
| GET | `/api/crawler/challenges?all=1` | 待处理人机验证会话列表（不含 Cookie 值） |
| GET | `/api/crawler/challenge/{id}` | 单个验证会话状态 |
| DELETE | `/api/crawler/challenge/{id}` | 删除验证会话 |
| POST | `/api/crawler/challenge/{id}/verify` | 带会话 Cookie 重试搜索，成功返回结果 |
| GET/ANY | `/api/crawler/challenge/{id}/site/...` | 验证页同源反代（页面/JS/CSS/图片，无需登录态） |

示例（桌面控制台用壳内令牌，网页端用登录后的 Bearer）：

```bash
BASE=http://localhost:3333
TOKEN='<管理员 accessToken 或壳内令牌>'

curl -s "$BASE/api/crawler/status" -H "Authorization: Bearer $TOKEN"

curl -s -X POST "$BASE/api/crawler/rules" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  --data @rule.json

curl -s -X POST "$BASE/api/crawler/rules/import" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  --data '{"bundle": <bundle-json>, "mode": "merge", "dryRun": true}'
```

## 6. 工具集（MCP）

同一份工具注册表（`internal/crawler/tools.go`）供三个调用方使用：Agent 对话、`/api/crawler/tools`、以及 MCP 客户端。MCP 入口就是后端可执行文件本身：

```bash
zviewer-backend --mcp            # stdio，JSON-RPC 2.0，一行一条报文
zviewer-backend --mcp --root D:\crawler   # 显式指定数据目录
```

这个模式**不读 .env、不连数据库、不开任何端口**：只把 stdin 的 JSON-RPC 交给引擎，把结果写回 stdout；诊断日志一律走 stderr（stdout 混进别的字符，客户端会直接判定协议错误）。目录优先级：`--root` → `CRAWLER_ROOT` → `ZVIEWER_CRAWLER_ROOT` → exe 同级的 `crawler/` 或 `runtime/crawler/`。

客户端配置（Claude Desktop 的 `claude_desktop_config.json`、Cursor 的 `.cursor/mcp.json` 都是这个形状）：

```json
{
  "mcpServers": {
    "zviewer-crawler": {
      "command": "C:\\Program Files\\ZViewer\\runtime\\zviewer-backend.exe",
      "args": ["--mcp"]
    }
  }
}
```

VS Code 的 `.vscode/mcp.json` 把 `mcpServers` 换成 `servers`，并加 `"type": "stdio"`。桌面控制台的「爬虫引擎 → MCP 工具」按钮会按当前安装路径生成这三份配置，可直接复制。

协议：支持 `2024-11-05` / `2025-03-26` / `2025-06-18`，按客户端请求协商，不认识的版本回最新；方法有 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、`resources/list`、`prompts/list`（后两个返回空列表，部分客户端会先探一下）。

工具（26 个）：

- 抓取/检查：`fetch_page`、`inspect_html`、`inspect_challenge`、`detect_challenge_html`
- 规则：`test_rule`、`save_rule`、`list_rules`、`get_rule`、`update_rule`、`delete_rule`、`generate_rule`
- 播放：`test_play`
- 搜索：`search_site`、`list_sites`、`search_logs`
- 账号：`list_accounts`、`save_account`、`delete_account`、`bind_account`
- 浏览器：`browser_status`、`browser_open`、`browser_text`、`browser_html`、`browser_eval`、`browser_click`、`browser_cookies`

`tools/call` 把工具结果序列化成 JSON 放进 `content[0].text`；工具返回 `success:false` 时 `isError` 为 `true`，模型据此决定是否重试。`task_complete`、`ask_user`、`rename_session` 由 Agent 的 run 循环直接处理（依赖会话上下文），**不作为 MCP 工具暴露**。

没有 `config.json`（或里面没有 `api_key`）时 `generate_rule` 仍会注册，调用时才报「未配置模型」——这样客户端的工具表始终是完整的。

## 7. Agent 对话

`POST /api/crawler/agent/chat` 支持多轮工具调用，会话持久化在 `data/sessions/`；`POST /api/crawler/agent/runs` 是 GUI 使用的流式版本，返回 `runId` 后可用 `GET /api/crawler/agent/runs/{runId}?cursor=N` 增量读取思考、工具调用与最终答复。两者都支持：

- Agent 的 registry 已注入 `browser_*` 工具（与管理员一致），可以自己打开离线浏览器、读渲染后 HTML、执行脚本探查接口；登录仍必须由人工在窗口里完成。
- 行为约定（写进系统提示词）：处理站点前先查已有规则，**同站点优先 `update_rule` 修改**，不新建；默认自主执行、工具调用次数不设上限，但需求有歧义、缺用户才能提供的信息、同一问题连续 2~3 次失败、需要用户决定换站点/放弃、需要人工登录或人机验证时，应当用 `ask_user` 暂停本轮提问（可带 2~4 个 `options`），不要硬着头皮继续；需要登录/人机验证时 `browser_show` 打开窗口后用 `ask_user` 告知用户并暂停；站点自身原因（无法访问/403/会员/DRM 等）无法生成规则时如实说明；任务完成用 `task_complete` 回复，需要用户回答时用 `ask_user` 结束本轮。
- 模型调用 `ask_user` 后本轮立即结束：返回结果带 `awaitingUser: true`，`reply` 即要展示给用户的问题；用户回复后按普通对话继续，不会自动重试。
- `images`：最多 4 张图片，元素为 `data:image/png|jpeg|webp|gif;base64,...`；会作为多模态内容随最后一条用户消息发给模型。
- `context.rules`：引用规则列表 `[{id,name,site}]`（最多 10 条），引擎会在提示里附上「引用规则 ID / 名称 / 站点」，便于 Agent 直接改指定规则。

适合在 GUI 里：

- 「帮我把 example.com 配成可搜索站点」→ agent 抓页面、写规则、测试、保存。
- 「把这条规则改成只允许房间 R1 使用」→ 调用 `update_rule`。
- 「这个站点要登录」→ `browser_show` 把窗口显示给用户登录，再 `browser_save_login` 存成账号，最后 `bind_account`，可用 `browser_hide` 收回窗口。
- 「这条提交给个规则」→ 读 `data/submissions.json` 里的 url/keyword，按生成流程测试并保存。

- 成员提交的「生成规则」按钮走 `POST /submissions/{id}/run`：引擎缺省新建真实会话（标题「生成规则：站点名」）并像人工一样发送一条消息，GUI 复用 `/agent/runs` 的轮询逻辑实时显示 thinking/tool，run 结束后提交状态由引擎回写（done 需要找到该站点规则且 test_rule 通过，否则 failed）。
- **生成规则串行队列**：自动生成（`submissions.auto_generate` 提交即触发）和手动点「生成规则」共用同一个队列，同一时间只跑一个 run，上一个结束（成功/失败/取消）后自动开始下一个。队列项只保存 submissionId/sessionId/思考强度/模型，真正启动时才创建 run；提交状态依次是 `pending → queued → processing → done/failed`。
  - `POST /run` 空闲时直接返回 `runId`（`queued:false`），忙时返回 `{success:true,queued:true,position,sessionId}`，GUI 用 `position` 提示「已加入生成队列（第 N 位）」。
  - `GET /submissions` / `GET /submissions/{id}` 对排队中的记录额外返回 `queuePosition`（1 起），可用来展示队列位次。
  - `DELETE /submissions/{id}` 会先把该提交从队列取出再删除，避免已经删掉的站点仍被排队执行。
  - 每个排队项保留自己的 `sessionId`，轮到它时 GUI 点「查看会话」即可接上这次 run 的事件流实时看过程。
- 生成过程中会在调用模型前先把用户消息写入会话文件，所以中途打开会话不会空白。

- 「脚本里签名参数不对，帮我调试」→ `get_rule` + `update_rule` + `test_rule`。

生成单条规则的快捷接口是 `POST /api/crawler/generate`（url + keyword + notes），底层同样走 agent 工具循环。

Agent 可以在任务开始时调用 `rename_session` 工具把当前会话改成一句短语（≤16 个中文字符），GUI 会话下拉会显示新标题；用户也可以在 GUI 里手动重命名（`PUT /api/crawler/agent/sessions/{id}` 的 `title` 字段）。

每个会话可以单独指定模型和思考强度，并持久化在 `data/sessions/*.json`：新建会话时传 `model`（缺省取 `llm.model`），之后 `PUT /api/crawler/agent/sessions/{id}` 或在下一轮 chat 的 `model` 字段切换，只影响该会话后续请求。GUI 的 Agent 对话页顶部有「模型」「思考」两个会话级下拉，切模型从下一条消息生效。

## 8. 测试

```bash
cd backend-go
GOPROXY=https://goproxy.cn,direct go test ./internal/crawler/ ./internal/mcp/ ./internal/api/
```

覆盖 DOM/选择器、HTML/JSON/脚本搜索、播放解析（六路兜底 + 清晰度排序）、账号 Cookie 注入与掩码、验证会话与同源反代、CDP 浏览器嗅探、LLM 流式与工具调用、Agent 生成/修复/对话与 run 管理、导出导入往返与 dry-run/replace，以及 MCP 报文层（版本协商、tools/list、tools/call 的 isError 映射、通知不回包、错误码、行协议拆分）。

## 9. 已知边界

1. **MCP 与桌面端共用 `data/`**：stdio 进程与桌面后端各自持有一套引擎实例。规则文件是「写临时文件再改名」，并发安全；但 `data/search-log.json`、`data/accounts.json` 是整文件重写，两边同时写会丢更新。同一时间只在一个客户端里高频调用即可避免。`data/browser-profile` 被桌面端占用时，MCP 里的 `browser_*` 会报启动失败，关掉桌面端的浏览器会话即可。
2. **只提供 stdio 传输**：没有 HTTP 端点，远程/多客户端场景需要自行加一层转发（例如 `mcp-proxy`），不要把它暴露到公网。
3. **成员提交站点已移除**：网页端只保留 agent 直接建规则；GUI 的提交页会显示为空。
4. **可见登录窗口**依赖本机 Edge/Chrome；没有浏览器时只能在规则里写死 Cookie 或改用脚本规则。
