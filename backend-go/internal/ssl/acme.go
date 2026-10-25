package ssl

import (
	"bytes"
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
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// ACME v2（RFC 8555）HTTP-01 客户端，逐条复刻 services/ssl/acme-client.ts。
//
// 为什么手写而不是用 x/crypto/acme：
//  1. Node 侧的流程里有 Let's Encrypt 的 IP 证书（`identifier.type = "ip"` +
//     `profile: "shortlived"`），通用库对这个扩展的支持取决于版本；
//  2. 错误文案与轮询节奏（3s / 120s / 60s）是用户可见行为，库会自己决定；
//  3. 手写之后可以用假 ACME 服务器把整条链路（JWS 签名 / nonce 流转 /
//     POST-as-GET 空载荷 / CSR / 证书下载）跑成单测——真连 CA 没法自动测。
const (
	acmeUserAgent      = "zviewer-backend-cert/1.0"
	acmeRequestTimeout = 30 * time.Second
	orderPollInterval  = 3 * time.Second
	orderTimeout       = 120 * time.Second
	finalizeTimeout    = 60 * time.Second

	// DirectoryLetsEncrypt 是正式环境目录；DirectoryStaging 无速率限制。
	DirectoryLetsEncrypt = "https://acme-v02.api.letsencrypt.org/directory"
	DirectoryStaging     = "https://acme-staging-v02.api.letsencrypt.org/directory"
)

// ACMEOptions 是一次签发请求的参数（与 TS 的 AcmeRequestOptions 同名同义）。
type ACMEOptions struct {
	// Domain 是需要证书的域名或 IP。
	Domain string
	// DirectoryURL 是 ACME 目录地址。
	DirectoryURL string
	// AccountKeyFile 是账号私钥文件（不存在则生成 RSA 2048 并写盘）。
	AccountKeyFile string
	// Email 是可选的账号邮箱。
	Email string
	// ChallengePort 是 HTTP-01 验证端口（默认 80，必须公网可达）。
	ChallengePort int
	// IdentifierType 为空时自动检测（net.ParseIP 成功即 ip）。
	IdentifierType HostKind
	// Log 是进度输出。
	Log func(string)
}

// Certificate 是签发结果（完整链 + 域名私钥）。
type Certificate struct {
	FullchainPEM string
	KeyPEM       string
}

// acmeDirectory 只取流程用到的三个字段。
type acmeDirectory struct {
	NewNonce   string `json:"newNonce"`
	NewAccount string `json:"newAccount"`
	NewOrder   string `json:"newOrder"`
}

// acmeJSON 是各类 ACME 响应的宽松载体（字段随资源类型不同）。
type acmeJSON struct {
	Status         string   `json:"status"`
	Finalize       string   `json:"finalize"`
	Certificate    string   `json:"certificate"`
	Authorizations []string `json:"authorizations"`
	Challenges     []struct {
		Type  string `json:"type"`
		URL   string `json:"url"`
		Token string `json:"token"`
	} `json:"challenges"`
	Detail string `json:"detail"`
}

type acmeResponse struct {
	status  int
	headers http.Header
	body    string
	json    *acmeJSON
}

// acmeCtx 承载一次签发过程中的可变状态。
type acmeCtx struct {
	client     *http.Client
	key        *rsa.PrivateKey
	kid        string
	nonce      string
	log        func(string)
	domain     string
	idType     HostKind
	identifier string // 日志里的「域名」/「IP 地址」
}

// RequestCertificate 通过 ACME HTTP-01 申请域名或 IP 证书。
func RequestCertificate(ctx context.Context, opts ACMEOptions) (*Certificate, error) {
	if opts.ChallengePort <= 0 {
		opts.ChallengePort = 80
	}
	logf := opts.Log
	if logf == nil {
		logf = func(string) {}
	}

	key, _, err := loadOrCreateAccountKey(opts.AccountKeyFile)
	if err != nil {
		return nil, err
	}

	ctxObj := &acmeCtx{
		client: &http.Client{Timeout: acmeRequestTimeout},
		key:    key,
		log:    logf,
		domain: opts.Domain,
	}
	ctxObj.idType = opts.IdentifierType
	if ctxObj.idType == HostNone {
		if net.ParseIP(opts.Domain) != nil {
			ctxObj.idType = HostIP
		} else {
			ctxObj.idType = HostDNS
		}
	}
	ctxObj.identifier = "域名"
	if ctxObj.idType == HostIP {
		ctxObj.identifier = "IP 地址"
	}

	// 1. 目录
	logf("  获取 ACME 目录...")
	dirRes, err := doACME(ctx, ctxObj, http.MethodGet, opts.DirectoryURL, "", nil)
	if err != nil {
		return nil, err
	}
	var directory acmeDirectory
	if dirRes.body == "" || json.Unmarshal([]byte(dirRes.body), &directory) != nil ||
		directory.NewNonce == "" || directory.NewAccount == "" || directory.NewOrder == "" {
		return nil, fmt.Errorf("ACME 目录响应异常: %s", opts.DirectoryURL)
	}

	// 2. nonce
	nonceRes, err := doACME(ctx, ctxObj, http.MethodHead, directory.NewNonce, "", nil)
	if err != nil {
		return nil, err
	}
	ctxObj.nonce = nonceRes.headers.Get("Replay-Nonce")
	if ctxObj.nonce == "" {
		return nil, fmt.Errorf("ACME 服务器未返回 nonce")
	}

	// 3. 注册账号（幂等：同样的 key 只会有一个账号）
	logf("  注册 ACME 账号...")
	accountPayload := map[string]any{"termsOfServiceAgreed": true}
	if opts.Email != "" {
		accountPayload["contact"] = []string{"mailto:" + opts.Email}
	}
	signed, err := signJWS(ctxObj, directory.NewAccount, accountPayload, "")
	if err != nil {
		return nil, err
	}
	accRes, err := doACME(ctx, ctxObj, http.MethodPost, directory.NewAccount, signed, nil)
	if err != nil {
		return nil, err
	}
	ctxObj.nonce = accRes.headers.Get("Replay-Nonce")
	if ctxObj.nonce == "" {
		// 部分服务器不在 newAccount 响应里给 nonce，显式再取一次
		n2, err := doACME(ctx, ctxObj, http.MethodHead, directory.NewNonce, "", nil)
		if err != nil {
			return nil, err
		}
		ctxObj.nonce = n2.headers.Get("Replay-Nonce")
	}
	ctxObj.kid = accRes.headers.Get("Location")
	if ctxObj.kid == "" {
		return nil, fmt.Errorf("ACME 账号注册失败（无 location）")
	}
	if ctxObj.nonce == "" {
		return nil, fmt.Errorf("ACME 服务器未返回 nonce")
	}

	// 4. 创建订单
	logf(fmt.Sprintf("  为 %s（%s）创建订单...", opts.Domain, ctxObj.identifier))
	orderPayload := map[string]any{
		"identifiers": []map[string]string{{"type": string(ctxObj.idType), "value": opts.Domain}},
	}
	if ctxObj.idType == HostIP {
		// Let's Encrypt 的公网 IP 证书要求 shortlived profile（160 小时），
		// 不带会被直接拒单。
		orderPayload["profile"] = "shortlived"
	}
	orderSigned, err := signJWS(ctxObj, directory.NewOrder, orderPayload, ctxObj.kid)
	if err != nil {
		return nil, err
	}
	orderRes, err := doACME(ctx, ctxObj, http.MethodPost, directory.NewOrder, orderSigned, nil)
	if err != nil {
		return nil, err
	}
	ctxObj.nonce = headerOr(orderRes.headers.Get("Replay-Nonce"), ctxObj.nonce)
	orderURL := orderRes.headers.Get("Location")
	if orderURL == "" {
		return nil, fmt.Errorf("ACME 订单创建失败（无 location）")
	}
	order := orderRes.json
	if order == nil {
		order = &acmeJSON{}
	}
	finalizeURL := order.Finalize
	certificateURL := order.Certificate

	// 5. 处理授权（HTTP-01）
	logf("  启动 HTTP-01 验证服务器...")
	challengeSrv, err := startChallengeServer(opts.ChallengePort)
	if err != nil {
		return nil, err
	}
	defer challengeSrv.close()

	thumbprint, err := jwkThumbprint(&key.PublicKey)
	if err != nil {
		return nil, err
	}

	for _, authzURL := range order.Authorizations {
		authzSigned, err := signJWS(ctxObj, authzURL, "", ctxObj.kid)
		if err != nil {
			return nil, err
		}
		authzRes, err := doACME(ctx, ctxObj, http.MethodPost, authzURL, authzSigned, nil)
		if err != nil {
			return nil, err
		}
		ctxObj.nonce = headerOr(authzRes.headers.Get("Replay-Nonce"), ctxObj.nonce)
		authz := authzRes.json
		if authz == nil {
			authz = &acmeJSON{}
		}

		var challengeType, challengeURL, challengeToken string
		for _, c := range authz.Challenges {
			if c.Type == "http-01" {
				challengeType, challengeURL, challengeToken = c.Type, c.URL, c.Token
				break
			}
		}
		if challengeType == "" {
			return nil, fmt.Errorf("%s %s 的授权不支持 http-01 验证", ctxObj.identifier, opts.Domain)
		}
		if authz.Status == "valid" {
			// 授权被复用（同一账号近期验证过），无需再响应挑战
			continue
		}

		challengeSrv.set(challengeToken, challengeToken+"."+thumbprint)
		logf(fmt.Sprintf("  响应验证: http://%s/.well-known/acme-challenge/%s", opts.Domain, challengeToken))

		chalSigned, err := signJWS(ctxObj, challengeURL, "", ctxObj.kid)
		if err != nil {
			return nil, err
		}
		chalRes, err := doACME(ctx, ctxObj, http.MethodPost, challengeURL, chalSigned, nil)
		if err != nil {
			return nil, err
		}
		ctxObj.nonce = headerOr(chalRes.headers.Get("Replay-Nonce"), ctxObj.nonce)
	}

	// 6. 轮询订单直到 ready / valid / invalid
	logf(fmt.Sprintf("  等待 CA 验证%s所有权...", ctxObj.identifier))
	status := order.Status
	deadline := time.Now().Add(orderTimeout)
	for status == "pending" || status == "processing" {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("验证超时（120 秒）。请检查：%s是否指向本机且公网可达、防火墙/安全组是否放行 80 端口", ctxObj.identifier)
		}
		if err := sleepCtx(ctx, orderPollInterval); err != nil {
			return nil, err
		}
		pollSigned, err := signJWS(ctxObj, orderURL, "", ctxObj.kid)
		if err != nil {
			return nil, err
		}
		pollRes, err := doACME(ctx, ctxObj, http.MethodPost, orderURL, pollSigned, nil)
		if err != nil {
			return nil, err
		}
		ctxObj.nonce = headerOr(pollRes.headers.Get("Replay-Nonce"), ctxObj.nonce)
		ord := pollRes.json
		if ord == nil {
			ord = &acmeJSON{}
		}
		status = ord.Status
		if ord.Finalize != "" {
			finalizeURL = ord.Finalize
		}
		if ord.Certificate != "" {
			certificateURL = ord.Certificate
		}
		logf(fmt.Sprintf("  订单状态: %s", status))
		if status == "ready" {
			break
		}
	}

	if status == "invalid" {
		return nil, fmt.Errorf("%s所有权验证失败。请检查%s解析与 80 端口可达性", ctxObj.identifier, ctxObj.identifier)
	}
	if status != "valid" && status != "ready" {
		return nil, fmt.Errorf("ACME 订单异常状态: %s", status)
	}
	if finalizeURL == "" {
		return nil, fmt.Errorf("ACME 订单缺少 finalize URL")
	}

	// 7. 生成域名密钥 + CSR，finalize
	logf(fmt.Sprintf("  生成%s密钥与 CSR...", ctxObj.identifier))
	domainKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("生成域名密钥失败: %w", err)
	}
	csrDER, err := buildCSR(opts.Domain, ctxObj.idType, domainKey)
	if err != nil {
		return nil, err
	}
	domainKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: mustPKCS8(domainKey),
	})

	logf("  提交 CSR（finalize）...")
	finSigned, err := signJWS(ctxObj, finalizeURL, map[string]string{
		"csr": base64.RawURLEncoding.EncodeToString(csrDER),
	}, ctxObj.kid)
	if err != nil {
		return nil, err
	}
	finRes, err := doACME(ctx, ctxObj, http.MethodPost, finalizeURL, finSigned, nil)
	if err != nil {
		return nil, err
	}
	ctxObj.nonce = headerOr(finRes.headers.Get("Replay-Nonce"), ctxObj.nonce)

	// 8. 轮询直到证书可用
	status = ""
	if finRes.json != nil {
		status = finRes.json.Status
		if finRes.json.Certificate != "" {
			certificateURL = finRes.json.Certificate
		}
	}
	finDeadline := time.Now().Add(finalizeTimeout)
	for status == "processing" {
		if time.Now().After(finDeadline) {
			return nil, fmt.Errorf("finalize 处理超时")
		}
		if err := sleepCtx(ctx, orderPollInterval); err != nil {
			return nil, err
		}
		pollSigned, err := signJWS(ctxObj, orderURL, "", ctxObj.kid)
		if err != nil {
			return nil, err
		}
		pollRes, err := doACME(ctx, ctxObj, http.MethodPost, orderURL, pollSigned, nil)
		if err != nil {
			return nil, err
		}
		ctxObj.nonce = headerOr(pollRes.headers.Get("Replay-Nonce"), ctxObj.nonce)
		if pollRes.json != nil {
			status = pollRes.json.Status
			if pollRes.json.Certificate != "" {
				certificateURL = pollRes.json.Certificate
			}
		}
	}
	if status != "valid" || certificateURL == "" {
		return nil, fmt.Errorf("ACME finalize 失败: %s", status)
	}

	// 9. 下载证书链（body 就是 PEM fullchain，不做 JSON 解析）
	logf("  下载证书链...")
	certSigned, err := signJWS(ctxObj, certificateURL, "", ctxObj.kid)
	if err != nil {
		return nil, err
	}
	certRes, err := doACME(ctx, ctxObj, http.MethodPost, certificateURL, certSigned, nil)
	if err != nil {
		return nil, err
	}

	return &Certificate{
		FullchainPEM: certRes.body,
		KeyPEM:       string(domainKeyPEM),
	}, nil
}

// ==================== 账号密钥 ====================

// loadOrCreateAccountKey 读取或生成账号私钥（PKCS#8，与 Node 的
// `privateKey.export({type:'pkcs8'})` 同形态）。
func loadOrCreateAccountKey(path string) (*rsa.PrivateKey, string, error) {
	if raw, err := os.ReadFile(path); err == nil {
		key, err := parseRSAPrivateKey(raw)
		if err != nil {
			return nil, "", fmt.Errorf("读取 ACME 账号密钥失败: %w", err)
		}
		return key, string(raw), nil
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, "", fmt.Errorf("生成 ACME 账号密钥失败: %w", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: mustPKCS8(key)})
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, "", fmt.Errorf("创建账号密钥目录失败: %w", err)
	}
	// 账号私钥只给当前用户读写
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return nil, "", fmt.Errorf("写入 ACME 账号密钥失败: %w", err)
	}
	return key, string(pemBytes), nil
}

func parseRSAPrivateKey(raw []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("私钥不是 PEM 格式")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			return rsaKey, nil
		}
		return nil, fmt.Errorf("私钥不是 RSA")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	return nil, fmt.Errorf("无法解析私钥")
}

func mustPKCS8(key *rsa.PrivateKey) []byte {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		// RSA 私钥的 PKCS#8 编码不会失败；真失败了也没有可用的降级路径
		panic(fmt.Sprintf("PKCS#8 编码失败: %v", err))
	}
	return der
}

// ==================== JWS ====================

// signJWS 生成 ACME 的扁平 JWS（RFC 8555 §6.2）。
//
// payload 为 nil 时编成空串——POST-as-GET 必须是 zero-length octet string，
// 写成 `{}` 会被 Boulder 当成「停用授权」而报错。
func signJWS(c *acmeCtx, url string, payload any, kid string) (string, error) {
	header := map[string]any{"alg": "RS256", "nonce": c.nonce, "url": url}
	if kid != "" {
		header["kid"] = kid
	} else {
		n, e, err := jwkParts(&c.key.PublicKey)
		if err != nil {
			return "", err
		}
		header["jwk"] = map[string]string{"kty": "RSA", "n": n, "e": e}
	}
	protectedBytes, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	protected := base64.RawURLEncoding.EncodeToString(protectedBytes)

	payloadB64 := ""
	if payload != nil && payload != "" {
		raw, err := json.Marshal(payload)
		if err != nil {
			return "", err
		}
		payloadB64 = base64.RawURLEncoding.EncodeToString(raw)
	}

	signingInput := protected + "." + payloadB64
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, c.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("JWS 签名失败: %w", err)
	}

	encoded, err := json.Marshal(map[string]string{
		"protected": protected,
		"payload":   payloadB64,
		"signature": base64.RawURLEncoding.EncodeToString(signature),
	})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// jwkParts 取 RSA 公钥的 n / e（base64url、无前导零）。
func jwkParts(pub *rsa.PublicKey) (string, string, error) {
	n := base64.RawURLEncoding.EncodeToString(pub.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())
	return n, e, nil
}

// jwkThumbprint 计算 RFC 7638 指纹（用作 keyAuthorization 的后半段）。
//
// 键顺序必须是 e → kty → n（字典序），这是规范要求、也是 Node 的写法；
// 换顺序算出来的 thumbprint 会让 CA 的验证请求 404。
func jwkThumbprint(pub *rsa.PublicKey) (string, error) {
	n, e, err := jwkParts(pub)
	if err != nil {
		return "", err
	}
	canonical := `{"e":"` + e + `","kty":"RSA","n":"` + n + `"}`
	sum := sha256.Sum256([]byte(canonical))
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// ==================== HTTP ====================

// doACME 发一次 ACME 请求；非 2xx 统一转成带 detail 的错误。
func doACME(ctx context.Context, c *acmeCtx, method, url, body string, extra map[string]string) (*acmeResponse, error) {
	var reader io.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", acmeUserAgent)
	req.Header.Set("Content-Type", "application/jose+json")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	for k, v := range extra {
		req.Header.Set(k, v)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	out := &acmeResponse{status: resp.StatusCode, headers: resp.Header, body: string(raw)}
	if len(raw) > 0 {
		var parsed acmeJSON
		if json.Unmarshal(raw, &parsed) == nil {
			out.json = &parsed
		}
	}
	if resp.StatusCode >= 400 {
		detail := ""
		if out.json != nil && out.json.Detail != "" {
			detail = " (" + out.json.Detail + ")"
		}
		return nil, fmt.Errorf("ACME 请求失败: %d %s%s", resp.StatusCode, url, detail)
	}
	return out, nil
}

func headerOr(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// ==================== CSR ====================

// buildCSR 生成 PKCS#10 请求：CN=identifier + SAN（DNS 或 IP）。
func buildCSR(identifier string, kind HostKind, key *rsa.PrivateKey) ([]byte, error) {
	template := &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: identifier},
	}
	if kind == HostIP {
		ip := net.ParseIP(identifier)
		if ip == nil {
			return nil, fmt.Errorf("非法 IP 地址: %s", identifier)
		}
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{identifier}
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, template, key)
	if err != nil {
		return nil, fmt.Errorf("生成 CSR 失败: %w", err)
	}
	return der, nil
}

// ==================== HTTP-01 挑战服务器 ====================

var challengePathPattern = regexp.MustCompile(`^/\.well-known/acme-challenge/([A-Za-z0-9_-]+)$`)

type challengeServer struct {
	srv  *http.Server
	mu   sync.Mutex
	data map[string]string
}

// startChallengeServer 在 0.0.0.0:<port> 上响应 HTTP-01 验证请求。
//
// 端口默认 80：CA 只会访问 80 端口，别的端口过不了验证。
func startChallengeServer(port int) (*challengeServer, error) {
	cs := &challengeServer{data: make(map[string]string)}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		match := challengePathPattern.FindStringSubmatch(r.URL.Path)
		if match != nil {
			cs.mu.Lock()
			value, ok := cs.data[match[1]]
			cs.mu.Unlock()
			if ok {
				w.Header().Set("Content-Type", "application/octet-stream")
				_, _ = io.WriteString(w, value)
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "Not Found")
	})

	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, fmt.Errorf("启动 HTTP-01 验证服务器失败（端口 %d）: %w", port, err)
	}
	cs.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		_ = cs.srv.Serve(ln)
	}()
	return cs, nil
}

func (c *challengeServer) set(token, keyAuthorization string) {
	c.mu.Lock()
	c.data[token] = keyAuthorization
	c.mu.Unlock()
}

func (c *challengeServer) close() {
	if c.srv != nil {
		_ = c.srv.Close()
	}
}

// lookup 给单测读某个 token 的响应值。
func (c *challengeServer) lookup(token string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := c.data[token]
	return value, ok
}
