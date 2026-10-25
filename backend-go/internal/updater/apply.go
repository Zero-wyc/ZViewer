package updater

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ApplyUpdate 从 GitHub Releases 拉最新产物并触发更新。
func (s *Service) ApplyUpdate(
	ctx context.Context,
	includePrerelease bool,
	onStage func(StageEvent),
) (*Result, error) {
	info, err := s.GetUpdateInfo(ctx, includePrerelease)
	if err != nil {
		return nil, err
	}
	if info.DownloadURL == "" {
		return nil, errors.New("未找到可用的下载地址")
	}

	// 再读一次 settings：从检查更新到这里可能过了几十秒，用户可能刚打开了 CDN。
	cdn, err := s.cdn(ctx)
	if err != nil {
		return nil, err
	}
	// GitCode 的附件直连华为云对象存储，套 CDN 前缀既没用、失败文案还会误导用户。
	if info.Source == SourceGitCode {
		cdn = nil
	}
	downloadURL := info.DownloadURL
	if cdn != nil && cdn.proxyURL != "" {
		downloadURL = ApplyCDNToURL(downloadURL, cdn.proxyURL)
		logf("CDN 加速: %s", cdn.proxyURL)
	}

	return s.applyArchive(ctx, nil, downloadURL, info.AssetName, onStage, cdn)
}

// ApplyUpdateFromFile 用用户上传的压缩包触发更新。
func (s *Service) ApplyUpdateFromFile(
	ctx context.Context,
	data []byte,
	filename string,
	onStage func(StageEvent),
) (*Result, error) {
	lower := strings.ToLower(filename)
	if !strings.HasSuffix(lower, ".zip") && !strings.HasSuffix(lower, ".tar.gz") {
		return nil, errors.New("仅支持 .zip 或 .tar.gz 格式的压缩包")
	}
	archiveName := "uploaded-update.zip"
	if strings.HasSuffix(lower, ".tar.gz") {
		archiveName = "uploaded-update.tar.gz"
	}
	return s.applyArchive(ctx, data, "", archiveName, onStage, nil)
}

// applyArchive 是两条更新路径的公共实现。
//
// downloadURL 非空时走流式下载（带进度），否则把 data 直接落盘。
//
// 关键设计：本函数**不替换任何运行中的文件**。它只负责准备 `.update-temp`
// 与一份平台脚本，然后 detached 拉起脚本就返回。脚本会先停掉本进程再覆盖
// 文件——在 Windows 上覆盖运行中的 exe 本来就会被拒绝，在 Linux 上覆盖运行中
// 的 ELF 会直接把进程打成 SIGBUS。
func (s *Service) applyArchive(
	ctx context.Context,
	data []byte,
	downloadURL string,
	archiveFilename string,
	onStage func(StageEvent),
	cdn *cdnConfig,
) (*Result, error) {
	emit := func(event StageEvent) {
		if onStage != nil {
			onStage(event)
		}
	}

	root := s.Root
	tempDir := filepath.Join(root, ".update-temp")
	archivePath := filepath.Join(tempDir, archiveFilename)

	if _, err := os.Stat(tempDir); err == nil {
		if err := os.RemoveAll(tempDir); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		return nil, err
	}

	// Node 在 catch 里清临时目录。这里用 defer 保证同样行为：
	// 失败时不留半截包，成功时保留（脚本自己会 rm -rf）。
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(tempDir)
		}
	}()

	if downloadURL != "" {
		err := s.DownloadFile(ctx, downloadURL, archivePath, func(received, total int64) {
			emit(StageEvent{Stage: StageDownloading, Received: received, Total: total})
		}, cdn)
		if err != nil {
			emit(StageEvent{Stage: StageError, Message: err.Error()})
			return nil, err
		}
	} else {
		if err := os.WriteFile(archivePath, data, 0o644); err != nil {
			emit(StageEvent{Stage: StageError, Message: err.Error()})
			return nil, err
		}
	}

	emit(StageEvent{Stage: StageExtracting})
	if err := extractArchive(archivePath, tempDir); err != nil {
		emit(StageEvent{Stage: StageError, Message: err.Error()})
		return nil, err
	}

	extractedDir := findExtractedDir(tempDir)

	emit(StageEvent{Stage: StageStarting})
	isWindows := s.goos() == "windows"
	// Docker 用专用脚本：不重启进程，而是留标记后退出，由 entrypoint 拉起。
	dockerMode := !isWindows && s.inDocker()

	var (
		scriptPath string
		err        error
	)
	switch {
	case isWindows:
		scriptPath, err = writeApplyUpdateBat(root, tempDir, extractedDir)
	case dockerMode:
		scriptPath, err = writeDockerUpdateSh(root, tempDir, extractedDir)
	default:
		scriptPath, err = writeApplyUpdateSh(root, tempDir, extractedDir)
	}
	if err != nil {
		emit(StageEvent{Stage: StageError, Message: err.Error()})
		return nil, err
	}
	spawn := s.spawnFn
	if spawn == nil {
		spawn = spawnScript
	}
	if err := spawn(isWindows, scriptPath, root); err != nil {
		emit(StageEvent{Stage: StageError, Message: err.Error()})
		return nil, err
	}

	successMessage := "更新已触发，后台将自动替换文件并重启服务"
	if dockerMode {
		successMessage = "更新已触发，后台将自动替换文件并在容器内重启后端进程"
	}
	emit(StageEvent{Stage: StageDone, Message: successMessage})
	ok = true
	return &Result{Success: true, Message: successMessage}, nil
}

// findExtractedDir 定位解压后的真实产物目录。
//
// Release 包有两种形态：直接把文件铺在根上（当前 CI 的产物），或外面套一层
// 目录。判断依据不是「只有一个目录」，而是那层目录里有没有 `zviewer-*` /
// `start.sh` / `start.bat`——只看目录数量的话，一个含 `config/` 的包会被误认。
func findExtractedDir(tempDir string) string {
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		return tempDir
	}
	filtered := make([]os.DirEntry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		// 排除刚下载的压缩包本身，它也在 tempDir 里。
		if strings.HasSuffix(name, ".zip") || strings.HasSuffix(name, ".tar.gz") {
			continue
		}
		filtered = append(filtered, entry)
	}
	if len(filtered) != 1 || !filtered[0].IsDir() {
		return tempDir
	}
	only := filepath.Join(tempDir, filtered[0].Name())
	subEntries, err := os.ReadDir(only)
	if err != nil {
		return tempDir
	}
	for _, entry := range subEntries {
		name := entry.Name()
		if strings.HasPrefix(name, "zviewer-") || name == "start.bat" || name == "start.sh" {
			return only
		}
	}
	return tempDir
}
