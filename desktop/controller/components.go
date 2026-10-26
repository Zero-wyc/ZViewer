package controller

// 可选组件：Cloudflare Tunnel 用的 cloudflared 与虚拟组网用的 EasyTier。
//
// 这两个二进制不再打进桌面运行包（GUI 本体只有几十 MB 的壳 + 后端 + 网页），
// 用户第一次用到时才下载。组件放在仓库的 public/ 目录里，随仓库同步到 GitCode，
// 下载地址就是 GitCode 的仓库文件直链：
//
//	https://api.gitcode.com/api/v5/repos/{owner}/{repo}/raw/public/{file}?ref={branch}
//
// 注意：**不能**用 raw.gitcode.com/{owner}/{repo}/raw/{branch}/{file}。
// 那个地址是站点的「预览」通道，除 README/LICENSE 一类被预览过的文档外
// 一律返回 403「暂不支持预览」，exe/zip 永远下不到；api/v5 的 raw 端点
// 才是真正按字节返回（支持 Range），这里只用后者。
//
// 每个组件都钉死版本与 SHA-256：public/ 里的文件被换掉而 Go 常量没跟着改时，
// components_test.go 会直接失败，避免线上出现「下载下来校验不过、一直重试」。

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// componentRepo / componentBranch 与仓库发布流程保持一致：main 上的 public/ 就是组件库。
	componentRepo   = "Zero-wyc/ZViewer"
	componentBranch = "main"
	componentAPIRaw = "https://api.gitcode.com/api/v5/repos/" + componentRepo + "/raw/"
	componentDir    = "public"

	componentCloudflared = "cloudflared"
	componentMesh        = "easytier"

	componentMaxBytes = 200 << 20
)

type componentSpec struct {
	Name string
	// File 是 public/ 下的文件名，同时也是 GitCode 直链的最后一段。
	File    string
	Version string
	Size    int64
	SHA256  string
	// GitHub 是不依赖镜像的官方来源；镜像不可达时用它兜底。
	GitHub string
	// Files 非空表示这是压缩包，只取这几个文件（按 basename 匹配）。
	Files []string
}

var cloudflaredSpec = componentSpec{
	Name:    componentCloudflared,
	File:    "cloudflared-windows-amd64.exe",
	Version: "2026.10.3",
	Size:    55329336,
	SHA256:  "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
	GitHub:  "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-windows-amd64.exe",
}

var meshSpec = componentSpec{
	Name:    componentMesh,
	File:    "easytier-windows-x86_64-v2.6.4.zip",
	Version: "2.6.4",
	Size:    32657720,
	SHA256:  "27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84",
	GitHub:  "https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-windows-x86_64-v2.6.4.zip",
	// 只取运行所需文件：官方包里的 easytier-web*.exe 是网页控制台，用不到。
	Files: []string{"easytier-core.exe", "easytier-cli.exe", "Packet.dll", "WinDivert64.sys", "wintun.dll"},
}

var componentCatalog = []componentSpec{cloudflaredSpec, meshSpec}

func componentByName(name string) (componentSpec, bool) {
	for _, spec := range componentCatalog {
		if spec.Name == name {
			return spec, true
		}
	}
	return componentSpec{}, false
}

// ComponentStatus 是单个组件的状态，直接进 Snapshot 供界面渲染。
type ComponentStatus struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Version   string `json:"version"`
	// State 取 idle / downloading / installing / ready / error。
	State    string `json:"state"`
	Progress int    `json:"progress"`
	Message  string `json:"message"`
	// Mirror 是实际使用的下载地址，出错时界面能直接指给用户看。
	Mirror string `json:"mirror"`
}

// ComponentsReport 按名称分发给界面；以后加组件只需在 catalog 里补一条。
type ComponentsReport struct {
	Cloudflared ComponentStatus `json:"cloudflared"`
	Mesh        ComponentStatus `json:"easytier"`
}

// componentState 保存下载中的瞬时状态；磁盘上是否存在一律现算，避免状态与文件不同步。
// 下载在 goroutine 里改、快照在别的 goroutine 里读，所以这里自带锁。
type componentState struct {
	mu      sync.Mutex
	items   map[string]ComponentStatus
	running map[string]bool
}

func (s *componentState) get(name string) ComponentStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if item, ok := s.items[name]; ok {
		return item
	}
	return ComponentStatus{Name: name, State: "idle"}
}

func (s *componentState) set(status ComponentStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.items == nil {
		s.items = map[string]ComponentStatus{}
	}
	s.items[status.Name] = status
}

func (s *componentState) busy(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running[name]
}

func (s *componentState) setBusy(name string, value bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running == nil {
		s.running = map[string]bool{}
	}
	s.running[name] = value
}

// componentInstalled 判断组件是否已在运行包里。
func (c *Controller) componentInstalled(spec componentSpec) bool {
	if spec.Name == componentMesh {
		return c.mesh.Available()
	}
	return c.root != "" && fileExists(filepath.Join(c.root, spec.File))
}

// componentStatus 合并磁盘事实与下载状态：文件在就一定是 available。
func (c *Controller) componentStatus(spec componentSpec) ComponentStatus {
	status := c.components.get(spec.Name)
	status.Name = spec.Name
	status.Version = spec.Version
	status.Available = c.componentInstalled(spec)
	status.Mirror = spec.mirrorURL()
	if status.Available && !c.components.busy(spec.Name) {
		status.State, status.Progress, status.Message = "ready", 100, ""
	}
	return status
}

func (c *Controller) componentReport() ComponentsReport {
	return ComponentsReport{
		Cloudflared: c.componentStatus(cloudflaredSpec),
		Mesh:        c.componentStatus(meshSpec),
	}
}

// mirrorURL 是组件在 GitCode 上的仓库直链（按字节返回，不是预览页）。
func (s componentSpec) mirrorURL() string {
	return componentAPIRaw + componentDir + "/" + s.File + "?ref=" + componentBranch
}

// InstallComponent 异步下载并安装可选组件；立即返回，进度通过快照推送。
func (c *Controller) InstallComponent(name string) (ComponentsReport, error) {
	spec, ok := componentByName(name)
	if !ok {
		return c.componentReport(), errors.New("未知的组件")
	}
	status := c.componentStatus(spec)
	if status.Available || c.components.busy(spec.Name) {
		return c.componentReport(), nil
	}
	if c.root == "" {
		return c.componentReport(), errors.New("无法确定运行包目录，不能保存组件")
	}
	c.components.setBusy(spec.Name, true)
	status.State, status.Progress, status.Message = "downloading", 0, "正在连接下载源…"
	c.components.set(status)
	c.log("开始下载组件："+spec.Name+" "+spec.Version, "component", "INFO")
	c.emit()
	go func() {
		defer c.components.setBusy(spec.Name, false)
		c.downloadComponent(spec)
	}()
	return c.componentReport(), nil
}

// downloadComponent 依次尝试镜像与官方来源；全部失败才把组件标成 error。
func (c *Controller) downloadComponent(spec componentSpec) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	var lastErr error
	for _, link := range componentSources(spec) {
		if ctx.Err() != nil {
			break
		}
		err := c.installComponentFrom(ctx, spec, link)
		if err == nil {
			c.components.set(ComponentStatus{Name: spec.Name, Version: spec.Version, Available: true, State: "ready", Progress: 100, Mirror: spec.mirrorURL()})
			c.log(fmt.Sprintf("组件已就绪：%s %s", spec.Name, spec.Version), "component", "INFO")
			c.emit()
			return
		}
		if ctx.Err() != nil {
			break
		}
		lastErr = err
		c.log("组件下载失败，尝试下一个来源："+err.Error(), "component", "WARN")
	}
	status := c.componentStatus(spec)
	status.State, status.Progress = "error", 0
	if lastErr != nil {
		status.Message = lastErr.Error()
	} else {
		status.Message = "下载已取消"
	}
	c.components.set(status)
	c.log("组件下载失败："+status.Message, "component", "ERROR")
	c.emit()
}

// componentSources 返回按优先级排列的下载地址：GitCode 镜像在前，官方直连兜底。
func componentSources(spec componentSpec) []string {
	out := []string{spec.mirrorURL()}
	if spec.GitHub != "" {
		out = append(out, spec.GitHub)
	}
	return out
}

// installComponentFrom 下载单个来源并安装；任何一步失败都返回可读原因。
func (c *Controller) installComponentFrom(ctx context.Context, spec componentSpec, link string) error {
	root := c.root
	temp, err := os.CreateTemp(root, ".component-*.download")
	if err != nil {
		return fmt.Errorf("无法创建临时文件：%w", err)
	}
	tempPath := temp.Name()
	if closeErr := temp.Close(); closeErr != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("无法创建临时文件：%w", closeErr)
	}
	defer os.Remove(tempPath)
	progress := func(done, total int64) {
		status := c.componentStatus(spec)
		status.State = "downloading"
		if total > 0 {
			status.Progress = int(done * 100 / total)
			if status.Progress > 99 && done < total {
				status.Progress = 99
			}
		}
		c.components.set(status)
		c.emit()
	}
	if err := downloadComponentFile(ctx, link, tempPath, spec, progress); err != nil {
		return err
	}
	status := c.componentStatus(spec)
	status.State, status.Progress, status.Message = "installing", 99, "正在安装…"
	c.components.set(status)
	c.emit()
	if len(spec.Files) == 0 {
		target := filepath.Join(root, spec.File)
		return installCloudflared(ctx, tempPath, target)
	}
	return extractComponentZip(tempPath, c.mesh.BinDir(), spec.Files)
}

// downloadComponentFile 逐字节写入并校验；只接受 https 的已知来源。
func downloadComponentFile(ctx context.Context, link, target string, spec componentSpec, onProgress func(done, total int64)) error {
	parsed, err := url.Parse(link)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || !allowedComponentHost(parsed.Hostname()) {
		return errors.New("组件下载地址不在允许的来源中")
	}
	client := &http.Client{
		Timeout: 15 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("组件下载跳转次数过多")
			}
			if !strings.EqualFold(request.URL.Scheme, "https") {
				return errors.New("组件下载被重定向到非 HTTPS 地址")
			}
			// GitHub 会跳到对象存储，GitCode 也可能跳到自己的 CDN：只要求公网 HTTPS，
			// 具体内容随后用 SHA-256 校验，重定向本身不构成信任。
			if !publicHost(request.URL.Hostname()) {
				return fmt.Errorf("组件下载跳转到未知来源：%s", request.URL.Hostname())
			}
			return nil
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("User-Agent", "ZViewerDesktop")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("无法连接下载源：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("下载源返回 HTTP %d", response.StatusCode)
	}
	if response.ContentLength > componentMaxBytes {
		return errors.New("组件文件超过预期大小，已取消下载")
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("无法写入临时文件：%w", err)
	}
	total := response.ContentLength
	if total <= 0 {
		total = spec.Size
	}
	writer := &progressWriter{dst: file, total: total, report: onProgress}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(writer, hasher), io.LimitReader(response.Body, componentMaxBytes+1))
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("下载组件失败：%w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("写入组件失败：%w", closeErr)
	}
	if written > componentMaxBytes {
		return errors.New("组件文件超过预期大小，已取消下载")
	}
	if spec.Size > 0 && written != spec.Size {
		return fmt.Errorf("组件大小不符（%d/%d 字节）", written, spec.Size)
	}
	if spec.SHA256 != "" {
		if digest := hex.EncodeToString(hasher.Sum(nil)); digest != spec.SHA256 {
			return errors.New("组件 SHA-256 与仓库记录不一致")
		}
	}
	return nil
}

// allowedComponentHost 只放行仓库与官方发布域。
func allowedComponentHost(host string) bool {
	switch strings.ToLower(host) {
	case "api.gitcode.com", "gitcode.com", "raw.gitcode.com",
		"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com":
		return true
	}
	return false
}

// extractComponentZip 只解出需要的文件，按 basename 匹配（官方包里有一层目录）。
func extractComponentZip(archive, dir string, names []string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return errors.New("组件包不是有效的 ZIP")
	}
	defer reader.Close()
	wanted := make(map[string]bool, len(names))
	for _, name := range names {
		wanted[strings.ToLower(name)] = true
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("无法创建组件目录：%w", err)
	}
	found := 0
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		base := filepath.Base(entry.Name)
		if !wanted[strings.ToLower(base)] {
			continue
		}
		if err := extractZipEntry(entry, filepath.Join(dir, base)); err != nil {
			return err
		}
		found++
	}
	if found != len(names) {
		return fmt.Errorf("组件包内容不完整（%d/%d 个文件）", found, len(names))
	}
	return nil
}

func extractZipEntry(entry *zip.File, target string) error {
	source, err := entry.Open()
	if err != nil {
		return fmt.Errorf("无法读取组件包：%w", err)
	}
	defer source.Close()
	// 先写临时文件再改名：中途失败不会留下半个 exe 让下次启动直接崩。
	temp, err := os.CreateTemp(filepath.Dir(target), ".extract-*")
	if err != nil {
		return fmt.Errorf("无法写入组件目录：%w", err)
	}
	tempPath := temp.Name()
	_, copyErr := io.Copy(temp, io.LimitReader(source, componentMaxBytes))
	closeErr := temp.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tempPath)
		if copyErr != nil {
			return fmt.Errorf("解压组件失败：%w", copyErr)
		}
		return fmt.Errorf("写入组件失败：%w", closeErr)
	}
	if err := os.Rename(tempPath, target); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("无法安装组件文件（可能仍被占用）：%w", err)
	}
	return nil
}
