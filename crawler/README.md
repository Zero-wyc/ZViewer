# crawler —— 一起看「全网搜片」的本机数据与文档

目标：让「一起看」不只在内置 B 站 / WebDAV / Emby 等来源里选片，而是按片名在外部站点搜索，拿到**详情、选集、可播放地址**后加入影片列表。站点适配不写死代码，用 JSON 规则描述；规则可以手动添加，也可以让大模型自动生成、测试、修正。

## 当前状态（2026-11-22）

- 引擎已 **用 Go 重写并并入后端进程**（`backend-go/internal/crawler`）：不再有 Python 服务、Node 运行时与 3789 端口。
- `crawler/` 目录只剩本机数据与文档：`config.json`、`data/`、`docs/`。
- 支持的规则类型：HTML 选择器、JSON 接口、JS 脚本（内置 goja 沙箱，可发请求/算签名）。
- 播放解析：脚本 → 站点播放接口 → 详情页直链 → 播放页直链 → CDP 离屏浏览器嗅探，逐级兜底；多档清晰度按站点给出。
- 账号库：离屏浏览器人工登录后可把 Cookie 存成本地账号（0600），规则绑定后搜索/解析自动带登录态。
- 人机验证：自动识别 403/验证码页，建 30 分钟验证会话，验证页经同源反代给前端 iframe；完成后带 Cookie 重试搜索。
- Agent：多轮 function calling，可抓页面、试规则、改规则、生成新规则、绑账号；会话落盘 `data/sessions/`，GUI 可按游标轮询执行过程。
- 自动修复：规则解析失败时让大模型修一次（冷却期内一次），GUI 可开关。

## 目录

```text
crawler/
├── README.md               # 本文件
├── config.example.json     # 配置样例（真实配置是 config.json，不入库）
├── dev-model-server.py     # 本地假 LLM（开发调试用，3899 端口）
├── docs/
│   └── engine.md           # 使用手册：配置、规则 schema、API、Agent
├── data/                   # 本机数据（不入库）
│   ├── rules/*.json        # 站点规则
│   ├── accounts.json       # 站点账号（0600）
│   ├── sessions/*.json     # Agent 会话
│   ├── search-log.json     # 搜索日志
│   └── browser-profile/    # 离屏浏览器 profile
└── log/                    # 运行日志
```

引擎实现分布（`backend-go/internal/crawler`）：

| 文件 | 职责 |
| --- | --- |
| `fetch.go` `dom.go` | 抓取（重试/编码）、HTML 树与选择器 |
| `rule*.go` `extract.go` `store.go` | 规则 schema、校验、HTML/JSON 抽取、存储与导入导出 |
| `search.go` `challenge.go` `challenges.go` | 搜索主链路、验证页识别、验证会话与同源反代 |
| `play.go` `browser.go` `browser_login.go` | 播放解析六路兜底、CDP 浏览器、可见登录与 Cookie 导出 |
| `jsruntime.go` `llm.go` `tools.go` `agent.go` `agent_run.go` | goja 脚本沙箱、OpenAI 兼容客户端、工具注册表、Agent 与后台 run |
| `accounts.go` `searchlog.go` `config.go` | 账号库、搜索日志、配置读取 |

## 怎么用

不需要单独启动任何进程：桌面控制台与网页端都通过 `/api/crawler/*` 访问后端内置引擎。

- 桌面控制台：右栏「爬虫引擎」页（状态、站点规则、登录/验证、Agent 对话、设置）。
- 网页端：一起看房间 → 添加影片的数据源下拉 → 全网搜片。

配置在 GUI 的「爬虫引擎 → 设置」里填（服务地址 / 模型 / API Key / 自定义提示词），写入 `crawler/config.json`；后端按文件修改时间热加载，改完不用重启。

## 文档与测试

- 使用手册：[`docs/engine.md`](docs/engine.md)
- 测试：`cd backend-go && go test ./internal/crawler/ ./internal/mcp/ ./internal/api/`

## 边界

- 只抓公开页面，不处理付费墙 / DRM；需要登录的站点由用户在本机浏览器窗口里人工完成。
- 纯元数据站（豆瓣等）不编造播放地址；解析不到就明确报「不可播放」。
- MCP 客户端可直接调用全部工具：`zviewer-backend --mcp`（stdio），配置见使用手册第 6 节。
- MCP 与桌面端共用 `data/`，不要两边同时高频写搜索日志 / 账号库。
