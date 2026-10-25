package ssl

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// ===========================================================================
// RFC 7638 指纹黄金值
// ===========================================================================

// TestJWKThumbprintRFC7638 用 RFC 7638 §3.1 的示例公钥验证指纹算法。
//
// 这条向量同时锁住三件事：键顺序必须是 e→kty→n、n 不带前导零、
// 哈希后必须去掉 base64 填充。
func TestJWKThumbprintRFC7638(t *testing.T) {
	const nB64 = "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw"
	nBytes, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		t.Fatalf("n 解码失败: %v", err)
	}
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: 65537}

	got, err := jwkThumbprint(pub)
	if err != nil {
		t.Fatalf("计算指纹失败: %v", err)
	}
	const want = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
	if got != want {
		t.Fatalf("thumbprint = %q, want %q", got, want)
	}
}

// ===========================================================================
// 假 ACME 服务器
// ===========================================================================

// fakeACME 复刻 RFC 8555 里流程用到的部分：nonce 一次性、JWS 验签、
// 授权/挑战/订单/finalize/证书下载，并把「CA 会做什么」也做掉——
// 收到 challenge 通知后真的去挑战端口取 keyAuthorization。
type fakeACME struct {
	t             *testing.T
	srv           *httptest.Server
	challengePort int

	mu       sync.Mutex
	account  *rsa.PublicKey
	nonces   map[string]bool
	seq      int
	order    string // pending → ready → valid / invalid
	gotCSR   *x509.CertificateRequest
	emptyGET map[string]bool // 记录了哪些资源收到的是 POST-as-GET（空 payload）
	leafPEM  []byte
}

func newFakeACME(t *testing.T, challengePort int) *fakeACME {
	t.Helper()
	// 生成一张「CA 签发」的叶子证书作为下载内容。
	// 必须让 issuer != subject：CLI 判断「已有证书是不是自签」来决定要不要重签，
	// 用自签的假证书会让「二次运行应跳过申请」那条断言失真。
	caKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成测试 CA 密钥失败: %v", err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("生成测试 CA 证书失败: %v", err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatalf("解析测试 CA 证书失败: %v", err)
	}

	leafKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成测试密钥失败: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		DNSNames:     []string{"example.com"},
		IPAddresses:  []net.IP{net.ParseIP("203.0.113.10")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(90 * 24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("生成测试证书失败: %v", err)
	}

	f := &fakeACME{
		t:             t,
		challengePort: challengePort,
		nonces:        make(map[string]bool),
		emptyGET:      make(map[string]bool),
		order:         "pending",
		leafPEM:       pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/directory", f.handleDirectory)
	mux.HandleFunc("/nonce", f.handleNonce)
	mux.HandleFunc("/account", f.handleAccount)
	mux.HandleFunc("/order", f.handleNewOrder)
	mux.HandleFunc("/authz/1", f.handleAuthz)
	mux.HandleFunc("/challenge/1", f.handleChallenge)
	mux.HandleFunc("/order/1", f.handlePollOrder)
	mux.HandleFunc("/finalize/1", f.handleFinalize)
	mux.HandleFunc("/cert/1", f.handleCert)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeACME) url(path string) string { return f.srv.URL + path }

func (f *fakeACME) issueNonce(w http.ResponseWriter) {
	f.mu.Lock()
	f.seq++
	nonce := fmt.Sprintf("nonce-%d", f.seq)
	f.nonces[nonce] = true
	f.mu.Unlock()
	w.Header().Set("Replay-Nonce", nonce)
}

func (f *fakeACME) writeJSON(w http.ResponseWriter, status int, payload any) {
	body, _ := json.Marshal(payload)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// verifyJWS 校验签名并把 payload 原文返回（空串 = POST-as-GET）。
func (f *fakeACME) verifyJWS(w http.ResponseWriter, r *http.Request, path string) (map[string]any, string, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "读 body 失败"})
		return nil, "", false
	}
	var envelope struct {
		Protected string `json:"protected"`
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "不是 JWS"})
		return nil, "", false
	}

	protectedRaw, err := base64.RawURLEncoding.DecodeString(envelope.Protected)
	if err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "protected 不是 base64url"})
		return nil, "", false
	}
	var protected map[string]any
	if err := json.Unmarshal(protectedRaw, &protected); err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "protected 不是 JSON"})
		return nil, "", false
	}

	// nonce 一次性
	nonce, _ := protected["nonce"].(string)
	f.mu.Lock()
	valid := f.nonces[nonce]
	delete(f.nonces, nonce)
	f.mu.Unlock()
	if !valid {
		f.writeJSON(w, 400, map[string]string{"type": "urn:ietf:params:acme:error:badNonce", "detail": "nonce 无效"})
		return nil, "", false
	}

	// 公钥：注册前用 jwk 头里的，注册后用账号公钥
	pub := f.account
	if jwk, ok := protected["jwk"].(map[string]any); ok {
		nStr, _ := jwk["n"].(string)
		eStr, _ := jwk["e"].(string)
		if jwk["kty"] != "RSA" || nStr == "" || eStr == "" {
			f.writeJSON(w, 400, map[string]string{"detail": "jwk 不完整"})
			return nil, "", false
		}
		nBytes, _ := base64.RawURLEncoding.DecodeString(nStr)
		eBytes, _ := base64.RawURLEncoding.DecodeString(eStr)
		pub = &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: int(new(big.Int).SetBytes(eBytes).Int64())}
		f.mu.Lock()
		f.account = pub
		f.mu.Unlock()
	}
	if pub == nil {
		f.writeJSON(w, 400, map[string]string{"detail": "未注册的账号"})
		return nil, "", false
	}

	if alg, _ := protected["alg"].(string); alg != "RS256" {
		f.writeJSON(w, 400, map[string]string{"detail": "alg 必须是 RS256"})
		return nil, "", false
	}
	if u, _ := protected["url"].(string); !strings.HasSuffix(u, path) {
		f.writeJSON(w, 400, map[string]string{"detail": "protected.url 与请求路径不一致"})
		return nil, "", false
	}

	sig, err := base64.RawURLEncoding.DecodeString(envelope.Signature)
	if err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "签名不是 base64url"})
		return nil, "", false
	}
	digest := sha256.Sum256([]byte(envelope.Protected + "." + envelope.Payload))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig); err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "签名校验失败"})
		return nil, "", false
	}

	if envelope.Payload == "" {
		f.mu.Lock()
		f.emptyGET[path] = true
		f.mu.Unlock()
		return protected, "", true
	}

	payloadRaw, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "payload 不是 base64url"})
		return nil, "", false
	}
	return protected, string(payloadRaw), true
}

func (f *fakeACME) handleDirectory(w http.ResponseWriter, r *http.Request) {
	f.issueNonce(w)
	f.writeJSON(w, 200, map[string]string{
		"newNonce":   f.url("/nonce"),
		"newAccount": f.url("/account"),
		"newOrder":   f.url("/order"),
	})
}

func (f *fakeACME) handleNonce(w http.ResponseWriter, r *http.Request) {
	f.issueNonce(w)
	w.WriteHeader(http.StatusOK)
}

func (f *fakeACME) handleAccount(w http.ResponseWriter, r *http.Request) {
	protected, payload, ok := f.verifyJWS(w, r, "/account")
	if !ok {
		return
	}
	if kid, has := protected["kid"]; has && kid != "" {
		f.t.Errorf("首次注册不应带 kid: %v", kid)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(payload), &body); err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "payload 不是 JSON"})
		return
	}
	if body["termsOfServiceAgreed"] != true {
		f.writeJSON(w, 400, map[string]string{"detail": "缺少 termsOfServiceAgreed"})
		return
	}
	f.issueNonce(w)
	w.Header().Set("Location", f.url("/acct/1"))
	f.writeJSON(w, 201, map[string]any{"status": "valid"})
}

func (f *fakeACME) handleNewOrder(w http.ResponseWriter, r *http.Request) {
	protected, payload, ok := f.verifyJWS(w, r, "/order")
	if !ok {
		return
	}
	if kid, _ := protected["kid"].(string); kid != f.url("/acct/1") {
		f.writeJSON(w, 400, map[string]string{"detail": "kid 不对: " + kid})
		return
	}
	var body struct {
		Identifiers []struct {
			Type  string `json:"type"`
			Value string `json:"value"`
		} `json:"identifiers"`
		Profile string `json:"profile"`
	}
	if err := json.Unmarshal([]byte(payload), &body); err != nil || len(body.Identifiers) != 1 {
		f.writeJSON(w, 400, map[string]string{"detail": "identifiers 不对"})
		return
	}
	if body.Identifiers[0].Value != "example.com" && body.Identifiers[0].Value != "203.0.113.10" {
		f.writeJSON(w, 400, map[string]string{"detail": "意外的 identifier"})
		return
	}
	if body.Identifiers[0].Type == "ip" && body.Profile != "shortlived" {
		// IP 证书必须带 shortlived profile（Let's Encrypt 的硬要求）
		f.writeJSON(w, 400, map[string]string{"detail": "IP 订单缺少 shortlived profile"})
		return
	}

	f.issueNonce(w)
	w.Header().Set("Location", f.url("/order/1"))
	f.writeJSON(w, 201, map[string]any{
		"status":         "pending",
		"authorizations": []string{f.url("/authz/1")},
		"finalize":       f.url("/finalize/1"),
	})
}

func (f *fakeACME) handleAuthz(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := f.verifyJWS(w, r, "/authz/1"); !ok {
		return
	}
	f.issueNonce(w)
	f.writeJSON(w, 200, map[string]any{
		"status": "pending",
		"challenges": []map[string]string{
			{"type": "dns-01", "url": f.url("/dns-challenge"), "token": "ignored"},
			{"type": "http-01", "url": f.url("/challenge/1"), "token": "tok-1"},
		},
	})
}

// handleChallenge 模拟 CA 的验证动作：真的去挑战端口取 keyAuthorization。
func (f *fakeACME) handleChallenge(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := f.verifyJWS(w, r, "/challenge/1"); !ok {
		return
	}

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/.well-known/acme-challenge/tok-1", f.challengePort))
	if err != nil {
		f.t.Errorf("CA 无法访问挑战地址: %v", err)
		f.writeJSON(w, 400, map[string]string{"detail": "挑战不可达"})
		return
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)

	f.mu.Lock()
	thumb := ""
	if f.account != nil {
		thumb, _ = jwkThumbprint(f.account)
	}
	order := f.order
	f.mu.Unlock()

	if want := "tok-1." + thumb; string(got) != want {
		f.t.Errorf("keyAuthorization = %q, want %q", string(got), want)
		f.mu.Lock()
		f.order = "invalid"
		f.mu.Unlock()
	} else if order == "pending" {
		f.mu.Lock()
		f.order = "ready"
		f.mu.Unlock()
	}

	f.issueNonce(w)
	f.writeJSON(w, 200, map[string]any{"status": "processing"})
}

func (f *fakeACME) handlePollOrder(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := f.verifyJWS(w, r, "/order/1"); !ok {
		return
	}
	f.mu.Lock()
	status := f.order
	f.mu.Unlock()

	body := map[string]any{"status": status, "finalize": f.url("/finalize/1")}
	if status == "valid" {
		body["certificate"] = f.url("/cert/1")
	}
	f.issueNonce(w)
	f.writeJSON(w, 200, body)
}

func (f *fakeACME) handleFinalize(w http.ResponseWriter, r *http.Request) {
	_, payload, ok := f.verifyJWS(w, r, "/finalize/1")
	if !ok {
		return
	}
	var body struct {
		CSR string `json:"csr"`
	}
	if err := json.Unmarshal([]byte(payload), &body); err != nil || body.CSR == "" {
		f.writeJSON(w, 400, map[string]string{"detail": "csr 缺失"})
		return
	}
	der, err := base64.RawURLEncoding.DecodeString(body.CSR)
	if err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "csr 不是 base64url"})
		return
	}
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "csr 无法解析"})
		return
	}
	if err := csr.CheckSignature(); err != nil {
		f.writeJSON(w, 400, map[string]string{"detail": "csr 签名无效"})
		return
	}
	f.mu.Lock()
	f.gotCSR = csr
	f.order = "valid"
	f.mu.Unlock()

	f.issueNonce(w)
	f.writeJSON(w, 200, map[string]any{"status": "valid", "certificate": f.url("/cert/1")})
}

func (f *fakeACME) handleCert(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := f.verifyJWS(w, r, "/cert/1"); !ok {
		return
	}
	f.issueNonce(w)
	w.Header().Set("Content-Type", "application/pem-certificate-chain")
	_, _ = w.Write(f.leafPEM)
}

// ===========================================================================
// 完整签发流程
// ===========================================================================

// TestRequestCertificateDNS 跑通整条链路：目录 → nonce → 注册 → 下单 →
// HTTP-01（真的被 CA 取到）→ 轮询到 ready → finalize（CSR 可解析）→ 下载证书。
func TestRequestCertificateDNS(t *testing.T) {
	port := freePort(t)
	fake := newFakeACME(t, port)
	dir := t.TempDir()

	var logs []string
	cert, err := RequestCertificate(context.Background(), ACMEOptions{
		Domain:         "example.com",
		DirectoryURL:   fake.url("/directory"),
		AccountKeyFile: dir + "/acme-account.key",
		Email:          "ops@example.com",
		ChallengePort:  port,
		Log:            func(line string) { logs = append(logs, line) },
	})
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}

	if !strings.Contains(cert.FullchainPEM, "BEGIN CERTIFICATE") {
		t.Errorf("证书链不是 PEM: %q", cert.FullchainPEM[:40])
	}
	if !strings.Contains(cert.KeyPEM, "BEGIN PRIVATE KEY") {
		t.Errorf("域名私钥应为 PKCS#8: %q", cert.KeyPEM[:40])
	}

	// CSR 必须带 SAN（CN 单独存在不够，现代 CA 只认 SAN）
	fake.mu.Lock()
	csr := fake.gotCSR
	fake.mu.Unlock()
	if csr == nil {
		t.Fatal("finalize 未收到 CSR")
	}
	if csr.Subject.CommonName != "example.com" {
		t.Errorf("CSR CN = %q", csr.Subject.CommonName)
	}
	if len(csr.DNSNames) != 1 || csr.DNSNames[0] != "example.com" {
		t.Errorf("CSR SAN = %v", csr.DNSNames)
	}

	// 所有 POST-as-GET 都必须是空 payload（写成 {} 会被 Boulder 当成停用请求）
	for _, path := range []string{"/authz/1", "/order/1", "/cert/1"} {
		if !fake.emptyGET[path] {
			t.Errorf("%s 没有收到空 payload 的 POST-as-GET", path)
		}
	}

	// 账号密钥落盘（下次续期复用同一个账号，避免触发 CA 的账号数量限制）
	if _, err := os.ReadFile(dir + "/acme-account.key"); err != nil {
		t.Errorf("账号密钥未落盘: %v", err)
	}

	joined := strings.Join(logs, "\n")
	for _, want := range []string{
		"获取 ACME 目录...",
		"注册 ACME 账号...",
		"为 example.com（域名）创建订单...",
		"响应验证: http://example.com/.well-known/acme-challenge/tok-1",
		"等待 CA 验证域名所有权...",
		"提交 CSR（finalize）...",
		"下载证书链...",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("日志缺少 %q:\n%s", want, joined)
		}
	}
}

// TestRequestCertificateIPCariesShortlivedProfile IP 证书必须带 profile。
func TestRequestCertificateIPCarriesShortlivedProfile(t *testing.T) {
	port := freePort(t)
	fake := newFakeACME(t, port)

	_, err := RequestCertificate(context.Background(), ACMEOptions{
		Domain:         "203.0.113.10",
		DirectoryURL:   fake.url("/directory"),
		AccountKeyFile: t.TempDir() + "/acme-account.key",
		ChallengePort:  port,
	})
	if err != nil {
		t.Fatalf("IP 证书签发失败: %v", err)
	}
	fake.mu.Lock()
	csr := fake.gotCSR
	fake.mu.Unlock()
	if csr == nil || len(csr.IPAddresses) != 1 || csr.IPAddresses[0].String() != "203.0.113.10" {
		t.Fatalf("CSR 的 IP SAN 不对: %+v", csr)
	}
}

// TestRequestCertificateValidationFailure 挑战响应不对时，订单会转 invalid，
// 客户端要给出「所有权验证失败」而不是干等 120 秒。
func TestRequestCertificateValidationFailure(t *testing.T) {
	port := freePort(t)
	fake := newFakeACME(t, port)
	// 先把 order 改成非 pending，让 handleChallenge 不把它推成 ready
	fake.mu.Lock()
	fake.order = "invalid"
	fake.mu.Unlock()

	_, err := RequestCertificate(context.Background(), ACMEOptions{
		Domain:         "example.com",
		DirectoryURL:   fake.url("/directory"),
		AccountKeyFile: t.TempDir() + "/acme-account.key",
		ChallengePort:  port,
	})
	if err == nil {
		t.Fatal("验证失败时应报错")
	}
	if !strings.Contains(err.Error(), "所有权验证失败") {
		t.Errorf("错误文案 = %q", err.Error())
	}
}

// TestRequestCertificateDirectoryError 目录不可用时给出明确文案。
func TestRequestCertificateDirectoryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"no such directory"}`))
	}))
	defer srv.Close()

	_, err := RequestCertificate(context.Background(), ACMEOptions{
		Domain:         "example.com",
		DirectoryURL:   srv.URL + "/directory",
		AccountKeyFile: t.TempDir() + "/acme-account.key",
		ChallengePort:  freePort(t),
	})
	if err == nil || !strings.Contains(err.Error(), "ACME 请求失败: 404") {
		t.Fatalf("错误 = %v", err)
	}
}

// ===========================================================================
// 挑战服务器
// ===========================================================================

func TestChallengeServerServesOnlyKnownTokens(t *testing.T) {
	port := freePort(t)
	cs, err := startChallengeServer(port)
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	defer cs.close()

	cs.set("tok-abc", "tok-abc.thumb")

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/.well-known/acme-challenge/tok-abc", port))
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "tok-abc.thumb" {
		t.Errorf("已知 token 应 200 + 值，得到 %d %q", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type = %q", ct)
	}

	// 未知 token / 其它路径都 404（别把 challenge 目录变成任意文件服务）
	for _, path := range []string{
		"/.well-known/acme-challenge/unknown",
		"/etc/passwd",
		"/.well-known/acme-challenge/tok-abc/extra",
	} {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, path))
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		_, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("%s 应 404，得到 %d", path, resp.StatusCode)
		}
	}
}

// ===========================================================================
// 小工具
// ===========================================================================

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("取空闲端口失败: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}
