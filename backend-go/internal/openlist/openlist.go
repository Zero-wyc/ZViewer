// Package openlist 是 OpenList / AList 的客户端。
//
// 不走 WebDAV：AList 的 /api/fs/get 直接返回带签名的 raw_url，代理透传它
// 比走 /dav 少一次协议协商，也能拿到 related（同目录字幕）。
//
// 三层缓存各自解决一个具体问题：
//   - token（12h）：每次 /stream 都重新登录会把 AList 的登录接口打成热点；
//   - raw_url（5min）：raw_url 带签名且可能过期，但不能每个 Range 请求都
//     重新 fs/get —— 一次播放几十个 Range，等于几十次上游往返；
//   - 单飞：多人同时进房间会并发打同一个 movieId，去重后只发一次上游请求。
package openlist

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// 错误码，与 openlist-errors.ts 的 OpenListErrorCode 同名。
const (
	CodeAuthFailed  = "AUTH_FAILED"
	CodeUnreachable = "UNREACHABLE"
	CodeNotFound    = "NOT_FOUND"
	CodeTimeout     = "TIMEOUT"
	CodeInvalidURL  = "INVALID_URL"
)

// Error 是 AList 业务错误。
type Error struct {
	Message string
	Code    string
}

func (e *Error) Error() string { return e.Message }

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// CodeOf 提取错误码，非 *Error 一律视为 UNREACHABLE（与 extractOpenListErrorCode 一致）。
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return CodeUnreachable
}

// ---------------------------------------------------------------------------
// URL 规范化
// ---------------------------------------------------------------------------

const (
	defaultUA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	requestTimeout = 30 * time.Second
	tokenTTL       = 12 * time.Hour
	tokenMaxSize   = 200
	rawURLTTL      = 5 * time.Minute
	rawURLMaxSize  = 500
	// passwordSalt 与 alist 官方前端一致，服务端按 sha256(password+salt) 校验。
	passwordSalt = "-https://github.com/alist-org/alist"
)

var schemePrefix = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.\-]*://`)
var hashedPassword = regexp.MustCompile(`(?i)^[a-f0-9]{64}$`)

// NormalizeServerURL 复刻 normalizeOpenListServerUrl。
//
// 与「挂载表里存的地址」对齐是匹配成功的前提：用户新增影片时填的是
// `192.168.1.5:5244`，挂载表里存的是 `http://192.168.1.5:5244/dav`，
// 不补协议和 /dav 后缀就永远匹配不上，表现为「影片有密码却提示未授权」。
func NormalizeServerURL(serverURL string) string {
	normalized := strings.TrimSpace(serverURL)
	if normalized == "" {
		return normalized
	}
	if !schemePrefix.MatchString(normalized) {
		normalized = "http://" + normalized
	}
	for strings.HasSuffix(normalized, "/") {
		normalized = normalized[:len(normalized)-1]
	}
	u, err := url.Parse(normalized)
	if err != nil {
		return normalized
	}
	if u.Path == "" || u.Path == "/" {
		return u.Scheme + "://" + u.Host + "/dav"
	}
	return normalized
}

// ToAPIBaseURL 去掉尾部斜杠与 /dav 后缀，得到 /api 的前缀。
func ToAPIBaseURL(serverURL string) string {
	u := strings.TrimSpace(serverURL)
	for strings.HasSuffix(u, "/") {
		u = u[:len(u)-1]
	}
	return strings.TrimSuffix(u, "/dav")
}

// HashPassword 复刻 hashAlistPassword：sha256(明文 + salt) 的 hex。
func HashPassword(plain string) string {
	sum := sha256.Sum256([]byte(plain + passwordSalt))
	return hex.EncodeToString(sum[:])
}

// IsHashedPassword 判断是否是 AList 格式的哈希密码（64 位 hex）。
//
// 用来区分新旧数据：v2 重构后路由层会先哈希再入库，旧数据是明文。
// 哈希走 /api/auth/login/hash，明文走 /api/auth/login。
func IsHashedPassword(v string) bool { return hashedPassword.MatchString(v) }

// ---------------------------------------------------------------------------
// 数据类型
// ---------------------------------------------------------------------------

// Related 是 fs/get 返回的同目录条目（type==4 表示字幕）。
type Related struct {
	Name string `json:"name"`
	Type int    `json:"type"`
}

// FileInfo 是 fs/get 的归一化结果。
type FileInfo struct {
	RawURL   string
	Name     string
	Size     int64
	Provider string
	// Subtitles 是同目录字幕（已经解析成绝对 raw_url）。
	Subtitles []Subtitle
}

// Subtitle 是一条字幕。
type Subtitle struct {
	Name   string
	RawURL string
}

type fsGetData struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	IsDir    bool      `json:"is_dir"`
	Provider string    `json:"provider"`
	RawURL   string    `json:"raw_url"`
	Related  []Related `json:"related"`
}

// DirEntry 是 /api/fs/list 返回的单条目录项。
//
// 只保留真正用到的字段：AList 还下发 sign/thumb 等，那些是给 Web UI 渲染
// 图标用的，服务端不需要。Modified 是浏览界面的「修改时间」列（原样透传，
// AList 给的是 RFC3339 字符串，不做二次解析）。
type DirEntry struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	IsDir    bool   `json:"is_dir"`
	Type     int    `json:"type"`
	Modified string `json:"modified"`
}

// DirListing 是目录列举结果。
type DirListing struct {
	Entries  []DirEntry
	Total    int64
	Provider string
}

type fsListData struct {
	Content  []DirEntry `json:"content"`
	Total    int64      `json:"total"`
	Provider string     `json:"provider"`
}

type envelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type tokenEntry struct {
	token        string
	expire       time.Time
	passwordHash [sha256.Size]byte
}

type rawEntry struct {
	info   *FileInfo
	expire time.Time
}

// Client 持有 HTTP 客户端与所有缓存。
type Client struct {
	HTTP *http.Client

	mu       sync.Mutex
	tokens   map[string]tokenEntry
	raws     map[string]rawEntry
	inflight map[string]*rawCall
}

type rawCall struct {
	done chan struct{}
	info *FileInfo
	err  error
}

// NewClient 构造客户端。
func NewClient() *Client {
	return &Client{
		HTTP: &http.Client{
			Timeout: requestTimeout,
			// 不跟随重定向：raw_url 的跳转由代理层原样透传给播放器，
			// 在客户端这里跟随会丢掉 Range 语义。
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		tokens:   make(map[string]tokenEntry, 16),
		raws:     make(map[string]rawEntry, 32),
		inflight: make(map[string]*rawCall, 8),
	}
}

// InvalidateRawURL 失效某条 raw_url 缓存（上游 401/403/410 时调用）。
func (c *Client) InvalidateRawURL(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.raws, key)
}

// InvalidateToken 失效 token 缓存（登录凭证变化后调用）。
func (c *Client) InvalidateToken(serverURL, username string) {
	key := ToAPIBaseURL(NormalizeServerURL(serverURL)) + "|" + username
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.tokens, key)
}

// request 发起一次 AList API 请求并拆信封。
func (c *Client) request(ctx context.Context, baseURL, method, apiPath string, body any, token string) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, newError(CodeUnreachable, "AList 请求序列化失败: %v", err)
		}
		reader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, baseURL+apiPath, reader)
	if err != nil {
		return nil, newError(CodeInvalidURL, "AList 地址无效: %v", err)
	}
	req.Header.Set("User-Agent", defaultUA)
	// 把 Origin/Referer 设成 AList 自己的地址：部分反代开了防盗链，
	// 缺这两个头会直接 403，而错误信息看起来像「认证失败」。
	req.Header.Set("Origin", baseURL)
	req.Header.Set("Referer", baseURL+"/")
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.HTTP.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
			return nil, newError(CodeTimeout, "AList 请求超时")
		}
		return nil, newError(CodeUnreachable, "AList 网络错误: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		code := CodeUnreachable
		switch res.StatusCode {
		case http.StatusUnauthorized:
			code = CodeAuthFailed
		case http.StatusNotFound:
			code = CodeNotFound
		}
		return nil, newError(code, "AList HTTP %d", res.StatusCode)
	}

	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, newError(CodeUnreachable, "AList 响应读取失败: %v", err)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, newError(CodeUnreachable, "AList 响应解析失败: %v", err)
	}
	if env.Code != 200 {
		code := CodeUnreachable
		switch env.Code {
		case 401, 403:
			code = CodeAuthFailed
		case 500:
			code = CodeNotFound
		}
		msg := env.Message
		if msg == "" {
			msg = fmt.Sprintf("AList code=%d", env.Code)
		}
		// 前缀让用户能区分「AList 服务器返回的错误」与「ZViewer 自身的问题」；
		// AList 内部存储驱动（115 / 阿里云盘等）出错时返回的是 Go 风格文案，
		// 不加前缀会被误认为本项目的 bug。
		return nil, newError(code, "[AList 服务器] %s", msg)
	}
	return env.Data, nil
}

// Login 登录并返回 token。
func (c *Client) Login(ctx context.Context, baseURL, username, password string) (string, error) {
	apiPath := "/api/auth/login"
	if IsHashedPassword(password) {
		apiPath = "/api/auth/login/hash"
	}
	data, err := c.request(ctx, baseURL, http.MethodPost, apiPath, map[string]string{
		"username": username,
		"password": password,
	}, "")
	if err != nil {
		return "", err
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.Token == "" {
		return "", newError(CodeAuthFailed, "AList 未返回 token")
	}
	return out.Token, nil
}

// token 取 token（带缓存）。username 为空表示匿名，直接返回空串。
func (c *Client) token(ctx context.Context, serverURL, username, password string) (string, error) {
	if username == "" {
		return "", nil
	}
	baseURL := ToAPIBaseURL(NormalizeServerURL(serverURL))
	key := baseURL + "|" + username
	passwordHash := sha256.Sum256([]byte(password))

	c.mu.Lock()
	if e, ok := c.tokens[key]; ok && time.Now().Before(e.expire) && e.passwordHash == passwordHash {
		c.mu.Unlock()
		return e.token, nil
	}
	c.mu.Unlock()

	tok, err := c.Login(ctx, baseURL, username, password)
	if err != nil {
		return "", err
	}

	c.mu.Lock()
	if len(c.tokens) >= tokenMaxSize {
		for k, v := range c.tokens {
			if time.Now().After(v.expire) {
				delete(c.tokens, k)
			}
		}
	}
	c.tokens[key] = tokenEntry{token: tok, expire: time.Now().Add(tokenTTL), passwordHash: passwordHash}
	c.mu.Unlock()
	return tok, nil
}

// fsGet 调用 /api/fs/get（带 401 重试一次）。
func (c *Client) fsGet(ctx context.Context, serverURL, username, password, path string) (*fsGetData, error) {
	baseURL := ToAPIBaseURL(NormalizeServerURL(serverURL))
	body := map[string]any{"path": path, "password": "", "page": 1, "per_page": 0, "refresh": false}

	tok, err := c.token(ctx, serverURL, username, password)
	if err != nil {
		return nil, err
	}
	raw, err := c.request(ctx, baseURL, http.MethodPost, "/api/fs/get", body, tok)
	if err != nil {
		// token 过期：失效缓存重登一次。不重试的话，长时间运行的进程会在
		// token 到期后连续 12 小时（缓存 TTL）全部播放失败。
		if CodeOf(err) == CodeAuthFailed && tok != "" {
			c.InvalidateToken(serverURL, username)
			tok, err2 := c.token(ctx, serverURL, username, password)
			if err2 != nil {
				return nil, err2
			}
			raw, err = c.request(ctx, baseURL, http.MethodPost, "/api/fs/get", body, tok)
		}
		if err != nil {
			return nil, err
		}
	}

	var data fsGetData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, newError(CodeUnreachable, "AList fs/get 解析失败: %v", err)
	}
	return &data, nil
}

// fsList 调用 /api/fs/list（带 401 重试一次）。
//
// 与 fsGet 的重试逻辑一致：token 过期时必须重登一次，否则进程长时间运行后
// 会在 token 到期（约 12 小时）之后持续列举失败。
func (c *Client) fsList(ctx context.Context, serverURL, username, password, path string, page, perPage int) (*fsListData, error) {
	baseURL := ToAPIBaseURL(NormalizeServerURL(serverURL))
	if page <= 0 {
		page = 1
	}
	if perPage <= 0 {
		perPage = 100
	}
	body := map[string]any{
		"path":     path,
		"password": "",
		"page":     page,
		"per_page": perPage,
		"refresh":  false,
	}

	tok, err := c.token(ctx, serverURL, username, password)
	if err != nil {
		return nil, err
	}
	raw, err := c.request(ctx, baseURL, http.MethodPost, "/api/fs/list", body, tok)
	if err != nil {
		if CodeOf(err) == CodeAuthFailed && tok != "" {
			c.InvalidateToken(serverURL, username)
			tok, err2 := c.token(ctx, serverURL, username, password)
			if err2 != nil {
				return nil, err2
			}
			raw, err = c.request(ctx, baseURL, http.MethodPost, "/api/fs/list", body, tok)
		}
		if err != nil {
			return nil, err
		}
	}

	var data fsListData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, newError(CodeUnreachable, "AList fs/list 解析失败: %v", err)
	}
	return &data, nil
}

// ListDir 列出目录内容（挂载浏览与字幕搜索共用）。
//
// 路径处理与 Node 的 listOpenListDirectory 逐字对齐：先 decodeURIComponent
// （失败就保留原值），再补前导斜杠。少了 decode 这一步，带空格或中文的
// 目录名会被当成已编码字符串再编码一次，AList 回「文件不存在」。
func (c *Client) ListDir(ctx context.Context, serverURL, username, password, path string) (*DirListing, error) {
	return c.ListDirPaged(ctx, serverURL, username, password, path, 1, 100)
}

// ListDirPaged 是带分页的目录列举（浏览界面翻页用）。
func (c *Client) ListDirPaged(ctx context.Context, serverURL, username, password, path string, page, perPage int) (*DirListing, error) {
	targetPath := path
	if decoded, err := url.PathUnescape(path); err == nil {
		targetPath = decoded
	}
	if !strings.HasPrefix(targetPath, "/") {
		targetPath = "/" + targetPath
	}

	data, err := c.fsList(ctx, serverURL, username, password, targetPath, page, perPage)
	if err != nil {
		// 不在这里翻译错误：Node 的 listOpenListDirectory 也是原样往上抛，
		// 由路由层决定文案。只有 FetchFileInfo 才做「认证失败/文件不存在」的
		// 友好改写（那是用户直接看到的播放失败原因）。
		return nil, err
	}

	entries := make([]DirEntry, 0, len(data.Content))
	entries = append(entries, data.Content...)
	return &DirListing{Entries: entries, Total: data.Total, Provider: data.Provider}, nil
}

// FetchFileInfo 取文件直链与字幕（含 401 重试、相对 raw_url 补全）。
func (c *Client) FetchFileInfo(ctx context.Context, serverURL, username, password, path string) (*FileInfo, error) {
	baseURL := ToAPIBaseURL(NormalizeServerURL(serverURL))

	targetPath := path
	if decoded, err := url.PathUnescape(path); err == nil {
		targetPath = decoded
	}
	if !strings.HasPrefix(targetPath, "/") {
		targetPath = "/" + targetPath
	}

	data, err := c.fsGet(ctx, serverURL, username, password, targetPath)
	if err != nil {
		// 转成用户能看懂的文案：原始 "AList HTTP 401" 对用户没有任何指导意义。
		switch CodeOf(err) {
		case CodeAuthFailed:
			return nil, newError(CodeAuthFailed, "OpenList 认证失败，请检查挂载的用户名和密码")
		case CodeNotFound:
			return nil, newError(CodeNotFound, "文件不存在或路径错误: %s", targetPath)
		}
		return nil, err
	}

	rawURL := data.RawURL
	// AList 未配置 site_url 时会返回相对路径，必须补全成绝对地址，
	// 否则代理层拿到 "/d/xxx?sign=..." 会当成非法 URL。
	if rawURL != "" && !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		if strings.HasPrefix(rawURL, "/") {
			rawURL = baseURL + rawURL
		} else {
			rawURL = baseURL + "/" + rawURL
		}
	}
	if rawURL == "" {
		return nil, newError(CodeUnreachable, "OpenList 未返回 raw_url")
	}

	info := &FileInfo{
		RawURL:   rawURL,
		Name:     data.Name,
		Size:     data.Size,
		Provider: data.Provider,
	}

	// 同目录字幕：type==4 且不是 XML（XML 通常是弹幕元数据，不是文本字幕）。
	// 并行取，串行会让 N 个字幕变成 N 次往返，直接拖慢 resolve。
	if len(data.Related) > 0 {
		prefix := targetPath
		if idx := strings.LastIndex(prefix, "/"); idx >= 0 {
			prefix = prefix[:idx+1]
		}
		var (
			mu  sync.Mutex
			wg  sync.WaitGroup
			out []Subtitle
		)
		for _, rel := range data.Related {
			if rel.Type != 4 || strings.HasSuffix(strings.ToLower(rel.Name), ".xml") {
				continue
			}
			wg.Add(1)
			go func(name string) {
				defer wg.Done()
				sub, err := c.fsGet(ctx, serverURL, username, password, prefix+name)
				if err != nil || sub.RawURL == "" {
					return
				}
				subURL := sub.RawURL
				if !strings.HasPrefix(subURL, "http://") && !strings.HasPrefix(subURL, "https://") {
					if strings.HasPrefix(subURL, "/") {
						subURL = baseURL + subURL
					} else {
						subURL = baseURL + "/" + subURL
					}
				}
				mu.Lock()
				out = append(out, Subtitle{Name: name, RawURL: subURL})
				mu.Unlock()
			}(rel.Name)
		}
		wg.Wait()
		info.Subtitles = out
	}

	return info, nil
}

// CachedFileInfo 带 5 分钟缓存 + 单飞去重。
//
// 单飞不是优化而是必需：一次播放会产生几十个 Range 请求，多人同时进房
// 更会并发打同一个 key；没有去重的话上游会瞬间收到几十个 fs/get。
func (c *Client) CachedFileInfo(ctx context.Context, cacheKey, serverURL, username, password, path string) (*FileInfo, error) {
	c.mu.Lock()
	if e, ok := c.raws[cacheKey]; ok && time.Now().Before(e.expire) {
		c.mu.Unlock()
		return e.info, nil
	}
	if call, ok := c.inflight[cacheKey]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.info, call.err
		case <-ctx.Done():
			return nil, newError(CodeTimeout, "等待 OpenList 直链超时")
		}
	}
	call := &rawCall{done: make(chan struct{})}
	c.inflight[cacheKey] = call
	c.mu.Unlock()

	info, err := c.FetchFileInfo(ctx, serverURL, username, password, path)
	call.info, call.err = info, err

	c.mu.Lock()
	if err == nil {
		if len(c.raws) >= rawURLMaxSize {
			for k, v := range c.raws {
				if time.Now().After(v.expire) {
					delete(c.raws, k)
				}
			}
		}
		c.raws[cacheKey] = rawEntry{info: info, expire: time.Now().Add(rawURLTTL)}
	}
	delete(c.inflight, cacheKey)
	c.mu.Unlock()
	close(call.done)
	return info, err
}

// ---------------------------------------------------------------------------
// 搜索 / 账号信息 / 连通性（挂载管理页用）
// ---------------------------------------------------------------------------

// SearchEntry 是 /api/fs/search 的一条命中。
//
// 字段名刻意用 camelCase：Node 的搜索路由把 AList 的 snake_case 结果重组成
// `{name,size,isDir,type,modified,sign,thumb}` 再下发，前端按这套键读。
type SearchEntry struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	IsDir    bool   `json:"isDir"`
	Type     int    `json:"type"`
	Modified string `json:"modified"`
	Sign     string `json:"sign"`
	Thumb    string `json:"thumb"`
}

// SearchResult 是搜索结果。
type SearchResult struct {
	Entries []SearchEntry
	Total   int64
}

type fsSearchData struct {
	Content []struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
		IsDir  bool   `json:"is_dir"`
		Size   int64  `json:"size"`
		Type   int    `json:"type"`
	} `json:"content"`
	Total int64 `json:"total"`
}

// SearchFiles 按关键词搜索（带 401 重试一次）。
func (c *Client) SearchFiles(ctx context.Context, serverURL, username, password, parent, keywords string) (*SearchResult, error) {
	baseURL := ToAPIBaseURL(NormalizeServerURL(serverURL))
	body := map[string]any{
		"parent":   parent,
		"keywords": keywords,
		"password": "",
		"scope":    0,
		"page":     1,
		"per_page": 100,
	}

	run := func(tok string) (json.RawMessage, error) {
		return c.request(ctx, baseURL, http.MethodPost, "/api/fs/search", body, tok)
	}
	tok, err := c.token(ctx, serverURL, username, password)
	if err != nil {
		return nil, err
	}
	raw, err := run(tok)
	if err != nil {
		if CodeOf(err) == CodeAuthFailed && tok != "" {
			c.InvalidateToken(serverURL, username)
			if tok, err = c.token(ctx, serverURL, username, password); err != nil {
				return nil, err
			}
			raw, err = run(tok)
		}
		if err != nil {
			return nil, err
		}
	}

	var data fsSearchData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, newError(CodeUnreachable, "AList fs/search 解析失败: %v", err)
	}
	entries := make([]SearchEntry, 0, len(data.Content))
	for _, e := range data.Content {
		entries = append(entries, SearchEntry{
			Name:  e.Name,
			Size:  e.Size,
			IsDir: e.IsDir,
			Type:  e.Type,
		})
	}
	return &SearchResult{Entries: entries, Total: data.Total}, nil
}

// Me 取当前账号信息（用户中心展示）。
//
// 匿名挂载（没填用户名）时 Node 直接返回 null，这里同样返回 nil, nil：
// 前端据此隐藏「账号信息」区块，而不是报一个「未登录」的错误。
func (c *Client) Me(ctx context.Context, serverURL, username, password string) (json.RawMessage, error) {
	tok, err := c.token(ctx, serverURL, username, password)
	if err != nil {
		return nil, err
	}
	if tok == "" {
		return nil, nil
	}
	baseURL := ToAPIBaseURL(NormalizeServerURL(serverURL))
	raw, err := c.request(ctx, baseURL, http.MethodGet, "/api/me", nil, tok)
	if err != nil {
		if CodeOf(err) == CodeAuthFailed {
			c.InvalidateToken(serverURL, username)
		}
		return nil, err
	}
	return raw, nil
}

// TestConnection 验证地址/凭证/路径三者可用（挂载新增与编辑时调用）。
//
// 只列举 1 条：目的不是拿数据，是确认「登录拿得到 token」且「path 有权限」。
// 只测根目录时 path 填错也能"测试通过"，浏览/播放才发现问题。
func (c *Client) TestConnection(ctx context.Context, serverURL, username, password, path string) error {
	targetPath := path
	if targetPath == "" {
		targetPath = "/"
	}
	_, err := c.ListDirPaged(ctx, serverURL, username, password, targetPath, 1, 1)
	return err
}

func isTimeout(err error) bool {
	type timeout interface{ Timeout() bool }
	var t timeout
	if errors.As(err, &t) {
		return t.Timeout()
	}
	return false
}
