// Package nms 提供 OBS 推流模式依赖的媒体服务（RTMP 接收 + HTTP-FLV 分发）。
//
// 默认**进程内自带**（`embedded.go`）：RTMP 收在 `RTMP_PORT`（3334），
// HTTP-FLV 出在 `HTTP_FLV_PORT`（3335），`/live` 由后端反代到本地这个端口。
// 这样源码运行、单容器部署、桌面壳三种交付形态都能开箱推流，
// 与 Node 版进程内 `node-media-server` 的产品行为一致。
//
// 想用外部媒体服务（SRS / node-media-server / 自建集群）时，设
// `NMS_HTTP_FLV_URL` 指过去即可——此时不再监听本地端口，可用性改用
// TCP 探测（5s 缓存），语义与 Node 的 `nmsService.isAvailable()` 对齐
// （「能推流吗」）。
package nms

import (
	"context"
	"crypto/rand"
	"log"
	"math/big"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultRtmpPort 是 Node 版 RTMP_PORT 的默认值（OBS 推流地址用）。
	DefaultRtmpPort = 3334
	// DefaultHTTPFLVPort 是 Node 版 HTTP_FLV_PORT 的默认值。
	DefaultHTTPFLVPort = 3335

	// availabilityTTL 是可用性结果的缓存时长。
	//
	// 与 Node 的差别只在「刚起来的 NMS 最迟 5s 后才被认出来」，
	// 而那边是进程内布尔量、零延迟——这点延迟换来的是不再每次事件都探一次。
	availabilityTTL = 5 * time.Second
	// probeTimeout 是 TCP 探测超时。本机回环连不上基本就是没起，
	// 卡满 300ms 也没意义，不如快点给出否定答案。
	probeTimeout = 300 * time.Millisecond
)

// Config 是推流相关的静态配置（进程启动时解析一次）。
type Config struct {
	// HTTPFLVBase 是 /live 反代与可用性探测的上游，不带尾斜杠。
	HTTPFLVBase string
	// RtmpPort 是 OBS 配置里推流地址的端口。
	RtmpPort int
	// ServerHost 非空时覆盖「按请求 Host 推导」的主机名（对应 SERVER_HOST）。
	ServerHost string
	// Disabled 对应 STREAM_PUSH_ENABLED=0：与 Node 同名开关，
	// 显式关闭时不探测、一律报告不可用（对拍脚本靠它让两侧一致）。
	Disabled bool
	// Embedded 为 true 时由本进程托管 RTMP + HTTP-FLV（默认）。
	// 显式配了 NMS_HTTP_FLV_URL、或设 NMS_EMBEDDED=0 时转为外部模式。
	Embedded bool
	// BindHost 是内嵌服务的监听地址（NMS_BIND，默认 0.0.0.0）。
	BindHost string
}

// ConfigFromEnv 读取配置，语义与 Node 版一致：
//
//	RTMP_PORT         推流端口（默认 3334）
//	HTTP_FLV_PORT     拉流端口（默认 3335，仅在 NMS_HTTP_FLV_URL 缺省时生效）
//	NMS_HTTP_FLV_URL  显式上游（优先，指向外部媒体服务，此时不内嵌）
//	NMS_EMBEDDED      0 = 即使没配 URL 也不内嵌（调试外部服务时用）
//	NMS_BIND          内嵌服务的监听地址（默认 0.0.0.0）
//	SERVER_HOST       推流地址里的主机名（缺省从请求 Host 推导）
func ConfigFromEnv() Config {
	httpFlvPort := DefaultHTTPFLVPort
	if raw := strings.TrimSpace(os.Getenv("HTTP_FLV_PORT")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 65535 {
			httpFlvPort = v
		}
	}
	explicitBase := strings.TrimSpace(os.Getenv("NMS_HTTP_FLV_URL"))
	base := explicitBase
	if base == "" {
		base = "http://127.0.0.1:" + strconv.Itoa(httpFlvPort)
	}
	embedded := explicitBase == ""
	if raw := strings.TrimSpace(os.Getenv("NMS_EMBEDDED")); raw == "0" {
		embedded = false
	}

	rtmpPort := DefaultRtmpPort
	if raw := strings.TrimSpace(os.Getenv("RTMP_PORT")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 65535 {
			rtmpPort = v
		}
	}

	return Normalize(Config{
		HTTPFLVBase: base,
		RtmpPort:    rtmpPort,
		ServerHost:  strings.TrimSpace(os.Getenv("SERVER_HOST")),
		Disabled:    os.Getenv("STREAM_PUSH_ENABLED") == "0",
		Embedded:    embedded,
		BindHost:    strings.TrimSpace(os.Getenv("NMS_BIND")),
	})
}

// Normalize 补齐零值，避免手工构造的 Config 让下游拿到空端口/空地址。
func Normalize(c Config) Config {
	c.HTTPFLVBase = strings.TrimRight(strings.TrimSpace(c.HTTPFLVBase), "/")
	if c.HTTPFLVBase == "" {
		c.HTTPFLVBase = "http://127.0.0.1:" + strconv.Itoa(DefaultHTTPFLVPort)
	}
	if c.RtmpPort <= 0 || c.RtmpPort > 65535 {
		c.RtmpPort = DefaultRtmpPort
	}
	return c
}

// RtmpServerURL 构造 OBS 里填的推流服务器地址（不含推流码）。
//
// 与 Node 的 buildRtmpServerUrl 一致：SERVER_HOST 优先，否则取 Host 头去端口。
func (c Config) RtmpServerURL(hostHeader string) string {
	host := c.ServerHost
	if host == "" {
		host = hostOnly(hostHeader)
	}
	return "rtmp://" + net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(c.RtmpPort)) + "/live"
}

// LiveUpstream 拼接 /live 拉流的上游地址（requestURI 含查询串）。
func (c Config) LiveUpstream(requestURI string) string {
	return c.HTTPFLVBase + requestURI
}

// hostOnly 去掉 Host 头里的端口。
//
// Node 是 `host.split(':')[0]`，IPv6 会切出一个 `[`（坏地址）；这里用
// SplitHostPort 并给 IPv6 补回方括号——只在 IPv6 字面量场景与 Node 不同，
// 属于修正而非行为分叉（MIGRATION 七之二有登记）。
func hostOnly(hostHeader string) string {
	h := strings.TrimSpace(hostHeader)
	if h == "" {
		return "localhost"
	}
	host, _, err := net.SplitHostPort(h)
	if err != nil {
		// 没有端口（或本来就带方括号）：原样用
		return strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	}
	host = strings.Trim(host, "[]")
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}

// 推流码字符集与 Node 的 generateStreamKey 一致：
// 去掉易混淆的 0 / O / I / l / 1（OBS 里手抄推流码时最容易看错的那几个）。
const streamKeyAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

const StreamKeyLength = 8

// GenerateStreamKey 生成 8 位独立发布密钥，使用均匀的密码学随机数。
func GenerateStreamKey() string {
	out := make([]byte, StreamKeyLength)
	limit := big.NewInt(int64(len(streamKeyAlphabet)))
	for i := range out {
		n, err := rand.Int(rand.Reader, limit)
		if err != nil {
			panic("无法生成安全推流密钥")
		}
		out[i] = streamKeyAlphabet[n.Int64()]
	}
	return string(out)
}

// Service 是推流服务的可用性探测器（并发安全）。
//
// 内嵌模式下它同时持有媒体服务实例：`Start` 起监听，`Close` 收尾；
// 外部模式下只做探测，与之前的行为完全一致。
type Service struct {
	cfg Config

	// 便于单测替换：
	// now   —— 时间来源（验证缓存窗口）
	// probe —— 探测实现（验证失败/成功两条路径）
	now     func() time.Time
	probe   func(ctx context.Context) error
	logf    func(string, ...any)
	mu      sync.Mutex
	checked time.Time
	value   bool
	has     bool
	// embedded 非空表示媒体服务由本进程托管（内嵌模式且启动成功）。
	embedded         *embeddedServer
	authorizePublish func(context.Context, string) bool
	authorizeWatch   func(context.Context, string, string) bool
}

// New 构造探测器。
func New(cfg Config) *Service {
	s := &Service{cfg: Normalize(cfg), now: time.Now}
	s.probe = s.tcpProbe
	s.logf = log.Printf
	return s
}

// SetLogger 替换日志输出（单测里静音用）。
func (s *Service) SetLogger(logf func(string, ...any)) {
	if logf == nil {
		return
	}
	s.mu.Lock()
	s.logf = logf
	s.mu.Unlock()
}

// Start 在内嵌模式下启动 RTMP + HTTP-FLV 监听。
//
// 启动失败（端口被占、无权限）不返回致命错误：调用方只记日志，
// 服务降级成「探测外部 NMS」，与之前纯外部模式的语义一致——
// 推流不可用不该拖垮整个后端。
func (s *Service) Start() error {
	s.mu.Lock()
	cfg := s.cfg
	logf := s.logf
	s.mu.Unlock()

	if cfg.Disabled || !cfg.Embedded {
		return nil
	}

	srv := newEmbeddedServer(cfg, logf)
	srv.publishAllowed = s.publishAllowed
	srv.watchAllowed = s.watchAllowed
	if err := srv.start(); err != nil {
		logf("[nms] 内置媒体服务启动失败（%v），改为探测外部媒体服务 %s", err, cfg.HTTPFLVBase)
		s.mu.Lock()
		s.cfg.Embedded = false
		s.mu.Unlock()
		return err
	}

	s.mu.Lock()
	s.embedded = srv
	s.mu.Unlock()
	return nil
}

// Close 停止内嵌媒体服务（优雅退出时调用）。
func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	srv := s.embedded
	s.embedded = nil
	logf := s.logf
	s.mu.Unlock()

	if srv == nil {
		return nil
	}
	if len(srv.hub.streamKeys()) > 0 {
		logf("[nms] 关闭时仍有 %d 路推流在推", len(srv.hub.streamKeys()))
	}
	return srv.close(ctx)
}

// Config 返回归一化后的配置（api 层用它拼推流地址与拉流上游）。
func (s *Service) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

// Available 报告推流服务是否可用（内嵌模式看监听是否就绪；外部模式带 TTL 缓存）。
func (s *Service) Available() bool {
	s.mu.Lock()
	if s.cfg.Disabled {
		s.mu.Unlock()
		return false
	}
	if s.cfg.Embedded {
		srv := s.embedded
		s.mu.Unlock()
		return srv != nil && srv.isReady()
	}

	now := s.now()
	if s.has && now.Sub(s.checked) < availabilityTTL {
		value := s.value
		s.mu.Unlock()
		return value
	}
	s.mu.Unlock()

	// 探测不放锁：TCP 拨号最长 300ms，不能让并发请求排队。
	ok := s.probe(context.Background()) == nil

	s.mu.Lock()
	s.value = ok
	s.checked = now
	s.has = true
	s.mu.Unlock()
	return ok
}

// Invalidate 强制下一次 Available 重新探测。
//
// 前端点「重试」、或 NMS 刚被运维拉起来时用；单测也靠它绕过缓存。
func (s *Service) Invalidate() {
	s.mu.Lock()
	s.has = false
	s.mu.Unlock()
}

// tcpProbe 连一次上游 TCP 端口。NMS 的 HTTP 服务对任意路径都会先建立连接，
// 因此「连得上」就等价于「服务在跑」，不需要发 HTTP 请求。
func (s *Service) tcpProbe(ctx context.Context) error {
	s.mu.Lock()
	base := s.cfg.HTTPFLVBase
	s.mu.Unlock()

	u, err := url.Parse(base)
	if err != nil {
		return err
	}
	host := u.Host
	if u.Port() == "" {
		port := "80"
		if u.Scheme == "https" {
			port = "443"
		}
		host = net.JoinHostPort(u.Hostname(), port)
	}
	dialer := &net.Dialer{Timeout: probeTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", host)
	if err != nil {
		return err
	}
	return conn.Close()
}

// SetAuthorizers attaches authoritative room state after API assembly. Until
// configured, both network media surfaces fail closed.
func (s *Service) SetAuthorizers(publish func(context.Context, string) bool, watch func(context.Context, string, string) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authorizePublish, s.authorizeWatch = publish, watch
}
func (s *Service) publishAllowed(ctx context.Context, key string) bool {
	s.mu.Lock()
	fn := s.authorizePublish
	s.mu.Unlock()
	return fn != nil && fn(ctx, key)
}
func (s *Service) watchAllowed(ctx context.Context, key, ticket string) bool {
	s.mu.Lock()
	fn := s.authorizeWatch
	s.mu.Unlock()
	return fn != nil && fn(ctx, key, ticket)
}
