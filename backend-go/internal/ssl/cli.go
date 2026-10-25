package ssl

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// `--gen-cert` CLI：自签 / Let's Encrypt 双模式，逐条复刻 services/ssl/cert-cli.ts。
//
// 签发方式自动选择（与原独立 zviewer-cert 工具行为一致）：
//   - 域名（含点）或公网 IP → Let's Encrypt（ACME HTTP-01，需 80 端口公网可达）
//   - localhost / 内网 IP / 单标签主机名 → 本地自签

// knownFlags 与 Node 的 KNOWN_FLAGS 一致。
var knownFlags = map[string]bool{
	"--gen-cert":   true,
	"--force":      true,
	"-f":           true,
	"--selfsigned": true,
	"--staging":    true,
	"--email":      true,
	"--directory":  true,
}

// GenCertArgs 是 `--gen-cert` 之后的参数。
type GenCertArgs struct {
	Host      string
	Force     bool
	SelfSign  bool
	Staging   bool
	Email     string
	Directory string
}

// ParseGenCertArgs 解析 `--gen-cert` 之后的参数。
func ParseGenCertArgs(args []string) (GenCertArgs, error) {
	genIdx := -1
	for i, a := range args {
		if a == "--gen-cert" {
			genIdx = i
			break
		}
	}
	if genIdx < 0 {
		return GenCertArgs{}, fmt.Errorf("缺少 --gen-cert 参数")
	}
	rest := args[genIdx+1:]

	readValueArg := func(name string) (string, bool, error) {
		for i, a := range rest {
			if a != name {
				continue
			}
			if i+1 < len(rest) && !strings.HasPrefix(rest[i+1], "-") {
				return rest[i+1], true, nil
			}
			return "", false, fmt.Errorf("参数 %s 缺少值", name)
		}
		for _, a := range rest {
			if strings.HasPrefix(a, name+"=") {
				return a[len(name)+1:], true, nil
			}
		}
		return "", false, nil
	}

	var host string
	hostSet := false
	for i := 0; i < len(rest); i++ {
		a := rest[i]
		if knownFlags[a] {
			// 这两个 flag 后面跟一个值，跳过它，免得被当成 host
			if a == "--email" || a == "--directory" {
				i++
			}
			continue
		}
		if strings.HasPrefix(a, "--") && strings.Contains(a, "=") {
			continue
		}
		if strings.HasPrefix(a, "-") {
			return GenCertArgs{}, fmt.Errorf("无法识别的参数: %s（用法见 zviewer-backend --gen-cert --help）", a)
		}
		if hostSet {
			return GenCertArgs{}, fmt.Errorf("参数过多: %s", a)
		}
		host = a
		hostSet = true
	}

	email, _, err := readValueArg("--email")
	if err != nil {
		return GenCertArgs{}, err
	}
	directory, _, err := readValueArg("--directory")
	if err != nil {
		return GenCertArgs{}, err
	}

	return GenCertArgs{
		Host:      host,
		Force:     containsArg(rest, "--force") || containsArg(rest, "-f"),
		SelfSign:  containsArg(rest, "--selfsigned"),
		Staging:   containsArg(rest, "--staging"),
		Email:     email,
		Directory: directory,
	}, nil
}

func containsArg(args []string, target string) bool {
	for _, a := range args {
		if a == target {
			return true
		}
	}
	return false
}

// PrintUsage 打印 `--gen-cert` 用法（文案与 Node 逐字一致）。
func PrintUsage(w io.Writer) {
	fmt.Fprintln(w, "用法: zviewer-backend --gen-cert [host] [选项]")
	fmt.Fprintln(w, "  host            域名、公网 IP 或 localhost（缺省 localhost）")
	fmt.Fprintln(w, "                  域名和公网 IP 默认通过 Let's Encrypt 申请可信 CA 证书；")
	fmt.Fprintln(w, "                  localhost / 内网 IP 使用自签证书")
	fmt.Fprintln(w, "  --force/-f      强制重新生成，不检查已有证书")
	fmt.Fprintln(w, "  --selfsigned    强制自签（即使指定的是域名或公网 IP）")
	fmt.Fprintln(w, "  --staging       使用 Let's Encrypt 测试环境（staging，无速率限制）")
	fmt.Fprintln(w, "  --email <邮箱>  ACME 账号邮箱（可选）")
	fmt.Fprintln(w, "  --directory <url> 自定义 ACME 目录 URL（高级选项）")
}

// IsPublicIP 判断 IP 是否为公网地址（非私有 / 环回 / 链路本地）。
//
// 逐条照抄 Node 的分支（含 CGNAT 100.64/10）；IPv6 用前缀字符串判断，
// 与 `lower.startsWith('fc')` 等价。
func IsPublicIP(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	if v4 := parsed.To4(); v4 != nil {
		a, b := int(v4[0]), int(v4[1])
		switch {
		case a == 10:
			return false
		case a == 172 && b >= 16 && b <= 31:
			return false
		case a == 192 && b == 168:
			return false
		case a == 127:
			return false
		case a == 169 && b == 254:
			return false
		case a == 0:
			return false
		case a == 100 && b >= 64 && b <= 127:
			return false
		default:
			return true
		}
	}

	lower := strings.ToLower(parsed.String())
	if lower == "::1" {
		return false
	}
	if strings.HasPrefix(lower, "fc") || strings.HasPrefix(lower, "fd") {
		return false
	}
	if strings.HasPrefix(lower, "fe8") || strings.HasPrefix(lower, "fe9") ||
		strings.HasPrefix(lower, "fea") || strings.HasPrefix(lower, "feb") {
		return false
	}
	return true
}

// RunGenCert 执行 `--gen-cert`（成功返回 nil，调用方据此 exit 0）。
func RunGenCert(ctx context.Context, args []string, configDir string, out io.Writer) error {
	opts, err := ParseGenCertArgs(args)
	if err != nil {
		return err
	}
	host, kind, err := ParseHostKind(opts.Host)
	if err != nil {
		return err
	}

	useACME := host != "" && !opts.SelfSign &&
		((kind == HostDNS && strings.Contains(host, ".")) ||
			(kind == HostIP && IsPublicIP(host)))

	if useACME {
		return issueCACert(ctx, host, kind, opts, configDir, out)
	}
	return ensureSelfSignedCLI(host, opts, configDir, out)
}

func ensureSelfSignedCLI(host string, opts GenCertArgs, configDir string, out io.Writer) error {
	result, err := EnsureSelfSigned(SelfSignedOptions{
		Host:  host,
		Force: opts.Force,
		Paths: Paths(configDir),
		Log:   func(line string) { fmt.Fprintln(out, line) },
	})
	if err != nil {
		return err
	}
	if !result.Generated {
		fmt.Fprintf(out, "  %s\n", result.Reason)
	}
	return nil
}

func issueCACert(ctx context.Context, host string, kind HostKind, opts GenCertArgs, configDir string, out io.Writer) error {
	idLabel := "域名"
	if kind == HostIP {
		idLabel = "IP 地址"
	}
	directoryURL := opts.Directory
	envName := "Let's Encrypt"
	if opts.Staging {
		envName = "Let's Encrypt 测试环境(staging)"
		if directoryURL == "" {
			directoryURL = DirectoryStaging
		}
	}
	if directoryURL == "" {
		directoryURL = DirectoryLetsEncrypt
	}

	paths := Paths(configDir)
	accountKeyFile := filepath.Join(filepath.Dir(paths.CertPath), "acme-account.key")

	// CA 模式：已有证书是 CA 签发的、含该主机且未过期 → 跳过申请
	if !opts.Force && fileExists(paths.CertPath) && fileExists(paths.KeyPath) {
		hasHost := false
		want := strings.ToLower(host)
		for _, h := range ReadSANHosts(paths.CertPath) {
			if strings.ToLower(h) == want {
				hasHost = true
				break
			}
		}
		notExpired := IsNotExpired(paths.CertPath)
		selfSigned := IsSelfSigned(paths.CertPath)
		if hasHost && notExpired && !selfSigned {
			fmt.Fprintf(out, "  可信证书已存在（已包含 %s），跳过申请（如需重新申请请加 --force）\n", host)
			return nil
		}
		if hasHost && notExpired && selfSigned {
			fmt.Fprintln(out, "  现有证书为自签证书，将重新申请 Let's Encrypt 可信证书...")
		} else if hasHost && !notExpired {
			fmt.Fprintln(out, "  现有证书已过期，自动重新申请...")
		}
		// Node 还有一条 `else if (hostExists)`，逻辑上不可达（前两条已覆盖），不实现。
	}

	fmt.Fprintf(out, "  通过 %s 申请可信 CA 证书（%s: %s）...\n", envName, idLabel, host)
	fmt.Fprintln(out, "  提示: 需满足以下条件才能成功：")
	fmt.Fprintf(out, "        1) %s已指向本机且公网可达\n", idLabel)
	fmt.Fprintln(out, "        2) 80 端口空闲且防火墙/安全组已放行（HTTP-01 验证）")

	challengePort := 80
	if raw := strings.TrimSpace(os.Getenv("ZVIEWER_CERT_CHALLENGE_PORT")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 65535 {
			challengePort = v
		}
	}

	cert, err := RequestCertificate(ctx, ACMEOptions{
		Domain:         host,
		DirectoryURL:   directoryURL,
		AccountKeyFile: accountKeyFile,
		Email:          opts.Email,
		ChallengePort:  challengePort,
		IdentifierType: kind,
		Log:            func(line string) { fmt.Fprintln(out, line) },
	})
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(paths.CertPath), 0o755); err != nil {
		return fmt.Errorf("创建证书目录失败: %w", err)
	}
	if err := os.WriteFile(paths.CertPath, []byte(cert.FullchainPEM), 0o644); err != nil {
		return fmt.Errorf("写入证书失败: %w", err)
	}
	if err := os.WriteFile(paths.KeyPath, []byte(cert.KeyPEM), 0o600); err != nil {
		return fmt.Errorf("写入私钥失败: %w", err)
	}

	fmt.Fprintf(out, "  可信证书已生成: %s（完整证书链）\n", paths.CertPath)
	fmt.Fprintf(out, "  私钥已生成: %s\n", paths.KeyPath)
	if kind == HostIP {
		fmt.Fprintln(out, "  公网 IP 证书有效期约 6 天，到期后请重新签发")
	} else {
		fmt.Fprintln(out, "  证书有效期约 90 天，到期前请重新运行本命令续期")
	}
	return nil
}
