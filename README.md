# ZViewer

一个基于 WebRTC 的浏览器远程控制 / 屏幕共享平台。

## 项目简介

ZViewer 允许分享端创建一个房间，观看端申请加入并经分享端同意后，通过 WebRTC 建立 P2P 连接，实现低延迟的远程观看与控制。项目包含独立的前后端服务：

- **frontend**：Vite + React + TypeScript 构建的 Web 界面。
- **backend**：Node.js + TypeScript + Express + Socket.IO 负责房间管理、信令转发与数据库持久化。

## 技术栈

- 前端：React 18、TypeScript、Vite、Socket.IO Client、Zustand、Ant Design
- 后端：Node.js、Express、Socket.IO、TypeORM、better-sqlite3
- 部署：Docker、Docker Compose、Nginx、Let's Encrypt

## 默认管理员

系统首次启动时会自动创建默认管理员账号：

- **用户名**：`root`
- **密码**：`root`

> 生产环境部署后，请尽快登录并修改默认管理员密码。

## 登录与权限

- **普通用户**：可自行注册，注册后仅拥有观看权限，不能创建房间。
- **管理员**：拥有创建房间、管理用户等完整权限。
- 分享端创建房间后，观看端需申请加入，经分享端同意后方可建立 WebRTC 连接。

## 帧率 / 码率 / 音频

分享端支持灵活的媒体配置：

- **帧率**：支持 `30 / 60 / 90 / 120 / 144 / 240` fps，可根据网络与场景选择。
- **最大码率**：支持自定义最大码率（Mbps），平衡画质与带宽占用。
- **音频**：支持共享**系统音频**与**麦克风**，可单独开启或关闭。

## IPv6

后端默认监听 `::`，同时支持 IPv4 与 IPv6 双栈访问。Docker 部署时无需额外配置即可通过 IPv6 访问。

## P2P 直连

除房间模式外，系统还提供**直连模式**：

- 双方通过手动**复制 / 粘贴 SDP 直连码**完成 P2P 协商。
- 同一局域网内可直接建立 P2P 连接，无需经过服务器中转。
- 适用于无公网服务器或临时点对点使用的场景。

## 评论 / 弹幕 / 批注

观看端与分享端支持丰富的实时互动：

- **评论**：观看端可发送文字评论，所有在线人员实时可见。
- **弹幕**：评论可一键投送为弹幕，以滚动形式在视频画面上展示。
- **批注**：观看端可在视频画面上直接绘制批注，分享端实时同步显示。

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

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 4. 上传代码

使用 `git clone` 或 `scp` 将代码上传到服务器，例如：

```bash
cd ~
git clone https://your-repo.git ZViewer
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
