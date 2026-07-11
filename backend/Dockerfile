FROM node:20-alpine

WORKDIR /app

# better-sqlite3 是原生模块，需要在容器内重新编译
# 安装 Python、make、g++ 等构建工具
RUN apk add --no-cache python3 make g++ sqlite

# 先复制依赖清单并安装依赖（利用缓存层）
COPY package*.json ./
RUN npm ci

# 复制源码并编译
COPY . .
RUN npm run build

# 创建数据库持久化目录
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
