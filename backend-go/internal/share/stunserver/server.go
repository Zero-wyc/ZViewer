// Package stunserver 是 ZViewer 自带的 STUN 反射端。
//
// 为什么不只依赖公共 STUN：Piik 的直连候选要靠 STUN 拿到双方观察到的反射
// 地址，而 Google 的 STUN 在国内基本不可用，miwifi / cdnbye 也时常抖动。
// 自带一个 3478/udp 的反射端之后，部署方只要放通这一个端口，打洞就不再
// 受第三方可用性影响。
//
// 只实现 RFC 5389 的 Binding 请求：不做 TURN（媒体中继交给 Piik 的 SFU），
// 也不做鉴权——STUN 无状态，反射地址本身不是秘密。
package stunserver

import (
	"errors"
	"fmt"
	"net"
	"strconv"

	"github.com/pion/stun/v4"
)

// Options 是 STUN 监听参数。零值表示不启用。
type Options struct {
	// Host 是监听地址，空 = 0.0.0.0。
	Host string
	// Port 是 UDP 端口；0 表示不启用，负数非法。
	Port int
	// PublicHost 是写进 ICE 配置的对外地址。
	//
	// 留空时：Host 不是通配地址就直接用它；是通配地址则取本机第一个非回环
	// IPv4——这在纯局域网部署里够用，公网 / NAT 1:1 必须显式配置，否则客户端
	// 拿到的候选指向内网地址，连不上。
	PublicHost string
}

// Server 持有一个 STUN UDP listener。Close 之前一直服务。
type Server struct {
	conn *net.UDPConn
	urls []string
}

// Start 绑定端口并开始应答。Port 为 0 时返回 (nil, nil)。
func Start(options Options) (*Server, error) {
	if options.Port == 0 {
		return nil, nil
	}
	if options.Port < 0 || options.Port > 65535 {
		return nil, fmt.Errorf("stun: port %d is out of range", options.Port)
	}
	host := options.Host
	if host == "" {
		host = "0.0.0.0"
	}
	address, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, strconv.Itoa(options.Port)))
	if err != nil {
		return nil, fmt.Errorf("stun: resolve %s: %w", host, err)
	}
	conn, err := net.ListenUDP("udp4", address)
	if err != nil {
		return nil, fmt.Errorf("stun: bind %s: %w", address, err)
	}
	port := conn.LocalAddr().(*net.UDPAddr).Port
	public := options.PublicHost
	if public == "" {
		public = resolvePublicHost(host)
	}
	server := &Server{
		conn: conn,
		urls: []string{fmt.Sprintf("stun:%s", net.JoinHostPort(public, strconv.Itoa(port)))},
	}
	go server.serve()
	return server, nil
}

// URLs 是下发给客户端的 ICE 地址，形如 `stun:example.com:3478`。
func (s *Server) URLs() []string {
	if s == nil {
		return nil
	}
	return append([]string(nil), s.urls...)
}

// Port 返回实际监听的端口（配置 0 表示未启用时调用方不会拿到 Server）。
func (s *Server) Port() int {
	if s == nil {
		return 0
	}
	return s.conn.LocalAddr().(*net.UDPAddr).Port
}

// Close 停止服务；可重复调用。
func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	return s.conn.Close()
}

func (s *Server) serve() {
	buffer := make([]byte, 1500)
	for {
		n, from, err := s.conn.ReadFromUDP(buffer)
		if err != nil {
			// 关闭 listener 也会走到这里，不当作错误上报。
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		// pion 的 Message 只在 Raw 不变期间有效，这里必须拷一份再解码：
		// 直接引用 buffer 会被下一次 ReadFrom 覆盖。
		raw := make([]byte, n)
		copy(raw, buffer[:n])
		request := &stun.Message{Raw: raw}
		if err := request.Decode(); err != nil {
			continue
		}
		if request.Type != stun.BindingRequest {
			continue
		}
		response, err := stun.Build(
			stun.BindingSuccess,
			stun.NewTransactionIDSetter(request.TransactionID),
			&stun.XORMappedAddress{IP: from.IP, Port: from.Port},
		)
		if err != nil {
			continue
		}
		_, _ = s.conn.WriteToUDP(response.Raw, from)
	}
}

// resolvePublicHost 在没显式配置对外地址时挑一个能用的 IPv4。
func resolvePublicHost(host string) string {
	if ip := net.ParseIP(host); ip != nil && !ip.IsUnspecified() {
		return host
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return "127.0.0.1"
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			network, ok := address.(*net.IPNet)
			if !ok {
				continue
			}
			ip := network.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			return ip.String()
		}
	}
	return "127.0.0.1"
}
