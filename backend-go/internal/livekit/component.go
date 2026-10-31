package livekit

// LiveKit 二进制的**按需下载兜底**。
//
// 语音组件本身随产物分发（build-all 从 backend-go/dev-bin 复制），正常安装里
// livekit-server 一定存在，本文件对它们来说是死代码。留着是给「二进制被手动删掉 /
// 复制产物时漏拷」的场景兜底：房间里的「下载语音聊天组件」能把它补回来，不用重装。
//
// 下载源与桌面端可选组件（cloudflared / EasyTier / frpc）完全一致：
// 产物仓库 ZviewerRelease 的 components 分支，境内走 GitCode 的 raw 端点，
// 取不到再退回 GitHub（raw 直链 → 官方 Release 资产）。
//
// 安装位置就是可执行文件同目录（生产 rintime/），也就是 findBinary 的第一优先级；
// 装完后立即把伴生进程拉起来，不需要重启后端。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	// componentRepo 是存放可选组件的产物仓库（与主仓库分开发版）。
	componentRepo = "Zero-wyc/ZviewerRelease"
	// componentRef 是组件库分支：发版只替换 main，components 分支长期稳定。
	componentRef = "components"
	// componentGitCodeBase 是 GitCode 的仓库文件直连接口。
	//
	// 不用 raw.gitcode.com：那个域名前挂 CloudWAF，对非浏览器指纹一律 418。
	// 与 updater.mirrorRawBase / 桌面端 components.go 用的是同一个端点。
	componentGitCodeBase = "https://api.gitcode.com/api/v5/repos/" + componentRepo + "/raw"
	// componentGitHubRaw 是同一份文件的 GitHub 直链（境内多半不通，仅作兜底）。
	componentGitHubRaw = "https://raw.githubusercontent.com/" + componentRepo + "/" + componentRef
	// componentProxy 是社区 CDN 前缀（与「更新 CDN 加速」默认值同一个站）：
	// GitCode 还没镜像到 components 分支时，用它先顶上。
	componentProxy = "https://gh-proxy.com/"
	// componentMaxBytes 是下载体积上限，防止拿到一段 HTML 错误页也当成压缩包。
	componentMaxBytes = 120 << 20
)

// 下载状态机。前端按 state 决定是显示「下载」按钮、进度条还是错误提示。
const (
	// StateIdle 表示既没有二进制、也没有在下载（首次进房间就是它）。
	StateIdle = "idle"
	// StateDownloading 表示正在下载压缩包。
	StateDownloading = "downloading"
	// StateInstalling 表示压缩包已下完，正在解出二进制。
	StateInstalling = "installing"
	// StateReady 表示二进制就位（进程是否起来由 Running 另说）。
	StateReady = "ready"
	// StateError 表示上一次下载/安装失败。
	StateError = "error"
	// StateExternal 表示部署方自带了 LiveKit（LIVEKIT_EXTERNAL=1），无需下载。
	StateExternal = "external"
)

// ErrInstallInProgress 表示已有一次下载在进行，重复请求直接返回它。
var ErrInstallInProgress = errors.New("语音组件正在下载中")

// ErrAlreadyInstalled 表示二进制已经在了（重复点下载按钮）。
var ErrAlreadyInstalled = errors.New("语音组件已安装")

// ErrExternalLiveKit 表示部署方自带了 LiveKit，内嵌组件不参与。
var ErrExternalLiveKit = errors.New("当前部署使用外置 LiveKit，无需下载")

// Status 是 /api/voice/status 的响应体。
type Status struct {
	// Available 为 true 时前端才允许点「加入语音」。
	Available bool `json:"available"`
	// State 见上面的 State* 常量。
	State string `json:"state"`
	// Progress 是 0–100 的整数百分比（总大小未知时为 0）。
	Progress int `json:"progress"`
	// Received / Total 是原始字节数，前端可自行格式化。
	Received int64 `json:"received"`
	Total    int64 `json:"total"`
	// Message 是给用户看的一句话（失败原因、正在做什么）。
	Message string `json:"message"`
	// Version 是期望的 LiveKit 版本（v1.13.7）。
	Version string `json:"version"`
	// External 表示用的是外置 LiveKit，与内嵌组件无关。
	External bool `json:"external"`
}

// componentFileName 返回组件库里的压缩包文件名。
//
// 与 build-all.js 的资产命名保持一致，方便两份东西对得上号。
func componentFileName() (string, error) {
	ver := strings.TrimPrefix(BinaryVersion, "v")
	switch runtime.GOOS {
	case "windows":
		return fmt.Sprintf("livekit_%s_windows_%s.zip", ver, runtime.GOARCH), nil
	case "linux":
		return fmt.Sprintf("livekit_%s_linux_%s.tar.gz", ver, runtime.GOARCH), nil
	case "darwin":
		return fmt.Sprintf("livekit_%s_darwin_%s.tar.gz", ver, runtime.GOARCH), nil
	default:
		return "", errUnsupportedPlatform
	}
}

// componentSources 按优先级返回下载地址：境内镜像 → GitHub 的产物仓库 → 官方 Release。
func componentSources() ([]string, error) {
	name, err := componentFileName()
	if err != nil {
		return nil, err
	}
	escaped := url.PathEscape(name)
	raw := componentGitHubRaw + "/" + escaped
	return []string{
		componentGitCodeBase + "/" + escaped + "?ref=" + componentRef,
		componentProxy + raw,
		raw,
		downloadURL(),
	}, nil
}

// installDir 是安装落点：优先可执行文件同目录（生产 runtime/），
// 其次是 dev-bin（源码运行 / 目录只读时）。
func (m *Manager) installDir() string {
	if dir := strings.TrimSpace(m.cfg.ExecDir); dir != "" {
		return dir
	}
	if dir := strings.TrimSpace(m.cfg.DevBinDir); dir != "" {
		return dir
	}
	return "."
}

// Status 汇总当前语音组件状态（只读、无副作用，可高频轮询）。
func (m *Manager) Status() Status {
	st := Status{Version: BinaryVersion, State: StateIdle}
	if m.cfg.External {
		st.External = true
		// 桌面壳托管：二进制由壳启动，文件在不在仍以磁盘为准，
		// 这样「没下载」时网页端才能给出下载入口。
		if m.findBinary() != "" || !m.cfg.AllowDownload {
			st.Available = true
			st.State = StateExternal
			st.Message = "使用外置 LiveKit"
			return st
		}
		// 继续往下走：按「组件缺失 / 下载中」如实上报
	} else if bin := m.findBinary(); bin != "" {
		st.Available = true
		st.State = StateReady
		return st
	}

	m.sm.Lock()
	defer m.sm.Unlock()
	st.State = m.state
	st.Progress = m.progress
	st.Received = m.received
	st.Total = m.total
	st.Message = m.message
	if st.State == StateReady {
		// 二进制被手动删掉的情况：状态机还停在 ready，得按实际文件判定
		st.State = StateIdle
		st.Message = ""
	}
	return st
}

// Install 启动一次后台下载（幂等：已在下载中直接返回 ErrInstallInProgress）。
//
// 返回即代表「已开始」，调用方（HTTP handler）不应等待完成——18 MB 在慢网络上
// 要几分钟，前端靠轮询 Status 显示进度。
func (m *Manager) Install(ctx context.Context) error {
	if m.cfg.External && !m.cfg.AllowDownload {
		return ErrExternalLiveKit
	}
	if m.findBinary() != "" {
		return ErrAlreadyInstalled
	}

	m.sm.Lock()
	if m.state == StateDownloading || m.state == StateInstalling {
		m.sm.Unlock()
		return ErrInstallInProgress
	}
	m.state = StateDownloading
	m.progress = 0
	m.received = 0
	m.total = 0
	m.message = "正在获取语音组件…"
	m.sm.Unlock()

	go m.runInstall(ctx)
	return nil
}

// runInstall 是 Install 的后台部分：下载 → 解压 → 落盘 → 拉起伴生进程。
func (m *Manager) runInstall(ctx context.Context) {
	// 与请求生命周期解耦：浏览器关了下载也该继续。
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Minute)
	defer cancel()

	if err := m.downloadComponent(ctx); err != nil {
		m.setFailed(err)
		return
	}

	m.logf("[voice] 语音组件已安装到 %s", m.installDir())
	m.startAfterInstall()
}

func (m *Manager) setFailed(err error) {
	m.sm.Lock()
	m.state = StateError
	m.message = err.Error()
	m.sm.Unlock()
	m.logf("[voice] 语音组件安装失败: %v", err)
}

// downloadComponent 依次尝试各个下载源，成功一次即返回。
func (m *Manager) downloadComponent(ctx context.Context) error {
	sources, err := componentSources()
	if err != nil {
		return err
	}
	name, _ := componentFileName()

	var lastErr error
	for i, src := range sources {
		archive := filepath.Join(os.TempDir(), fmt.Sprintf("zviewer-%s", name))
		err := m.fetchArchive(ctx, src, archive)
		if err != nil {
			lastErr = err
			if i < len(sources)-1 {
				m.logf("[voice] 从 %s 获取失败（%v），换下一个源", hostOf(src), err)
				m.sm.Lock()
				m.message = "主下载源不可用，正在尝试备用源…"
				m.sm.Unlock()
			}
			continue
		}

		m.sm.Lock()
		m.state = StateInstalling
		m.message = "正在解压语音组件…"
		m.sm.Unlock()

		dest, err := m.extractArchive(archive, name)
		_ = os.Remove(archive)
		if err != nil {
			lastErr = err
			continue
		}
		m.sm.Lock()
		m.state = StateReady
		m.progress = 100
		m.message = ""
		m.sm.Unlock()
		m.logf("[voice] 语音组件已就绪: %s", dest)
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("没有可用的下载源")
	}
	return fmt.Errorf("语音组件下载失败：%w", lastErr)
}

// extractArchive 把压缩包里的二进制解到安装目录。
//
// 目录可能只读（Docker 里 /app 属主是镜像用户）：写不进去就退到 dev-bin。
func (m *Manager) extractArchive(archive, name string) (string, error) {
	dirs := []string{m.installDir()}
	if dev := strings.TrimSpace(m.cfg.DevBinDir); dev != "" && dev != dirs[0] {
		dirs = append(dirs, dev)
	}
	var lastErr error
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			lastErr = err
			continue
		}
		dest := filepath.Join(dir, binName())
		if err := extractBinary(archive, dest); err != nil {
			lastErr = err
			continue
		}
		if runtime.GOOS != "windows" {
			_ = os.Chmod(dest, 0o755)
		}
		return dest, nil
	}
	if lastErr == nil {
		lastErr = errors.New("没有可写的安装目录")
	}
	return "", lastErr
}

// fetchArchive 下载一个压缩包，边下边更新进度。
func (m *Manager) fetchArchive(ctx context.Context, src, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "zviewer-voice-component")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	total := resp.ContentLength
	if total > componentMaxBytes {
		return fmt.Errorf("组件体积异常（%d 字节）", total)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	m.sm.Lock()
	m.total = total
	m.sm.Unlock()

	buf := make([]byte, 256<<10)
	var written int64
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			written += int64(n)
			if written > componentMaxBytes {
				return errors.New("组件体积超过上限")
			}
			if _, err := f.Write(buf[:n]); err != nil {
				return err
			}
			m.trackProgress(written, total)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if written == 0 {
		return errors.New("下载内容为空")
	}
	return nil
}

// trackProgress 更新已下载字节与百分比（每 1% 才写一次，避免高频加锁）。
func (m *Manager) trackProgress(written, total int64) {
	pct := 0
	if total > 0 {
		pct = int(written * 100 / total)
	}
	m.sm.Lock()
	if pct != m.progress || m.received == 0 {
		m.received = written
		if total > 0 {
			m.progress = pct
			m.message = fmt.Sprintf("正在下载语音组件 %d%%", pct)
		} else {
			m.message = "正在下载语音组件…"
		}
	}
	m.sm.Unlock()
}

func hostOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	return u.Host
}
