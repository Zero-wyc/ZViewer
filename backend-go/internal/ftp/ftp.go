// Package ftp 实现流媒体代理所需的 FTP/FTPS 客户端。
//
// 只覆盖三件事：列目录、单文件 stat、按偏移取流。对接口径以 Node 侧
// basic-ftp 6.0.1 为准（见 backend/src/services/ftp.ts）：
//
//   - 登录后先 FEAT，支持 MLST 就用 MLSD，否则回退 LIST -a / LIST；
//   - stat 优先 SIZE + MDTM（各一次往返），失败才回退 CWD + LIST 全目录扫描；
//   - 分段读取用 REST 偏移，服务端从偏移处一直发到文件尾（截断由 HTTP 层负责）。
//
// 为什么不引第三方库：basic-ftp 的等价能力只需要「命令行协议 + 被动模式
// 数据连接」，自己写约 500 行，换来零外部依赖（本项目 Go 侧一直坚持
// 纯 Go + 最少依赖，modernc.org/sqlite 已经是为了这个原则选的）。
package ftp

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultPort 是 FTP 默认端口（ftps 隐式 TLS 同理，显式 TLS 也走 21）。
const DefaultPort = 21

// opTimeout 与 Node 侧 withTimeout 的 10s 一致：一次 stat/列目录必须在
// 这个时间内完成，否则报「FTP 连接 超时」。流传输不受此限制。
const opTimeout = 10 * time.Second

// streamIdleTimeout 是流传输期间「多久收不到数据就放弃」。
//
// Node 侧把数据 socket 的 timeout 设成 ftp.timeout（30s），但流传输
// 期间控制 socket 不设限。这里取 60s：比 30s 宽松，避免慢速 FTP
// （尤其是跨境线路）因为一个 chunk 晚到就被判死。
const streamIdleTimeout = 60 * time.Second

// maxListingBytes 是目录列举的读取上限（防恶意/异常服务器把内存打满）。
const maxListingBytes = 4 << 20

// Params 是一次 FTP 操作所需的连接参数。
type Params struct {
	// ServerURL 可以是 ftp://host、ftps://host 或裸主机名。
	ServerURL string
	// Path 是操作目标路径（stat 时是文件路径，列目录时是目录）。
	Path     string
	Username string
	Password string
	// Port 为 0 时用 DefaultPort。
	Port int
}

func (p Params) port() int {
	if p.Port > 0 {
		return p.Port
	}
	return DefaultPort
}

// 目录项类型。取值与 Node 侧 file.type === 1 ? 'file' : 'directory' 对齐：
// 只有普通文件是 "file"，目录/符号链接/未知一律 "directory"。
const (
	TypeDirectory = "directory"
	TypeFile      = "file"
)

// Entry 是一个目录项。
type Entry struct {
	Name string
	Path string
	Type string
	// Size 恒有值（拿不到时是 0，与 Node 的 FileInfo.size 默认值一致）。
	Size int64
	// LastModified 为零值时表示源站没给时间（老式 LIST 无法可靠解析）。
	LastModified time.Time
}

// FileInfo 是单文件 stat 结果。
type FileInfo struct {
	Name         string
	Path         string
	Size         int64
	LastModified time.Time
}

// Error 是面向用户的 FTP 错误。
//
// Code 只用于日志与内部分流，**不下发到 HTTP 响应**——Node 的 FTP 路由
// 只返回 message，没有 code 字段。
type Error struct {
	Message string
	Code    string
}

func (e *Error) Error() string { return e.Message }

// 错误分类。
const (
	CodeUnreachable = "UNREACHABLE"
	CodeAuthFailed  = "AUTH_FAILED"
	CodeNotFound    = "NOT_FOUND"
	CodeTimeout     = "TIMEOUT"
)

func newError(message, code string) *Error {
	return &Error{Message: message, Code: code}
}

// ==================== 控制连接 ====================

type reply struct {
	code int
	// message 是完整响应文本：单行即该行（"530 Login incorrect."），
	// 多行则含首尾行、以 \n 连接。与 basic-ftp 的 res.message 一致。
	message string
}

type client struct {
	ctrl net.Conn
	r    *bufio.Reader
	// host 是控制连接的对端 IP：数据连接的目标（basic-ftp 默认强制
	// 用控制连接地址，防 FTP bounce 与 NAT 场景下的私有地址错配）。
	host string
	// supportsMLSD 由 FEAT 是否声明 MLST 决定（RFC 3659：有 MLST 就有 MLSD）。
	supportsMLSD bool
}

func (c *client) close() {
	if c.ctrl != nil {
		_ = c.ctrl.Close()
	}
}

// readLine 读一行（去 CRLF）。
func (c *client) readLine() (string, error) {
	line, err := c.r.ReadString('\n')
	if err != nil {
		if err == io.EOF && line == "" {
			return "", newError("FTP 服务器关闭了连接", CodeUnreachable)
		}
		return "", c.translate(err)
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// readReply 读一个完整响应（多行响应读到同 token 的结束行）。
func (c *client) readReply() (*reply, error) {
	line, err := c.readLine()
	if err != nil {
		return nil, err
	}
	if len(line) < 3 {
		return nil, newError("FTP 响应格式无效: "+line, CodeUnreachable)
	}
	code, convErr := strconv.Atoi(line[:3])
	if convErr != nil {
		return nil, newError("FTP 响应格式无效: "+line, CodeUnreachable)
	}
	if len(line) > 3 && line[3] == '-' {
		token := line[:3]
		lines := []string{line}
		for {
			next, err := c.readLine()
			if err != nil {
				return nil, err
			}
			lines = append(lines, next)
			if strings.HasPrefix(next, token) && (len(next) == 3 || next[3] == ' ') {
				break
			}
		}
		return &reply{code: code, message: strings.Join(lines, "\n")}, nil
	}
	return &reply{code: code, message: line}, nil
}

// send 写一条命令。
func (c *client) send(command string) error {
	if strings.ContainsAny(command, "\r\n\x00") {
		return errors.New("FTP 命令包含非法字符")
	}
	_ = c.ctrl.SetWriteDeadline(time.Now().Add(opTimeout))
	if _, err := io.WriteString(c.ctrl, command+"\r\n"); err != nil {
		return c.translate(err)
	}
	return nil
}

// request 发命令并读响应；4xx/5xx 转成 Error（文案即服务端原文）。
func (c *client) request(command string) (*reply, error) {
	if err := c.send(command); err != nil {
		return nil, err
	}
	_ = c.ctrl.SetReadDeadline(time.Now().Add(opTimeout))
	res, err := c.readReply()
	if err != nil {
		return nil, err
	}
	if res.code >= 400 {
		return res, newError(res.message, codeFromReply(res.code))
	}
	return res, nil
}

// requestIgnoring 忽略服务端错误码（对应 basic-ftp 的 sendIgnoringError）：
// 传输层错误照常返回，业务错误直接吞掉。
func (c *client) requestIgnoring(command string) *reply {
	res, err := c.request(command)
	if err != nil {
		return nil
	}
	return res
}

// codeFromReply 把 FTP 返回码映射成错误分类。
func codeFromReply(code int) string {
	switch code {
	case 530, 532:
		return CodeAuthFailed
	case 550, 553:
		return CodeNotFound
	}
	return CodeUnreachable
}

// translate 把网络层错误翻译成面向用户的文案。
func (c *client) translate(err error) error {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return newError("FTP 连接 超时", CodeTimeout)
	}
	return newError(err.Error(), CodeUnreachable)
}

// ==================== 建连与登录 ====================

// parseServerURL 拆出主机与是否 FTPS。
//
// 与 Node 的 parseServerUrl 有一处刻意的差异：Node 用
// `serverUrl.replace(/^ftp/i, ”)`，会把 ftp.example.com 变成
// example.com（真·DNS 解析失败）；这里按 scheme 前缀或裸主机正确处理。
func parseServerURL(serverURL string) (host string, secure bool) {
	trimmed := strings.TrimSpace(serverURL)
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "ftp://") || strings.HasPrefix(lower, "ftps://") {
		if parsed, err := url.Parse(trimmed); err == nil && parsed.Host != "" {
			return parsed.Hostname(), strings.HasPrefix(lower, "ftps://")
		}
	}
	// 裸主机形态：host / host:port / host/path
	trimmed = strings.TrimSpace(strings.Split(trimmed, "/")[0])
	trimmed = strings.TrimSpace(strings.Split(trimmed, "\\")[0])
	return trimmed, false
}

// dial 建立控制连接并完成登录与默认设置。
func dial(ctx context.Context, params Params) (*client, error) {
	host, secure := parseServerURL(params.ServerURL)
	if host == "" {
		return nil, newError("FTP 服务器地址不能为空", CodeUnreachable)
	}

	addr := host
	if _, _, err := net.SplitHostPort(host); err != nil {
		addr = net.JoinHostPort(host, strconv.Itoa(params.port()))
	}

	dialer := &net.Dialer{Timeout: opTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, newError("FTP 连接失败: "+err.Error(), CodeUnreachable)
	}
	remoteIP := host
	if tcpAddr, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
		remoteIP = tcpAddr.IP.String()
	}
	c := &client{ctrl: conn, r: bufio.NewReader(conn), host: remoteIP}
	if err := c.handshake(ctx, params, secure); err != nil {
		c.close()
		return nil, err
	}
	return c, nil
}

// handshake 走完「欢迎语 → 可选 AUTH TLS → 登录 → 默认设置」。
func (c *client) handshake(ctx context.Context, params Params, secure bool) error {
	_ = c.ctrl.SetReadDeadline(time.Now().Add(opTimeout))
	welcome, err := c.readReply()
	if err != nil {
		return err
	}
	if welcome.code >= 300 {
		return newError(welcome.message, CodeUnreachable)
	}

	if secure {
		if _, err := c.request("AUTH TLS"); err != nil {
			return err
		}
		tlsConn := tls.Client(c.ctrl, &tls.Config{ServerName: c.host, MinVersion: tls.VersionTLS12})
		_ = tlsConn.SetDeadline(time.Now().Add(opTimeout))
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			return newError("FTP TLS 握手失败: "+err.Error(), CodeUnreachable)
		}
		_ = tlsConn.SetDeadline(time.Time{})
		c.ctrl = tlsConn
		c.r = bufio.NewReader(tlsConn)
	}

	// 登录前先开 UTF-8：用户名/密码里可能有非 ASCII 字符。
	c.requestIgnoring("OPTS UTF8 ON")

	username := params.Username
	if username == "" {
		username = "anonymous"
	}
	password := params.Password
	if password == "" {
		password = "anonymous@"
	}
	userReply, err := c.request("USER " + username)
	if err != nil {
		return err
	}
	if userReply.code == 331 || userReply.code == 332 {
		if _, err := c.request("PASS " + password); err != nil {
			return err
		}
	}

	// FEAT 决定用 MLSD 还是 LIST（失败按「不支持」处理，不阻塞）。
	if feat := c.requestIgnoring("FEAT"); feat != nil && feat.code < 400 {
		c.supportsMLSD = parseFeatures(feat.message)["MLST"]
	}
	if _, err := c.request("TYPE I"); err != nil {
		return err
	}
	c.requestIgnoring("STRU F")
	c.requestIgnoring("OPTS UTF8 ON")
	if c.supportsMLSD {
		c.requestIgnoring("OPTS MLST type;size;modify;unique;unix.mode;unix.owner;unix.group;unix.ownername;unix.groupname;")
	}
	return nil
}

// parseFeatures 解析 FEAT 的多行响应（首尾是状态行，中间每条一行）。
func parseFeatures(message string) map[string]bool {
	features := make(map[string]bool)
	lines := strings.Split(message, "\n")
	if len(lines) < 2 {
		return features
	}
	for _, line := range lines[1 : len(lines)-1] {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		features[strings.ToUpper(fields[0])] = true
	}
	return features
}

// ==================== 数据连接 ====================

// enterPassive 打开被动模式数据连接。
//
// 先试 EPSV（IPv6 与穿透友好），被拒再回退 PASV——与 basic-ftp 的
// _enterFirstCompatibleMode 顺序一致。
func (c *client) enterPassive() (net.Conn, error) {
	if res, err := c.request("EPSV"); err == nil {
		port, parseErr := parseEPSVPort(res.message)
		if parseErr == nil {
			return c.dialData(net.JoinHostPort(c.host, strconv.Itoa(port)))
		}
	}
	res, err := c.request("PASV")
	if err != nil {
		return nil, err
	}
	_, port, parseErr := parsePASVAddress(res.message)
	if parseErr != nil {
		return nil, parseErr
	}
	// 忽略 PASV 回报的主机：basic-ftp 默认同样强制用控制连接地址。
	return c.dialData(net.JoinHostPort(c.host, strconv.Itoa(port)))
}

func (c *client) dialData(addr string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: opTimeout}
	conn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return nil, newError("FTP 数据连接失败: "+err.Error(), CodeUnreachable)
	}
	return conn, nil
}

var reEPSV = regexp.MustCompile(`[|!]{3}([0-9]+)[|!]`)

func parseEPSVPort(message string) (int, error) {
	m := reEPSV.FindStringSubmatch(message)
	if m == nil {
		return 0, newError("无法解析 EPSV 响应: "+message, CodeUnreachable)
	}
	port, err := strconv.Atoi(m[1])
	if err != nil || port <= 0 || port > 65535 {
		return 0, newError("无法解析 EPSV 响应: "+message, CodeUnreachable)
	}
	return port, nil
}

var rePASV = regexp.MustCompile(`([-\d]+,[-\d]+,[-\d]+,[-\d]+),([-\d]+),([-\d]+)`)

func parsePASVAddress(message string) (string, int, error) {
	m := rePASV.FindStringSubmatch(message)
	if m == nil {
		return "", 0, newError("无法解析 PASV 响应: "+message, CodeUnreachable)
	}
	high, _ := strconv.Atoi(m[2])
	low, _ := strconv.Atoi(m[3])
	return strings.ReplaceAll(m[1], ",", "."), (high&255)*256 + (low & 255), nil
}

// ==================== 目录列举 ====================

// listCandidates 返回本轮可尝试的列举命令。
//
// 注意 basic-ftp 会把命中的候选记在 client 上复用；我们的 client 是
// 「一次操作一条连接」的生命周期，所以每次都从第一个开始试。
func (c *client) listCandidates() []string {
	if c.supportsMLSD {
		return []string{"MLSD", "LIST -a", "LIST"}
	}
	return []string{"LIST -a", "LIST"}
}

// list 尝试候选命令列当前目录，返回原始文本。
func (c *client) list() (string, error) {
	var lastErr error
	for _, candidate := range c.listCandidates() {
		text, err := c.listRaw(candidate)
		if err == nil {
			return text, nil
		}
		lastErr = err
		var ftpErr *Error
		// 只有「服务端明确拒绝」才换下一条命令；网络错误直接失败。
		if !errors.As(err, &ftpErr) || ftpErr.Code == CodeTimeout {
			return "", err
		}
	}
	return "", lastErr
}

// listRaw 执行一条目录列举命令并读完数据连接。
func (c *client) listRaw(command string) (string, error) {
	dataConn, err := c.enterPassive()
	if err != nil {
		return "", err
	}
	defer dataConn.Close()

	if err := c.send(command); err != nil {
		return "", err
	}
	_ = c.ctrl.SetReadDeadline(time.Now().Add(opTimeout))
	res, err := c.readReply()
	if err != nil {
		return "", err
	}
	if res.code >= 400 {
		return "", newError(res.message, codeFromReply(res.code))
	}
	if res.code != 125 && res.code != 150 {
		// 200/226：服务器直接报告「已完成」，目录为空
		return "", nil
	}

	text, err := readLimited(dataConn, maxListingBytes)
	if err != nil {
		return "", err
	}
	// 收尾响应：成功是 226（或 250），失败要报出去
	_ = c.ctrl.SetReadDeadline(time.Now().Add(opTimeout))
	final, err := c.readReply()
	if err != nil {
		return "", err
	}
	if final.code >= 400 {
		return "", newError(final.message, codeFromReply(final.code))
	}
	return text, nil
}

func readLimited(reader io.Reader, limit int64) (string, error) {
	buf, err := io.ReadAll(io.LimitReader(reader, limit))
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return "", newError("FTP 数据连接 超时", CodeTimeout)
		}
		return "", newError(err.Error(), CodeUnreachable)
	}
	return string(buf), nil
}

// ListDir 列出目录，返回带绝对路径的目录项。
func ListDir(ctx context.Context, params Params, targetPath string) ([]Entry, error) {
	// 目录选择与 Node 的 listFTPDirectory 一致：
	// 显式 targetPath 优先，其次挂载 path，最后根目录。
	dir := targetPath
	if dir == "" {
		dir = params.Path
	}
	if strings.TrimSpace(dir) == "" {
		dir = "/"
	}

	var entries []Entry
	err := withClient(ctx, params, func(c *client) error {
		command, err := c.absolute(dir)
		if err != nil {
			return err
		}
		if _, err := c.request("CWD " + command); err != nil {
			return err
		}
		text, err := c.list()
		if err != nil {
			return err
		}
		items, err := parseListing(text)
		if err != nil {
			return err
		}
		prefix := dir
		if !strings.HasSuffix(prefix, "/") {
			prefix += "/"
		}
		entries = make([]Entry, 0, len(items))
		for _, item := range items {
			entries = append(entries, Entry{
				Name:         item.name,
				Path:         prefix + item.name,
				Type:         item.displayType(),
				Size:         item.size,
				LastModified: item.modified,
			})
		}
		_ = c.requestIgnoring("QUIT")
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

// absolute 复刻 basic-ftp 的 protectWhitespace：路径以空格开头时，
// 裸命令会被服务器当成「无参数」，必须先拼上当前工作目录。
func (c *client) absolute(path string) (string, error) {
	if !strings.HasPrefix(path, " ") {
		return path, nil
	}
	res, err := c.request("PWD")
	if err != nil {
		return "", err
	}
	start := strings.Index(res.message, `"`)
	end := strings.LastIndex(res.message, `"`)
	if start < 0 || end <= start {
		return "", newError("无法解析 PWD 响应: "+res.message, CodeUnreachable)
	}
	pwd := res.message[start+1 : end]
	if !strings.HasSuffix(pwd, "/") {
		pwd += "/"
	}
	return pwd + path, nil
}

// ==================== stat ====================

// Stat 取单文件信息：优先 SIZE + MDTM，失败回退 CWD + LIST。
//
// SIZE/MDTM 各一次往返，而 LIST 要扫整个目录——视频 seek 时每个 Range
// 请求都会 stat 一次，高延迟 FTP 下这个差别就是秒级的手感差异。
func Stat(ctx context.Context, params Params) (FileInfo, error) {
	var info FileInfo
	err := withClient(ctx, params, func(c *client) error {
		filename := lastSegment(params.Path)

		size, sizeErr := c.fileSize(params.Path)
		if sizeErr == nil {
			info = FileInfo{Name: filename, Path: params.Path, Size: size}
			// MDTM 是可选命令，失败只丢时间戳，不影响 stat 结果
			if modified, err := c.lastModified(params.Path); err == nil {
				info.LastModified = modified
			}
			_ = c.requestIgnoring("QUIT")
			return nil
		}

		dir := parentDir(params.Path)
		command, err := c.absolute(dir)
		if err != nil {
			return err
		}
		if _, err := c.request("CWD " + command); err != nil {
			return err
		}
		text, err := c.list()
		if err != nil {
			return err
		}
		items, err := parseListing(text)
		if err != nil {
			return err
		}
		for _, item := range items {
			if item.name == filename && item.kind == kindFile {
				info = FileInfo{Name: item.name, Path: params.Path, Size: item.size, LastModified: item.modified}
				_ = c.requestIgnoring("QUIT")
				return nil
			}
		}
		return newError("FTP 文件不存在", CodeNotFound)
	})
	if err != nil {
		return FileInfo{}, err
	}
	return info, nil
}

// fileSize 执行 SIZE；返回错误表示服务器不支持或文件不存在。
func (c *client) fileSize(path string) (int64, error) {
	command, err := c.absolute(path)
	if err != nil {
		return 0, err
	}
	res, err := c.request("SIZE " + command)
	if err != nil {
		return 0, err
	}
	// 响应形如 "213 555555"，也可能带注释 "213 5555, some commentary"
	rest := strings.TrimSpace(res.message[3:])
	if idx := strings.IndexAny(rest, ", "); idx > 0 {
		rest = rest[:idx]
	}
	size, convErr := strconv.ParseInt(rest, 10, 64)
	if convErr != nil {
		return 0, newError("无法解析 SIZE 响应: "+res.message, CodeUnreachable)
	}
	return size, nil
}

// lastModified 执行 MDTM（RFC 3659 的 YYYYMMDDHHMMSS[.sss]）。
func (c *client) lastModified(path string) (time.Time, error) {
	command, err := c.absolute(path)
	if err != nil {
		return time.Time{}, err
	}
	res, err := c.request("MDTM " + command)
	if err != nil {
		return time.Time{}, err
	}
	value := strings.TrimSpace(res.message[3:])
	return parseMLSxDate(value)
}

func lastSegment(path string) string {
	trimmed := strings.TrimRight(path, "/")
	if idx := strings.LastIndex(trimmed, "/"); idx >= 0 {
		return trimmed[idx+1:]
	}
	return trimmed
}

func parentDir(path string) string {
	trimmed := strings.TrimRight(path, "/")
	idx := strings.LastIndex(trimmed, "/")
	if idx <= 0 {
		return "/"
	}
	return trimmed[:idx]
}

// withClient 完成「建连 → 执行 → 断开」的完整生命周期（每次操作一条连接，
// 与 Node 的 statFTPFile / listFTPDirectory 一致）。
func withClient(ctx context.Context, params Params, fn func(*client) error) error {
	opCtx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	c, err := dial(opCtx, params)
	if err != nil {
		return err
	}
	defer c.close()
	return fn(c)
}

// ==================== 取流 ====================

// OpenStream 从 offset 处打开文件流。
//
// 返回的 ReadCloser 同时持有控制连接与数据连接，Close 时一并释放；
// 读到 EOF 时会尝试读掉服务端的 226 收尾响应（否则控制连接会留下
// 「未读响应」，QUIT 之类的后续命令会读到错位的结果）。
//
// 与 Node 一致：不做 end 截断，服务端从 offset 一直发到文件尾。
func OpenStream(ctx context.Context, params Params, offset int64) (io.ReadCloser, error) {
	c, err := dial(ctx, params)
	if err != nil {
		return nil, err
	}
	dataConn, err := c.enterPassive()
	if err != nil {
		c.close()
		return nil, err
	}

	if offset > 0 {
		res, err := c.request("REST " + strconv.FormatInt(offset, 10))
		if err != nil {
			dataConn.Close()
			c.close()
			return nil, err
		}
		_ = res
	}

	command, err := c.absolute(params.Path)
	if err != nil {
		dataConn.Close()
		c.close()
		return nil, err
	}
	if err := c.send("RETR " + command); err != nil {
		dataConn.Close()
		c.close()
		return nil, err
	}
	_ = c.ctrl.SetReadDeadline(time.Now().Add(opTimeout))
	res, err := c.readReply()
	if err != nil {
		dataConn.Close()
		c.close()
		return nil, err
	}
	if res.code >= 400 {
		dataConn.Close()
		c.close()
		return nil, newError(res.message, codeFromReply(res.code))
	}
	if res.code != 125 && res.code != 150 {
		dataConn.Close()
		c.close()
		return nil, newError("FTP 服务器未开始传输: "+res.message, CodeUnreachable)
	}
	return &stream{data: dataConn, ctrl: c}, nil
}

type stream struct {
	data net.Conn
	ctrl *client
	// finished 保证收尾响应只读一次（Read 与 Close 都可能触发）。
	finished bool
}

func (s *stream) Read(p []byte) (int, error) {
	_ = s.data.SetReadDeadline(time.Now().Add(streamIdleTimeout))
	n, err := s.data.Read(p)
	if err == io.EOF {
		s.finish()
	}
	if err != nil && err != io.EOF {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return n, newError("FTP 数据连接 超时", CodeTimeout)
		}
	}
	return n, err
}

// finish 读掉 226 收尾响应并释放控制连接。
func (s *stream) finish() {
	if s.finished {
		return
	}
	s.finished = true
	_ = s.ctrl.ctrl.SetReadDeadline(time.Now().Add(opTimeout))
	_, _ = s.ctrl.readReply()
	s.ctrl.close()
}

func (s *stream) Close() error {
	_ = s.data.Close()
	s.finish()
	s.ctrl.close()
	return nil
}

// ==================== 目录列举解析 ====================

// 内部的文件类型枚举，对应 basic-ftp 的 FileType。
const (
	kindUnknown = iota
	kindFile
	kindDirectory
	kindSymbolicLink
)

type rawEntry struct {
	name     string
	size     int64
	kind     int
	modified time.Time
	link     string
	uniqueID string
}

// displayType 复刻 Node 的 `item.type === 1 ? 'file' : 'directory'`。
func (r rawEntry) displayType() string {
	if r.kind == kindFile {
		return TypeFile
	}
	return TypeDirectory
}

var (
	reDOSLine  = regexp.MustCompile(`(\S+)\s+(\S+)\s+(?:(<DIR>)|([0-9]+))\s+(\S.*)`)
	reUnixLine = regexp.MustCompile(`([bcdelfmpSs-])` +
		`(((r|-)(w|-)([xsStTL-]))((r|-)(w|-)([xsStTL-]))((r|-)(w|-)([xsStTL-]?)))\+?` +
		`\s*` +
		`(\d+)` +
		`\s+` +
		`(?:(\S+(?:\s\S+)*?)\s+)?` +
		`(?:(\S+(?:\s\S+)*)\s+)?` +
		`(\d+(?:,\s*\d+)?)` +
		`\s+` +
		`(` +
		`(?:\d+[-/]\d+[-/]\d+)` +
		`|(?:\S{3}\s+\d{1,2})` +
		`|(?:\d{1,2}\s+\S{3})` +
		`|(?:\d{1,2}月\s+\d{1,2}日)` +
		`)` +
		`\s+` +
		`((?:\d+(?::\d+)?)|(?:\d{4}年))` +
		`\s` +
		`(.*)`)
)

// parseListing 复刻 basic-ftp 的 parseList：用**最后一行**判定格式，
// 再用同一个解析器处理全部行。
func parseListing(rawList string) ([]rawEntry, error) {
	lines := make([]string, 0, 16)
	for _, line := range strings.Split(strings.ReplaceAll(rawList, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.HasPrefix(line, "total") {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return nil, nil
	}

	last := lines[len(lines)-1]
	var parse func(string) *rawEntry
	switch {
	case isDOSLine(last):
		parse = parseDOSLine
	case reUnixLine.MatchString(last):
		parse = parseUnixLine
	case isMLSDLine(last):
		parse = parseMLSDLine
	default:
		return nil, newError("不支持该 FTP 服务器的目录格式（仅支持 MLSD / Unix / DOS 三种）", CodeUnreachable)
	}

	entries := make([]rawEntry, 0, len(lines))
	for _, line := range lines {
		if item := parse(line); item != nil {
			entries = append(entries, *item)
		}
	}
	// MLSD 的符号链接可能指向目录外的路径，带 "/" 的条目不属于本目录
	if isMLSDLine(last) {
		filtered := entries[:0]
		for _, item := range entries {
			if !strings.Contains(item.name, "/") {
				filtered = append(filtered, item)
			}
		}
		entries = filtered
	}
	return entries, nil
}

func isDOSLine(line string) bool {
	if len(line) < 2 || line[0] < '0' || line[0] > '9' || line[1] < '0' || line[1] > '9' {
		return false
	}
	return reDOSLine.MatchString(line)
}

func isMLSDLine(line string) bool {
	if strings.HasPrefix(line, " ") {
		return true
	}
	// ^\S+=\S+;
	if idx := strings.Index(line, " "); idx > 0 {
		facts := line[:idx]
		return strings.Contains(facts, "=") && strings.HasSuffix(facts, ";")
	}
	return false
}

func parseDOSLine(line string) *rawEntry {
	m := reDOSLine.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	name := m[5]
	if name == "." || name == ".." {
		return nil
	}
	item := &rawEntry{name: name, kind: kindFile}
	if m[3] == "<DIR>" {
		item.kind = kindDirectory
		item.size = 0
		return item
	}
	item.size, _ = strconv.ParseInt(m[4], 10, 64)
	return item
}

func parseUnixLine(line string) *rawEntry {
	m := reUnixLine.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	name := m[21]
	if name == "." || name == ".." {
		return nil
	}
	item := &rawEntry{name: name}
	sizeText := m[18]
	if idx := strings.Index(sizeText, ","); idx >= 0 {
		sizeText = strings.ReplaceAll(sizeText[:idx], " ", "")
	}
	item.size, _ = strconv.ParseInt(sizeText, 10, 64)

	switch m[1][0] {
	case 'd':
		item.kind = kindDirectory
	case 'l', 'e':
		item.kind = kindSymbolicLink
	case 'b', 'c', 'f', '-':
		item.kind = kindFile
	default:
		item.kind = kindUnknown
	}
	// 符号链接名形如 "link -> target"，展示名只取箭头前那段
	if item.kind == kindSymbolicLink {
		if idx := strings.Index(name, " -> "); idx >= 0 {
			item.name = name[:idx]
			item.link = name[idx+4:]
		}
	}
	return item
}

func parseMLSDLine(line string) *rawEntry {
	space := strings.Index(line, " ")
	if space < 0 {
		return nil
	}
	packedFacts := line[:space]
	name := line[space+1:]
	if name == "" || name == "." || name == ".." {
		return nil
	}
	item := &rawEntry{name: name, kind: kindUnknown}
	for _, fact := range strings.Split(packedFacts, ";") {
		eq := strings.Index(fact, "=")
		if eq < 0 {
			continue
		}
		key := strings.ToLower(fact[:eq])
		value := fact[eq+1:]
		if value == "" {
			continue
		}
		switch key {
		case "size", "sizd":
			item.size, _ = strconv.ParseInt(value, 10, 64)
		case "modify":
			if modified, err := parseMLSxDate(value); err == nil {
				item.modified = modified
			}
		case "unique":
			item.uniqueID = value
		case "type":
			switch {
			case strings.HasPrefix(value, "OS.unix=slink"):
				item.kind = kindSymbolicLink
				if idx := strings.Index(value, ":"); idx >= 0 {
					item.link = value[idx+1:]
				}
			case value == "file":
				item.kind = kindFile
			case value == "dir":
				item.kind = kindDirectory
			case value == "OS.unix=symlink":
				item.kind = kindSymbolicLink
			case value == "cdir", value == "pdir":
				// 当前目录 / 父目录，不进入列表
				return nil
			default:
				item.kind = kindUnknown
			}
		}
	}
	return item
}

// parseMLSxDate 解析 RFC 3659 时间（YYYYMMDDHHMMSS[.sss]，UTC）。
func parseMLSxDate(fact string) (time.Time, error) {
	value := strings.TrimSpace(fact)
	if len(value) < 14 {
		return time.Time{}, fmt.Errorf("时间格式无效: %s", value)
	}
	digits := func(from, to int) int {
		if len(value) < to {
			return 0
		}
		number, err := strconv.Atoi(value[from:to])
		if err != nil {
			return 0
		}
		return number
	}
	millis := 0
	if len(value) >= 18 {
		millis = digits(15, 18)
	}
	return time.Date(
		digits(0, 4), time.Month(digits(4, 6)), digits(6, 8),
		digits(8, 10), digits(10, 12), digits(12, 14),
		millis*int(time.Millisecond), time.UTC,
	), nil
}

// ==================== 缓存 ====================

// StatCache 缓存单文件 stat（30s / 200 条）。
//
// 视频 seek 时每个 Range 请求都要 stat 一次（一次完整登录 + SIZE），
// 而文件大小在播放期间不会变。文件被替换时最多 30s 后自愈。
type StatCache struct {
	mu    sync.Mutex
	items map[string]statItem
}

type statItem struct {
	info FileInfo
	at   time.Time
}

const (
	statCacheTTL = 30 * time.Second
	statCacheCap = 200
)

// NewStatCache 构造 stat 缓存。
func NewStatCache() *StatCache {
	return &StatCache{items: make(map[string]statItem, 32)}
}

// StatCached 走缓存的 Stat。
func StatCached(ctx context.Context, params Params, cache *StatCache) (FileInfo, error) {
	key := cacheKey(params)
	if cache != nil {
		if info, ok := cache.get(key); ok {
			return info, nil
		}
	}
	info, err := Stat(ctx, params)
	if err != nil {
		return FileInfo{}, err
	}
	if cache != nil {
		cache.set(key, info)
	}
	return info, nil
}

func (c *StatCache) get(key string) (FileInfo, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[key]
	if !ok {
		return FileInfo{}, false
	}
	if time.Since(item.at) >= statCacheTTL {
		delete(c.items, key)
		return FileInfo{}, false
	}
	return item.info, true
}

func (c *StatCache) set(key string, info FileInfo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if len(c.items) >= statCacheCap {
		for k, v := range c.items {
			if now.Sub(v.at) >= statCacheTTL {
				delete(c.items, k)
			}
		}
		// 还有满的说明全是新鲜条目：整表清空（与 Node 的处理一致）
		if len(c.items) >= statCacheCap {
			c.items = make(map[string]statItem, 32)
		}
	}
	c.items[key] = statItem{info: info, at: now}
}

// DirCache 缓存目录列举（60s / 300 条）。
//
// 浏览界面反复进出目录，每次都重开一条 FTP 连接（登录 + LIST）太贵。
// 只有 browse 用缓存，mounts/test 必须直连（陈旧缓存会把「连不上」测成通过）。
type DirCache struct {
	mu    sync.Mutex
	items map[string]dirItem
	order []string
}

type dirItem struct {
	entries []Entry
	at      time.Time
}

const (
	dirCacheTTL = 60 * time.Second
	dirCacheCap = 300
)

// NewDirCache 构造目录缓存。
func NewDirCache() *DirCache {
	return &DirCache{items: make(map[string]dirItem, 32)}
}

// ListDirCached 走缓存的 ListDir。
//
// 缓存 key 里的目录取「显式 targetPath，否则挂载 path，最后 /」，
// 与 Node 的 listFTPDirectoryCached 一致。
func ListDirCached(ctx context.Context, params Params, targetPath string, cache *DirCache) ([]Entry, error) {
	dir := targetPath
	if dir == "" {
		dir = params.Path
	}
	if dir == "" {
		dir = "/"
	}
	key := cacheKey(params) + "|" + dir
	if cache != nil {
		if entries, ok := cache.get(key); ok {
			return entries, nil
		}
	}
	entries, err := ListDir(ctx, params, targetPath)
	if err != nil {
		return nil, err
	}
	if cache != nil {
		cache.set(key, entries)
	}
	return entries, nil
}

func (c *DirCache) get(key string) ([]Entry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[key]
	if !ok {
		return nil, false
	}
	if time.Since(item.at) >= dirCacheTTL {
		delete(c.items, key)
		return nil, false
	}
	// LRU：命中后挪到队尾
	c.touch(key)
	return item.entries, true
}

func (c *DirCache) set(key string, entries []Entry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.items[key]; !exists {
		c.order = append(c.order, key)
	}
	c.items[key] = dirItem{entries: entries, at: time.Now()}
	for len(c.items) > dirCacheCap && len(c.order) > 0 {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.items, oldest)
	}
}

func (c *DirCache) touch(key string) {
	for i, existing := range c.order {
		if existing == key {
			c.order = append(append(c.order[:i:i], c.order[i+1:]...), key)
			return
		}
	}
	c.order = append(c.order, key)
}

// cacheKey 复刻 Node 的 `${serverUrl}|${port || 21}|${username || ”}|${path}`。
func cacheKey(params Params) string {
	return fmt.Sprintf("%s|%d|%s|%s", params.ServerURL, params.port(), params.Username, params.Path)
}

// NormalizeMountPath 给挂载路径补前导斜杠。
//
// basic-ftp 的 cd 会把无前导 / 的路径解释成「相对登录目录」，行为因服务器
// 而异；统一补 / 保证绝对语义（Node 的 mountToParams 同样这么处理）。
func NormalizeMountPath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "/"
	}
	if !strings.HasPrefix(trimmed, "/") {
		return "/" + trimmed
	}
	return trimmed
}
