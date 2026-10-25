package ssl

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestParseGenCertArgs(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		want    GenCertArgs
		wantErr string
	}{
		{
			name: "只有 --gen-cert",
			args: []string{"--gen-cert"},
			want: GenCertArgs{},
		},
		{
			name: "host + 全部开关",
			args: []string{"--gen-cert", "example.com", "--force", "--selfsigned", "--staging",
				"--email", "a@b.com", "--directory", "https://acme.test/dir"},
			want: GenCertArgs{
				Host: "example.com", Force: true, SelfSign: true, Staging: true,
				Email: "a@b.com", Directory: "https://acme.test/dir",
			},
		},
		{
			name: "flag=value 形态",
			args: []string{"--gen-cert", "1.2.3.4", "--email=a@b.com", "--directory=https://x/d"},
			want: GenCertArgs{Host: "1.2.3.4", Email: "a@b.com", Directory: "https://x/d"},
		},
		{
			name: "-f 短开关",
			args: []string{"--gen-cert", "-f"},
			want: GenCertArgs{Force: true},
		},
		{
			name:    "email 缺值",
			args:    []string{"--gen-cert", "--email"},
			wantErr: "参数 --email 缺少值",
		},
		{
			name:    "email 后面跟着另一个开关也算缺值",
			args:    []string{"--gen-cert", "--email", "--force"},
			wantErr: "参数 --email 缺少值",
		},
		{
			name:    "未知开关",
			args:    []string{"--gen-cert", "--wat"},
			wantErr: "无法识别的参数: --wat（用法见 zviewer-backend --gen-cert --help）",
		},
		{
			name:    "多个 host",
			args:    []string{"--gen-cert", "a.com", "b.com"},
			wantErr: "参数过多: b.com",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ParseGenCertArgs(c.args)
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("错误 = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if got != c.want {
				t.Errorf("ParseGenCertArgs = %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestPrintUsage(t *testing.T) {
	var buf bytes.Buffer
	PrintUsage(&buf)
	text := buf.String()
	for _, want := range []string{
		"用法: zviewer-backend --gen-cert [host] [选项]",
		"--force/-f      强制重新生成，不检查已有证书",
		"--selfsigned    强制自签（即使指定的是域名或公网 IP）",
		"--staging       使用 Let's Encrypt 测试环境（staging，无速率限制）",
		"--email <邮箱>  ACME 账号邮箱（可选）",
		"--directory <url> 自定义 ACME 目录 URL（高级选项）",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("用法缺少 %q:\n%s", want, text)
		}
	}
}

// cleanSSLEnv 清掉可能从外部带进来的证书路径覆盖。
func cleanSSLEnv(t *testing.T) {
	t.Helper()
	t.Setenv("SSL_CERT_PATH", "")
	t.Setenv("SSL_KEY_PATH", "")
	t.Setenv("ZVIEWER_CERT_CHALLENGE_PORT", "")
}

func TestRunGenCertSelfSignedPaths(t *testing.T) {
	cases := []struct {
		name string
		host string
		args []string
	}{
		{name: "缺省 localhost", host: "", args: []string{"--gen-cert"}},
		{name: "localhost", host: "localhost", args: []string{"--gen-cert", "localhost"}},
		{name: "内网 IPv4", host: "192.168.1.10", args: []string{"--gen-cert", "192.168.1.10"}},
		{name: "单标签主机名", host: "zviewer", args: []string{"--gen-cert", "zviewer"}},
		// 域名默认走 ACME，加 --selfsigned 才自签
		{name: "域名强制自签", host: "example.com", args: []string{"--gen-cert", "example.com", "--selfsigned"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cleanSSLEnv(t)
			dir := t.TempDir()
			var out bytes.Buffer
			if err := RunGenCert(context.Background(), c.args, dir, &out); err != nil {
				t.Fatalf("执行失败: %v", err)
			}
			paths := Paths(dir)
			if _, err := os.Stat(paths.CertPath); err != nil {
				t.Fatalf("证书未生成: %v", err)
			}
			if _, err := os.Stat(paths.KeyPath); err != nil {
				t.Fatalf("私钥未生成: %v", err)
			}
			if !strings.Contains(out.String(), "证书已生成") {
				t.Errorf("缺少生成日志:\n%s", out.String())
			}
			if c.host != "" {
				hosts := strings.ToLower(strings.Join(ReadSANHosts(paths.CertPath), ","))
				if !strings.Contains(hosts, strings.ToLower(c.host)) {
					t.Errorf("SAN 未包含 %s: %s", c.host, hosts)
				}
			}
		})
	}
}

func TestRunGenCertSkipsExistingSelfSigned(t *testing.T) {
	cleanSSLEnv(t)
	dir := t.TempDir()

	if err := RunGenCert(context.Background(), []string{"--gen-cert"}, dir, &bytes.Buffer{}); err != nil {
		t.Fatalf("首次失败: %v", err)
	}
	var out bytes.Buffer
	if err := RunGenCert(context.Background(), []string{"--gen-cert"}, dir, &out); err != nil {
		t.Fatalf("二次失败: %v", err)
	}
	if !strings.Contains(out.String(), "证书已存在（已包含 localhost），如需重新生成请加 --force") {
		t.Errorf("二次运行应提示跳过:\n%s", out.String())
	}

	// --force 重签：证书内容会变（新密钥/新序列号）
	before, _ := os.ReadFile(Paths(dir).CertPath)
	if err := RunGenCert(context.Background(), []string{"--gen-cert", "--force"}, dir, &bytes.Buffer{}); err != nil {
		t.Fatalf("强制重签失败: %v", err)
	}
	after, _ := os.ReadFile(Paths(dir).CertPath)
	if string(before) == string(after) {
		t.Error("--force 应重新签发（证书内容不应完全相同）")
	}
}

func TestRunGenCertRejectsBadHost(t *testing.T) {
	cleanSSLEnv(t)
	err := RunGenCert(context.Background(), []string{"--gen-cert", "999.1.1.1"}, t.TempDir(), &bytes.Buffer{})
	if err == nil || err.Error() != "非法 IPv4 地址: 999.1.1.1" {
		t.Fatalf("错误 = %v", err)
	}
}

// TestRunGenCertIssuesViaACME 用假 ACME 跑 CLI 的完整 CA 路径：
// 默认目录被 --directory 覆盖，挑战端口从 ZVIEWER_CERT_CHALLENGE_PORT 读。
func TestRunGenCertIssuesViaACME(t *testing.T) {
	cleanSSLEnv(t)
	port := freePort(t)
	fake := newFakeACME(t, port)
	dir := t.TempDir()
	t.Setenv("ZVIEWER_CERT_CHALLENGE_PORT", strconv.Itoa(port))

	var out bytes.Buffer
	err := RunGenCert(context.Background(), []string{
		"--gen-cert", "example.com",
		"--directory", fake.url("/directory"),
		"--email", "ops@example.com",
	}, dir, &out)
	if err != nil {
		t.Fatalf("签发失败: %v\n%s", err, out.String())
	}

	paths := Paths(dir)
	cert, err := os.ReadFile(paths.CertPath)
	if err != nil {
		t.Fatalf("证书未落盘: %v", err)
	}
	if !strings.Contains(string(cert), "BEGIN CERTIFICATE") {
		t.Error("落盘的不是 PEM 证书")
	}
	key, err := os.ReadFile(paths.KeyPath)
	if err != nil {
		t.Fatalf("私钥未落盘: %v", err)
	}
	if !strings.Contains(string(key), "BEGIN PRIVATE KEY") {
		t.Error("域名私钥应为 PKCS#8")
	}
	// 账号密钥与证书同目录，续期时复用
	if _, err := os.Stat(filepath.Join(dir, "ssl", "acme-account.key")); err != nil {
		t.Errorf("账号密钥未落盘: %v", err)
	}

	text := out.String()
	for _, want := range []string{
		"通过 Let's Encrypt 申请可信 CA 证书（域名: example.com）",
		"提示: 需满足以下条件才能成功：",
		"可信证书已生成:",
		"证书有效期约 90 天，到期前请重新运行本命令续期",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("输出缺少 %q:\n%s", want, text)
		}
	}

	// 再跑一次：非自签证书且含该域名 → 跳过申请
	var second bytes.Buffer
	if err := RunGenCert(context.Background(), []string{
		"--gen-cert", "example.com", "--directory", fake.url("/directory"),
	}, dir, &second); err != nil {
		t.Fatalf("二次失败: %v", err)
	}
	if !strings.Contains(second.String(), "可信证书已存在（已包含 example.com），跳过申请") {
		t.Errorf("二次运行应跳过申请:\n%s", second.String())
	}
}

func TestRunGenCertSelfSignedReplacedByACME(t *testing.T) {
	cleanSSLEnv(t)
	dir := t.TempDir()

	// 先自签
	if err := RunGenCert(context.Background(), []string{"--gen-cert", "example.com", "--selfsigned"}, dir, &bytes.Buffer{}); err != nil {
		t.Fatalf("自签失败: %v", err)
	}
	if !IsSelfSigned(Paths(dir).CertPath) {
		t.Fatal("应生成自签证书")
	}

	// 再申请可信证书：提示「现有证书为自签证书」
	port := freePort(t)
	fake := newFakeACME(t, port)
	t.Setenv("ZVIEWER_CERT_CHALLENGE_PORT", strconv.Itoa(port))
	var out bytes.Buffer
	if err := RunGenCert(context.Background(), []string{
		"--gen-cert", "example.com", "--directory", fake.url("/directory"),
	}, dir, &out); err != nil {
		t.Fatalf("申请失败: %v", err)
	}
	if !strings.Contains(out.String(), "现有证书为自签证书，将重新申请 Let's Encrypt 可信证书...") {
		t.Errorf("缺少自签替换提示:\n%s", out.String())
	}
	if IsSelfSigned(Paths(dir).CertPath) {
		t.Error("应已被可信证书替换")
	}
}
