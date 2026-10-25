package ssl

import (
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseHostKind(t *testing.T) {
	cases := []struct {
		host    string
		want    string
		kind    HostKind
		wantErr string
	}{
		{host: "", want: "", kind: HostNone},
		{host: "localhost", want: "localhost", kind: HostNone},
		{host: "LocalHost", want: "LocalHost", kind: HostNone},
		{host: "192.168.1.10", want: "192.168.1.10", kind: HostIP},
		{host: "::1", want: "::1", kind: HostIP},
		{host: "example.com", want: "example.com", kind: HostDNS},
		{host: "sub.example.com", want: "sub.example.com", kind: HostDNS},
		{host: "zviewer", want: "zviewer", kind: HostDNS},
		// 长得像 IPv4 但非法 → 报「非法 IPv4」而不是落到 DNS 分支
		{host: "999.1.1.1", kind: HostNone, wantErr: "非法 IPv4 地址: 999.1.1.1"},
		{host: "fe80::1%eth0", kind: HostNone, wantErr: "非法 IPv6 地址: fe80::1%eth0"},
		{host: "bad host", kind: HostNone, wantErr: "无法识别的域名或 IP 地址: bad host"},
		{host: "-bad.com", kind: HostNone, wantErr: "无法识别的域名或 IP 地址: -bad.com"},
	}
	for _, c := range cases {
		t.Run(c.host, func(t *testing.T) {
			host, kind, err := ParseHostKind(c.host)
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("错误 = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if host != c.want || kind != c.kind {
				t.Errorf("ParseHostKind(%q) = (%q, %q), want (%q, %q)", c.host, host, kind, c.want, c.kind)
			}
		})
	}
}

// readCert 读回证书（测试内省用）。
func readCert(t *testing.T, path string) *x509.Certificate {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取证书失败: %v", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		t.Fatal("证书不是 PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("解析证书失败: %v", err)
	}
	return cert
}

func TestGenerateSelfSigned(t *testing.T) {
	dir := t.TempDir()
	paths := PathsIn(dir)
	var logs []string
	if err := GenerateSelfSigned(paths.CertPath, paths.KeyPath, "192.168.1.50", func(s string) {
		logs = append(logs, s)
	}); err != nil {
		t.Fatalf("生成失败: %v", err)
	}

	cert := readCert(t, paths.CertPath)
	if cert.Subject.CommonName != "192.168.1.50" {
		t.Errorf("CN = %q", cert.Subject.CommonName)
	}
	if cert.Issuer.CommonName != cert.Subject.CommonName {
		t.Errorf("自签证书的 issuer 应与 subject 一致: %q vs %q",
			cert.Issuer.CommonName, cert.Subject.CommonName)
	}
	if len(cert.Subject.Country) != 1 || cert.Subject.Country[0] != "CN" {
		t.Errorf("C = %v", cert.Subject.Country)
	}
	if len(cert.Subject.Organization) != 1 || cert.Subject.Organization[0] != "ZViewer" {
		t.Errorf("O = %v", cert.Subject.Organization)
	}

	// SAN 恒含本机地址，且带上了指定 IP
	san := map[string]bool{}
	for _, h := range ReadSANHosts(paths.CertPath) {
		san[h] = true
	}
	for _, want := range []string{"localhost", "127.0.0.1", "::1", "192.168.1.50"} {
		if !san[want] {
			t.Errorf("SAN 缺少 %s（实际 %v）", want, san)
		}
	}

	// 10 年有效期，notBefore 提前一天
	validity := cert.NotAfter.Sub(cert.NotBefore)
	if validity < 10*365*24*3600*1e9 || validity > 11*365*24*3600*1e9 {
		t.Errorf("有效期 = %v, want 约 10 年", validity)
	}
	if !cert.NotBefore.Before(cert.NotAfter) || cert.NotBefore.After(time.Now()) {
		t.Errorf("notBefore 应早于现在: %v", cert.NotBefore)
	}

	if !IsSelfSigned(paths.CertPath) {
		t.Error("IsSelfSigned 应为 true")
	}
	if !IsNotExpired(paths.CertPath) {
		t.Error("IsNotExpired 应为 true")
	}

	// 私钥是 PKCS#1（node-forge 的形态），权限 0600
	keyRaw, err := os.ReadFile(paths.KeyPath)
	if err != nil {
		t.Fatalf("读取私钥失败: %v", err)
	}
	if !strings.Contains(string(keyRaw), "BEGIN RSA PRIVATE KEY") {
		t.Errorf("私钥不是 PKCS#1: %s", string(keyRaw[:40]))
	}
	// 私钥权限 0600（Windows 不支持 POSIX 权限位，跳过断言）
	if info, err := os.Stat(paths.KeyPath); err == nil && runtime.GOOS != "windows" {
		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("私钥权限过宽: %v", info.Mode().Perm())
		}
	}

	// 日志文案（CLI 直接展示给用户）
	joined := strings.Join(logs, "\n")
	if !strings.Contains(joined, "证书主体: CN=192.168.1.50") {
		t.Errorf("缺少主体日志: %s", joined)
	}
	if !strings.Contains(joined, "证书 SAN : DNS:localhost, IP:192.168.1.50, IP:127.0.0.1, IP:::1") {
		t.Errorf("SAN 日志不对: %s", joined)
	}
}

func TestGenerateSelfSignedDefaultHost(t *testing.T) {
	dir := t.TempDir()
	paths := PathsIn(dir)
	if err := GenerateSelfSigned(paths.CertPath, paths.KeyPath, "", nil); err != nil {
		t.Fatalf("生成失败: %v", err)
	}
	cert := readCert(t, paths.CertPath)
	if cert.Subject.CommonName != "localhost" {
		t.Errorf("CN = %q, want localhost", cert.Subject.CommonName)
	}
	hosts := ReadSANHosts(paths.CertPath)
	if len(hosts) != 3 {
		t.Errorf("未指定 host 时 SAN 应只有本机三条，实际 %v", hosts)
	}
}

func TestEnsureSelfSignedSkipsWhenValid(t *testing.T) {
	dir := t.TempDir()
	paths := PathsIn(dir)

	first, err := EnsureSelfSigned(SelfSignedOptions{Paths: paths})
	if err != nil {
		t.Fatalf("首次生成失败: %v", err)
	}
	if !first.Generated {
		t.Fatal("首次应生成证书")
	}

	second, err := EnsureSelfSigned(SelfSignedOptions{Paths: paths})
	if err != nil {
		t.Fatalf("第二次失败: %v", err)
	}
	if second.Generated {
		t.Fatal("已有可用证书时不应重签")
	}
	if second.Reason != "证书已存在（已包含 localhost），如需重新生成请加 --force" {
		t.Errorf("跳过原因 = %q", second.Reason)
	}

	// force 必须重签
	third, err := EnsureSelfSigned(SelfSignedOptions{Paths: paths, Force: true})
	if err != nil {
		t.Fatalf("强制重签失败: %v", err)
	}
	if !third.Generated {
		t.Fatal("force 时应重签")
	}
}

func TestEnsureSelfSignedRegeneratesForNewHost(t *testing.T) {
	dir := t.TempDir()
	paths := PathsIn(dir)

	if _, err := EnsureSelfSigned(SelfSignedOptions{Paths: paths}); err != nil {
		t.Fatalf("首次生成失败: %v", err)
	}
	// 已有证书不含 example.lan → 必须重签并补进 SAN
	result, err := EnsureSelfSigned(SelfSignedOptions{Paths: paths, Host: "example.lan"})
	if err != nil {
		t.Fatalf("重签失败: %v", err)
	}
	if !result.Generated {
		t.Fatal("证书未覆盖新 host 时应重签")
	}
	hosts := strings.Join(ReadSANHosts(paths.CertPath), ",")
	if !strings.Contains(hosts, "example.lan") {
		t.Errorf("新 host 未写入 SAN: %s", hosts)
	}
}

func TestPathsEnvOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SSL_CERT_PATH", "")
	t.Setenv("SSL_KEY_PATH", "")
	paths := Paths(dir)
	if paths.CertPath != filepath.Join(dir, "ssl", "cert.pem") {
		t.Errorf("cert = %q", paths.CertPath)
	}
	if paths.KeyPath != filepath.Join(dir, "ssl", "key.pem") {
		t.Errorf("key = %q", paths.KeyPath)
	}

	t.Setenv("SSL_CERT_PATH", "/tmp/custom-cert.pem")
	t.Setenv("SSL_KEY_PATH", "/tmp/custom-key.pem")
	paths = Paths(dir)
	if paths.CertPath != "/tmp/custom-cert.pem" || paths.KeyPath != "/tmp/custom-key.pem" {
		t.Errorf("环境变量未生效: %+v", paths)
	}
}

func TestReadSANHostsOnBrokenFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "broken.pem")
	if err := os.WriteFile(path, []byte("not a pem"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	if hosts := ReadSANHosts(path); len(hosts) != 0 {
		t.Errorf("坏证书应返回空列表，实际 %v", hosts)
	}
	if IsNotExpired(path) {
		t.Error("坏证书应视为已过期")
	}
	if IsSelfSigned(path) {
		t.Error("坏证书不应被判为自签")
	}
}

func TestIsPublicIP(t *testing.T) {
	cases := map[string]bool{
		"8.8.8.8":              true,
		"1.1.1.1":              true,
		"10.0.0.1":             false,
		"172.16.0.1":           false,
		"172.31.255.255":       false,
		"172.32.0.1":           true,
		"192.168.1.1":          false,
		"127.0.0.1":            false,
		"169.254.1.1":          false,
		"0.0.0.0":              false,
		"100.64.0.1":           false,
		"100.127.255.255":      false,
		"100.128.0.1":          true,
		"::1":                  false,
		"fd00::1":              false,
		"fc00::1":              false,
		"fe80::1":              false,
		"2001:4860:4860::8888": true,
		"not-an-ip":            false,
	}
	for ip, want := range cases {
		if got := IsPublicIP(ip); got != want {
			t.Errorf("IsPublicIP(%q) = %v, want %v", ip, got, want)
		}
	}
}
