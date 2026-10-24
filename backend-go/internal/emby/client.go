// Package emby 是 Emby / Jellyfin 的 REST 客户端。
//
// Jellyfin 是 Emby 的开源分支，两者的「/emby/...」端点完全兼容，Node 版
// 也是同一个客户端类服务两个路由前缀（services/jellyfin-client.ts 只是重导出）。
// Go 侧同样只保留一份实现。
//
// 这个客户端的行为细节比看起来重要，逐条都是对拍里校对出来的：
//   - 所有请求都带 X-Emby-Token 头，GET 额外把 api_key 塞进 query（兼容旧版）；
//   - 每个请求都要带 X-Emby-Authorization 客户端标识头，登录请求尤其必需；
//   - 401 时若有账号密码就重登一次再重试，且只重试一次（否则坏密码会把
//     服务器锁账号）;
//   - 登录结果按 server+账号+密码 的 sha256 缓存 24 小时、上限 500 条，
//     并发请求共用同一个登录过程（Emby 对并发 authenticatebyname 会限流）。
package emby

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/store"
)

// 错误码。与 Node 的 EmbyError.code 同名，上层直接下发给前端。
const (
	CodeRequestFailed      = "EMBY_REQUEST_FAILED"
	CodeTimeout            = "TIMEOUT"
	CodeUnreachable        = "UNREACHABLE"
	CodeLoginFailed        = "LOGIN_FAILED"
	CodeNoUser             = "NO_USER"
	CodeNoMediaSource      = "NO_MEDIA_SOURCE"
	CodeMissingCredentials = "MISSING_CREDENTIALS"
)

// defaultTimeout 与 Node 的 DEFAULT_TIMEOUT_MS 一致。
const defaultTimeout = 10 * time.Second

// Error 是 Emby 系错误：Message 直接给用户看，Code 决定上层怎么分流。
type Error struct {
	Message string
	Status  int
	Code    string
}

func (e *Error) Error() string { return e.Message }

// EmbyItem 是 /Users/{id}/Items 与 /Views 返回的条目。
//
// 可能缺失的字段一律用指针：Node 侧 `item.X` 缺失就是 undefined，
// JSON.stringify 会**丢掉整个键**；用 string 会变成 `""` 出现在响应里，
// 前端的 `entry.filePath ?? ...` 之类的兜底就失效了。
type EmbyItem struct {
	ID                      string         `json:"Id"`
	Name                    *string        `json:"Name"`
	Type                    *string        `json:"Type"`
	IsFolder                *bool          `json:"IsFolder"`
	ChildCount              *int           `json:"ChildCount"`
	IsFile                  *bool          `json:"IsFile"`
	ProductionYear          *int           `json:"ProductionYear"`
	ImageTags               *EmbyImageTags `json:"ImageTags"`
	PrimaryImageAspectRatio *float64       `json:"PrimaryImageAspectRatio"`
	IndexNumber             *int           `json:"IndexNumber"`
	ParentIndexNumber       *int           `json:"ParentIndexNumber"`
	RunTimeTicks            *int64         `json:"RunTimeTicks"`
	MediaSources            []EmbyMediaSrc `json:"MediaSources"`
	Path                    *string        `json:"Path"`
	RecursiveItemCount      *int           `json:"RecursiveItemCount"`
}

// EmbyImageTags 是条目图片标签集合（只用到 Primary）。
type EmbyImageTags struct {
	Primary string `json:"Primary"`
}

// EmbyMediaStream 是 MediaSources[].MediaStreams[] 的元素。
type EmbyMediaStream struct {
	Index          int     `json:"Index"`
	Type           string  `json:"Type"` // Video / Audio / Subtitle
	Codec          *string `json:"Codec"`
	Language       string  `json:"Language"`
	DisplayTitle   string  `json:"DisplayTitle"`
	IsExternal     *bool   `json:"IsExternal"`
	DeliveryMethod string  `json:"DeliveryMethod"`
	DeliveryURL    string  `json:"DeliveryUrl"`
	Height         *int    `json:"Height"`
}

// EmbyMediaSrc 是 MediaSource（同一部影片的多版本）。
type EmbyMediaSrc struct {
	ID             string            `json:"Id"`
	Path           *string           `json:"Path"`
	Container      *string           `json:"Container"`
	Size           *int64            `json:"Size"`
	Name           *string           `json:"Name"`
	DirectPlayURL  string            `json:"DirectPlayUrl"`
	TranscodingURL string            `json:"TranscodingUrl"`
	MediaStreams   []EmbyMediaStream `json:"MediaStreams"`
}

// LoginResult 是 authenticatebyname 的结果。
type LoginResult struct {
	Token    string
	ServerID string
	UserID   string
	UserName string
}

// UserInfo 是 /Users/Me 的结果。
type UserInfo struct {
	ID       string `json:"Id"`
	Name     string `json:"Name"`
	ServerID string `json:"ServerId"`
}

// ImageResult 是二进制响应（海报）。
type ImageResult struct {
	Buffer      []byte
	ContentType string
}

// Client 是一个挂载连接上的客户端。
//
// token 会在 401 重登时被替换，所以用互斥锁包住：同一个 Client 可能被
// resolve / proxy / 字幕并发使用（Node 是单线程所以不用操心）。
type Client struct {
	BaseURL  string
	timeout  time.Duration
	username string
	password string

	mu    sync.Mutex
	token string
}

// NewClient 构造客户端。serverURL 会先补 scheme（裸地址 `192.168.1.5:8096`
// 不补的话 url.Parse 会把 "192.168.1.5:" 当成非法 scheme）。
func NewClient(serverURL, token string) *Client {
	base := netutil.NormalizeServerURLWithScheme(serverURL)
	if base == "" {
		base = "http://localhost:8096"
	}
	return &Client{BaseURL: base, token: token, timeout: defaultTimeout}
}

// WithCredentials 记录账号密码，用于 401 自动重登。
func (c *Client) WithCredentials(username, password string) *Client {
	c.username = username
	c.password = password
	return c
}

// AccessToken 返回当前会话令牌（重登后会变）。
func (c *Client) AccessToken() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token
}

func (c *Client) setToken(token string) {
	c.mu.Lock()
	c.token = token
	c.mu.Unlock()
}

// embyAuthHeader 是 X-Emby-Authorization 客户端标识。
//
// DeviceId 在 Node 侧是进程级常量（Math.random().toString(36).slice(2,12)），
// 这里同样只在进程启动时生成一次：Emby 会按 DeviceId 聚合会话，
// 每个请求换一个 ID 会让服务器会话表爆掉。
var embyAuthHeader = buildAuthHeader()

func buildAuthHeader() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	buf := make([]byte, 10)
	for i := range buf {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			buf[i] = '0'
			continue
		}
		buf[i] = alphabet[n.Int64()]
	}
	return `MediaBrowser Client="ZViewer", Device="Web Browser", DeviceId="zviewer-web-` +
		string(buf) + `", Version="1.0.0"`
}

// queryPair 是有序 query 参数。
//
// 刻意用切片而不是 url.Values：Node 侧按书写顺序 append（api_key 固定在最后），
// 对拍时 mock 服务器会把收到的 query 原样回显，顺序不一致会被判成差异。
type queryPair struct {
	key   string
	value string
}

// requestOptions 是一次请求的差异项。
type requestOptions struct {
	method       string
	path         string
	query        []queryPair
	body         any
	useAuthQuery bool   // GET 时把 api_key 放进 query（默认 true）
	responseType string // "" | text | buffer
}

// do 发起请求并按 responseType 解码。
func (c *Client) do(
	ctx context.Context,
	opts requestOptions,
) ([]byte, string, error) {
	_, raw, contentType, err := c.doOnce(ctx, opts, false)
	return raw, contentType, err
}

func (c *Client) doOnce(
	ctx context.Context,
	opts requestOptions,
	retried bool,
) (requestOptions, []byte, string, error) {
	method := opts.method
	if method == "" {
		method = http.MethodGet
	}
	target := c.BaseURL + opts.path

	q := make([]queryPair, 0, len(opts.query)+1)
	q = append(q, opts.query...)
	token := c.AccessToken()
	if token != "" && method == http.MethodGet && opts.useAuthQuery {
		q = append(q, queryPair{"api_key", token})
	}
	if len(q) > 0 {
		var b strings.Builder
		b.WriteByte('?')
		for i, pair := range q {
			if i > 0 {
				b.WriteByte('&')
			}
			b.WriteString(netutil.EncodeURIComponent(pair.key))
			b.WriteByte('=')
			b.WriteString(netutil.EncodeURIComponent(pair.value))
		}
		target += b.String()
	}

	var bodyReader io.Reader
	if opts.body != nil {
		encoded, err := json.Marshal(opts.body)
		if err != nil {
			return opts, nil, "", &Error{Message: "Emby 请求体编码失败: " + err.Error(), Code: CodeUnreachable}
		}
		bodyReader = bytes.NewReader(encoded)
	}

	reqCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, method, target, bodyReader)
	if err != nil {
		return opts, nil, "", &Error{Message: "Emby 连接失败: " + err.Error(), Code: CodeUnreachable}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Emby-Authorization", embyAuthHeader)
	if token != "" {
		req.Header.Set("X-Emby-Token", token)
	}
	if opts.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return opts, nil, "", &Error{
				Message: fmt.Sprintf("Emby 请求超时（%dms）", c.timeout.Milliseconds()),
				Code:    CodeTimeout,
			}
		}
		return opts, nil, "", &Error{Message: "Emby 连接失败: " + err.Error(), Code: CodeUnreachable}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusUnauthorized && !retried && c.username != "" && c.password != "" {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			// 登录结果有 24h 缓存，直接重登会拿回**同一个已失效的 token**
			// （Node 侧同样要先把这份陈旧缓存扔掉，见 emby-client.ts 的注释）。
			// 必须只扔「缓存的正是当前这个 token」的那一份：如果是别的请求
			// 刚刷新的新 token，扔掉会引发无谓的重复登录。
			dropStaleLogin(c.BaseURL, c.username, c.password, token)
			result, loginErr := Login(ctx, c.BaseURL, c.username, c.password)
			if loginErr != nil {
				return opts, nil, "", loginErr
			}
			c.setToken(result.Token)
			return c.doOnce(ctx, opts, true)
		}
		detail := ""
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		var payload struct {
			Message string `json:"Message"`
			Error   struct {
				Message string `json:"message"`
			} `json:"Error"`
		}
		if json.Unmarshal(body, &payload) == nil {
			if payload.Message != "" {
				detail = payload.Message
			} else if payload.Error.Message != "" {
				detail = payload.Error.Message
			}
		}
		if detail == "" {
			detail = "Emby 请求失败: " + strconv.Itoa(resp.StatusCode)
		}
		return opts, nil, "", &Error{Message: detail, Status: resp.StatusCode, Code: CodeRequestFailed}
	}

	if resp.StatusCode == http.StatusNoContent {
		return opts, nil, "", nil
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return opts, nil, "", &Error{Message: "Emby 连接失败: " + err.Error(), Code: CodeUnreachable}
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" && opts.responseType == "buffer" {
		ct = "image/jpeg"
	}
	return opts, body, ct, nil
}

// getJSON 发 GET 并解码 JSON。
func (c *Client) getJSON(ctx context.Context, path string, query []queryPair, dst any) error {
	body, _, err := c.do(ctx, requestOptions{path: path, query: query})
	if err != nil {
		return err
	}
	return decode(body, dst)
}

func decode(body []byte, dst any) error {
	if dst == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return &Error{Message: "Emby 响应解析失败: " + err.Error(), Code: CodeRequestFailed}
	}
	return nil
}

// ==================== 登录 ====================

type loginEntry struct {
	done   chan struct{}
	result *LoginResult
	err    error
	at     time.Time
}

var (
	loginMu    sync.Mutex
	loginCache = map[string]*loginEntry{}
)

const loginTTL = 24 * time.Hour

// loginKey 复刻 Node 的 sha256(JSON.stringify([server, username, password]))。
//
// 键只在本进程内使用（不进库、不下发），所以不要求和 Node 的键逐字节相等，
// 只要同进程内稳定即可；但仍保持同样的输入形状，方便对照排查。
func loginKey(server, username, password string) string {
	payload, _ := json.Marshal([]string{server, username, password})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// Login 账号密码登录（24h 缓存 + 并发单飞）。
func Login(ctx context.Context, serverURL, username, password string) (*LoginResult, error) {
	key := loginKey(netutil.NormalizeServerURLWithScheme(serverURL), username, password)

	loginMu.Lock()
	if entry, ok := loginCache[key]; ok && time.Since(entry.at) < loginTTL {
		// 在途登录同样算命中：并发请求必须等同一个登录过程，
		// 否则 Emby 会因为并发 authenticatebyname 直接限流。
		loginMu.Unlock()
		<-entry.done
		return entry.result, entry.err
	}
	entry := &loginEntry{done: make(chan struct{}), at: time.Now()}
	loginCache[key] = entry
	if len(loginCache) > 500 {
		// 超容量时按插入序淘汰最旧的一条（Go 的 map 无序，取任意非当前项）
		for k := range loginCache {
			if k != key {
				delete(loginCache, k)
				break
			}
		}
	}
	loginMu.Unlock()

	result, err := performLogin(ctx, serverURL, username, password)

	loginMu.Lock()
	entry.result, entry.err = result, err
	if err != nil {
		// 失败不缓存：否则一次网络抖动会让 24 小时内的重试全部直接失败。
		delete(loginCache, key)
	}
	loginMu.Unlock()
	close(entry.done)
	return result, err
}

func performLogin(ctx context.Context, serverURL, username, password string) (*LoginResult, error) {
	client := NewClient(serverURL, "")
	var res struct {
		AccessToken string `json:"AccessToken"`
		ServerID    string `json:"ServerId"`
		User        *struct {
			ID   string `json:"Id"`
			Name string `json:"Name"`
		} `json:"User"`
	}
	body, _, err := client.do(ctx, requestOptions{
		method: http.MethodPost,
		path:   "/emby/Users/authenticatebyname",
		body:   map[string]string{"Username": username, "Pw": password},
	})
	if err != nil {
		return nil, err
	}
	if err := decode(body, &res); err != nil {
		return nil, err
	}
	if res.AccessToken == "" || res.User == nil || res.User.ID == "" {
		return nil, &Error{Message: "Emby 登录失败：服务器未返回有效会话", Code: CodeLoginFailed}
	}
	return &LoginResult{
		Token:    res.AccessToken,
		ServerID: res.ServerID,
		UserID:   res.User.ID,
		UserName: res.User.Name,
	}, nil
}

// dropStaleLogin 丢弃「缓存的 token 正是当前失效 token」的那份登录缓存。
//
// 这是 401 自动重登能生效的前提：否则 Login 会把同一份陈旧结果再返回一次，
// 重试必然还是 401，表现为「密码是对的，但一过 token 有效期就再也好不了」。
func dropStaleLogin(serverURL, username, password, currentToken string) {
	key := loginKey(netutil.NormalizeServerURLWithScheme(serverURL), username, password)

	for attempt := 0; attempt < 2; attempt++ {
		loginMu.Lock()
		entry, ok := loginCache[key]
		if !ok {
			loginMu.Unlock()
			return
		}
		if entry.result == nil && entry.done != nil {
			// 还在登录中：等它落地再判断（Node 也是 await cached.result）。
			done := entry.done
			loginMu.Unlock()
			<-done
			continue
		}
		if entry.result != nil && entry.result.Token == currentToken {
			delete(loginCache, key)
		}
		loginMu.Unlock()
		return
	}
}

// ==================== 用户 ====================

// Me 取当前用户信息。
//
// 优先 /Users/Me；部分 Emby 版本对它返回 500，此时回退到 /Users 列表并
// 取第一个管理员（Node 侧同样的降级顺序，不能颠倒：/Users 可能返回
// 非管理员账号，用它去查媒体库会得到空列表）。
func (c *Client) Me(ctx context.Context) (*UserInfo, error) {
	var me UserInfo
	if err := c.getJSON(ctx, "/emby/Users/Me", nil, &me); err == nil {
		return &me, nil
	}
	var users []struct {
		ID       string `json:"Id"`
		Name     string `json:"Name"`
		ServerID string `json:"ServerId"`
		Policy   *struct {
			IsAdministrator bool `json:"IsAdministrator"`
		} `json:"Policy"`
	}
	if err := c.getJSON(ctx, "/emby/Users", nil, &users); err != nil {
		return nil, err
	}
	pick := -1
	for i, u := range users {
		if u.Policy != nil && u.Policy.IsAdministrator {
			pick = i
			break
		}
	}
	if pick < 0 && len(users) > 0 {
		pick = 0
	}
	if pick < 0 {
		return nil, &Error{Message: "Emby 服务器无可用用户", Code: CodeNoUser}
	}
	return &UserInfo{ID: users[pick].ID, Name: users[pick].Name, ServerID: users[pick].ServerID}, nil
}

// ==================== 浏览 ====================

// fieldsForItems 是 Items 必须显式索取的字段。
//
// IndexNumber / ParentIndexNumber / RunTimeTicks 不写进 Fields 就不会返回，
// 分集的 SxEy 标签与时长会全部缺失；RecursiveItemCount 是剧集总集数角标。
const fieldsForItems = "ChildCount,MediaSources,Path,ProductionYear,PrimaryImageAspectRatio," +
	"IndexNumber,ParentIndexNumber,RunTimeTicks,RecursiveItemCount"

// UserViews 列出媒体库（媒体文件夹）。
func (c *Client) UserViews(ctx context.Context, userID string) ([]EmbyItem, error) {
	var res struct {
		Items []EmbyItem `json:"Items"`
	}
	path := "/emby/Users/" + netutil.EncodeURIComponent(userID) + "/Views"
	if err := c.getJSON(ctx, path, []queryPair{{"Fields", "ChildCount"}}, &res); err != nil {
		return nil, err
	}
	if res.Items == nil {
		return []EmbyItem{}, nil
	}
	return res.Items, nil
}

// Items 列出某个条目的子项（parentID 为空时列出根）。
func (c *Client) Items(ctx context.Context, userID, parentID, includeItemTypes string) ([]EmbyItem, error) {
	query := make([]queryPair, 0, 4)
	if parentID != "" {
		query = append(query, queryPair{"ParentId", parentID})
	}
	if includeItemTypes != "" {
		query = append(query, queryPair{"IncludeItemTypes", includeItemTypes})
	}
	query = append(query, queryPair{"Fields", fieldsForItems})
	if parentID == "" {
		query = append(query, queryPair{"Recursive", "false"})
	}
	var res struct {
		Items            []EmbyItem `json:"Items"`
		TotalRecordCount int        `json:"TotalRecordCount"`
	}
	path := "/emby/Users/" + netutil.EncodeURIComponent(userID) + "/Items"
	if err := c.getJSON(ctx, path, query, &res); err != nil {
		return nil, err
	}
	if res.Items == nil {
		return []EmbyItem{}, nil
	}
	return res.Items, nil
}

// Search 递归搜索条目。
func (c *Client) Search(ctx context.Context, userID, term string) ([]EmbyItem, error) {
	var res struct {
		Items []EmbyItem `json:"Items"`
	}
	path := "/emby/Users/" + netutil.EncodeURIComponent(userID) + "/Items"
	query := []queryPair{
		{"SearchTerm", term},
		{"Fields", fieldsForItems},
		{"Recursive", "true"},
	}
	if err := c.getJSON(ctx, path, query, &res); err != nil {
		return nil, err
	}
	if res.Items == nil {
		return []EmbyItem{}, nil
	}
	return res.Items, nil
}

// ItemImage 取条目主海报。
func (c *Client) ItemImage(ctx context.Context, itemID, tag string, maxWidth int) (*ImageResult, error) {
	query := make([]queryPair, 0, 3)
	if maxWidth > 0 {
		query = append(query, queryPair{"maxWidth", strconv.Itoa(maxWidth)})
	}
	if tag != "" {
		query = append(query, queryPair{"tag", tag})
	}
	query = append(query, queryPair{"quality", "90"})
	path := "/emby/Items/" + netutil.EncodeURIComponent(itemID) + "/Images/Primary"
	body, contentType, err := c.do(ctx, requestOptions{
		path:         path,
		query:        query,
		responseType: "buffer",
	})
	if err != nil {
		return nil, err
	}
	return &ImageResult{Buffer: body, ContentType: contentType}, nil
}

// FindPosterChildren 找后代中带主海报的条目（文件夹海报回退用）。
//
// 返回多个候选、竖版优先：Emby 的 ImageTags 与实际图片可能不同步，
// 单个候选取图 404 时调用方要能继续试下一个。
func (c *Client) FindPosterChildren(ctx context.Context, userID, parentID string) ([]string, error) {
	var res struct {
		Items []EmbyItem `json:"Items"`
	}
	path := "/emby/Users/" + netutil.EncodeURIComponent(userID) + "/Items"
	query := []queryPair{
		{"ParentId", parentID},
		{"Recursive", "true"},
		{"Limit", "50"},
		{"Fields", "PrimaryImageAspectRatio"},
		{"SortBy", "SortName"},
		{"SortOrder", "Ascending"},
	}
	if err := c.getJSON(ctx, path, query, &res); err != nil {
		return nil, err
	}
	withPoster := make([]EmbyItem, 0, len(res.Items))
	for _, item := range res.Items {
		if item.ImageTags != nil && item.ImageTags.Primary != "" {
			withPoster = append(withPoster, item)
		}
	}
	portrait := make([]EmbyItem, 0, len(withPoster))
	landscape := make([]EmbyItem, 0, len(withPoster))
	for _, item := range withPoster {
		ratio := 1.0
		if item.PrimaryImageAspectRatio != nil {
			ratio = *item.PrimaryImageAspectRatio
		}
		if ratio < 0.9 {
			portrait = append(portrait, item)
		} else {
			landscape = append(landscape, item)
		}
	}
	ordered := append(portrait, landscape...)
	if len(ordered) > 5 {
		ordered = ordered[:5]
	}
	ids := make([]string, 0, len(ordered))
	for _, item := range ordered {
		ids = append(ids, item.ID)
	}
	return ids, nil
}

// ==================== 播放 ====================

// PlaybackInfo 取播放信息（MediaSources 含多版本）。
func (c *Client) PlaybackInfo(ctx context.Context, itemID, userID string) ([]EmbyMediaSrc, error) {
	var res struct {
		MediaSources []EmbyMediaSrc `json:"MediaSources"`
	}
	path := "/emby/Items/" + netutil.EncodeURIComponent(itemID) + "/PlaybackInfo"
	body, _, err := c.do(ctx, requestOptions{
		method: http.MethodPost,
		path:   path,
		query:  []queryPair{{"UserId", userID}, {"reqformat", "json"}},
		body:   struct{}{},
	})
	if err != nil {
		return nil, err
	}
	if err := decode(body, &res); err != nil {
		return nil, err
	}
	if len(res.MediaSources) == 0 {
		return nil, &Error{Message: "Emby 未返回可用媒体源", Code: CodeNoMediaSource}
	}
	return res.MediaSources, nil
}

// SubtitleContent 取字幕轨道内容（Emby 会把内嵌字幕转封装成对应格式）。
func (c *Client) SubtitleContent(
	ctx context.Context,
	itemID, mediaSourceID string,
	index int,
	ext string,
) (string, error) {
	suffix := ""
	if ext != "" {
		suffix = "." + ext
	}
	path := "/emby/Videos/" + netutil.EncodeURIComponent(itemID) + "/" +
		netutil.EncodeURIComponent(mediaSourceID) + "/Subtitles/" +
		strconv.Itoa(index) + "/Stream" + suffix
	body, _, err := c.do(ctx, requestOptions{path: path, responseType: "text"})
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// ==================== 挂载 → 会话 ====================

// Session 是一次已鉴权的挂载会话。
type Session struct {
	Client *Client
	UserID string
}

// Token 返回当前令牌（401 重登后会自动更新）。
func (s *Session) Token() string { return s.Client.AccessToken() }

// NewFromMount 按挂载记录构造客户端。
//
// 优先用 API Key；否则用账号密码登录（登录结果有 24h 缓存，不会每次
// 浏览都打一次 authenticatebyname）。
func NewFromMount(mount *store.Mount) (*Client, error) {
	serverURL := ""
	if mount.ServerURL != nil {
		serverURL = *mount.ServerURL
	}
	if mount.APIKey != nil && *mount.APIKey != "" {
		return NewClient(serverURL, *mount.APIKey), nil
	}
	if mount.Username != nil && *mount.Username != "" && mount.Password != nil && *mount.Password != "" {
		result, err := Login(context.Background(), serverURL, *mount.Username, *mount.Password)
		if err != nil {
			return nil, err
		}
		return NewClient(serverURL, result.Token).WithCredentials(*mount.Username, *mount.Password), nil
	}
	return nil, &Error{
		Message: "Emby 挂载缺少 API Key 或账号密码",
		Code:    CodeMissingCredentials,
	}
}

// ResolveSession 解析挂载会话（token + userId）。
//
// API Key 模式下 userId 不可能从登录结果拿到，只能用库里存的 embyUserId；
// 它为空时才请求 /Users/Me（这是「添加挂载时已测得 userId」的意义所在：
// 每次播放都少一次往返）。
func ResolveSession(ctx context.Context, mount *store.Mount) (*Session, error) {
	client, err := NewFromMount(mount)
	if err != nil {
		return nil, err
	}
	if mount.APIKey != nil && *mount.APIKey != "" && mount.EmbyUserID != nil && *mount.EmbyUserID != "" {
		return &Session{Client: client, UserID: *mount.EmbyUserID}, nil
	}
	me, err := client.Me(ctx)
	if err != nil {
		return nil, err
	}
	return &Session{Client: client, UserID: me.ID}, nil
}
