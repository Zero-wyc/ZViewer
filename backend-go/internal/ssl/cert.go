// Package ssl 负责 HTTPS 证书：本地自签生成与 Let's Encrypt（ACME HTTP-01）签发。
//
// 与 Node 版的服务边界一致：`services/ssl/self-signed-cert.ts`（自签）、
// `services/ssl/acme-client.ts`（ACME v2）、`services/ssl/cert-cli.ts`（`--gen-cert`）。
//
// 为什么要有自签：本项目默认监听 http，但屏幕共享（getDisplayMedia）与语音
// 在非安全上下文里会被浏览器直接禁用。局域网用户跑 `HTTPS=true` 时，
// 若没有现成证书就自动签一张自签证书——浏览器首次提示继续即可用。
//
// 公网部署仍建议用 Caddy/Nginx 申请可信证书；内置 ACME 只是为了
// 「一台公网机器 + 80 端口」这种最简场景不用再装别的工具。
package ssl

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// CertPaths 是证书与私钥的落点。
type CertPaths struct {
	CertPath string
	KeyPath  string
}

// Paths 解析证书路径（支持 SSL_CERT_PATH / SSL_KEY_PATH 环境变量覆盖）。
//
// 与 Node 的 getSslCertPaths 一致：环境变量优先于目录默认值，
// 因此「只改其中一个」也能生效（另一个仍落在默认目录）。
func Paths(configDir string) CertPaths {
	return PathsIn(filepath.Join(configDir, "ssl"))
}

// PathsIn 以显式目录解析路径（单测与 CLI 用）。
func PathsIn(sslDir string) CertPaths {
	certPath := os.Getenv("SSL_CERT_PATH")
	if certPath == "" {
		certPath = filepath.Join(sslDir, "cert.pem")
	}
	keyPath := os.Getenv("SSL_KEY_PATH")
	if keyPath == "" {
		keyPath = filepath.Join(sslDir, "key.pem")
	}
	return CertPaths{CertPath: certPath, KeyPath: keyPath}
}

// HostKind 是证书主体（SAN）的类型。
type HostKind string

const (
	HostNone HostKind = ""
	HostIP   HostKind = "ip"
	HostDNS  HostKind = "dns"
)

// dnsNamePattern 与 Node 的正则逐字相同（不允许下划线、不校验长度上限）。
var dnsNamePattern = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$`)

// ipv4Pattern 用来识别「长得像 IPv4 但非法」的输入（如 999.1.1.1），
// 这种要报「非法 IPv4」而不是落到 DNS 分支。
var ipv4Pattern = regexp.MustCompile(`^(\d{1,3}\.){3}\d{1,3}$`)

// ParseHostKind 校验并归类 host：IP / 域名 / localhost（不指定）。
//
// 错误文案与 Node 逐字一致——`--gen-cert` 的报错会直接打给用户。
func ParseHostKind(host string) (string, HostKind, error) {
	if host == "" || strings.ToLower(host) == "localhost" {
		return host, HostNone, nil
	}
	if net.ParseIP(host) != nil {
		return host, HostIP, nil
	}
	if ipv4Pattern.MatchString(host) {
		return "", HostNone, fmt.Errorf("非法 IPv4 地址: %s", host)
	}
	if strings.Contains(host, ":") {
		return "", HostNone, fmt.Errorf("非法 IPv6 地址: %s", host)
	}
	if dnsNamePattern.MatchString(host) {
		return host, HostDNS, nil
	}
	return "", HostNone, fmt.Errorf("无法识别的域名或 IP 地址: %s", host)
}

// ReadSANHosts 读取证书里的 SAN 条目（解析失败返回空列表）。
//
// 返回顺序与「DNS 名在前、IP 在后」一致；SAN 的顺序本身没有语义，
// 调用方只用来判断「是否已包含某个 host」。
func ReadSANHosts(certFile string) []string {
	cert, err := loadLeaf(certFile)
	if err != nil {
		return nil
	}
	hosts := make([]string, 0, len(cert.DNSNames)+len(cert.IPAddresses))
	hosts = append(hosts, cert.DNSNames...)
	for _, ip := range cert.IPAddresses {
		hosts = append(hosts, ip.String())
	}
	return hosts
}

// IsNotExpired 判断证书是否仍未过期（解析失败按过期处理）。
func IsNotExpired(certFile string) bool {
	cert, err := loadLeaf(certFile)
	if err != nil {
		return false
	}
	return cert.NotAfter.After(time.Now())
}

// IsSelfSigned 判断证书是否自签（签发者与主体同名）。
//
// Node 比的是 `issuer.hash === subject.hash`（只比名字、不验签），
// 这里比编码后的 RawIssuer/RawSubject，语义相同。
func IsSelfSigned(certFile string) bool {
	cert, err := loadLeaf(certFile)
	if err != nil {
		return false
	}
	return string(cert.RawIssuer) == string(cert.RawSubject)
}

// loadLeaf 读 PEM 证书（只取第一张：fullchain 的第一段就是叶证书）。
func loadLeaf(certFile string) (*x509.Certificate, error) {
	raw, err := os.ReadFile(certFile)
	if err != nil {
		return nil, err
	}
	for {
		var block *pem.Block
		block, raw = pem.Decode(raw)
		if block == nil {
			return nil, fmt.Errorf("证书里没有 PEM 块: %s", certFile)
		}
		if block.Type == "CERTIFICATE" {
			return x509.ParseCertificate(block.Bytes)
		}
	}
}

// SelfSignedOptions 控制自签证书生成。
type SelfSignedOptions struct {
	// Host 是要额外写入 SAN 的主机名 / IP（缺省只含本机地址）。
	Host string
	// Force 为 true 时忽略已有证书，强制重签。
	Force bool
	// Paths 是证书/私钥落点（调用方用 Paths(configDir) 算出来）。
	// 零值时按当前目录下的 ssl/ 兜底（单测/临时调用方便）。
	Paths CertPaths
	// Log 是进度输出（CLI 直接打到 stdout）。
	Log func(string)
}

// SelfSignedResult 是 EnsureSelfSigned 的结果。
type SelfSignedResult struct {
	CertPaths
	// Generated 表示本次是否真的生成了新证书。
	Generated bool
	// Reason 是跳过生成的原因（Generated=false 时非空）。
	Reason string
}

// GenerateSelfSigned 生成自签证书并写入指定路径（覆盖已有文件）。
//
// 参数与 Node 的 generateSelfSignedCert 一致：RSA 2048、SHA256 签名、
// 主体 C=CN/O=ZViewer/CN=<host|localhost>，SAN 恒含 localhost/127.0.0.1/::1。
// 私钥用 **PKCS#1**（`BEGIN RSA PRIVATE KEY`）写出——node-forge 的
// privateKeyToPem 就是这个形态，保持两端产出的文件可互换。
func GenerateSelfSigned(certPath, keyPath, host string, logf func(string)) error {
	host, kind, err := ParseHostKind(host)
	if err != nil {
		return err
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("生成 RSA 密钥失败: %w", err)
	}

	serialBytes := make([]byte, 8)
	if _, err := rand.Read(serialBytes); err != nil {
		return fmt.Errorf("生成序列号失败: %w", err)
	}
	// 最高位置零，避免 big.Int 解释成负数（Node 的 hex 串同样不会是负数）
	serialBytes[0] &= 0x7f

	cn := "localhost"
	if host != "" && kind != HostNone {
		cn = host
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: new(big.Int).SetBytes(serialBytes),
		Subject: pkix.Name{
			Country:      []string{"CN"},
			Organization: []string{"ZViewer"},
			CommonName:   cn,
		},
		// 从前一天开始：客户端与本机时钟有几小时偏差时不至于「尚未生效」
		NotBefore:             now.AddDate(0, 0, -1),
		NotAfter:              now.AddDate(10, 0, 0),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		// 必须置 true 才能自签并被当作 CA 链的根（浏览器会提示「不受信任」，
		// 但至少允许用户手动继续；缺 CA:TRUE 时部分客户端会直接拒绝）。
		IsCA: true,
	}

	baseHosts := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	var dnsNames []string
	var ips []net.IP
	if host != "" && kind != HostNone && !baseHosts[strings.ToLower(host)] {
		if kind == HostIP {
			ips = append(ips, net.ParseIP(host))
		} else {
			dnsNames = append(dnsNames, host)
		}
	}
	dnsNames = append(dnsNames, "localhost")
	ips = append(ips, net.ParseIP("127.0.0.1"), net.ParseIP("::1"))
	template.DNSNames = dnsNames
	template.IPAddresses = ips

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("签发证书失败: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	if err := os.MkdirAll(filepath.Dir(certPath), 0o755); err != nil {
		return fmt.Errorf("创建证书目录失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o755); err != nil {
		return fmt.Errorf("创建私钥目录失败: %w", err)
	}
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return fmt.Errorf("写入证书失败: %w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return fmt.Errorf("写入私钥失败: %w", err)
	}

	if logf != nil {
		var sanText []string
		for _, name := range dnsNames {
			sanText = append(sanText, "DNS:"+name)
		}
		for _, ip := range ips {
			sanText = append(sanText, "IP:"+ip.String())
		}
		logf(fmt.Sprintf("  证书主体: CN=%s", cn))
		logf(fmt.Sprintf("  证书 SAN : %s", strings.Join(sanText, ", ")))
		logf(fmt.Sprintf("  证书已生成: %s", certPath))
		logf(fmt.Sprintf("  私钥已生成: %s", keyPath))
	}
	return nil
}

// EnsureSelfSigned 确保存在可用的自签证书。
func EnsureSelfSigned(opts SelfSignedOptions) (SelfSignedResult, error) {
	paths := opts.Paths
	if paths.CertPath == "" {
		paths = PathsIn("ssl")
	}

	exists := fileExists(paths.CertPath) && fileExists(paths.KeyPath)
	if !opts.Force && exists {
		existing := ReadSANHosts(paths.CertPath)
		want := "localhost"
		if opts.Host != "" {
			want = strings.ToLower(opts.Host)
		}
		has := false
		for _, h := range existing {
			if strings.ToLower(h) == want {
				has = true
				break
			}
		}
		if has && IsNotExpired(paths.CertPath) {
			label := opts.Host
			if label == "" {
				label = "localhost"
			}
			return SelfSignedResult{
				CertPaths: paths,
				Generated: false,
				Reason:    fmt.Sprintf("证书已存在（已包含 %s），如需重新生成请加 --force", label),
			}, nil
		}
	}

	if err := GenerateSelfSigned(paths.CertPath, paths.KeyPath, opts.Host, opts.Log); err != nil {
		return SelfSignedResult{CertPaths: paths}, err
	}
	return SelfSignedResult{CertPaths: paths, Generated: true}, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
