// Package nms 管理 OBS 推流模式依赖的媒体服务（RTMP 接收 + HTTP-FLV 分发）。
//
// 与 Node 版最大的差异：`node-media-server` 是纯 Node 库，Go 侧不内嵌，
// 改成**外部化**——`NMS_HTTP_FLV_URL`（默认 `http://127.0.0.1:3335`）指向
// 已经跑起来的 NMS 兼容服务（node-media-server / SRS / mediamtx 均可）。
//
// 可用性语义与 Node 的 `nmsService.isAvailable()` 对齐（「能推流吗」），
// 只是判据从「进程内实例启动成功」换成「上游 TCP 端口连得上」，
// 并带 5s 缓存：socket 事件里会反复问，每次都做一次 TCP 握手太浪费。
//
// 部署含义：只跑 Go 版时，OBS 推流需要额外跑一个 NMS（与一起听的 NCM
// 外部服务同一套策略）；没跑时前端会显示「推流服务不可用」。
package nms

import (
	"context"
	"crypto/rand"
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
}

// ConfigFromEnv 读取配置，语义与 Node 版一致：
//
//	RTMP_PORT      推流端口（默认 3334）
//	HTTP_FLV_PORT  拉流端口（默认 3335，仅在 NMS_HTTP_FLV_URL 缺省时生效）
//	NMS_HTTP_FLV_URL  显式上游（优先，可指向外部 NMS）
//	SERVER_HOST    推流地址里的主机名（缺省从请求 Host 推导）
func ConfigFromEnv() Config {
	httpFlvPort := DefaultHTTPFLVPort
	if raw := strings.TrimSpace(os.Getenv("HTTP_FLV_PORT")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 65535 {
			httpFlvPort = v
		}
	}
	base := strings.TrimSpace(os.Getenv("NMS_HTTP_FLV_URL"))
	if base == "" {
		base = "http://127.0.0.1:" + strconv.Itoa(httpFlvPort)
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
	return "rtmp://" + host + ":" + strconv.Itoa(c.RtmpPort) + "/live"
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

// GenerateStreamKey 生成 8 位推流码。
func GenerateStreamKey() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		// 熵源故障时退化成固定长度占位串：宁可让用户重试，
		// 也不要写一个空密钥进库（OBS 那边会表现为「推流码无效」）。
		return "STREAMKY"
	}
	out := make([]byte, 8)
	for i, b := range buf {
		out[i] = streamKeyAlphabet[int(b)%len(streamKeyAlphabet)]
	}
	return string(out)
}

// Service 是推流服务的可用性探测器（并发安全）。
type Service struct {
	cfg Config

	// 便于单测替换：
	// now   —— 时间来源（验证缓存窗口）
	// probe —— 探测实现（验证失败/成功两条路径）
	now   func() time.Time
	probe func(ctx context.Context) error

	mu      sync.Mutex
	checked time.Time
	value   bool
	has     bool
}

// New 构造探测器。
func New(cfg Config) *Service {
	s := &Service{cfg: Normalize(cfg), now: time.Now}
	s.probe = s.tcpProbe
	return s
}

// Config 返回归一化后的配置（api 层用它拼推流地址与拉流上游）。
func (s *Service) Config() Config { return s.cfg }

// Available 报告推流服务是否可用（带 TTL 缓存）。
func (s *Service) Available() bool {
	if s.cfg.Disabled {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if s.has && now.Sub(s.checked) < availabilityTTL {
		return s.value
	}
	s.value = s.probe(context.Background()) == nil
	s.checked = now
	s.has = true
	return s.value
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
	u, err := url.Parse(s.cfg.HTTPFLVBase)
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
