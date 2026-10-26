package ncmapi

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

// LoopbackBase 是进程内实现的哨兵基地址。
//
// 它不对应任何真实主机：请求由 inProcessTransport 直接交给 Handler.ServeHTTP，
// 不解析域名、不建连接、不占端口。保留 URL 形态是因为 internal/ncm 整个转发层
// 都在拼 `base + path + "?" + query`，换掉字符串会牵连 1,300 行。
const LoopbackBase = "http://ncm.internal"

var (
	inProcessMu sync.RWMutex
	inProcess   http.Handler
)

// StartInProcess 把进程内实现挂成上游，返回基地址与停止函数。
//
// 相比 Listen：没有监听端口、没有内核往返，也不会在 netstat / 安全软件里
// 多出一个可疑的本机服务。HTTP 语义（状态码、Set-Cookie、Location、请求体
// 流式透传）全部保留——这层「方言」正是 internal/ncm 依赖的东西。
func StartInProcess() (string, func()) {
	handler := NewHandler()
	inProcessMu.Lock()
	inProcess = handler
	inProcessMu.Unlock()
	stop := func() {
		inProcessMu.Lock()
		inProcess = nil
		inProcessMu.Unlock()
	}
	return LoopbackBase, stop
}

// InProcessTransport 返回进程内上游的 RoundTripper；未启用时返回 nil。
//
// 调用方（internal/ncm）只在基地址等于 LoopbackBase 时使用它，所以外部服务
// 与随包 Node 组件的路径完全不受影响。
func InProcessTransport() http.RoundTripper {
	inProcessMu.RLock()
	handler := inProcess
	inProcessMu.RUnlock()
	if handler == nil {
		return nil
	}
	return &handlerTransport{handler: handler}
}

// Listen 在回环地址上起一个进程内 HTTP 服务，返回基地址与停止函数。
//
// 这条路径只在排障时用（NCM_LOOPBACK=1）：真 socket 能直接 curl，方便看
// 上游原始响应；默认走 StartInProcess，不占端口。
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

// handlerTransport 把 HTTP 请求直接交给 handler，不经过网络栈。
//
// 顺手补了一条真实 socket 上由 net/http 负责的语义：RoundTripper 必须关闭
// 请求体，否则调用方的 body 会泄漏（云盘上传时那是浏览器连接体）。
type handlerTransport struct {
	handler http.Handler
}

// RoundTrip 实现 http.RoundTripper。
func (t *handlerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		defer func() { _ = req.Body.Close() }()
	}
	if req.ContentLength == 0 {
		// 与服务端行为一致：没有 body 时不能给 handler 一个可读的空流之外的东西
		req.Body = http.NoBody
	}
	recorder := newMemoryResponse()
	t.handler.ServeHTTP(recorder, req)
	return recorder.response(req), nil
}

// memoryResponse 是只需收下 JSON 的最小 ResponseWriter。
//
// 不用 httptest.ResponseRecorder：那是测试包，且它会把 Set-Cookie 重新解析
// 一遍；这里原样保留头部，正好匹配 internal/ncm 直接读 Header.Values 的做法。
type memoryResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func newMemoryResponse() *memoryResponse {
	return &memoryResponse{header: http.Header{}}
}

func (m *memoryResponse) Header() http.Header { return m.header }

func (m *memoryResponse) Write(p []byte) (int, error) {
	if m.status == 0 {
		m.status = http.StatusOK
	}
	return m.body.Write(p)
}

func (m *memoryResponse) WriteHeader(status int) {
	if m.status == 0 {
		m.status = status
	}
}

func (m *memoryResponse) response(req *http.Request) *http.Response {
	status := m.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		Status:        http.StatusText(status),
		StatusCode:    status,
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        m.header.Clone(),
		Body:          io.NopCloser(bytes.NewReader(m.body.Bytes())),
		ContentLength: int64(m.body.Len()),
		Request:       req,
	}
}
