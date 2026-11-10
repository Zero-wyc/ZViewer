// Package mediaapi 是 Emby / Jellyfin 共用的传输与 wire DTO 层。
//
// 两者都是「MediaBrowser」协议族，JSON 结构一致，但 12.0 之后已经不能
// 靠调前缀互转：Jellyfin 删除了 /emby 路由、关闭 legacy authorization，
// 媒体库列表也从 /Users/{id}/Items 搬到 /Items?userId=…。
// 协议差异全部收敛到 Protocol（路径拼装 + 鉴权头 + 令牌参数名），
// 具体协议常量分别放在 internal/emby 与 internal/jellyfin，两边互不依赖。
//
// 这个客户端的行为细节比看起来重要，逐条都是对拍里校对出来的：
//   - 鉴权按 Protocol 走：Emby 是 X-Emby-Token 双头，Jellyfin 是
//     Authorization: MediaBrowser 单头；
//   - 401 时若有账号密码就重登一次再重试，且只重试一次（否则坏密码会把
//     服务器锁账号）;
//   - 登录结果按 协议+server+账号+密码 的 sha256 缓存 24 小时、上限 500 条，
//     并发请求共用同一个登录过程（Emby 对并发 authenticatebyname 会限流）。
package mediaapi

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
	"os"
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

// Item 是条目列表（Emby /Users/{id}/Items、Jellyfin /Items）与 Views 的元素。
//
// 可能缺失的字段一律用指针：Node 侧 `item.X` 缺失就是 undefined，
// JSON.stringify 会**丢掉整个键**；用 string 会变成 `""` 出现在响应里，
// 前端的 `entry.filePath ?? ...` 之类的兜底就失效了。
type Item struct {
	ID                      string        `json:"Id"`
	Name                    *string       `json:"Name"`
	Type                    *string       `json:"Type"`
	IsFolder                *bool         `json:"IsFolder"`
	ChildCount              *int          `json:"ChildCount"`
	IsFile                  *bool         `json:"IsFile"`
	ProductionYear          *int          `json:"ProductionYear"`
	ImageTags               *ImageTags    `json:"ImageTags"`
	PrimaryImageAspectRatio *float64      `json:"PrimaryImageAspectRatio"`
	IndexNumber             *int          `json:"IndexNumber"`
	ParentIndexNumber       *int          `json:"ParentIndexNumber"`
	RunTimeTicks            *int64        `json:"RunTimeTicks"`
	MediaSources            []MediaSource `json:"MediaSources"`
	Path                    *string       `json:"Path"`
	RecursiveItemCount      *int          `json:"RecursiveItemCount"`
}

// ImageTags 是条目图片标签集合（只用到 Primary）。
type ImageTags struct {
	Primary string `json:"Primary"`
}

// MediaStream 是 MediaSources[].MediaStreams[] 的元素。
type MediaStream struct {
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

// MediaSource 是 MediaSource（同一部影片的多版本）。
type MediaSource struct {
	ID                  string        `json:"Id"`
	Path                *string       `json:"Path"`
	Container           *string       `json:"Container"`
	Size                *int64        `json:"Size"`
	Name                *string       `json:"Name"`
	DirectPlayURL       string        `json:"DirectPlayUrl"`
	TranscodingURL      string        `json:"TranscodingUrl"`
	SupportsTranscoding *bool         `json:"SupportsTranscoding"`
	MediaStreams        []MediaStream `json:"MediaStreams"`
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
	proto    Protocol

	mu    sync.Mutex
	token string
}

// NewClientWithProtocol 构造客户端。serverURL 会先补 scheme（裸地址
// `192.168.1.5:8096` 不补的话 url.Parse 会把 "192.168.1.5:" 当成非法 scheme）。
//
// 协议必须显式传入：Emby 与 Jellyfin 12 的路径和鉴权已经不同，
// 任何「默认值」都会在某一侧悄悄发错请求。
func NewClientWithProtocol(serverURL, token string, proto Protocol) *Client {
	base := netutil.NormalizeServerURLWithScheme(serverURL)
	if base == "" {
		base = "http://localhost:8096"
	}
	return &Client{BaseURL: base, token: token, timeout: defaultTimeout, proto: proto}
}

// Protocol 返回该客户端使用的上游协议。
func (c *Client) Protocol() Protocol { return c.proto }

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

// defaultEmbyClientName 是默认的客户端标识名。
//
// 私有 Emby/Jellyfin 常见「客户端名白名单」策略：写死 ZViewer 会被直接拒绝
// （401 或无法建立会话）。允许用 EMBY_CLIENT_NAME 覆盖（如 "Emby Web"），
// 未设置 / 空白时仍是 ZViewer，保持向下兼容。
const defaultEmbyClientName = "ZViewer"

// resolveClientName 归一化客户端标识名。
//
// 三条规则都是「宁可回退，也不要发出一个非法请求头」：
//   - TrimSpace：`.env` 里写 `EMBY_CLIENT_NAME=` 或带尾随空格时不能产生 Client=""；
//   - 去掉双引号：这个值要拼进 `Client="…"`，带引号会截断键值格式；
//   - 去掉 CR/LF：环境变量里混入换行会造出非法头，Go 会直接拒绝整个请求。
func resolveClientName(raw string) string {
	name := strings.NewReplacer(`"`, "", "\r", "", "\n", "").Replace(strings.TrimSpace(raw))
	if name == "" {
		return defaultEmbyClientName
	}
	return name
}

// authHeaderFromEnv 按当前环境变量构造客户端标识头。
//
// 运行期只解析一次（见 clientIdentity）：环境变量属于部署配置，热改没有意义，
// 而每个请求都读一遍 os.Getenv 会在浏览瀑布流时反复取同一把锁。
func authHeaderFromEnv() string {
	return buildAuthHeader(resolveClientName(os.Getenv("EMBY_CLIENT_NAME")))
}

// clientIdentity 是 MediaBrowser 客户端标识。
//
// Emby 放在 X-Emby-Authorization，Jellyfin 12 放在 Authorization；
// 两种协议共用同一份标识，差别只在 Protocol.SetAuth。
//
// DeviceId 在 Node 侧是进程级常量（Math.random().toString(36).slice(2,12)），
// 这里同样只在进程启动时生成一次：Emby 会按 DeviceId 聚合会话，
// 每个请求换一个 ID 会让服务器会话表爆掉。
var clientIdentity = authHeaderFromEnv()

func buildAuthHeader(clientName string) string {
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
	return `MediaBrowser Client="` + clientName + `", Device="Web Browser", DeviceId="zviewer-web-` +
		string(buf) + `", Version="1.0.0"`
}

// requestOptions 是一次请求的差异项。
type requestOptions struct {
	method       string
	path         string
	query        []Query
	body         any
	useAuthQuery bool   // GET 时把令牌放进 query（默认 true）
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
	target := c.BaseURL + c.proto.Path(opts.path)

	q := make([]Query, 0, len(opts.query)+1)
	q = append(q, opts.query...)
	token := c.AccessToken()
	if token != "" && method == http.MethodGet && opts.useAuthQuery {
		q = append(q, Query{c.proto.TokenQuery, token})
	}
	if len(q) > 0 {
		var b strings.Builder
		b.WriteByte('?')
		for i, pair := range q {
			if i > 0 {
				b.WriteByte('&')
			}
			b.WriteString(netutil.EncodeURIComponent(pair.Key))
			b.WriteByte('=')
			b.WriteString(netutil.EncodeURIComponent(pair.Value))
		}
		target += b.String()
	}

	var bodyReader io.Reader
	if opts.body != nil {
		encoded, err := json.Marshal(opts.body)
		if err != nil {
			return opts, nil, "", &Error{Message: c.proto.label() + " 请求体编码失败: " + err.Error(), Code: CodeUnreachable}
		}
		bodyReader = bytes.NewReader(encoded)
	}

	reqCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, method, target, bodyReader)
	if err != nil {
		return opts, nil, "", &Error{Message: c.proto.label() + " 连接失败: " + err.Error(), Code: CodeUnreachable}
	}
	req.Header.Set("Accept", "application/json")
	c.proto.SetAuth(req, token)
	if opts.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return opts, nil, "", &Error{
				Message: fmt.Sprintf(c.proto.label()+" 请求超时（%dms）", c.timeout.Milliseconds()),
				Code:    CodeTimeout,
			}
		}
		return opts, nil, "", &Error{Message: c.proto.label() + " 连接失败: " + err.Error(), Code: CodeUnreachable}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusUnauthorized && !retried && c.username != "" && c.password != "" {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			// 登录结果有 24h 缓存，直接重登会拿回**同一个已失效的 token**
			// （Node 侧同样要先把这份陈旧缓存扔掉，见 emby-client.ts 的注释）。
			// 必须只扔「缓存的正是当前这个 token」的那一份：如果是别的请求
			// 刚刷新的新 token，扔掉会引发无谓的重复登录。
			dropStaleLogin(c.proto, c.BaseURL, c.username, c.password, token)
			result, loginErr := LoginWithProtocol(ctx, c.proto, c.BaseURL, c.username, c.password)
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
			detail = c.proto.label() + " 请求失败: " + strconv.Itoa(resp.StatusCode)
		}
		return opts, nil, "", &Error{Message: detail, Status: resp.StatusCode, Code: CodeRequestFailed}
	}

	if resp.StatusCode == http.StatusNoContent {
		return opts, nil, "", nil
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return opts, nil, "", &Error{Message: c.proto.label() + " 连接失败: " + err.Error(), Code: CodeUnreachable}
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" && opts.responseType == "buffer" {
		ct = "image/jpeg"
	}
	return opts, body, ct, nil
}

// getJSON 发 GET 并解码 JSON。
func (c *Client) getJSON(ctx context.Context, path string, query []Query, dst any) error {
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
		return &Error{Message: "服务器响应解析失败: " + err.Error(), Code: CodeRequestFailed}
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
// 协议名进键：同一地址同时被当作 Emby 与 Jellyfin 挂载时（迁移/误配），
// 两条会话的令牌不能互相顶掉。
func loginKey(proto Protocol, server, username, password string) string {
	payload, _ := json.Marshal([]string{proto.Name, server, username, password})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// LoginWithProtocol 账号密码登录（24h 缓存 + 并发单飞）。
func LoginWithProtocol(
	ctx context.Context,
	proto Protocol,
	serverURL, username, password string,
) (*LoginResult, error) {
	key := loginKey(proto, netutil.NormalizeServerURLWithScheme(serverURL), username, password)

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

	result, err := performLogin(ctx, proto, serverURL, username, password)

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

func performLogin(
	ctx context.Context,
	proto Protocol,
	serverURL, username, password string,
) (*LoginResult, error) {
	client := NewClientWithProtocol(serverURL, "", proto)
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
		path:   proto.Routes.Login,
		body:   map[string]string{"Username": username, "Pw": password},
	})
	if err != nil {
		return nil, err
	}
	if err := decode(body, &res); err != nil {
		return nil, err
	}
	if res.AccessToken == "" || res.User == nil || res.User.ID == "" {
		return nil, &Error{Message: proto.label() + " 登录失败：服务器未返回有效会话", Code: CodeLoginFailed}
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
func dropStaleLogin(proto Protocol, serverURL, username, password, currentToken string) {
	key := loginKey(proto, netutil.NormalizeServerURLWithScheme(serverURL), username, password)

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

// Me 取当前令牌对应的用户。
//
// 先试 /Users/Me，再回退全量 /Users 并取第一个管理员（Node 侧同样的降级
// 顺序，不能颠倒：/Users 可能返回非管理员账号，用它去查媒体库会得到空
// 列表）。协议没声明 Me 路由时（Emby 没有这个端点：它会把 "Me" 当 GUID
// 解析并返回 500）直接走回退，省掉一次必然失败的往返。
func (c *Client) Me(ctx context.Context) (*UserInfo, error) {
	if route := c.proto.Routes.Me; route != "" {
		var me UserInfo
		if err := c.getJSON(ctx, route, nil, &me); err == nil && me.ID != "" {
			return &me, nil
		}
	}
	var users []struct {
		ID       string `json:"Id"`
		Name     string `json:"Name"`
		ServerID string `json:"ServerId"`
		Policy   *struct {
			IsAdministrator bool `json:"IsAdministrator"`
		} `json:"Policy"`
	}
	if err := c.getJSON(ctx, c.proto.Routes.Users, nil, &users); err != nil {
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
		return nil, &Error{Message: c.proto.label() + " 服务器无可用用户", Code: CodeNoUser}
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
func (c *Client) UserViews(ctx context.Context, userID string) ([]Item, error) {
	var res struct {
		Items []Item `json:"Items"`
	}
	path, extra := c.proto.Routes.Views(userID)
	query := append(extra, Query{"Fields", "ChildCount"})
	if err := c.getJSON(ctx, path, query, &res); err != nil {
		return nil, err
	}
	if res.Items == nil {
		return []Item{}, nil
	}
	return res.Items, nil
}

// Items 列出某个条目的子项（parentID 为空时列出根）。
func (c *Client) Items(ctx context.Context, userID, parentID, includeItemTypes string) ([]Item, error) {
	path, extra := c.proto.Routes.Items(userID)
	query := make([]Query, 0, len(extra)+4)
	query = append(query, extra...)
	if parentID != "" {
		query = append(query, Query{"ParentId", parentID})
	}
	if includeItemTypes != "" {
		query = append(query, Query{"IncludeItemTypes", includeItemTypes})
	}
	query = append(query, Query{"Fields", fieldsForItems})
	if parentID == "" {
		query = append(query, Query{"Recursive", "false"})
	}
	var res struct {
		Items            []Item `json:"Items"`
		TotalRecordCount int    `json:"TotalRecordCount"`
	}
	if err := c.getJSON(ctx, path, query, &res); err != nil {
		return nil, err
	}
	if res.Items == nil {
		return []Item{}, nil
	}
	return res.Items, nil
}

// Search 递归搜索条目。
func (c *Client) Search(ctx context.Context, userID, term string) ([]Item, error) {
	var res struct {
		Items []Item `json:"Items"`
	}
	path, extra := c.proto.Routes.Items(userID)
	query := make([]Query, 0, len(extra)+3)
	query = append(query, extra...)
	query = append(query,
		Query{"SearchTerm", term},
		Query{"Fields", fieldsForItems},
		Query{"Recursive", "true"},
	)
	if err := c.getJSON(ctx, path, query, &res); err != nil {
		return nil, err
	}
	if res.Items == nil {
		return []Item{}, nil
	}
	return res.Items, nil
}

// ItemImage 取条目主海报。
func (c *Client) ItemImage(ctx context.Context, itemID, tag string, maxWidth int) (*ImageResult, error) {
	query := make([]Query, 0, 3)
	if maxWidth > 0 {
		query = append(query, Query{"maxWidth", strconv.Itoa(maxWidth)})
	}
	if tag != "" {
		query = append(query, Query{"tag", tag})
	}
	query = append(query, Query{"quality", "90"})
	path := c.proto.Routes.Image(itemID)
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
		Items []Item `json:"Items"`
	}
	path, extra := c.proto.Routes.Items(userID)
	query := make([]Query, 0, len(extra)+6)
	query = append(query, extra...)
	query = append(query,
		Query{"ParentId", parentID},
		Query{"Recursive", "true"},
		Query{"Limit", "50"},
		Query{"Fields", "PrimaryImageAspectRatio"},
		Query{"SortBy", "SortName"},
		Query{"SortOrder", "Ascending"},
	)
	if err := c.getJSON(ctx, path, query, &res); err != nil {
		return nil, err
	}
	withPoster := make([]Item, 0, len(res.Items))
	for _, item := range res.Items {
		if item.ImageTags != nil && item.ImageTags.Primary != "" {
			withPoster = append(withPoster, item)
		}
	}
	portrait := make([]Item, 0, len(withPoster))
	landscape := make([]Item, 0, len(withPoster))
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
func (c *Client) PlaybackInfo(ctx context.Context, itemID, userID string) ([]MediaSource, error) {
	var res struct {
		MediaSources []MediaSource `json:"MediaSources"`
	}
	path := c.proto.Routes.PlaybackInfo(itemID)
	body, _, err := c.do(ctx, requestOptions{
		method: http.MethodPost,
		path:   path,
		query:  []Query{{"UserId", userID}, {"reqformat", "json"}},
		body:   struct{}{},
	})
	if err != nil {
		return nil, err
	}
	if err := decode(body, &res); err != nil {
		return nil, err
	}
	if len(res.MediaSources) == 0 {
		return nil, &Error{Message: c.proto.label() + " 未返回可用媒体源", Code: CodeNoMediaSource}
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
	path := c.proto.Routes.Subtitles(itemID, mediaSourceID, index, ext)
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

// NewFromMountWithProtocol 按挂载记录构造客户端。
//
// 优先用 API Key；否则用账号密码登录（登录结果有 24h 缓存，不会每次
// 浏览都打一次 authenticatebyname）。
func NewFromMountWithProtocol(mount *store.Mount, proto Protocol) (*Client, error) {
	client, _, err := clientFromMount(context.Background(), mount, proto)
	return client, err
}

// clientFromMount 构造客户端，顺带返回登录过程中拿到的 userId。
//
// 账号密码模式下 authenticatebyname 的响应里本来就有 User.Id，等于白拿；
// API Key 模式没有登录过程，第二个返回值固定为空。
func clientFromMount(
	ctx context.Context,
	mount *store.Mount,
	proto Protocol,
) (*Client, string, error) {
	serverURL := ""
	if mount.ServerURL != nil {
		serverURL = *mount.ServerURL
	}
	if mount.APIKey != nil && *mount.APIKey != "" {
		return NewClientWithProtocol(serverURL, *mount.APIKey, proto), "", nil
	}
	if mount.Username != nil && *mount.Username != "" && mount.Password != nil && *mount.Password != "" {
		result, err := LoginWithProtocol(ctx, proto, serverURL, *mount.Username, *mount.Password)
		if err != nil {
			return nil, "", err
		}
		return NewClientWithProtocol(serverURL, result.Token, proto).
			WithCredentials(*mount.Username, *mount.Password), result.UserID, nil
	}
	return nil, "", &Error{
		Message: proto.label() + " 挂载缺少 API Key 或账号密码",
		Code:    CodeMissingCredentials,
	}
}

// ResolveSession 解析挂载会话（token + userId）。
//
// userId 按「代价从低到高」取，前两步都不产生额外往返：
//
//  1. 库里存的 embyUserId —— **任意认证方式都直接用**。
//     这是「添加挂载时已测得 userId」的意义：每次浏览与播放都少一次请求。
//     它不能只在 API Key 模式下生效：账号密码挂载在创建时同样写入了
//     userId，若这里再退回 /Users/Me，Emby 会先 500（Emby 没有这个端点，
//     把 "Me" 当 GUID 解析），再回退 /Users，而 /Users 需要 ManageServer
//     权限，普通观影账号直接 403 —— 媒体库就浏览不了（issue #45）。
//  2. 账号密码模式的登录结果 —— authenticatebyname 的响应里就有 User.Id，
//     且结果缓存 24h，等于零成本。
//  3. /Users/Me 兜底 —— 只可能是「API Key + 库里没有 userId」的存量数据。
func ResolveSessionWithProtocol(
	ctx context.Context,
	mount *store.Mount,
	proto Protocol,
) (*Session, error) {
	client, loginUserID, err := clientFromMount(ctx, mount, proto)
	if err != nil {
		return nil, err
	}
	if mount.EmbyUserID != nil && *mount.EmbyUserID != "" {
		return &Session{Client: client, UserID: *mount.EmbyUserID}, nil
	}
	if loginUserID != "" {
		return &Session{Client: client, UserID: loginUserID}, nil
	}
	me, err := client.Me(ctx)
	if err != nil {
		return nil, err
	}
	return &Session{Client: client, UserID: me.ID}, nil
}
