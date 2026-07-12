# ZViewer

多人同步追番、观影与远程共享平台。

## 项目简介

ZViewer 是一款面向番剧与视频爱好者的一体化观影工具：

- **一起看房间**：创建或加入房间，与好友同步观看番剧、电影与视频，实时收发评论与弹幕。
- **屏幕共享 / 远程共享**：分享端可共享屏幕或视频画面，观看端经授权后低延迟观看。
- **多源番剧解析**：支持 Bilibili、ani-subs 订阅源、Kazumi 规则源等多种番剧获取方式。
- **实时互动**：评论、弹幕、播放状态同步、房主控制、弹幕轨道实时列表。
- **GitHub CDN 加速**：内置 `https://github.cdn.zero251.xyz/` 加速代理，更快拉取订阅与规则。
- **一键更新**：自动检测 GitHub 仓库变更，通过 CDN 拉取最新版本并更新。

项目包含独立的前后端服务：

- **frontend**：Vite + React + TypeScript 构建的 Web 界面。
- **backend**：Node.js + TypeScript + Express + Socket.IO 负责房间管理、信令、番剧解析与数据库持久化。

## 技术栈

- 前端：React 18、TypeScript、Vite、Socket.IO Client、Zustand、Tailwind CSS
- 后端：Node.js、Express、Socket.IO、TypeORM、better-sqlite3
- 部署：Docker、Docker Compose、Nginx

## 默认管理员

系统首次启动时会自动创建默认超级管理员账号：

- **用户名**：`root`
- **密码**：`root`

> 生产环境部署后，请尽快登录并修改默认 root 密码。

## 权限与注册制度

系统采用四层权限模型：

| 角色 | 说明 | 权限 |
|---|---|---|
| `root`（超级管理员） | 唯一用户名 `root`，不可被其他账户授予 | 可创建/控制/删除任意房间，可绕过房间密码，可审核用户、修改任意用户角色、删除任意用户 |
| `admin`（管理员） | 由 root 授予 | 可创建房间并完全控制自己创建的房间（新增/删除影片、修改房间名称），但**不能**删除他人房间 |
| `user`（普通用户） | 注册并审核通过后获得 | 可加入房间观看、发送评论与弹幕，无法创建房间或管理影片 |
| `guest`（游客） | 未登录时的默认身份 | 可加入房间观看、发送评论与弹幕，无法创建房间；注册后进入待审核状态 |

### 注册审核

- 新用户注册后，角色为 `guest`，状态为 `pending`（待审核）。
- 待审核用户无法创建房间，登录时会提示“账号正在审核中”。
- 只有 root 可以在「权限管理」页面审核通过用户，审核后自动升级为 `user`。

### 房间权限

- 任何人（含游客）均可加入允许进入的房间，发送评论与弹幕。
- 仅 root 和房间创建者（admin）可管理房间影片、修改房间名称、关闭房间。
- root 可进入任意房间（包括有密码的房间）并接管控制权。

## 番剧与视频源

ZViewer 支持多种视频来源：

- **Bilibili**：解析 BV 号或视频链接，支持 DASH 音视频合并播放。
- **ani-subs 订阅**：通过自定义 JSON 订阅源聚合 web-selector 与 RSS 番剧资源。
- **Kazumi 规则**：导入 Kazumi 插件规则，使用 XPath/CSS 选择器解析第三方站点。
- **直链 / 本地**：支持 MP4、WebDAV、FTP、SMB、OpenList 等直链播放。

在「权限管理 → 基础设置」中可在线浏览 GitHub 仓库并快速导入 ani-subs / Kazumi 源地址。

## GitHub CDN 加速

内置 CDN 代理 `https://github.cdn.zero251.xyz/`，使用时直接在后面跟上仓库/文件路径即可：

```
https://github.cdn.zero251.xyz/Zero-wyc/ZViewer/main/README.md
```

ani-subs 订阅、Kazumi 规则、一键更新等功能均已默认通过该 CDN 加速访问。

## 一键更新

在「权限管理 → 基础设置 → 版本更新」中：

1. 点击「检查更新」获取 GitHub 仓库 `https://github.com/Zero-wyc/ZViewer` 最新提交。
2. 若发现新版本，点击「一键更新」即可通过 CDN 拉取最新代码并自动替换、重启服务。

> 更新功能需要服务具备写入当前目录的权限，生产环境建议提前备份数据。

## Windows 一键启动

项目根目录提供 `start-prod.bat`，双击即可一键启动生产环境前后端服务：

```bat
start-prod.bat
```

脚本会自动：

1. 检查 Node.js 环境。
2. 安装根目录、前端、后端依赖。
3. 构建前端与后端。
4. 以后台方式启动后端 API 与前端生产预览服务。

关闭时再次运行脚本或手动结束相关 Node 进程。

## 本地开发

分别启动前后端服务：

```bash
# 1. 启动后端
cd backend
cp .env.example .env
npm install
npm run dev

# 2. 启动前端（新终端）
cd frontend
cp .env.example .env
npm install
npm run dev
```

开发时前端默认直连 `http://localhost:3000`，请在 `frontend/.env` 中确认：

```env
VITE_API_URL=http://localhost:3000
```

## Docker 本地运行

> **安全提示**：无论本地测试还是生产部署，都请修改默认的 JWT 密钥，不要使用 `.env.example` 中的占位值。

在项目根目录执行：

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env，至少修改 JWT 密钥
code .env   # 或 nano / vim

# 构建并启动服务
docker compose up -d --build

# 查看日志
docker compose logs -f
```

启动后即可访问：

- 前端：http://localhost
- 后端 API：http://localhost/api
- 后端健康检查：http://localhost/health

停止服务：

```bash
docker compose down
```

如需同时删除持久化数据卷：

```bash
docker compose down -v
```

## 云服务器部署

### 1. 准备服务器

- 购买一台 Linux 云服务器（Ubuntu 22.04/24.04 推荐）。
- 开放安全组端口：80、443、3000（可选，生产环境建议只开放 80/443）。

### 2. 配置域名与 DNS

- 购买域名并添加 A 记录指向服务器公网 IP。
- 等待 DNS 生效。

### 3. 安装 Docker

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

### 4. 上传代码

使用 `git clone` 或 `scp` 将代码上传到服务器，例如：

```bash
cd ~
git clone https://github.com/Zero-wyc/ZViewer.git ZViewer
cd ZViewer
```

### 5. 配置环境变量

```bash
cp .env.example .env
nano .env
```

至少修改以下项：

```env
NODE_ENV=production
CORS_ORIGIN=https://your-domain.com
# 生产环境必须将 JWT 密钥替换为强随机字符串，切勿使用默认值
JWT_ACCESS_SECRET=your-strong-random-secret
JWT_REFRESH_SECRET=your-strong-random-secret
# VITE_API_URL 保持留空，让前端使用当前域名
VITE_API_URL=
```

> ⚠️ **生产环境必须设置 JWT_SECRET**：`JWT_ACCESS_SECRET` 与 `JWT_REFRESH_SECRET` 用于签发和校验登录凭证。使用默认或弱密钥会导致账号体系被绕过，务必在部署前替换为强随机字符串。

### 6. 启动服务

```bash
# 拉取最新镜像并重新构建
docker compose pull
docker compose up -d --build
```

### 7. 配置 SSL 证书（Let's Encrypt）

推荐使用 `certbot` + Nginx 容器获取并自动续期证书。

安装 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
```

为了使用 certbot 的 standalone 模式，先临时停止占用 80 端口的容器：

```bash
cd ~/ZViewer
docker compose stop frontend
```

申请证书：

```bash
sudo certbot certonly --standalone -d your-domain.com
```

将证书挂载到 Nginx 容器。修改 `docker-compose.yml` 中 frontend 服务的 volumes：

```yaml
volumes:
  - /etc/letsencrypt:/etc/letsencrypt:ro
```

并修改 `frontend/nginx.conf` 增加 443 监听与 SSL 配置：

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

重启前端容器：

```bash
docker compose up -d --build frontend
```

设置 certbot 自动续期：

```bash
echo "0 3 * * * root certbot renew --quiet --pre-hook 'cd /root/ZViewer && docker compose stop frontend' --post-hook 'cd /root/ZViewer && docker compose start frontend'" | sudo tee -a /etc/crontab
```

## 环境变量说明

### 后端环境变量（backend/.env 或根目录 .env）

| 变量名 | 说明 | 示例 |
|---|---|---|
| PORT | 后端服务端口 | 3000 |
| HOST | 监听地址 | `::`（IPv4/IPv6 双栈） |
| NODE_ENV | 运行环境 | development / production |
| DATABASE_URL | SQLite 数据库文件路径或 PostgreSQL 连接串 | /app/data/dev.sqlite |
| CORS_ORIGIN | CORS 允许来源 | * 或 https://your-domain.com |
| JWT_ACCESS_SECRET | JWT Access Token 密钥（生产环境必须修改） | 强随机字符串 |
| JWT_REFRESH_SECRET | JWT Refresh Token 密钥（生产环境必须修改） | 强随机字符串 |
| JWT_ACCESS_EXPIRES_IN | Access Token 有效期 | 15m |
| JWT_REFRESH_EXPIRES_IN | Refresh Token 有效期 | 7d |

### 前端环境变量（frontend/.env）

| 变量名 | 说明 | 示例 |
|---|---|---|
| VITE_API_URL | Socket.IO / API 基础地址 | http://localhost:3000 或留空 |

> `VITE_` 前缀表示该变量会在构建时注入前端代码。留空时前端将使用 `window.location.origin`，适合 Nginx 反向代理的生产环境。

## 常见问题

### better-sqlite3 原生模块编译失败

better-sqlite3 包含 C++ 扩展，必须在容器内重新编译。后端 Dockerfile 已安装 `python3`、`make`、`g++` 等构建工具，并在容器内执行 `npm ci`，确保原生模块与容器环境匹配。

### WebSocket 连接失败

请确认 Nginx 已正确配置 WebSocket 升级头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### WebRTC 无法建立连接

WebRTC 的 `getUserMedia` 等功能要求页面必须通过 HTTPS 访问。部署到生产环境时请务必配置 SSL 证书。如果双方处于严格 NAT 之后，可能还需要部署 TURN 服务器（如 coturn）。

### CORS 报错

生产环境建议将 `CORS_ORIGIN` 设置为实际前端域名，而不是 `*`。设置后需要重新构建并启动后端容器：

```bash
docker compose up -d --build backend
```

### 数据库文件没有持久化

Docker 部署时 SQLite 数据库位于 `/app/data/dev.sqlite`，并通过 `backend-data` 命名卷持久化。如果数据丢失，请检查卷是否正常挂载：

```bash
docker volume ls
docker inspect zcontrol_backend-data
```

### Bilibili 解析失败

Bilibili 视频解析依赖登录态与 WBI 签名。如遇解析失败：

- 检查后端是否正确携带 Referer 等请求头。
- 封面与视频地址通过后端代理获取，避免 CORS 与防盗链问题。
- 大会员专享内容会提示“无权限播放，可能需要大会员”。
