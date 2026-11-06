package controller

// 网络探测：端口占用检查、后端健康检查、LiveKit 就绪检查、CLI 健康检查。

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func portAvailable(port int, host string) error {
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		// 双栈监听要求系统启用 IPv6；未启用时给出可操作的提示，而不是笼统说端口被占用。
		if host == "::" && !supportsIPv6() {
			return fmt.Errorf("当前系统未启用 IPv6，无法监听所有地址；请把监听范围改成“局域网 IPv4 · 0.0.0.0”")
		}
		return fmt.Errorf("端口 %d 已被占用；不会停止占用它的其他程序", port)
	}
	_ = listener.Close()
	return nil
}

// supportsIPv6 用一次随机端口的 bind 判断系统是否启用了 IPv6 协议栈。
func supportsIPv6() bool {
	listener, err := net.Listen("tcp6", "[::]:0")
	if err != nil {
		return false
	}
	_ = listener.Close()
	return true
}

// lanIPv4s 返回本机可用于局域网访问的 IPv4 地址（私有网段，按数值排序去重）。
//
// 网卡地址随 DHCP 与虚拟网卡增减，证书签发时现取而不是读配置：
// 配置里的 lanIp 只是历史上手动填过的值，可能早已失效。
// 排除 169.254/16（APIPA）与回环；100.64/10（CGNAT，Tailscale 等）不算私有网段，也不会进来。
func lanIPv4s() []net.IP {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	out := make([]net.IP, 0, 4)
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipNet.IP.To4()
		if ip == nil || !ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			continue
		}
		key := ip.String()
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ip)
	}
	sort.Slice(out, func(i, j int) bool { return bytes.Compare(out[i], out[j]) < 0 })
	return out
}

func udpAvailable(port int, host string) error {
	base := "udp4"
	if strings.Contains(host, ":") {
		base = "udp6"
	}
	conn, err := net.ListenPacket(base, net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return fmt.Errorf("语音 UDP 端口 %d 已被占用；不会停止占用它的其他程序", port)
	}
	_ = conn.Close()
	return nil
}

func httpClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{DisableKeepAlives: true},
	}
}

func livekitReady(port int) bool {
	client := httpClient(1 * time.Second)
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return response.StatusCode == 200
}

// probeBackend 命中 /health，HTTPS 模式下用本机 CA 校验证书链。
func probeBackend(port int, secure bool, caPath string) bool {
	client := httpClient(1200 * time.Millisecond)
	if secure {
		raw, err := os.ReadFile(caPath)
		if err != nil {
			return false
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(raw) {
			return false
		}
		client = &http.Client{
			Timeout: 1200 * time.Millisecond,
			Transport: &http.Transport{
				DisableKeepAlives: true,
				TLSClientConfig:   &tls.Config{RootCAs: pool, ServerName: "localhost"},
			},
		}
	}
	scheme := "http"
	if secure {
		scheme = "https"
	}
	response, err := client.Get(fmt.Sprintf("%s://127.0.0.1:%d/health", scheme, port))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	text := string(body)
	return response.StatusCode == 200 && (strings.Contains(text, "ok") || strings.Contains(text, "status"))
}

type cliHealth struct {
	Version string
}

// cliHealthProbe 校验响应体确实来自 zcontrol-cli，避免误判占用端口的其他程序。
func cliHealthProbe(port int) (cliHealth, bool) {
	client := httpClient(1 * time.Second)
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if err != nil {
		return cliHealth{}, false
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil || response.StatusCode != 200 {
		return cliHealth{}, false
	}
	var payload struct {
		OK      bool   `json:"ok"`
		Agent   string `json:"agent"`
		Version string `json:"version"`
	}
	if json.Unmarshal(body, &payload) != nil || !payload.OK || payload.Agent != "zcontrol-cli" {
		return cliHealth{}, false
	}
	version := payload.Version
	if len(version) > 32 {
		version = version[:32]
	}
	return cliHealth{Version: version}, true
}
