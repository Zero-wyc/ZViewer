package sfu

import (
	"errors"
	"fmt"
	"net"
	"strconv"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// EngineOptions 是媒体面的网络配置。
type EngineOptions struct {
	// Port 是媒体 UDP 端口。0 表示由内核分配（测试用），实际端口从 Port() 读。
	Port int
	// TCPPort 是媒体 TCP 端口；0 表示与 Port 同号。
	//
	// 默认同号是给「一台机器只跑这一个服务」的部署用的：只转 TCP 的隧道后面
	// 运维只需记住一对端口。但**桌面壳里 3333/tcp 已经是网页**，媒体再抢
	// 同号就会绑不上、静默退化成只有 UDP——所以那里必须显式给 3337。
	TCPPort int
	// ListenHost 是监听地址，空 = 所有接口。
	ListenHost string
	// PublicIP 是 NAT 1:1 的公网地址（穿透/云主机场景）。空 = 用本地候选。
	PublicIP string
	// DisableTCP 关闭 ICE/TCP 候选。只在确认客户端都能走 UDP 时用。
	DisableTCP bool
	// IncludeLoopback 让本机回环也成为候选（本机开发必须开）。
	IncludeLoopback bool
}

// Engine 持有一对媒体端口（UDP + TCP）以及据此装配的 SettingEngine。
//
// 生命周期归装配层：Media 只拿到 SettingEngine 的拷贝，绝不关闭这些
// listener——关掉它们等于把整台机器的中继能力摘掉。
type Engine struct {
	settings   webrtc.SettingEngine
	udpConn    *net.UDPConn
	tcpLister  *net.TCPListener
	tcpMux     ice.TCPMux
	udpMux     ice.UDPMux
	port       int
	tcpPort    int
	tcpEnabled bool
}

// NewEngine 绑定媒体端口。
//
// UDP 先绑：它才是媒体流的主路径；TCP 绑不上（同号端口被别的进程占了）
// 只降级成「仅 UDP」，不整体失败——否则一个无关进程就能让屏幕共享起不来。
func NewEngine(options EngineOptions) (*Engine, error) {
	if options.Port < 0 || options.Port > 65535 {
		return nil, fmt.Errorf("sfu: media port %d is out of range", options.Port)
	}
	host := options.ListenHost
	if host == "" {
		host = "0.0.0.0"
	}
	udpAddr, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(host, strconv.Itoa(options.Port)))
	if err != nil {
		return nil, fmt.Errorf("sfu: resolve media address: %w", err)
	}
	udpConn, err := net.ListenUDP("udp4", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("sfu: bind %s/udp: %w", net.JoinHostPort(host, strconv.Itoa(options.Port)), err)
	}
	engine := &Engine{udpConn: udpConn, port: udpConn.LocalAddr().(*net.UDPAddr).Port}
	engine.udpMux = webrtc.NewICEUDPMux(nil, udpConn)

	engine.settings.SetICEUDPMux(engine.udpMux)
	networkTypes := []webrtc.NetworkType{webrtc.NetworkTypeUDP4}
	tcpPort := options.TCPPort
	if tcpPort == 0 {
		tcpPort = engine.port
	}
	if tcpPort < 0 || tcpPort > 65535 {
		_ = udpConn.Close()
		return nil, fmt.Errorf("sfu: media tcp port %d is out of range", tcpPort)
	}
	engine.tcpPort = tcpPort
	if !options.DisableTCP {
		tcpAddr, resolveErr := net.ResolveTCPAddr("tcp4", net.JoinHostPort(host, strconv.Itoa(tcpPort)))
		if resolveErr == nil {
			listener, listenErr := net.ListenTCP("tcp4", tcpAddr)
			if listenErr == nil {
				engine.tcpLister = listener
				engine.tcpMux = webrtc.NewICETCPMux(nil, listener, 8)
				engine.settings.SetICETCPMux(engine.tcpMux)
				networkTypes = append(networkTypes, webrtc.NetworkTypeTCP4)
				engine.tcpEnabled = true
			}
		}
	}
	engine.settings.SetNetworkTypes(networkTypes)
	engine.settings.SetIncludeLoopbackCandidate(options.IncludeLoopback)
	if options.PublicIP != "" {
		engine.settings.SetNAT1To1IPs([]string{options.PublicIP}, webrtc.ICECandidateTypeHost)
	}
	return engine, nil
}

// Settings 返回一份 SettingEngine 拷贝，交给 sfu.Media 使用。
func (engine *Engine) Settings() webrtc.SettingEngine {
	return engine.settings
}

// Port 是实际绑定的媒体 UDP 端口。
func (engine *Engine) Port() int { return engine.port }

// TCPPort 是实际绑定的媒体 TCP 端口（未启用 TCP 时也返回计划值）。
func (engine *Engine) TCPPort() int { return engine.tcpPort }

// TCPEnabled 报告 ICE/TCP 是否可用。
func (engine *Engine) TCPEnabled() bool { return engine.tcpEnabled }

// Close 释放媒体端口。
func (engine *Engine) Close() error {
	var errs []error
	if engine.udpMux != nil {
		errs = append(errs, engine.udpMux.Close())
	}
	if engine.tcpMux != nil {
		errs = append(errs, engine.tcpMux.Close())
	}
	if engine.udpConn != nil {
		errs = append(errs, engine.udpConn.Close())
	}
	if engine.tcpLister != nil {
		errs = append(errs, engine.tcpLister.Close())
	}
	return errors.Join(errs...)
}

// Describe 返回一行人类可读的端口状态（启动日志用）。
func (engine *Engine) Describe() string {
	if !engine.tcpEnabled {
		return fmt.Sprintf("%d/udp（TCP 未启用）", engine.port)
	}
	if engine.tcpPort == engine.port {
		return fmt.Sprintf("%d/udp + %d/tcp", engine.port, engine.port)
	}
	return fmt.Sprintf("%d/udp + %d/tcp", engine.port, engine.tcpPort)
}
