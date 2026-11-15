// Package netproxy 让出站 HTTP 和浏览器走同一条出口。
//
// 为什么需要这一层：Go 的 http.ProxyFromEnvironment 只看 HTTP_PROXY /
// HTTPS_PROXY / NO_PROXY 三个环境变量，而桌面端是 Explorer / Wails 拉起来的，
// 环境里根本没有这些变量。用户开着 Clash 之类的**系统代理**时，浏览器能打开
// 墙外的站点，ZViewer 却直连超时或被 RST（报错原文是
// `read tcp ...: wsarecv: An existing connection was forcibly closed by the
// remote host.`）——同一台机器、同一个网络，两套结果，用户完全无从下手。
//
// 解析顺序：环境变量 > 系统代理（Windows 注册表 Internet Settings）> 直连。
// 环境变量排前面是为了让「临时指定代理」这件事仍然有效（命令行启动、CI）。
package netproxy

import (
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/netutil"
)

// Transport 返回带代理解析的 transport（http.DefaultTransport 的克隆）。
//
// 克隆而不是新建：DefaultTransport 里的 dial 超时、keep-alive、HTTP/2
// 都是调好的，自己写一份迟早会漏（漏 ForceAttemptHTTP2 会静默退回 1.1）。
func Transport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = ProxyFunc()
	return transport
}

// NewClient 返回带代理的客户端。timeout 为 0 表示不设总超时（由调用方的
// context 控制），适合「单次请求各自带 deadline」的抓取场景。
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{Transport: Transport(), Timeout: timeout}
}

// ProxyFunc 按请求解析代理：环境变量优先，其次系统代理，最后直连。
//
// 返回 nil 表示直连（http.Transport 的约定），不是错误。
func ProxyFunc() func(*http.Request) (*url.URL, error) {
	return func(req *http.Request) (*url.URL, error) {
		if !proxyable(req.URL) {
			return nil, nil
		}
		// 环境变量优先，语义与 Go 默认客户端完全一致（含 NO_PROXY）。
		if u, err := http.ProxyFromEnvironment(req); err != nil {
			return nil, err
		} else if u != nil {
			return u, nil
		}
		system := loadSystem()
		if system == nil {
			return nil, nil
		}
		if netutil.IsInternalNetworkHost(req.URL.Hostname()) || system.bypasses(req.URL.Hostname()) {
			return nil, nil
		}
		addr, kind := system.pick(req.URL.Scheme)
		if addr == "" {
			return nil, nil
		}
		return proxyURL(addr, kind)
	}
}

// proxyable 判断这个 URL 该不该走代理。
//
// 只处理 http/https：其它 scheme（ws/wss 之外的 file 等）走 transport 自己的
// 逻辑，替它们挑代理只会出错。内网与回环在 ProxyFunc 里统一跳过。
func proxyable(u *url.URL) bool {
	if u == nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	return u.Hostname() != ""
}

// systemCacheTTL 是系统代理设置的缓存时长。
//
// 读注册表很便宜，但每个请求都读一次没必要；30 秒足够让「用户刚开关代理」
// 在下一次抓取时生效，又不用重启应用。
const systemCacheTTL = 30 * time.Second

type systemSettings struct {
	// shared 是 ProxyServer 只写了一个地址（不带 scheme=）时的那一个。
	shared string
	// perScheme 是 ProxyServer 按协议分开写的形态（http=…;https=…;socks=…）。
	perScheme map[string]string
	// bypass 是 ProxyOverride 拆出来的排除列表。
	bypass []string
}

var (
	systemMu        sync.Mutex
	systemValue     *systemSettings
	systemLoaded    bool
	systemFetchedAt time.Time
)

// loadSystem 返回系统代理设置（没有则 nil），带 TTL 缓存。
func loadSystem() *systemSettings {
	systemMu.Lock()
	defer systemMu.Unlock()
	if systemLoaded && time.Since(systemFetchedAt) < systemCacheTTL {
		return systemValue
	}
	enabled, server, override, _ := readSystemProxy()
	systemValue = nil
	if enabled && strings.TrimSpace(server) != "" {
		systemValue = parseProxyServer(server, override)
	}
	systemLoaded = true
	systemFetchedAt = time.Now()
	return systemValue
}

// ResetCache 丢掉缓存（测试用；运行期靠 TTL 自然过期）。
func ResetCache() {
	systemMu.Lock()
	defer systemMu.Unlock()
	systemValue = nil
	systemLoaded = false
	systemFetchedAt = time.Time{}
}

// parseProxyServer 解析 WinINET 的 ProxyServer 值。
//
// 两种形态都见过：
//
//	127.0.0.1:7890
//	http=127.0.0.1:7890;https=127.0.0.1:7890;ftp=127.0.0.1:7890
//
// 前者是全协议共用一个地址，后者按协议分开。
func parseProxyServer(raw, override string) *systemSettings {
	settings := &systemSettings{
		perScheme: map[string]string{},
		bypass:    splitBypass(override),
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return settings
	}
	if !strings.Contains(trimmed, "=") {
		settings.shared = trimmed
		return settings
	}
	for _, entry := range strings.Split(trimmed, ";") {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			continue
		}
		settings.perScheme[key] = value
	}
	return settings
}

// pick 选出该 scheme 用的代理地址与它的类别（http / socks…）。
//
// https 请求优先用 https 项，没有就退 http 项——Windows 上绝大多数代理工具
// 只写 http= 一行，把 https 当成「没配代理」会让所有站点都直连。
func (s *systemSettings) pick(scheme string) (string, string) {
	if s.shared != "" {
		return s.shared, ""
	}
	for _, key := range []string{scheme, "https", "http", "socks", "socks5"} {
		if value, ok := s.perScheme[key]; ok {
			return value, key
		}
	}
	return "", ""
}

// bypasses 判断主机是否命中 ProxyOverride（“请勿对以下条目开头的地址使用代理”）。
func (s *systemSettings) bypasses(host string) bool {
	for _, pattern := range s.bypass {
		if matchHost(pattern, host) {
			return true
		}
	}
	return false
}

// splitBypass 拆开 ProxyOverride（分号分隔，也见过逗号）。
func splitBypass(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool { return r == ';' || r == ',' })
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		if field = strings.TrimSpace(field); field != "" {
			out = append(out, field)
		}
	}
	return out
}

// matchHost 按 WinINET 的规则匹配排除项。
//
// `<local>` 表示「不含点的主机名」（内网短名）；其余支持 `*` / `?` 通配，
// 以及 `foo.com` 这种「本域 + 所有子域」的写法。
func matchHost(pattern, host string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	host = strings.ToLower(strings.TrimSpace(host))
	if pattern == "" || host == "" {
		return false
	}
	if pattern == "<local>" {
		return !strings.Contains(host, ".")
	}
	if strings.ContainsAny(pattern, "*?") {
		if ok, _ := path.Match(pattern, host); ok {
			return true
		}
	}
	trimmed := strings.TrimPrefix(pattern, "*.")
	return host == trimmed || strings.HasSuffix(host, "."+trimmed)
}

// proxyURL 把「host:port」或「scheme://host:port」变成 *url.URL。
func proxyURL(addr, kind string) (*url.URL, error) {
	if strings.Contains(addr, "://") {
		return url.Parse(addr)
	}
	scheme := "http"
	if strings.HasPrefix(kind, "socks") {
		scheme = "socks5"
	}
	return &url.URL{Scheme: scheme, Host: addr}, nil
}

// Describe 描述当前的出站方式，用于错误文案与启动日志。
//
// 只描述「会用于 https 请求」的那一条：抓取几乎都是 https，写一堆按协议
// 分开的地址对用户没有帮助。
func Describe() string {
	if label := envProxyLabel(); label != "" {
		return label
	}
	system := loadSystem()
	if system == nil {
		return "直连"
	}
	addr, kind := system.pick("https")
	if addr == "" {
		return "直连"
	}
	parsed, err := proxyURL(addr, kind)
	if err != nil {
		return "直连"
	}
	return "系统代理 " + parsed.String()
}

// envProxyLabel 返回环境变量里配置的代理（没有则空串）。
func envProxyLabel() string {
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return "代理 " + value + "（环境变量）"
		}
	}
	return ""
}
