# ZViewer

多人同步追番、观影与远程共享平台。

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [本地开发](#本地开发)
- [生产部署](#生产部署)
- [环境变量](#环境变量)
- [权限模型](#权限模型)
- [视频源](#视频源)
- [常见问题](#常见问题)

---

## 功能特性

### 一起看房间

创建或加入房间，与好友同步观看番剧、电影与视频。房主控制播放进度，观众实时跟随，支持暂停、跳转、倍速同步。

### 屏幕共享

基于 WebRTC 的屏幕共享功能。分享端可共享屏幕或视频画面，观看端经房主授权后低延迟观看。

### 多源视频解析

| 来源 | 说明 |
|---|---|
| Bilibili | 解析 BV 号或视频链接，支持 DASH 音视频合并、清晰度切换、大会员凭证 |
| ani-subs 订阅 | 自定义 JSON 订阅源，聚合 web-selector 与 RSS 番剧资源 |
| Kazumi 规则 | 导入 Kazumi 插件规则，使用 XPath/CSS 选择器解析第三方站点 |
| MP4 直链 | 直接播放可访问的 MP4 视频地址 |
| WebDAV | 挂载 WebDAV 服务器，浏览并播放其中的视频文件 |
| FTP | 挂载 FTP 服务器，浏览并播放其中的视频文件 |
| OpenList | 挂载 OpenList 服务，浏览并播放其中的视频文件 |

### 实时互动

- 评论面板：房间内实时收发文字评论
- 弹幕系统：支持 Bilibili 官方弹幕、DandanPlay 弹幕、自定义弹幕轨道
- 播放状态同步：房主播放/暂停/跳转/倍速实时同步给所有观众
- 观众申请：观众可申请跳转进度或暂停，房主确认后执行

### 主题系统

- Material You (Monet) 动态主题：从壁纸提取色彩，生成完整色板
- 明暗主题切换
- 自定义背景图片，支持模糊、透明度、缩放、旋转调节
- 玻璃拟态 (Glassmorphism) UI 效果
- 减少动效模式

### 其他

- 多挂载点管理：保存常用的 WebDAV / FTP / OpenList 连接配置
- 一键更新：通过 GitHub CDN 检测并拉取最新版本
- 房间列表：浏览所有公开房间，快速加入

---

## 技术栈

### 前端

- React 18 + TypeScript
- Vite 8 构建工具
- Tailwind CSS 原子化样式
- Zustand 状态管理
- Socket.IO Client 实时通信
- React Router v6 路由
- Material Color Utilities 主题色彩生成
- flv.js / Danmaku 弹幕引擎

### 后端

- Node.js + TypeScript
- Express 5 Web 框架
- Socket.IO 实时通信
- TypeORM + better-sqlite3 数据持久化
- node-media-server 流媒体推送
- bcryptjs 密码加密
- JSON Web Token 鉴权

### 部署

- Docker + Docker Compose
- Nginx 反向代理

---

## 项目结构

```
ZControl/
├── frontend/                # 前端 (React + Vite)
│   ├── src/
│   │   ├── components/      # 通用组件 (Button, Card, Dropdown, Modal...)
│   │   ├── modules/         # 业务模块
│   │   │   ├── room/        # 房间与一起看
│   │   │   ├── screen-sharing/  # 屏幕共享
│   │   │   ├── sync-playback/   # 同步播放核心
│   │   │   ├── bilibili/   # Bilibili 解析
│   │   │   ├── mounts/     # 挂载点管理
│   │   │   ├── webdav/     # WebDAV 浏览
│   │   │   ├── ftp/        # FTP 浏览
│   │   │   ├── openlist/   # OpenList 浏览
│   │   │   └── admin/      # 管理后台
│   │   ├── pages/          # 页面组件
│   │   ├── store/          # Zustand 状态
│   │   ├── hooks/          # 通用 Hooks
│   │   └── lib/            # 工具库
│   ├── public/             # 静态资源
│   └── nginx.conf          # 生产 Nginx 配置
├── backend/                 # 后端 (Express + TypeORM)
│   ├── src/
│   │   ├── entities/       # 数据库实体
│   │   ├── routes/         # HTTP 路由
│   │   ├── services/       # 业务服务
│   │   │   ├── bilibili/   # Bilibili 解析与凭证
│   │   │   ├── anime/      # 番剧源聚合
│   │   │   ├── danmaku/    # 弹幕聚合
│   │   │   ├── room/       # 房间状态与同步
│   │   │   └── screen-sharing/  # WebRTC 信令
│   │   ├── middleware/     # 中间件
│   │   └── utils/          # 工具
│   └── Dockerfile
├── docker-compose.yml       # 生产编排
├── start-prod.ps1           # Windows 启动脚本
├── start-prod.sh            # Linux/macOS 启动脚本
└── package.json             # npm workspaces 根配置
```

---

## 快速开始

### 默认管理员

系统首次启动时自动创建超级管理员账号：

- 用户名：`root`
- 密码：`root`

> 生产环境部署后请立即修改默认密码。

### Docker 一键启动

```bash
# 1. 复制环境变量模板
cp .env.example .env

# 2. 修改 JWT 密钥（必须）
# 编辑 .env，将 JWT_ACCESS_SECRET 和 JWT_REFRESH_SECRET 替换为强随机字符串

# 3. 构建并启动
docker compose up -d --build

# 4. 查看日志
docker compose logs -f
```

启动后访问：

- 前端：http://localhost
- 后端 API：http://localhost/api
- 健康检查：http://localhost/health

停止服务：

```bash
docker compose down          # 保留数据
docker compose down -v       # 同时删除数据卷
```

---

## 本地开发

项目使用 npm workspaces，根目录统一安装依赖。

```bash
# 安装全部依赖
npm install

# 同时启动前后端开发服务
npm run dev

# 或分别启动
npm run dev:backend
npm run dev:frontend
```

开发端口：

- 前端：http://localhost:5174（Vite dev server）
- 后端：http://localhost:3000

前端开发时默认通过 Vite 代理连接后端，无需额外配置 `VITE_API_URL`。

---

## 生产部署

### 一键启动脚本

项目根目录提供跨平台启动脚本，支持启动、停止、重启、查看状态与日志。

#### Windows (PowerShell)

```powershell
.\start-prod.ps1 start                # 构建并启动
.\start-prod.ps1 stop                 # 停止
.\start-prod.ps1 restart              # 重启
.\start-prod.ps1 status               # 查看状态
.\start-prod.ps1 logs backend         # 查看后端日志
.\start-prod.ps1 logs frontend        # 查看前端日志
```

双击 `start-prod.bat` 可打开交互菜单。

#### Linux / macOS

```bash
./start-prod.sh start                 # 构建并启动
./start-prod.sh stop                  # 停止
./start-prod.sh restart               # 重启
./start-prod.sh status                # 查看状态
./start-prod.sh logs backend          # 查看后端日志
./start-prod.sh logs frontend         # 查看前端日志
```

#### 常用选项

| 选项 | PowerShell | Bash | 说明 |
|---|---|---|---|
| 跳过构建 | `-SkipBuild` | `--skip-build` | 复用已有 `dist/` 产物 |
| 智能跳过 | `-AutoBuild`（默认） | — | 源码未修改时自动跳过构建 |
| 强制构建 | `-NoAutoBuild` | — | 禁用智能跳过，强制构建 |
| 后端端口 | `-Port <int>` | `-p, --port <int>` | 默认 3000 |
| 前端端口 | `-FrontendPort <int>` | `--frontend-port <int>` | 默认 4173 |
| 数据库 | `-Database <url>` | `-d, --database <url>` | 覆盖 `DATABASE_URL` |
| 重装依赖 | `-ForceDeps` | — | 强制重新安装依赖 |

示例：

```powershell
.\start-prod.ps1 start -SkipBuild -Port 3001
```

```bash
./start-prod.sh start --skip-build -p 3001
```

#### 启动流程

执行 `start` 时脚本自动完成：

1. 检查 Node.js / npm 环境
2. 安装依赖（npm workspaces 根目录统一安装）
3. 智能构建（源码未修改时跳过）
4. 校验后端产物 `backend/dist/index.js`
5. 后台启动后端 API 与前端静态服务

PID 写入 `.prod.pids.json`，日志写入 `backend-prod.log` 与 `frontend-prod.log`。

### 云服务器部署

#### 1. 准备服务器

购买 Linux 云服务器（Ubuntu 22.04/24.04 推荐），开放安全组端口 80、443。

#### 2. 安装 Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

#### 3. 上传代码

```bash
cd ~
git clone https://github.com/Zero-wyc/ZViewer.git ZViewer
cd ZViewer
```

#### 4. 配置环境变量

```bash
cp .env.example .env
nano .env
```

至少修改以下项：

```env
NODE_ENV=production
CORS_ORIGIN=https://your-domain.com
JWT_ACCESS_SECRET=your-strong-random-secret
JWT_REFRESH_SECRET=your-strong-random-secret
VITE_API_URL=
```

> 生产环境必须将 JWT 密钥替换为强随机字符串，切勿使用默认值。

#### 5. 启动服务

```bash
docker compose pull
docker compose up -d --build
```

#### 6. 配置 SSL 证书

推荐使用 certbot + Let's Encrypt：

```bash
sudo apt install -y certbot python3-certbot-nginx

# 临时停止前端容器以释放 80 端口
docker compose stop frontend

# 申请证书
sudo certbot certonly --standalone -d your-domain.com
```

修改 `frontend/nginx.conf` 增加 443 监听：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # ... 其余配置与 80 端口相同
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

在 `docker-compose.yml` 中挂载证书目录：

```yaml
frontend:
  volumes:
    - /etc/letsencrypt:/etc/letsencrypt:ro
```

重启前端并设置自动续期：

```bash
docker compose up -d --build frontend
echo "0 3 * * * root certbot renew --quiet --pre-hook 'cd /root/ZViewer && docker compose stop frontend' --post-hook 'cd /root/ZViewer && docker compose start frontend'" | sudo tee -a /etc/crontab
```

---

## 环境变量

### 后端

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 后端服务端口 | `3000` |
| `HOST` | 监听地址，`::` 表示 IPv4/IPv6 双栈 | `::` |
| `NODE_ENV` | 运行环境 | `production` |
| `DATABASE_URL` | SQLite 文件路径或 PostgreSQL 连接串 | `/app/data/dev.sqlite` |
| `CORS_ORIGIN` | CORS 允许来源，多个用逗号分隔 | `*` |
| `JWT_ACCESS_SECRET` | Access Token 密钥（生产必须修改） | — |
| `JWT_REFRESH_SECRET` | Refresh Token 密钥（生产必须修改） | — |
| `JWT_ACCESS_EXPIRES_IN` | Access Token 有效期 | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 有效期 | `7d` |

### 前端

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VITE_API_URL` | API / Socket.IO 基础地址，留空时使用 `window.location.origin` | — |

> `VITE_API_URL` 留空适合 Nginx 反向代理的生产环境；本地开发时由 Vite 代理处理，同样无需设置。

---

## 权限模型

系统采用四层权限模型：

| 角色 | 说明 | 权限 |
|---|---|---|
| `root` | 超级管理员，唯一用户名 `root` | 创建/控制/删除任意房间，绕过房间密码，审核用户，修改用户角色，删除用户 |
| `admin` | 管理员，由 root 授予 | 创建房间并完全控制自己的房间（管理影片、修改名称），不能删除他人房间 |
| `user` | 普通用户，注册审核通过后获得 | 加入房间观看、发送评论与弹幕，无法创建房间 |
| `guest` | 游客，未登录或注册待审核 | 加入房间观看、发送评论与弹幕，无法创建房间 |

### 注册审核

- 新用户注册后角色为 `guest`，状态为 `pending`（待审核）
- 待审核用户无法创建房间，登录时提示"账号正在审核中"
- 仅 root 可在「权限管理」页面审核通过用户，通过后自动升级为 `user`

### 房间权限

- 任何人（含游客）可加入允许进入的房间，发送评论与弹幕
- 仅 root 和房间创建者可管理房间影片、修改房间名称、关闭房间
- root 可进入任意房间（包括有密码的房间）并接管控制权

---

## 视频源

### Bilibili

解析 BV 号或视频链接，支持 DASH 音视频合并播放、清晰度切换、大会员专享内容。可在管理后台配置 Bilibili 登录凭证以获取大会员清晰度。

### ani-subs 订阅

通过自定义 JSON 订阅源聚合番剧资源。在「权限管理 → 基础设置」中可在线浏览 GitHub 仓库并快速导入订阅源地址。

### Kazumi 规则

导入 Kazumi 插件规则，使用 XPath/CSS 选择器解析第三方站点资源。同样支持从 GitHub 仓库在线导入。

### 直链与挂载

- **MP4 直链**：直接输入可访问的 MP4 视频地址播放
- **WebDAV / FTP / OpenList**：在挂载点管理中保存连接配置，浏览目录并播放视频文件

### GitHub CDN 加速

内置 CDN 代理 `https://github.cdn.zero251.xyz/`，ani-subs 订阅、Kazumi 规则、一键更新等功能默认通过该 CDN 加速访问：

```
https://github.cdn.zero251.xyz/Zero-wyc/ZViewer/main/README.md
```

### 一键更新

在「权限管理 → 基础设置 → 版本更新」中：

1. 点击「检查更新」获取 GitHub 仓库最新提交
2. 发现新版本后点击「一键更新」，通过 CDN 拉取最新代码并自动替换、重启服务

> 更新功能需要服务具备写入当前目录的权限，生产环境建议提前备份数据。

---

## 常见问题

### better-sqlite3 编译失败

better-sqlite3 包含 C++ 扩展，必须在目标环境重新编译。后端 Dockerfile 已安装 `python3`、`make`、`g++` 等构建工具，容器内执行 `npm ci` 确保原生模块匹配。本地开发时如遇编译失败，确认系统已安装构建工具链。

### WebSocket 连接失败

确认 Nginx 已正确配置 WebSocket 升级头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### WebRTC 无法建立连接

WebRTC 的 `getUserMedia` 要求 HTTPS 访问。生产环境请配置 SSL 证书。若双方处于严格 NAT 之后，可能需要部署 TURN 服务器（如 coturn）。

### CORS 报错

生产环境将 `CORS_ORIGIN` 设置为实际前端域名而非 `*`，修改后重新构建后端：

```bash
docker compose up -d --build backend
```

### 数据库数据丢失

Docker 部署时 SQLite 位于 `/app/data/dev.sqlite`，通过 `backend-data` 命名卷持久化。检查卷是否正常挂载：

```bash
docker volume ls
docker inspect zcontrol_backend-data
```

### Bilibili 解析失败

Bilibili 视频解析依赖登录态与 WBI 签名。如遇解析失败：

- 检查后端是否正确携带 Referer 等请求头
- 封面与视频地址通过后端代理获取，避免 CORS 与防盗链问题
- 大会员专享内容需在后台配置有效的 Bilibili 登录凭证
