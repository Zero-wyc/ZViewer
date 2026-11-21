# crawler —— 一起看「全网搜片」爬虫引擎

目标：让「一起看」不只在内置 B 站 / WebDAV / Emby 等来源里选片，而是按片名在外部站点搜索，拿到**详情、选集、可播放地址**后加入影片列表。站点适配不写死代码，用 JSON 规则描述；规则可以由人手动添加，也可以让大模型通过 MCP 工具自动生成、测试、修正。

## 当前状态（2026-11-13）

- 引擎主体已实现，纯 Python 标准库 + 本机 Node.js（仅脚本规则需要），零第三方依赖。
- 支持三种规则：HTML 选择器、JSON 接口、Node 脚本（可发请求/算签名/处理 JS 渲染后的数据）。
- 支持手动增删改查、一键导出/导入、成员提交站点、离屏浏览器登录（Cookie 自动存账号）、按房间可见性。
- 规则解析失败会自动交给大模型修复（冷却期内一次），GUI 可开关。
- 人机验证：自动识别 403/验证码/滑块页，生成 30 分钟验证会话；验证页经同源反代给前端 iframe 或系统浏览器，完成后带 Cookie 重试搜索。agent 可写 `challenge` 识别规则。
- 大模型配置：GUI 填 API Key 后自动拉取 `/models` 下拉；支持思考强度（Agent 会话级 + 成员提交自动生成默认）。
- 搜索日志：限量 200 条，记录站点/关键词/房间/状态/条数/耗时/错误，agent 工具与 API 可查。
- 提供 HTTP API、MCP stdio 服务、命令行三种入口；引擎/API/提交/浏览器/验证等 55 个测试全绿。
- GUI「爬虫引擎」页已可用（状态、成员提交、规则、人机验证、agent 对话、站点登录、搜索日志）；房间内「全网搜片」按钮与 root 规则房间控制已接入；下一步是更多站点规则与解析质量。

## 目录

```text
crawler/
├── README.md               # 本文件
├── docs/
│   ├── engine.md           # 引擎使用手册：配置、规则 schema、API、MCP、导入导出
│   ├── research-log.md     # 站点抓取调研日志
│   └── model-research-2026-11.md
├── engine/                 # 引擎源码（python -m engine）
│   ├── dom.py              # 自建 DOM + CSS 子集选择器
│   ├── fetch.py            # HTTP 抓取、重试、编码
│   ├── rules.py            # 规则校验与 HTML/JSON 抽取
│   ├── scripts.py          # Node 脚本运行时（vm 沙箱）
│   ├── store.py            # 规则存储、可见性、导入导出
│   ├── search.py           # 搜索执行、账号注入、脚本模式、验证页识别
│   ├── challenge.py        # 验证页识别与提示
│   ├── challenge_proxy.py  # 验证会话、同源反代、Cookie 吸收
│   ├── searchlog.py        # 限量搜索日志
│   ├── accounts.py         # 账号库（Cookie 等，掩码返回）
│   ├── submissions.py      # 成员提交的站点（待生成规则）
│   ├── browser.py          # Chromium/CDP 离屏浏览器与人工登录
│   ├── agent.py            # 多轮对话 agent（function calling）
│   ├── llm.py              # OpenAI 兼容 /chat/completions 客户端
│   ├── tools.py            # 工具注册表（agent 与 MCP 共用）
│   ├── api.py              # HTTP API
│   ├── mcp_server.py       # MCP stdio 服务
│   ├── cli.py              # 命令行
│   └── tests/              # unittest
├── tests/test_dom.py       # 早期 DOM 单测
├── adapters/               # 预留：导出/内置规则
└── experiments/            # 一次性脚本、HTML 快照
```

## 快速开始

在 `crawler/` 目录执行（Windows 下把 `python` 换成你的解释器路径即可）：

```bash
# 查看状态（规则数、API key 是否配置、Node 是否可用）
python -m engine status

# 配置大模型（OpenAI 兼容接口，默认 DeepSeek）
python -m engine config set --api-key sk-xxx --model deepseek-chat

# 启动 HTTP API：http://127.0.0.1:3789
python -m engine serve

# 作为 MCP stdio 服务运行
python -m engine mcp

# 手动添加 / 列出 / 测试搜索 / 导出 / 导入规则
python -m engine rules add --file my-rule.json
python -m engine rules list
python -m engine search example 流浪地球 --role root
python -m engine rules export -o rules-backup.json
python -m engine rules import rules-backup.json --mode merge --dry-run
```

数据默认放在 `crawler/`：`config.json`、`data/rules/*.json`、`data/accounts.json`、`data/submissions.json`、`data/sessions/*.json`；浏览器 profile 在 `data/browser-profile`。

首次使用把仓库里的 `config.example.json` 复制成 `config.json`，填 `llm.api_key`（也可以启动后在 GUI「爬虫引擎」页填）。`config.json` 含密钥与本地路径，已被 `.gitignore` 排除，不要提交。

## 规则能表达什么

- **HTML 站点**：`parse.container` + 每个字段的 CSS 选择器与属性，支持 `#id`、`.class`、`[attr=value]`、后代/`>`、逗号分组、`:nth-child`、`:contains`、`:not`。
- **JSON 接口**：`parse.type="json"`，`list_path` 取列表（支持 `a.b[*].c`），字段用 `path`。
- **脚本**：`search.mode="script"` 或 `parse.type="script"`，在 Node `vm` 沙箱里执行，可 `fetch`、拼签名、返回自定义请求或直接返回结果。
- **账号**：`search.account_id` 绑定账号库；HTTP 模式自动带 Cookie/头，脚本内从 `input.account` 读取。GUI「设置 → 站点登录」显示可见浏览器人工登录后，可一键把 Cookie 存成账号。
- **登录/JS 站点**：引擎内置 Chromium/CDP 离屏浏览器，agent 可用 `browser_open`/`browser_text`/`browser_eval` 处理 SPA；遇到登录墙时 agent 会调用 `browser_show` 把窗口弹给用户人工登录，登录后 `browser_save_login` 存账号、`browser_hide` 收回后台。密码与 Cookie 不进入对话，账号只以 id 形式交给模型。
- **自动修复**：搜索失败（异常或 0 条）时自动让 agent 修规则并用原关键词重试一次，冷却 600 秒，响应带 `repair`/`repaired`。
- **可见性**：`visibility="public"` 所有人可用，`"root"` 仅管理员；`allowed_rooms` 为空表示所有房间，否则只允许列出的房间。

完整字段、示例与接口见 [docs/engine.md](docs/engine.md)。

## 测试

```bash
cd crawler
python -X utf8 -m unittest engine.tests.test_engine engine.tests.test_api engine.tests.test_submissions engine.tests.test_browser engine.tests.test_searchlog engine.tests.test_challenge engine.tests.test_challenge_proxy -v
```

## 边界

- 只做公开可访问页面的检索与信息提取；不破解 DRM、不绕付费墙/登录墙、不批量注册账号。
- 遵守目标站点 robots 与频控，默认低并发 + 本地缓存。
- 抓取结果只用于本房间播放/展示，不对外提供聚合站或二次分发接口。
- 规则失效必须降级（返回空结果 + 日志），不能拖垮房间功能。
- 站点域名、Cookie、密钥不要写进仓库，统一用占位符。

## 小模型调研（已被大模型 API 路线取代）

早期评估过本机小模型做 GUI/抽取（Holo3.1-0.8B、Holo1.5-3B、UGround-V1-2B 等），结论是「没有现成的爬虫模型」，详见 [docs/model-research-2026-11.md](docs/model-research-2026-11.md)。现在改为大模型 API + JSON 规则 + MCP，不再依赖本机小模型。

## 里程碑

- M1（完成）：引擎内核、规则 schema、HTML/JSON/脚本三种模式、测试。
- M2（完成）：账号库、agent 生成规则、MCP 工具、HTTP API、CLI、导入导出。
- M3（完成）：GUI「爬虫引擎」页（状态、成员提交+自动生成开关、规则列表/手动添加/导入导出、agent 对话、站点登录）。
- M4（进行中）：成员提交入口（backend-go 代理 + 前端按钮）、一起看站点搜索按钮，backend-go 调用引擎并做房间权限校验。
> 2026-11-14：搜索功能按用户要求暂停（当前状态见 `crawler/docs/task-progress-2026-11-13.md` 末尾）。
> 下一步「播放」研究在仓库根目录 `player/`（怎么把搜索结果变成可播放视频）。
