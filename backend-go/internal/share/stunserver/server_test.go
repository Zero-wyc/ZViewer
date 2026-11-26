package stunserver

import (
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/pion/stun/v4"
)

// 真起一个 listener，发一次 Binding 请求，确认反射回来的就是客户端自己的地址。
func TestBindingReturnsObservedAddress(t *testing.T) {
	// Port 0 表示关闭，所以先借一个空闲端口再交给 Start。
	probe, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("申请空闲端口失败: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	_ = probe.Close()

	server, err := Start(Options{Host: "127.0.0.1", Port: port, PublicHost: "127.0.0.1"})
	if err != nil {
		t.Fatalf("启动 STUN 失败: %v", err)
	}
	defer func() { _ = server.Close() }()

	if got, want := server.URLs(), []string{fmt.Sprintf("stun:127.0.0.1:%d", port)}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("URLs = %v，期望 %v", got, want)
	}

	client, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatalf("连接 STUN 失败: %v", err)
	}
	defer func() { _ = client.Close() }()

	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	if _, err := client.Write(request.Raw); err != nil {
		t.Fatalf("发送请求失败: %v", err)
	}

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buffer := make([]byte, 1500)
	n, err := client.Read(buffer)
	if err != nil {
		t.Fatalf("没有收到响应: %v", err)
	}

	response := &stun.Message{Raw: buffer[:n]}
	if err := response.Decode(); err != nil {
		t.Fatalf("响应无法解码: %v", err)
	}
	if response.Type != stun.BindingSuccess {
		t.Fatalf("响应类型 = %v，期望 BindingSuccess", response.Type)
	}
	if response.TransactionID != request.TransactionID {
		t.Fatal("事务 ID 没有原样带回")
	}

	var mapped stun.XORMappedAddress
	if err := mapped.GetFrom(response); err != nil {
		t.Fatalf("没有 XOR-MAPPED-ADDRESS: %v", err)
	}
	local := client.LocalAddr().(*net.UDPAddr)
	if mapped.Port != local.Port || !mapped.IP.Equal(local.IP) {
		t.Fatalf("反射地址 = %s:%d，期望 %s:%d", mapped.IP, mapped.Port, local.IP, local.Port)
	}
}

func TestPortZeroDisables(t *testing.T) {
	server, err := Start(Options{Port: 0})
	if err != nil {
		t.Fatalf("Port=0 不该报错: %v", err)
	}
	if server != nil {
		t.Fatal("Port=0 应返回 nil server")
	}
	if urls := server.URLs(); urls != nil {
		t.Fatalf("nil server 的 URLs 应为空，得到 %v", urls)
	}
	if err := server.Close(); err != nil {
		t.Fatalf("nil server Close 应为空操作: %v", err)
	}
}
