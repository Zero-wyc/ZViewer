# ZViewer 接入 TVBox 式第三方视频源 — 实施计划

> 参考仓库：https://github.com/qist/tvbox（TVBox/OK影视 聚合配置仓库）
> 目标：让 ZViewer 像 ani / kazumi 一样，通过"源配置 + 规则解析"从第三方网站拉取视频。

---

## 一、TVBox 的源机制拆解

### 1.1 配置文件结构（顶层字段）

TVBox 客户端启动时向一个「接口 URL」（如 `jsm.json`）拉取整份配置：

| 字段 | 作用 |
|---|---|
| `spider` | 插件 jar 包地址（带 md5 校验），承载所有 `csp_` 类源实现 |
| `sites` | **点播源列表（核心）**，150+ 个站点 |
| `lives` | 直播源（m3u/txt） |
| `parses` | 网页/VIP 解析接口列表 |
| `flags` | 平台嗅探关键词（youku/qq/bilibili…），配合 parses |
| `rules` | m3u8 广告过滤规则（hosts + regex） |
| `ads` | 广告域名黑名单 |
| `hosts` | 域名重定向映射 |
| `doh` | 加密 DNS |

### 1.2 sites 站点对象与源类型

```json
{"key": "量子", "name": "影视 • 量子[直连]", "type": 1,
 "api": "https://cj.lziapi.com/api.php/provide/vod/",
 "searchable": 1, "categories": ["动作片", ...]}

{"key": "drpy_js_腾云驾雾", "name": "官源 • 腾讯", "type": 3,
 "api": "./lib/drpy2.min.js", "ext": "./js/腾云驾雾.js"}

{"key": "玩偶", "name": "玩偶 • 4K", "type": 3, "api": "csp_Wogg",
 "ext": {"site": ["https://www.wogg.live", ...]}}
```

- `type 0`：XML/m3u8 直连订阅
- **`type 1`：苹果 CMS V10 采集站**（`api.php/provide/vod` 纯 JSON API）——占比最大、最易复刻
- `type 2`：旧式 JSON 源
- **`type 3`：插件源**，三种实现：
  - `csp_XXX` → spider.jar 里的 Java 类（含 App 逆向壳、网盘源）
  - `./lib/drpy2.min.js` + `ext: ./js/xxx.js` → **drpy JS 规则引擎**
  - `./py/xxx.py` → Python 脚本源
- `type 4`：XPath 规则源（json 内嵌选择器规则）

### 1.3 拉取流程（六段式）

```
加载配置 URL
  → 解析 sites / spider / rules
  → 选择站点
  → homeContent    拉分类 + 筛选项
  → categoryContent 拉片单列表（vod_id/name/pic/remark）
  → detailContent  请求详情页，解析 tabs + 剧集列表（vod_play_from / vod_play_url："第x集$链接#第y集$链接"）
  → playerContent  请求播放页，解析/嗅探出 m3u8|mp4 直链（lazy 规则或默认抓取）
  → 播放器带 Referer/UA 播放，rules/ads 过滤广告分片
```

### 1.4 drpy 规则型源（声明式，无手写函数）

以 `js/NT动漫.js` 为例，一个 rule 对象声明全部信息，引擎自动生成六段接口：

```js
{ title: 'NT动漫', host: 'http://www.ntdm8.com',
  url: '/show/fyclassfyfilter.html',        // 分类页模板
  searchUrl: '/search/**----------fypage---.html',
  class_parse: '.search-tag li;a&&Text;a&&href;.*/(\\w+).html',  // 分类选择器
  一级: '.blockcontent1&&.blockdif2;img&&alt;img&&src;.newname&&Text;a&&href', // 列表: 容器;标题;封面;备注;详情链接
  二级: { title: 'h4&&Text', img: '.poster&&src', tabs: '#menu0&&li', lists: '.movurl:eq(#id)&&li' },
  lazy: '', play_parse: true }
```

`&&` 分段选择器 + `fycalss/fypage/{{fl.xxx}}` URL 占位符是整套规则语法核心；`lazy` 为空则引擎默认抓播放页里的直链。

### 1.5 对 ZViewer 的可移植性结论

| TVBox 机制 | ZViewer 移植可行性 |
|---|---|
| 配置 JSON（sites/sites 字段） | ✅ 直接解析，作为「源配置」存储 |
| **type 1 苹果 CMS 采集站** | ✅ 纯 JSON API，后端一个 provider 即可，**首选落地** |
| type 4 XPath / XBPQ 选择器规则 | ✅ **ZViewer 已有 Kazumi 规则引擎**（xpath/正则抓取），可复用或做一层规则翻译 |
| drpy JS 规则源 | ⚠️ 需在后端沙箱跑 JS（node:vm），二期实现 |
| csp_XXX jar 插件 / App 逆向源 | ❌ Java 不可行，排除 |
| 规则 ads/rules 广告过滤 | ⚠️ hls-engine 侧可做分片 URL 黑名单过滤，可选增强 |
| parses 嗅探解析 | ⚠️ 需要无头浏览器/WebView，成本高，暂不做 |

---

## 二、ZViewer 现状盘点（接入点）

ZViewer 已经有与 TVBox 同构的三段式架构，**Kazumi 就是现成范式**：

1. **数据模型**：`backend/src/entities/Movie.ts` 的 `source`(varchar) + `sourceMeta`(JSON，anime 源已在用)。新源类型只需在 DTO union（`movie.dto.ts`）、`roomStore.mapDtoToMovie()`、`MovieListPanel.SOURCE_LABELS`、`MoviePushPanel.SourceType` 四处登记。
2. **解析范式**：`routes/kazumi.ts` 五件套（sources/search/episodes/resolve/proxy）+ `services/kazumi/`（ruleLoader/provider/scraper）——CMS 源完全照此复制。
3. **URL 时效语义**：anime 源的「播放时经 sourceMeta 重新解析拿新鲜直链」与 CMS 采集站直链易失效的特点完全匹配，直接复用 `resolveMovieSource` 的 `anime` 分支模式加 `cms` 分支。
4. **代理就绪**：`/api/stream/proxy` + `proxyHttpUpstream`（自定义 headers/Referer 透传、SSRF 防护）+ hls-engine 可播第三方 m3u8。
5. **UI 就绪**：`AnimeSourceBrowser.tsx`（源列表→搜索→选集）可作为新 tab 的模板；设置管理走 `SystemSettings` JSON 列（参考 `dataSourceConfig`）。

缺口：CMS JSON API provider、TVBox 配置导入/管理、m3u8 内相对路径分片拼接、多源聚合搜索。

---

## 三、分阶段实施计划

### Phase 1 — 后端 CMS 采集源 + TVBox 配置导入（核心，先做）

**新增 `backend/src/services/cms/`**：

- `tvboxConfigLoader.ts`
  - 输入接口 URL（远程 json / 本地上传），拉取并解析：`sites`（只认 type 1 + type 3 中 api 为 CMS 形态的）、`header`/`timeout`
  - md5 校验字段忽略；`ext` 若为对象则透传
  - 缓存 + 手动/定时刷新（TVBox 配置每日漂移，刷新语义参考 kazumi ruleLoader）
- `cmsProvider.ts`
  - `search(site, wd)` → `api?ac=videolist&wd=`；`detail(site, vodId)` → `api?ac=videolist&ids=`
  - 解析 `vod_play_url`（`名$链接#...`）与 `vod_play_from`（多播放源→多选集组）
  - 直链规范化：相对路径补全、m3u8/mp4 格式嗅探（复用 mediaFormat 检测逻辑下沉后端）
- `types.ts`：`CmsSite`、`CmsVodItem`、`CmsEpisode`

**新增 `backend/src/routes/cms.ts`**（照 kazumi.ts 五件套）：

- `GET /api/stream/cms/sources` — 可用站点列表（来自已导入配置）
- `GET /api/stream/cms/search?siteKey=&wd=`
- `GET /api/stream/cms/detail?siteKey=&vodId=`
- `GET /api/stream/cms/resolve?siteKey=&vodId=&episode=` — 返回新鲜直链 + 所需 headers（播放时实时调用，TTL 缓存 + 单飞去重，参考 movie-direct-resolver）
- 代理复用现有 `/api/stream/proxy`，为 CMS 域名补 Referer/UA 透传规则

**配置存储**：`SystemSettings` 新增 JSON 列 `cmsSourcesConfig`（接口 URL 列表 + 启用站点 key），走既有四步套路（实体列 → DEFAULT_SETTINGS → admin.ts 校验 → AdminPage/systemSettingsStore）。admin UI 加「TVBox 源管理」区块：添加接口 URL、拉取预览 sites、勾选启用。

### Phase 2 — 前端：添加影片 + 播放链路

- `MoviePushPanel` 新增「采集源」tab：照 `AnimeSourceBrowser` 模式（站点下拉 → 搜索 → 结果卡片 → 选集）→ `addMovie({ source: 'cms', url: '', sourceMeta: { siteKey, vodId, episodeIndex, playFrom } })`
- 四处类型登记：`movie.dto.ts` union 加 `'cms'`、`roomStore.mapDtoToMovie`、`MovieListPanel.SOURCE_LABELS`、`MoviePushPanel.SourceType`
- `movie-source-resolver.ts` 加 `cms` 分支：调 `/api/stream/cms/resolve` 拿新鲜直链 + headers，返回 `ResolvedMovieSource`（headers 进 `PlayerSource.headers`，走现有代理决策 `resolveProxyUrl`）
- 观众端一致性：解析一律走服务器（服务器拿直链广播/落库），与 Kazumi「信令级锚定」语义一致，观众无需处理源站 CORS/防盗链
- `MovieListPanel`：cms 影片显示站点名 + 清晰度/刷新直链按钮（直链失效 → 触发 re-resolve）

### Phase 3 — 增强项（可选，按需排期）

- **drpy JS 规则引擎**：后端 `node:vm` 沙箱实现 rule 对象（class_parse/一级/二级/lazy），把 drpy 规则源也吃进来 —— 覆盖面大增但工作量大，单独立项
- **聚合搜索**：`/api/stream/cms/search-all` 并发查多个启用站点，前端合并去重（标题归一化）
- **m3u8 广告过滤**：hls-engine 分片加载层按域名黑名单跳过（对应 TVBox rules/ads）
- **规则翻译层**：把 TVBox type 4/XBPQ 选择器规则转译为 Kazumi 规则格式，统一到一套引擎

### 明确不做

- `csp_XXX` jar 插件、App 逆向源（Java 生态无法在 Node 后端运行）
- parses 网页嗅探（需无头浏览器，成本/风险高）
- 直播源 lives（ZViewer 定位是点播观影）

---

## 四、风险与注意事项

1. **合规**：采集站内容多为盗版搬运，功能定位为私有部署自用，配置由管理员自行导入，不内置任何默认源 URL。
2. **直链时效**：CMS 直链普遍短时效且防盗链，必须坚持「播放时实时 resolve + sourceMeta 锚定」语义，不要把直链当持久数据落库播放。
3. **源漂移**：TVBox 配置每日更新，需要「配置刷新」入口 + 站点失效检测（resolve 连续失败 N 次标记停用）。
4. **SSRF**：后端拉取用户提供的接口 URL / CMS API，需复用 kazumi 侧已有的域名安全校验。
5. **广告与杂链**：采集站 m3u8 常夹带广告分片，Phase 3 的过滤规则值得提前设计字段。
6. **验证口径**：沿用项目惯例——`npm test -w frontend`、tsc/eslint 0 错 0 警，完成即本地 commit（不 push）。
