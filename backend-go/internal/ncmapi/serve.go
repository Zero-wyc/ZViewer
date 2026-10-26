package ncmapi

import (
	"context"
	"net"
	"net/http"
	"time"
)

// Listen 在回环地址上起一个进程内 HTTP 服务，返回基地址与停止函数。
//
// 为什么绕一圈走 HTTP 而不直接暴露方法：internal/ncm 与上游之间本来就有
// HTTP 边界（Node 时代如此），保持这个边界能让「换实现」不需要改动凭证注入、
// cookie 落库、音质降级、直链缓存这一整层，也让灰度开关能落到单个环境变量上。
//
// 端口用 0 让内核分配：不会和用户自建的 36530 撞车，也不会被同机其他实例
// 误连。监听只绑 tcp4 回环，外部无法访问。
func Listen() (string, func(), error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	server := &http.Server{
		Handler:           NewHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		// Serve 在 Shutdown 后返回 ErrServerClosed，属正常收尾，忽略。
		_ = server.Serve(listener)
	}()
	stop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
	return "http://" + listener.Addr().String(), stop, nil
}
