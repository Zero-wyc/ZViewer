package crawler

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// 人机验证会话 + 同源反代。
//
// 站点用验证码/滑块/登录墙回应搜索时，引擎建一个短生命周期会话：记住规则、
// 关键词，以及用户在验证页里解出来的 Cookie。页面由本进程回源后重写再吐给
// 浏览器，所以浏览器从不直连站点（没有混合内容/CSP 问题），Cookie 也只留在
// 服务端。Cookie 在浏览器侧全部改名为 zc_<session>_<name>，跨会话不会串。

const (
	// challengeProxyPrefix 与前端约定的反代前缀。
	challengeProxyPrefix = "/api/crawler/challenge"
	challengeMaxBody     = 8 << 20
	challengeDefaultTTL  = 30 * time.Minute
)

var (
	rewriteAttrRe   = regexp.MustCompile(`(?is)(\b(?:src|href|action|poster|data-src|data-url|data-original)\s*=\s*)(?:"([^"]*)"|'([^']*)')`)
	rewriteSrcsetRe = regexp.MustCompile(`(?is)(\bsrcset\s*=\s*)(?:"([^"]*)"|'([^']*)')`)
	rewriteCSSURLRe = regexp.MustCompile(`(?i)url\(\s*(["']?)([^"')]+)["']?\s*\)`)
	metaCSPRe       = regexp.MustCompile(`(?is)<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>`)
	baseTagRe       = regexp.MustCompile(`(?is)<base\b[^>]*>`)
	charsetRe       = regexp.MustCompile(`(?i)charset=([\w.-]+)`)
)

// ChallengeSession 是一次待处理的人工验证。
type ChallengeSession struct {
	ID        string
	RuleID    string
	Site      string
	Name      string
	Keyword   string
	RoomID    string
	Role      string
	PageURL   string
	Origin    string
	Status    int
	Reason    string
	Note      string
	Cookies   map[string]string
	CreatedAt int64
	UpdatedAt int64
	ExpiresAt int64
	Completed bool
}

// ChallengeStore 是内存里的验证会话表（一两百条，进程重启即失效）。
type ChallengeStore struct {
	ttl      time.Duration
	maxItems int

	mu       sync.Mutex
	sessions map[string]*ChallengeSession
	// cookieMu 保护 session.Cookies：反代请求可能并发，验证页会同时发多个子请求。
	cookieMu sync.Mutex

	// client 必须直连且不压缩：验证页要精确控制 Cookie 与 Host，
	// 也不能让 transport 偷偷改请求头（Python 版同样用裸 http.client）。
	client *http.Client
}

// NewChallengeStore 构造会话表。ttl<=0 用 30 分钟，maxItems<=0 用 200。
func NewChallengeStore(ttl time.Duration, maxItems int) *ChallengeStore {
	if ttl <= 0 {
		ttl = challengeDefaultTTL
	}
	if maxItems <= 0 {
		maxItems = 200
	}
	return &ChallengeStore{
		ttl:      ttl,
		maxItems: maxItems,
		sessions: map[string]*ChallengeSession{},
		client: &http.Client{
			Transport: &http.Transport{
				Proxy:              nil,
				DisableCompression: true,
				DialContext:        (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
			},
			Timeout: 30 * time.Second,
			// 重定向由 Fetch 自己跟，才能逐跳改写 Cookie 与 Host。
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// Create 建会话。
func (s *ChallengeStore) Create(rule *Rule, keyword, roomID, role string, page *Page, challenge map[string]any) (*ChallengeSession, error) {
	if rule == nil {
		return nil, RuleError("验证会话缺少规则", nil)
	}
	pageURL := ""
	if page != nil {
		pageURL = page.PageURL
	}
	if pageURL == "" {
		pageURL = rule.Search.Request.URL
	}
	now := time.Now().Unix()
	status := 0
	if page != nil {
		status = page.Status
	}
	session := &ChallengeSession{
		ID:        randomToken(12),
		RuleID:    rule.ID,
		Site:      rule.Site,
		Name:      firstNonEmpty(rule.Name, rule.Site),
		Keyword:   keyword,
		RoomID:    roomID,
		Role:      firstNonEmpty(role, "guest"),
		PageURL:   pageURL,
		Origin:    originOf(pageURL),
		Status:    status,
		Reason:    stringOr(challenge["reason"]),
		Note:      stringOr(challenge["note"]),
		Cookies:   map[string]string{},
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now + int64(s.ttl.Seconds()),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	s.sessions[session.ID] = session
	for len(s.sessions) > s.maxItems {
		oldest := s.oldestLocked()
		if oldest == "" {
			break
		}
		delete(s.sessions, oldest)
	}
	return session, nil
}

// Get 取会话，过期或不存在时报错。
func (s *ChallengeStore) Get(sessionID string) (*ChallengeSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(time.Now().Unix())
	session, ok := s.sessions[sessionID]
	if !ok {
		return nil, newError("challenge_not_found", "验证会话不存在或已过期，请重新搜索", nil)
	}
	session.UpdatedAt = time.Now().Unix()
	return session, nil
}

// List 给 GUI 的待处理列表（不含 Cookie 值）。
func (s *ChallengeStore) List(includeCompleted bool) []map[string]any {
	now := time.Now().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	items := make([]map[string]any, 0, len(s.sessions))
	for _, session := range s.sessions {
		if session.Completed && !includeCompleted {
			continue
		}
		items = append(items, map[string]any{
			"id":        session.ID,
			"site":      session.Site,
			"name":      session.Name,
			"keyword":   session.Keyword,
			"roomId":    session.RoomID,
			"pageUrl":   session.PageURL,
			"proxyUrl":  s.ProxyBase(session),
			"reason":    session.Reason,
			"note":      session.Note,
			"status":    session.Status,
			"createdAt": session.CreatedAt,
			"expiresAt": session.ExpiresAt,
			"completed": session.Completed,
			"cookies":   s.CookieCount(session),
		})
	}
	// 新的在前。
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j]["createdAt"].(int64) > items[j-1]["createdAt"].(int64); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
	return items
}

// Delete 删会话。
func (s *ChallengeStore) Delete(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[sessionID]; !ok {
		return false
	}
	delete(s.sessions, sessionID)
	return true
}

// MarkCompleted 标记验证是否完成。
func (s *ChallengeStore) MarkCompleted(sessionID string, completed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session, ok := s.sessions[sessionID]; ok {
		session.Completed = completed
		session.UpdatedAt = time.Now().Unix()
	}
}

// Clear 清空。
func (s *ChallengeStore) Clear() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := len(s.sessions)
	s.sessions = map[string]*ChallengeSession{}
	return count
}

// CookieCount 返回会话已收集的 Cookie 数量。
func (s *ChallengeStore) CookieCount(session *ChallengeSession) int {
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	return len(session.Cookies)
}

func (s *ChallengeStore) pruneLocked(now int64) {
	for id, session := range s.sessions {
		if session.ExpiresAt <= now {
			delete(s.sessions, id)
		}
	}
}

func (s *ChallengeStore) oldestLocked() string {
	oldest := ""
	var oldestAt int64
	for id, session := range s.sessions {
		if oldest == "" || session.CreatedAt < oldestAt {
			oldest, oldestAt = id, session.CreatedAt
		}
	}
	return oldest
}

// ProxyBase 返回该会话在反代下的根路径。
func (s *ChallengeStore) ProxyBase(session *ChallengeSession) string {
	return challengeProxyPrefix + "/" + session.ID + "/site"
}

func originOf(target string) string {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func sameOrigin(target, origin string) bool {
	if origin == "" {
		return false
	}
	return strings.HasPrefix(strings.ToLower(target), strings.ToLower(strings.TrimRight(origin, "/"))+"/")
}

// ToProxy 把同源地址改写成反代地址；非同源的原样返回（浏览器直连）。
func (s *ChallengeStore) ToProxy(session *ChallengeSession, rawURL, baseURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return rawURL
	}
	lowered := strings.ToLower(trimmed)
	for _, prefix := range []string{"#", "data:", "blob:", "javascript:", "mailto:", "tel:"} {
		if strings.HasPrefix(lowered, prefix) {
			return rawURL
		}
	}
	absolute := joinURL(baseURL, trimmed)
	if !sameOrigin(absolute, session.Origin) {
		return rawURL
	}
	return s.ProxyBase(session) + absolute[len(session.Origin):]
}

// RewriteHTML 去掉 CSP/base，改写同源资源地址，并注入 fetch/XHR 钩子。
func (s *ChallengeStore) RewriteHTML(session *ChallengeSession, htmlText string) string {
	pageURL := session.PageURL
	out := metaCSPRe.ReplaceAllString(htmlText, "")
	out = baseTagRe.ReplaceAllString(out, "")

	out = rewriteAttrRe.ReplaceAllStringFunc(out, func(match string) string {
		parts := rewriteAttrRe.FindStringSubmatch(match)
		quote := `"`
		value := parts[2]
		if parts[3] != "" || (parts[2] == "" && strings.Contains(match, "'")) {
			quote = "'"
			value = parts[3]
		}
		return parts[1] + quote + s.ToProxy(session, value, pageURL) + quote
	})

	out = rewriteSrcsetRe.ReplaceAllStringFunc(out, func(match string) string {
		parts := rewriteSrcsetRe.FindStringSubmatch(match)
		quote := `"`
		value := parts[2]
		if parts[3] != "" {
			quote = "'"
			value = parts[3]
		}
		candidates := make([]string, 0, 4)
		for _, item := range strings.Split(value, ",") {
			bits := strings.Fields(strings.TrimSpace(item))
			if len(bits) == 0 {
				continue
			}
			bits[0] = s.ToProxy(session, bits[0], pageURL)
			candidates = append(candidates, strings.Join(bits, " "))
		}
		return parts[1] + quote + strings.Join(candidates, ", ") + quote
	})

	out = rewriteCSSURLRe.ReplaceAllStringFunc(out, func(match string) string {
		parts := rewriteCSSURLRe.FindStringSubmatch(match)
		return "url(" + parts[1] + s.ToProxy(session, parts[2], pageURL) + parts[1] + ")"
	})

	shim := challengeShim(s.ProxyBase(session), session.Origin)
	lowered := strings.ToLower(out)
	if index := strings.Index(lowered, "<head"); index >= 0 {
		if end := strings.Index(lowered[index:], ">"); end >= 0 {
			cut := index + end + 1
			return out[:cut] + shim + out[cut:]
		}
	}
	return shim + out
}

// RewriteCSS 只改写 url(...) 里的同源资源。
func (s *ChallengeStore) RewriteCSS(session *ChallengeSession, cssText, cssURL string) string {
	return rewriteCSSURLRe.ReplaceAllStringFunc(cssText, func(match string) string {
		parts := rewriteCSSURLRe.FindStringSubmatch(match)
		return "url(" + parts[1] + s.ToProxy(session, parts[2], cssURL) + parts[1] + ")"
	})
}

// challengeShim 在页面里把同源请求改写到反代，避免跨域与 CSP。
func challengeShim(prefix, origin string) string {
	return `<script>(function(){
var PREFIX=` + jsString(prefix) + `, ORIGIN=` + jsString(origin) + `;
function abs(u){try{return new URL(u, document.baseURI).href}catch(e){return u}}
function map(u){
  if(typeof u!=="string")return u;
  if(/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(u))return u;
  var a=abs(u);
  if(a.indexOf(ORIGIN)===0)return PREFIX+a.slice(ORIGIN.length);
  return u;
}
window.__crawlerProxyMap=map;
try{var of=window.fetch;if(of){window.fetch=function(input,init){
  if(typeof input==="string")input=map(input);
  else if(input&&input.url){try{input=new Request(map(input.url),input)}catch(e){}}
  return of.call(this,input,init);
};}}catch(e){}
try{var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=map(u);return xo.apply(this,arguments)};}catch(e){}
try{var ow=window.open;window.open=function(u){return ow.call(this,map(u))};}catch(e){}
})();</script>`
}

func jsString(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", `"`, `\"`, "\n", "", "\r", "")
	return `"` + replacer.Replace(value) + `"`
}

func (s *ChallengeStore) cookieName(sessionID, name string) string {
	return "zc_" + sessionID + "_" + name
}

// cookieHeader 把会话里的原始 Cookie 拼回请求头。
func (s *ChallengeStore) cookieHeader(session *ChallengeSession) string {
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	if len(session.Cookies) == 0 {
		return ""
	}
	parts := make([]string, 0, len(session.Cookies))
	for name, value := range session.Cookies {
		parts = append(parts, name+"="+value)
	}
	return strings.Join(parts, "; ")
}

// AbsorbBrowserCookies 从浏览器请求的 Cookie 里取回本会话的 Cookie（带前缀）。
func (s *ChallengeStore) AbsorbBrowserCookies(session *ChallengeSession, header string) {
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	prefix := "zc_" + session.ID + "_"
	for _, part := range strings.Split(header, ";") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		name := strings.TrimSpace(part[:index])
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		session.Cookies[name[len(prefix):]] = strings.TrimSpace(part[index+1:])
	}
}

// AbsorbResponseCookies 收下站点 Set-Cookie，并返回改写后的浏览器侧 Cookie。
func (s *ChallengeStore) AbsorbResponseCookies(session *ChallengeSession, values []string) []string {
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	rewritten := make([]string, 0, len(values))
	for _, value := range values {
		first := value
		if index := strings.Index(value, ";"); index >= 0 {
			first = value[:index]
		}
		index := strings.Index(first, "=")
		if index <= 0 {
			continue
		}
		name := strings.TrimSpace(first[:index])
		if name == "" {
			continue
		}
		cookieValue := strings.TrimSpace(first[index+1:])
		session.Cookies[name] = cookieValue
		rewritten = append(rewritten, fmt.Sprintf("%s=%s; Path=%s/%s/; HttpOnly; SameSite=Lax",
			s.cookieName(session.ID, name), cookieValue, challengeProxyPrefix, session.ID))
	}
	return rewritten
}

// ChallengeResponse 是一次回源结果。
type ChallengeResponse struct {
	Status  int
	Headers http.Header
	Body    []byte
}

// Fetch 用会话的 Cookie 回源，手动跟重定向（最多 maxRedirects 跳）。
func (s *ChallengeStore) Fetch(session *ChallengeSession, target, method string, headers map[string]string, body []byte, maxRedirects int) (*ChallengeResponse, error) {
	if maxRedirects <= 0 {
		maxRedirects = 5
	}
	current := target
	currentBody := body
	currentMethod := strings.ToUpper(firstNonEmpty(method, "GET"))
	extraHeaders := make(map[string]string, len(headers))
	for key, value := range headers {
		if value != "" {
			extraHeaders[key] = value
		}
	}

	for redirects := 0; ; {
		if originOf(current) != session.Origin {
			return nil, newError("challenge_origin_mismatch", "验证代理只允许访问发起搜索的站点", nil)
		}
		response, err := s.doRequest(session, current, currentMethod, extraHeaders, currentBody)
		if err != nil {
			return nil, err
		}
		setCookies := response.Headers.Values("Set-Cookie")
		if len(setCookies) > 0 {
			s.AbsorbResponseCookies(session, setCookies)
		}
		location := response.Headers.Get("Location")
		if isRedirect(response.Status) && location != "" && redirects < maxRedirects {
			next := joinURL(current, location)
			if originOf(next) != session.Origin {
				return response, nil
			}
			if response.Status == 301 || response.Status == 302 || response.Status == 303 {
				currentMethod = "GET"
				currentBody = nil
				delete(extraHeaders, "Content-Type")
			}
			current = next
			redirects++
			continue
		}
		return response, nil
	}
}

func isRedirect(status int) bool {
	switch status {
	case 301, 302, 303, 307, 308:
		return true
	}
	return false
}

func (s *ChallengeStore) doRequest(session *ChallengeSession, target, method string, headers map[string]string, body []byte) (*ChallengeResponse, error) {
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, newError("challenge_bad_url", "验证代理只支持 http/https", nil)
	}
	var reader io.Reader
	if len(body) > 0 {
		reader = strings.NewReader(string(body))
	}
	request, err := http.NewRequest(method, target, reader)
	if err != nil {
		return nil, newError("challenge_bad_url", "验证页面地址无效: "+err.Error(), nil)
	}
	request.Header.Set("User-Agent", firstNonEmpty(headers["User-Agent"],
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36"))
	request.Header.Set("Accept", firstNonEmpty(headers["Accept"], "*/*"))
	request.Header.Set("Accept-Language", firstNonEmpty(headers["Accept-Language"], "zh-CN,zh;q=0.9,en;q=0.6"))
	request.Header.Set("Accept-Encoding", "identity")
	for _, name := range []string{"Content-Type", "X-Requested-With", "Range", "Referer", "Origin"} {
		if value := headers[name]; value != "" {
			request.Header.Set(name, value)
		}
	}
	if cookie := s.cookieHeader(session); cookie != "" {
		request.Header.Set("Cookie", cookie)
	}

	response, err := s.client.Do(request)
	if err != nil {
		return nil, newError("challenge_fetch_failed", "验证页面请求失败: "+err.Error(), nil)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, challengeMaxBody+1))
	if err != nil {
		return nil, newError("challenge_fetch_failed", "验证页面读取失败: "+err.Error(), nil)
	}
	if len(raw) > challengeMaxBody {
		return nil, newError("challenge_too_large", "验证页面响应过大", nil)
	}
	return &ChallengeResponse{Status: response.StatusCode, Headers: response.Header, Body: raw}, nil
}

// randomToken 生成 n 字节的十六进制 id（与 Python 的 token_hex(12) 同形）。
func randomToken(n int) string {
	buffer := make([]byte, n)
	if _, err := rand.Read(buffer); err != nil {
		// 极端的熵源失败：退化成时间戳，宁可重复也不 panic。
		return fmt.Sprintf("%024x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

// CharsetOf 从 Content-Type 里取 charset，缺省 utf-8。
func CharsetOf(contentType string) string {
	if match := charsetRe.FindStringSubmatch(contentType); match != nil {
		return strings.ToLower(match[1])
	}
	return "utf-8"
}
