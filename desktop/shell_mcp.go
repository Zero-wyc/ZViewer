package main

// MCP 工具的桌面侧能力：清单探测、配置片段、以及「写进各家客户端」的自动部署。
//
// 三件事都围绕同一份事实：后端可执行文件自己就是 MCP stdio 服务
// （`zviewer-backend.exe --mcp`），客户端配置里只需要 command + args。
// 所以这里不复制工具清单、也不内置任何站规，只负责：
//   1. 探测工具清单——先问运行中的后端 HTTP 接口，失败就真的拉起一次
//      `--mcp` 走 JSON-RPC 问 tools/list（MCP 不需要 HTTP 服务，这条路更接近
//      客户端看到的东西，也能救「后端版本旧、没有 /api/crawler/tools」的情况）；
//   2. 生成给别的 Agent 平台看的部署提示词（让对面的大模型自己找配置文件、
//      自己合并、自己校验，而不是让用户手动粘）；
//   3. 直接把条目写进 Claude Desktop / Claude Code / Cursor / VS Code /
//      Windsurf / Codex 的配置文件，写前备份、写后回读校验。
//
// 为什么探测要真的拉进程：桌面控制台和后端是两个产物，运行包里后端可能是
// 旧版本。只信 HTTP 会把「后端旧了」报成「工具有 0 个」，用户完全看不出原因；
// 而 stdio 探测拿到的是客户端即将看到的同一份清单，顺手还验证了可执行文件本身。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// mcpServerEntryName 是写进客户端配置的服务名；客户端用它给工具名加前缀。
const mcpServerEntryName = "zviewer-crawler"

// mcpProbeTimeout 给 stdio 探测的总预算：进程启动 + 两次往返，正常几十毫秒。
const mcpProbeTimeout = 12 * time.Second

// mcpClientSpec 描述一个客户端：配置文件在哪、结构是什么、改完怎么生效。
type mcpClientSpec struct {
	ID       string
	Name     string
	Format   string // json | toml
	Key      string // JSON 里的容器键：mcpServers / servers
	StdioTyp bool   // VS Code 风格：条目必须带 "type": "stdio"
	Path     string
	// DetectPath 是「这个客户端装过」的判据（默认取配置文件所在目录）。
	// Claude Code 的配置直接落在 ~/.claude.json，父目录是用户主目录——
	// 拿主目录当判据会把所有机器都判成装了 Claude Code。
	DetectPath string
	Hint       string
}

// mcpClientSpecs 返回支持的客户端清单（顺序即界面顺序）。
//
// 路径全部按「用户级配置」给：写项目级会跟着工作目录跑，用户下次换个文件夹
// 就以为工具丢了。项目级属于可选项，留给提示词里的说明。
func mcpClientSpecs() []mcpClientSpec {
	home, _ := os.UserHomeDir()
	appData := strings.TrimSpace(os.Getenv("APPDATA"))
	if appData == "" && home != "" {
		appData = filepath.Join(home, "AppData", "Roaming")
	}
	join := func(base string, parts ...string) string {
		if strings.TrimSpace(base) == "" {
			return ""
		}
		return filepath.Join(append([]string{base}, parts...)...)
	}
	return []mcpClientSpec{
		{
			ID: "claude", Name: "Claude Desktop", Format: "json", Key: "mcpServers",
			Path: join(appData, "Claude", "claude_desktop_config.json"),
			Hint: "写完后完全退出 Claude（含托盘）再启动才会加载新服务。",
		},
		{
			ID: "claude-code", Name: "Claude Code", Format: "json", Key: "mcpServers",
			Path:       join(home, ".claude.json"),
			DetectPath: join(home, ".claude"),
			Hint:       "用户级配置。写完后新开一个会话即可，已开着的会话要重进。",
		},
		{
			ID: "cursor", Name: "Cursor", Format: "json", Key: "mcpServers",
			Path: join(home, ".cursor", "mcp.json"),
			Hint: "写完后在 Cursor 设置的 MCP 面板点一下刷新。",
		},
		{
			ID: "vscode", Name: "VS Code (Copilot)", Format: "json", Key: "servers", StdioTyp: true,
			Path: join(appData, "Code", "User", "mcp.json"),
			Hint: "需要 VS Code 设置里启用 MCP，用户级配置对所有工作区生效。",
		},
		{
			ID: "windsurf", Name: "Windsurf", Format: "json", Key: "mcpServers",
			Path: join(home, ".codeium", "windsurf", "mcp_config.json"),
			Hint: "写完后在 Windsurf 的 Cascade → MCP 面板点刷新。",
		},
		{
			ID: "codex", Name: "Codex CLI", Format: "toml",
			Path: join(home, ".codex", "config.toml"),
			Hint: "TOML 配置，写完后重开 codex 会话；用 /mcp 可查看已接入的服务。",
		},
	}
}

// mcpClientState 带现场信息的客户端：装没装、写没写、能不能写。
type mcpClientState struct {
	mcpClientSpec
	Detected  bool
	Exists    bool
	Installed bool
	Writable  bool
	Problem   string
}

// inspect 读一次配置文件，得出「已装客户端 / 已写入 / 可写」。
func (spec mcpClientSpec) inspect() mcpClientState {
	state := mcpClientState{mcpClientSpec: spec}
	if strings.TrimSpace(spec.Path) == "" {
		state.Problem = "无法确定用户目录"
		return state
	}
	state.Exists = fileExists(spec.Path)
	marker := spec.DetectPath
	if marker == "" {
		marker = filepath.Dir(spec.Path)
	}
	state.Detected = state.Exists || dirExists(marker) || fileExists(marker)
	state.Writable = state.Detected || writableParent(spec.Path)
	state.Installed = mcpConfigured(spec)
	return state
}

// writableParent 判断配置文件的父目录能不能建出来（用户级配置首次写入很常见）。
func writableParent(path string) bool {
	dir := filepath.Dir(path)
	for dir != "" && !dirExists(dir) {
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if !dirExists(dir) {
		return false
	}
	probe := filepath.Join(dir, ".zviewer-mcp-probe")
	if err := os.WriteFile(probe, []byte(""), 0o600); err != nil {
		return false
	}
	_ = os.Remove(probe)
	return true
}

// mcpConfigured 判断配置文件里是否已有 zviewer-crawler 条目。
func mcpConfigured(spec mcpClientSpec) bool {
	raw, err := os.ReadFile(spec.Path)
	if err != nil {
		return false
	}
	if spec.Format == "toml" {
		return strings.Contains(string(raw), "[mcp_servers."+mcpServerEntryName+"]")
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return false
	}
	container, _ := doc[spec.Key].(map[string]any)
	_, ok := container[mcpServerEntryName]
	return ok
}

// mcpClients 供界面渲染「一键写入」列表。
func mcpClients() []map[string]any {
	specs := mcpClientSpecs()
	out := make([]map[string]any, 0, len(specs))
	for _, spec := range specs {
		state := spec.inspect()
		out = append(out, map[string]any{
			"id":        state.ID,
			"name":      state.Name,
			"path":      state.Path,
			"hint":      state.Hint,
			"format":    state.Format,
			"detected":  state.Detected,
			"exists":    state.Exists,
			"installed": state.Installed,
			"writable":  state.Writable,
			"problem":   state.Problem,
		})
	}
	return out
}

// mcpInfo 给 GUI 的「MCP 工具」弹窗：客户端要填的命令、参数、目录、工具清单，
// 一键写入的客户端状态，以及给别的 Agent 平台自动部署用的提示词。
func (a *App) mcpInfo() (any, error) {
	if a.crawler == nil {
		return map[string]any{"available": false, "reason": "桌面桥接未初始化"}, nil
	}
	// MCP 客户端拉起的是运行包里的后端本体：它在 runtime/ 下，自动能探测到 runtime/crawler。
	command := filepath.Join(a.root, "zviewer-backend.exe")
	args := []string{"--mcp"}
	ready, reason := a.crawler.available()

	tools, toolsError, source := a.mcpTools(command, args, ready)
	return map[string]any{
		"available":     true,
		"engineReady":   ready,
		"reason":        reason,
		"command":       command,
		"commandExists": fileExists(command),
		"args":          args,
		"root":          a.crawler.root,
		"count":         len(tools),
		"tools":         tools,
		"toolsError":    toolsError,
		"toolsSource":   source,
		"clients":       mcpClients(),
		"prompt":        mcpDeployPrompt(command, args, a.crawler.root, tools),
	}, nil
}

// mcpTools 取工具清单：先走 HTTP（快），失败再拉一次 stdio 探测（准）。
//
// 第二个返回值是给界面的失败原因，第三个是数据来源（backend / stdio / none），
// 界面据此说明「清单来自哪」。两个都失败才报错。
func (a *App) mcpTools(command string, args []string, ready bool) ([]any, string, string) {
	tools := []any{}
	errText := ""
	if ready {
		result, err := a.crawler.do("GET", "/api/crawler/tools", nil)
		if err != nil {
			errText = err.Error()
		} else if status, _ := result["status"].(int); status != http.StatusOK {
			// 后端版本比界面旧时就是这里 404：给一句能看懂的话，再走 stdio。
			if status == http.StatusNotFound {
				errText = "后端版本较旧，没有 /api/crawler/tools 接口"
			} else {
				errText = "读取工具清单失败（HTTP " + strconv.Itoa(status) + "）"
			}
		} else if body, ok := result["body"].(map[string]any); ok {
			if list, ok := body["tools"].([]any); ok && len(list) > 0 {
				return list, "", "backend"
			}
			errText = "后端返回的工具清单是空的"
		}
	} else {
		errText = "后端服务未运行"
	}
	if !fileExists(command) {
		return tools, firstNonEmpty(errText, "找不到 zviewer-backend.exe"), "none"
	}
	probed, probeErr := probeMCPTools(command, append(append([]string{}, args...), "--root", a.crawler.root))
	if probeErr != nil {
		return tools, firstNonEmpty(errText, probeErr.Error()), "none"
	}
	out := make([]any, 0, len(probed))
	for _, tool := range probed {
		out = append(out, tool)
	}
	// stdio 通了但 HTTP 没过：原因仍然值得显示（多半是后端该更新了）。
	return out, errText, "stdio"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// probeMCPTools 直接拉起 `--mcp` 走一遍 initialize + tools/list。
//
// 读到 tools/list 的响应就立刻杀进程：MCP 服务是长驻的，探测不需要它活着。
// stdout 混进非协议内容会在这里暴露成「协议无响应」，比客户端里静默失败好排。
func probeMCPTools(command string, args []string) ([]map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), mcpProbeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = filepath.Dir(command)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("无法启动 MCP 服务：%w", err)
	}
	// 无论走哪条路都要收尾：Client 端只管发请求，进程留着没意义。
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	go func() {
		encoder := json.NewEncoder(stdin)
		_ = encoder.Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1, "method": "initialize",
			"params": map[string]any{
				"protocolVersion": "2025-06-18",
				"capabilities":    map[string]any{},
				"clientInfo":      map[string]any{"name": "zviewer-desktop", "version": "1"},
			},
		})
		_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
		_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	}()

	type outcome struct {
		tools []map[string]any
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 8<<20)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 || line[0] != '{' {
				continue
			}
			var message struct {
				ID     json.RawMessage `json:"id"`
				Result struct {
					Tools []map[string]any `json:"tools"`
				} `json:"result"`
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(line, &message) != nil {
				continue
			}
			if string(message.ID) != "2" {
				continue
			}
			if message.Error != nil {
				done <- outcome{err: errors.New("MCP 服务返回错误：" + message.Error.Message)}
				return
			}
			done <- outcome{tools: message.Result.Tools}
			return
		}
		if err := scanner.Err(); err != nil {
			done <- outcome{err: err}
			return
		}
		done <- outcome{err: errors.New("MCP 服务没有返回工具清单")}
	}()

	select {
	case result := <-done:
		if result.err != nil {
			detail := strings.TrimSpace(stderr.String())
			if detail != "" {
				if lines := strings.Split(detail, "\n"); len(lines) > 0 {
					detail = lines[len(lines)-1]
				}
				return nil, fmt.Errorf("%w（%s）", result.err, detail)
			}
			return nil, result.err
		}
		return result.tools, nil
	case <-ctx.Done():
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			lines := strings.Split(detail, "\n")
			detail = lines[len(lines)-1]
			return nil, fmt.Errorf("读取工具清单超时（%s）", detail)
		}
		return nil, errors.New("读取工具清单超时，后端可能被安全软件拦住")
	}
}

// ---------------------------------------------------------------- 自动写入

// mcpInstall 把服务条目写进客户端配置。payload.clients 为空表示「能写的都写」。
//
// 只写用户级配置，写前把原文件备份成 <文件名>.zviewer-bak，写后回读校验：
// 配置文件是用户的东西，出错必须能退回去，且不能让用户自己排查。
func (a *App) mcpInstall(payload map[string]any) (any, error) {
	if a.crawler == nil {
		return nil, errors.New("桌面桥接未初始化")
	}
	command := strings.TrimSpace(payloadString(payload, "command"))
	if command == "" {
		command = filepath.Join(a.root, "zviewer-backend.exe")
	}
	if !fileExists(command) {
		return nil, errors.New("找不到 MCP 可执行文件：" + command)
	}
	args := payloadStrings(payload, "args")
	if len(args) == 0 {
		args = []string{"--mcp"}
	}
	wanted := map[string]bool{}
	for _, id := range payloadStrings(payload, "clients") {
		wanted[strings.TrimSpace(id)] = true
	}
	all := len(wanted) == 0

	results := make([]map[string]any, 0, len(mcpClientSpecs()))
	written := 0
	for _, spec := range mcpClientSpecs() {
		if !all && !wanted[spec.ID] {
			continue
		}
		state := spec.inspect()
		if all && !state.Detected {
			// 「全部写入」只在检测到客户端的机器上动手，免得凭空造出
			// %APPDATA%\Claude 这种空目录，让用户以为装过。
			results = append(results, map[string]any{
				"id": state.ID, "name": state.Name, "path": state.Path,
				"status": "skipped", "message": "未检测到该客户端",
			})
			continue
		}
		result := installMCPClient(state, command, args)
		if result["status"] == "installed" {
			written++
		}
		results = append(results, result)
	}
	return map[string]any{
		"success": written > 0,
		"written": written,
		"results": results,
		"clients": mcpClients(),
	}, nil
}

// installMCPClient 写单个客户端，返回带 status 的结果（installed / error / skipped）。
func installMCPClient(state mcpClientState, command string, args []string) map[string]any {
	base := map[string]any{"id": state.ID, "name": state.Name, "path": state.Path}
	if state.Path == "" {
		base["status"] = "error"
		base["message"] = "无法确定用户目录"
		return base
	}
	var backup string
	var err error
	if state.Format == "toml" {
		backup, err = installMCPTOML(state.Path, command, args)
	} else {
		backup, err = installMCPJSON(state, command, args)
	}
	if err != nil {
		base["status"] = "error"
		base["message"] = err.Error()
		if backup != "" {
			base["backup"] = backup
		}
		return base
	}
	// 回读校验：写成功但结构不对（比如容器键被别的工具改形状）要当场发现。
	if !mcpConfigured(state.mcpClientSpec) {
		base["status"] = "error"
		base["message"] = "已写入但回读校验失败，请检查 " + state.Path
		if backup != "" {
			base["backup"] = backup
		}
		return base
	}
	base["status"] = "installed"
	base["message"] = "已写入"
	if backup != "" {
		base["backup"] = backup
	}
	base["hint"] = state.Hint
	return base
}

// installMCPJSON 按 mcpServers / servers 结构合并条目。
func installMCPJSON(state mcpClientState, command string, args []string) (string, error) {
	doc := map[string]any{}
	backup := ""
	if raw, err := os.ReadFile(state.Path); err == nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			// 解析不了的配置不能猜着改：备份原文，让用户/客户端自己修。
			if saved, saveErr := backupFile(state.Path); saveErr == nil {
				backup = saved
			}
			return backup, fmt.Errorf("配置文件不是有效 JSON，未改动（原文已备份）")
		}
		if saved, saveErr := backupFile(state.Path); saveErr == nil {
			backup = saved
		}
	}
	container, ok := doc[state.Key].(map[string]any)
	if !ok {
		container = map[string]any{}
	}
	entry := map[string]any{"command": command, "args": args}
	if state.StdioTyp {
		entry["type"] = "stdio"
	}
	container[mcpServerEntryName] = entry
	doc[state.Key] = container

	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return backup, err
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(filepath.Dir(state.Path), 0o755); err != nil {
		return backup, fmt.Errorf("无法创建配置目录：%w", err)
	}
	tmp := state.Path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return backup, fmt.Errorf("无法写入配置：%w", err)
	}
	if err := os.Rename(tmp, state.Path); err != nil {
		_ = os.Remove(tmp)
		return backup, fmt.Errorf("无法替换配置：%w", err)
	}
	return backup, nil
}

// installMCPTOML 只替换（或追加）[mcp_servers.zviewer-crawler] 这一段。
//
// 不引 TOML 依赖：要改的只有一节，按行定位、整段替换比全量解析回写安全得多
// ——全量回写会把用户的注释、锚点、顺序全部打散。
func installMCPTOML(path, command string, args []string) (string, error) {
	header := "[mcp_servers." + mcpServerEntryName + "]"
	quotedArgs := make([]string, 0, len(args))
	for _, arg := range args {
		quotedArgs = append(quotedArgs, strconv.Quote(arg))
	}
	section := []string{
		header,
		"command = " + strconv.Quote(command),
		"args = [" + strings.Join(quotedArgs, ", ") + "]",
	}

	backup := ""
	lines := []string{}
	if raw, err := os.ReadFile(path); err == nil {
		if saved, saveErr := backupFile(path); saveErr == nil {
			backup = saved
		}
		lines = strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	}
	// 去掉末尾空行，方便拼段。
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}

	start := -1
	for index, line := range lines {
		if strings.TrimSpace(line) == header {
			start = index
			break
		}
	}
	if start >= 0 {
		end := len(lines)
		for index := start + 1; index < len(lines); index++ {
			trimmed := strings.TrimSpace(lines[index])
			if strings.HasPrefix(trimmed, "[") {
				end = index
				break
			}
		}
		merged := append([]string{}, lines[:start]...)
		merged = append(merged, section...)
		merged = append(merged, "")
		merged = append(merged, lines[end:]...)
		lines = merged
	} else {
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, section...)
	}
	content := strings.Join(lines, "\n") + "\n"
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return backup, fmt.Errorf("无法创建配置目录：%w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return backup, fmt.Errorf("无法写入配置：%w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return backup, fmt.Errorf("无法替换配置：%w", err)
	}
	return backup, nil
}

// backupFile 把文件复制成 <文件名>.zviewer-bak，返回备份路径（文件不存在时返回空）。
func backupFile(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	backup := path + ".zviewer-bak"
	if err := os.WriteFile(backup, raw, 0o600); err != nil {
		return "", err
	}
	return backup, nil
}

// ---------------------------------------------------------------- 部署提示词

// mcpDeployPrompt 生成一段可直接粘给「别的 AI Agent」的部署指令。
//
// 用处是跨平台：桌面端能把配置写进上面那六家，但 Cherry Studio、Cline、
// Trae 这些还在长；与其一家家适配，不如把「怎么装」讲清楚，让对面那个
// 本来就能读写文件的模型自己去装、自己去校验。
func mcpDeployPrompt(command string, args []string, root string, tools []any) string {
	argsJSON, _ := json.Marshal(args)
	entry, _ := json.MarshalIndent(map[string]any{
		"mcpServers": map[string]any{
			mcpServerEntryName: map[string]any{"command": command, "args": args},
		},
	}, "", "  ")
	vscodeEntry, _ := json.MarshalIndent(map[string]any{
		"servers": map[string]any{
			mcpServerEntryName: map[string]any{"type": "stdio", "command": command, "args": args},
		},
	}, "", "  ")
	toolNames := make([]string, 0, len(tools))
	for _, raw := range tools {
		if item, ok := raw.(map[string]any); ok {
			if name, _ := item["name"].(string); name != "" {
				toolNames = append(toolNames, name)
			}
		}
	}
	sort.Strings(toolNames)

	lines := []string{
		"你现在可以读写这台电脑上的文件。请把下面的 MCP 服务接入你当前所在的客户端，",
		"全程由你自主完成（自己找配置文件、自己合并、自己校验），不要让我手动复制粘贴，",
		"也不要凭印象猜路径——先确认文件在哪，再动手。",
		"",
		"## 要接入的服务（stdio 传输）",
		"- 名称：" + mcpServerEntryName,
		"- 命令：" + command,
		"- 参数：" + string(argsJSON),
		"- 数据目录：" + root,
		"",
		"## 请按这个顺序做",
		"1. 先判断你运行在哪个客户端（Claude Desktop / Claude Code / Cursor / VS Code + Copilot /",
		"   Windsurf / Codex CLI / 其它），据此确定它读取哪个 MCP 配置文件；",
		"2. 读取该文件（不存在就按下面的位置新建），保留里面已有的所有服务，只新增 " + mcpServerEntryName + "；",
		"3. 写入前把原文件备份成 <原文件名>.bak；",
		"4. 写回后校验语法（JSON 能被解析、TOML 段能定位），确认新条目真的在里面；",
		"5. 告诉我需要重启哪个客户端、重启后在哪里能看到这些工具；",
		"6. 如果客户端支持，重启后调用 tools/list，确认能列出 " + mcpServerEntryName + " 的工具。",
		"",
		"## 各家客户端的位置与写法",
		"- Claude Desktop：%APPDATA%\\Claude\\claude_desktop_config.json（Windows）或",
		"  ~/Library/Application Support/Claude/claude_desktop_config.json（macOS）——写入 mcpServers；",
		"- Claude Code：~/.claude.json ——写入顶层 mcpServers（用户级）；",
		"- Cursor：~/.cursor/mcp.json（项目内是 .cursor/mcp.json）——写入 mcpServers；",
		"- VS Code：%APPDATA%\\Code\\User\\mcp.json（项目内是 .vscode/mcp.json）——写入 servers，",
		"  条目必须带 \"type\": \"stdio\"；",
		"- Windsurf：~/.codeium/windsurf/mcp_config.json ——写入 mcpServers；",
		"- Codex CLI：~/.codex/config.toml ——追加一段 [mcp_servers." + mcpServerEntryName + "]，",
		"  里面写 command 与 args；",
		"- 其它客户端：照它文档里「stdio MCP server」的格式写，command 与 args 同上。",
		"",
		"## 配置内容（Claude Desktop / Cursor / Windsurf / Claude Code 用这份）",
		"```json",
		string(entry),
		"```",
		"",
		"## 配置内容（VS Code 用这份）",
		"```json",
		string(vscodeEntry),
		"```",
	}
	if len(toolNames) > 0 {
		lines = append(lines,
			"",
			"## 接入后你可以用这些工具（"+strconv.Itoa(len(toolNames))+" 个）",
			strings.Join(toolNames, "、"),
			"",
			"典型用法：先 fetch_page 看站点结构 → inspect_html 验证选择器 → test_rule 试跑 →",
			"save_rule 保存；规则出问题时 search_logs 查日志，遇到登录墙用 browser_show /",
			"browser_save_login 处理。这些都是真实网络请求，同一站点不要连续狂刷。",
		)
	}
	lines = append(lines,
		"",
		"## 边界",
		"- 只改这一处配置，不要动别人的 MCP 条目、不要重排文件；",
		"- 读不到文件、没权限、格式不是预期结构时，停下来把「文件路径 + 报错 + 你打算怎么改」",
		"  告诉我，不要自己发明一个路径；",
		"- 完成后把「改了哪个文件、备份在哪、要重启什么」这三件事说清楚。",
	)
	return strings.Join(lines, "\n")
}
