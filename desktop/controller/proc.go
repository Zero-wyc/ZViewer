package controller

// 进程层：后端、LiveKit、CLI 都由 ZViewer.ProcessHost.exe 托管，
// 这样 GUI 退出时 Job Object 会一起回收子进程；停止与归属校验走同一份 PowerShell 助手。

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Proc 包装一次受管子进程，done 关闭即表示已回收（等价 child.exitCode !== null）。
type Proc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	done   chan struct{}
	code   int
	hosted bool
	target string
}

func (p *Proc) Pid() int {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *Proc) Exited() bool {
	if p == nil {
		return true
	}
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

// Wait 阻塞到进程退出，返回退出码。
func (p *Proc) Wait() int {
	if p == nil {
		return 0
	}
	<-p.done
	return p.code
}

// startProcess 启动受管进程；onLine 在两个输出流上持续被调用，保证管道不会被写满。
func startProcess(hostExe, target string, extraArgs, env []string, cwd string, onLine func(string)) (*Proc, error) {
	return startProcessContext(context.Background(), hostExe, target, extraArgs, env, cwd, onLine)
}

func startProcessContext(ctx context.Context, hostExe, target string, extraArgs, env []string, cwd string, onLine func(string)) (*Proc, error) {
	hosted := isWindows() && hostExe != ""
	var cmd *exec.Cmd
	if hosted {
		cmd = exec.CommandContext(ctx, hostExe, append([]string{target}, extraArgs...)...)
	} else {
		cmd = exec.CommandContext(ctx, target, extraArgs...)
	}
	if cwd != "" {
		cmd.Dir = cwd
	}
	if env != nil {
		cmd.Env = env
	}
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	proc := &Proc{cmd: cmd, stdin: stdin, done: make(chan struct{}), hosted: hosted, target: target}
	go streamLines(stdout, onLine)
	go streamLines(stderr, onLine)
	go func() {
		err := cmd.Wait()
		if exit, ok := err.(*exec.ExitError); ok {
			proc.code = exit.ExitCode()
		}
		close(proc.done)
	}()
	return proc, nil
}

// streamLines 按行切分输出；超长行截断，避免日志被单行撑爆。
func streamLines(reader io.Reader, onLine func(string)) {
	buffered := bufio.NewReaderSize(reader, 64*1024)
	pending := ""
	emit := func(line string) {
		if onLine == nil || strings.TrimSpace(line) == "" {
			return
		}
		if len(line) > 16000 {
			line = line[:4000]
		}
		onLine(line)
	}
	for {
		chunk, err := buffered.ReadString('\n')
		if len(chunk) > 0 {
			pending += strings.TrimRight(chunk, "\r\n")
			if strings.HasSuffix(chunk, "\n") {
				emit(pending)
				pending = ""
			} else if len(pending) > 4000 {
				emit(pending[:4000])
				pending = ""
			}
		}
		if err != nil {
			if pending != "" {
				emit(pending)
			}
			return
		}
	}
}

func classifyLevel(line string) string {
	lower := strings.ToLower(line)
	if strings.Contains(lower, "error") || strings.Contains(lower, "fatal") || strings.Contains(lower, "failed") ||
		strings.Contains(line, "错误") || strings.Contains(line, "失败") {
		return "ERROR"
	}
	if strings.Contains(lower, "warn") || strings.Contains(line, "警告") {
		return "WARN"
	}
	return "INFO"
}

// inspection 对应 windows-process.ps1 -Action inspect 的输出。
type inspection struct {
	Owner        flexInts `json:"owner"`
	UDPOwner     flexInts `json:"udpOwner"`
	UDPAddresses flexList `json:"udpAddresses"`
	RTCOwner     flexInts `json:"rtcOwner"`
	Members      flexInts `json:"members"`
}

// flexInts 容忍 PowerShell 把单元素数组序列化成标量。
type flexInts []int

func (f *flexInts) UnmarshalJSON(raw []byte) error {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		*f = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var list []int
		if err := json.Unmarshal(raw, &list); err != nil {
			return err
		}
		*f = list
		return nil
	}
	var single int
	if err := json.Unmarshal(raw, &single); err != nil {
		return err
	}
	*f = []int{single}
	return nil
}

type flexList []string

func (f *flexList) UnmarshalJSON(raw []byte) error {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		*f = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var list []string
		if err := json.Unmarshal(raw, &list); err != nil {
			return err
		}
		*f = list
		return nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err != nil {
		return err
	}
	*f = []string{single}
	return nil
}

func (i inspection) owns(list []int) bool {
	for _, value := range list {
		for _, member := range i.Members {
			if member == value {
				return true
			}
		}
	}
	return false
}

// inspect 校验端口归属：监听端口必须属于 GUI 启动的进程树。
func (c *Controller) inspect(pid, port int, expected string, udpPort, mediaTCP int) (inspection, error) {
	args := []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", c.helper,
		"-Action", "inspect", "-ProcessId", strconv.Itoa(pid), "-Port", strconv.Itoa(port), "-ExpectedPath", expected}
	if udpPort > 0 {
		args = append(args, "-UdpPort", strconv.Itoa(udpPort))
	}
	if mediaTCP > 0 {
		args = append(args, "-MediaTcpPort", strconv.Itoa(mediaTCP))
	}
	cmd := exec.Command("powershell.exe", args...)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return inspection{}, err
	}
	var result inspection
	if err := json.Unmarshal(out, &result); err != nil {
		return inspection{}, err
	}
	return result, nil
}

// kill 先尝试优雅停止（ProcessHost 的 stdin 指令），再回落到进程树强杀。
func (c *Controller) kill(proc *Proc, exe string) error {
	if proc == nil || proc.Exited() {
		return nil
	}
	if proc.hosted && exe == c.hostExe && proc.stdin != nil {
		if _, err := io.WriteString(proc.stdin, "stop\n"); err == nil {
			select {
			case <-proc.done:
				return nil
			case <-time.After(14 * time.Second):
			}
		}
	}
	if isWindows() {
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
			"-File", c.helper, "-Action", "stop", "-ProcessId", strconv.Itoa(proc.Pid()), "-ExpectedPath", exe)
		hideWindow(cmd)
		_ = cmd.Run()
	} else if proc.cmd.Process != nil {
		_ = proc.cmd.Process.Kill()
	}
	select {
	case <-proc.done:
		return nil
	case <-time.After(5 * time.Second):
	}
	if proc.Exited() {
		return nil
	}
	return errors.New("受管进程停止超时")
}
