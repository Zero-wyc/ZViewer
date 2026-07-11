# 阶段一：构建前端应用
FROM node:20-alpine AS builder

WORKDIR /app

# 先复制依赖清单，利用 Docker 缓存层
COPY package*.json ./
RUN npm ci

# 复制源码并构建
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL:-}
RUN npm run build

# 阶段二：使用 nginx 提供静态资源
FROM nginx:alpine

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 复制自定义 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
