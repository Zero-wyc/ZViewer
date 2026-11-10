package ftp

import (
	"bufio"
	"context"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"

	"zviewer/backend/internal/proxy"
)

// fakeFTPServer 是最小可用的 FTP 服务器：只实现播放路径会发的命令。
//
// 存在的意义是断言「首播用了几条连接、几次登录、几次 SIZE」——这些是
// 公网 FTP 上最贵的往返，纯函数测试覆盖不到。
type fakeFTPServer struct {
	ln   net.Listener
	size int64
	data []byte

	mu     sync.Mutex
	conns  int
	logins int
	sizes  int
	retrs  int
	rests  []string
}

func newFakeFTPServer(t *testing.T, size int64) *fakeFTPServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i % 251)
	}
	s := &fakeFTPServer{ln: ln, size: size, data: data}
	go s.acceptLoop()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeFTPServer) addr() string { return s.ln.Addr().String() }

// params 构造指向假服务器的连接参数。
//
// 端口必须走 Params.Port：parseServerURL 用的是 url.Hostname()，
// 会把 ftp://host:port 里的端口丢掉（与 Node 侧一致——端口是挂载字段）。
func (s *fakeFTPServer) params() Params {
	port := s.ln.Addr().(*net.TCPAddr).Port
	return Params{
		ServerURL: "ftp://127.0.0.1",
		Path:      "/movies/a.mp4",
		Username:  "u",
		Password:  "p",
		Port:      port,
	}
}

func (s *fakeFTPServer) counts() (conns, logins, sizes, retrs int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns, s.logins, s.sizes, s.retrs
}

func (s *fakeFTPServer) acceptLoop() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns++
		s.mu.Unlock()
		go s.handle(conn)
	}
}

func (s *fakeFTPServer) handle(conn net.Conn) {
	defer conn.Close()
	write := func(line string) { _, _ = io.WriteString(conn, line+"\r\n") }

	write("220 fake ftp ready")
	r := bufio.NewReader(conn)
	var pasv net.Listener
	var offset int64

	for {
		raw, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line := strings.TrimRight(raw, "\r\n")
		parts := strings.SplitN(line, " ", 2)
		cmd := strings.ToUpper(parts[0])
		arg := ""
		if len(parts) > 1 {
			arg = parts[1]
		}

		switch cmd {
		case "OPTS", "TYPE", "STRU":
			write("200 ok")
		case "FEAT":
			write("211-Features:")
			write(" SIZE")
			write("211 End")
		case "USER":
			write("331 password required")
		case "PASS":
			s.mu.Lock()
			s.logins++
			s.mu.Unlock()
			write("230 logged in")
		case "NOOP":
			write("200 ok")
		case "SIZE":
			s.mu.Lock()
			s.sizes++
			s.mu.Unlock()
			write("213 " + strconv.FormatInt(s.size, 10))
		case "EPSV":
			if pasv != nil {
				_ = pasv.Close()
			}
			pasv, err = net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				write("425 cannot open data connection")
				continue
			}
			port := pasv.Addr().(*net.TCPAddr).Port
			write("229 Entering Extended Passive Mode (|||" + strconv.Itoa(port) + "|)")
		case "PASV":
			if pasv != nil {
				_ = pasv.Close()
			}
			pasv, err = net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				write("425 cannot open data connection")
				continue
			}
			port := pasv.Addr().(*net.TCPAddr).Port
			write("227 Entering Passive Mode (127,0,0,1," +
				strconv.Itoa(port/256) + "," + strconv.Itoa(port%256) + ")")
		case "REST":
			s.mu.Lock()
			s.rests = append(s.rests, arg)
			s.mu.Unlock()
			offset, _ = strconv.ParseInt(arg, 10, 64)
			write("350 restart position accepted")
		case "RETR":
			if pasv == nil {
				write("425 use PASV first")
				continue
			}
			s.mu.Lock()
			s.retrs++
			s.mu.Unlock()
			write("150 opening data connection")
			dataConn, acceptErr := pasv.Accept()
			_ = pasv.Close()
			pasv = nil
			if acceptErr != nil {
				write("425 data connection failed")
				continue
			}
			start := offset
			if start > int64(len(s.data)) {
				start = int64(len(s.data))
			}
			_, _ = dataConn.Write(s.data[start:])
			_ = dataConn.Close()
			offset = 0
			write("226 transfer complete")
		case "QUIT":
			write("221 bye")
			return
		default:
			write("500 unknown command")
		}
	}
}

func resetIdleConns() {
	idleConns.mu.Lock()
	idleConns.idle = make(map[string][]pooledConn)
	idleConns.mu.Unlock()
}

// 首播的核心回归：SIZE 与 RETR 在同一条控制连接上完成。
func TestOpenMergesStatAndRetrIntoOneSession(t *testing.T) {
	resetIdleConns()
	srv := newFakeFTPServer(t, 4096)

	stream, err := Open(context.Background(), srv.params(), "bytes=0-", nil, proxy.MaxRangeChunkBytes)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	body, _ := io.ReadAll(stream.Body)
	_ = stream.Body.Close()

	conns, logins, sizes, retrs := srv.counts()
	if conns != 1 || logins != 1 {
		t.Errorf("首播应只建 1 条连接、登录 1 次，实际 conns=%d logins=%d", conns, logins)
	}
	if sizes != 1 || retrs != 1 {
		t.Errorf("应各发 1 次 SIZE/RETR，实际 sizes=%d retrs=%d", sizes, retrs)
	}
	if stream.Size != 4096 {
		t.Errorf("Size 应为 4096，实际 %d", stream.Size)
	}
	if !stream.Ranged || stream.Start != 0 || stream.End != 4095 {
		t.Errorf("区间应为 0-4095 且 Ranged，实际 %v %d-%d", stream.Ranged, stream.Start, stream.End)
	}
	if len(body) != 4096 {
		t.Errorf("应读到整个文件，实际 %d 字节", len(body))
	}
}

// 连续两次取流复用同一条控制连接：第二个分片不再付出 TCP+登录成本。
func TestOpenReusesControlConnection(t *testing.T) {
	resetIdleConns()
	srv := newFakeFTPServer(t, 2048)
	cache := NewStatCache()
	params := srv.params()

	for i := 0; i < 2; i++ {
		stream, err := Open(context.Background(), params, "bytes=0-", cache, proxy.MaxRangeChunkBytes)
		if err != nil {
			t.Fatalf("第 %d 次 Open: %v", i+1, err)
		}
		if _, err := io.ReadAll(stream.Body); err != nil {
			t.Fatalf("第 %d 次读取: %v", i+1, err)
		}
		_ = stream.Body.Close()
	}

	conns, logins, sizes, retrs := srv.counts()
	if conns != 1 || logins != 1 {
		t.Errorf("第二次取流应复用控制连接，实际 conns=%d logins=%d", conns, logins)
	}
	if sizes != 1 {
		t.Errorf("第二次应命中 stat 缓存、不再 SIZE，实际 sizes=%d", sizes)
	}
	if retrs != 2 {
		t.Errorf("两次取流应各发一次 RETR，实际 retrs=%d", retrs)
	}
}

// 中段 Range 必须发 REST（否则会从头返回，播放器看到的字节全错位）。
func TestOpenSendsRestOffset(t *testing.T) {
	resetIdleConns()
	srv := newFakeFTPServer(t, 4096)

	stream, err := Open(context.Background(), srv.params(), "bytes=1024-2047", nil, proxy.MaxRangeChunkBytes)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	body, _ := io.ReadAll(stream.Body)
	_ = stream.Body.Close()

	srv.mu.Lock()
	rests := append([]string(nil), srv.rests...)
	srv.mu.Unlock()
	if len(rests) != 1 || rests[0] != "1024" {
		t.Errorf("应发一次 REST 1024，实际 %v", rests)
	}
	if stream.Start != 1024 || stream.End != 2047 {
		t.Errorf("区间应为 1024-2047，实际 %d-%d", stream.Start, stream.End)
	}
	// 服务器从 offset 一直发到文件尾，长度由上层按区间截断。
	if int64(len(body)) != stream.Size-1024 {
		t.Errorf("应读到偏移后的剩余字节，实际 %d", len(body))
	}
}
