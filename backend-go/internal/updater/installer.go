package updater

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// 这一层解决的是「安装策略从哪来」。
//
// 老做法是：策略（停哪些进程、拷哪些文件、怎么校验重启）写成 Go 的
// 内嵌模板，由**正在运行的旧版本**渲染执行。于是每次发行包多一个文件，
// 都得指望用户先跑到含新清单的版本，否则热更新永远漏掉它
// （zviewer-webgui 就是这么进不去容器的）。
//
// 现在的做法是：发行包自带 `install-update.sh` / `install-update.bat`，
// 更新器只负责发现 → 校验 → 把环境变量递过去 → detached 执行。
// 包内没有这份脚本时（旧包）才回退内嵌模板，保证升级路径不断。

// maxInstallerAPI 是当前更新器认识的最大契约版本。
//
// 包内脚本头部写 `zviewer-installer: N`。N 大于这个值说明包比更新器新，
// 脚本可能依赖新的注入约定；硬跑只会做出半截安装，所以直接拒绝并提示手动更新。
const maxInstallerAPI = 1

// maxInstallerSize 是包内脚本的体积上限。
//
// 真实脚本 5~10 KiB。设上限是为了挡住「压缩包里混进来的大文件被当成脚本执行」，
// 而不是限制功能——真需要更长就同时抬高这个值。
const maxInstallerSize = 256 << 10

// installerAPIPattern 匹配契约声明行，兼容 sh 的 `#` 与 bat 的 `REM`。
var installerAPIPattern = regexp.MustCompile(`(?i)^\s*(?:#|rem)\s*zviewer-installer:\s*(\d+)\s*$`)

// packagedInstaller 是从更新包里读出来的安装脚本。
type packagedInstaller struct {
	Name    string
	API     int
	Content []byte
}

// installerCandidateNames 返回当前平台在包内的脚本名（按优先级）。
func installerCandidateNames(isWindows bool) []string {
	if isWindows {
		return []string{"install-update.bat"}
	}
	return []string{"install-update.sh"}
}

// stagedInstallerName 是脚本落到安装根目录后的固定名字。
//
// 用固定名而不是包内原名：脚本靠 $0 / %~f0 定位自己，名字稳定更省心；
// 而且历史版本就地写过 apply-update.sh，固定名能让它被覆盖而不是越堆越多。
func stagedInstallerName(isWindows bool) string {
	if isWindows {
		return "apply-update.bat"
	}
	return "apply-update.sh"
}

// findPackagedInstaller 在解压目录里找包内安装脚本。
//
// 返回 (nil, nil) 表示包里没有——这是旧包的正常情况，调用方回退内嵌模板。
// 找到了但内容不合法则返回错误：文件存在就意味着这个包声明了自己的安装策略，
// 此时静默退化成旧策略比直接失败更危险（用户会以为更新成功了）。
func findPackagedInstaller(extractedDir string, isWindows bool) (*packagedInstaller, error) {
	for _, name := range installerCandidateNames(isWindows) {
		path := filepath.Join(extractedDir, name)
		info, err := os.Lstat(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		// 解压器已经跳过链接条目，这里再挡一次：上传包可能绕过那道过滤。
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("更新包里的 %s 不是普通文件，拒绝执行", name)
		}
		if info.Size() > maxInstallerSize {
			return nil, fmt.Errorf("更新包里的 %s 体积异常（%d 字节，上限 %d）", name, info.Size(), maxInstallerSize)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("读取更新包内的 %s 失败: %w", name, err)
		}
		api, err := parseInstallerAPI(content)
		if err != nil {
			return nil, fmt.Errorf("更新包里的 %s: %w", name, err)
		}
		if api > maxInstallerAPI {
			return nil, fmt.Errorf(
				"更新包里的安装脚本要求更新器契约 v%d，当前更新器最高支持 v%d；请手动更新到该版本后再试",
				api, maxInstallerAPI,
			)
		}
		return &packagedInstaller{Name: name, API: api, Content: content}, nil
	}
	return nil, nil
}

// parseInstallerAPI 读取脚本头部的契约版本。
//
// 只扫前 16 行：契约声明必须在头部，但允许 shebang、`@echo off`、`chcp` 在前面。
// 缺声明直接报错——没有版本号的脚本无法判断它适配哪套注入约定。
func parseInstallerAPI(content []byte) (int, error) {
	normalized := strings.ReplaceAll(string(content), "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	limit := len(lines)
	if limit > 16 {
		limit = 16
	}
	for _, line := range lines[:limit] {
		match := installerAPIPattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		api, err := strconv.Atoi(match[1])
		if err != nil {
			return 0, fmt.Errorf("契约版本不是合法数字: %s", match[1])
		}
		return api, nil
	}
	return 0, errors.New("缺少 `zviewer-installer: N` 契约声明，无法确认它适配当前更新器")
}

// stagePackagedInstaller 把包内脚本落到安装根目录，返回可执行路径。
//
// 不直接在解压目录里执行：脚本收尾会 `rm -rf $TEMP_DIR`，而 TEMP_DIR 正是
// 它自己所在的地方——删掉一个正在被 bash 逐行读取的文件属于未定义行为。
// 复制出来还有个附带好处：安装目录与解压目录在同一文件系统，覆盖不受影响。
func stagePackagedInstaller(root string, installer *packagedInstaller, isWindows bool) (string, error) {
	content := installer.Content
	if isWindows {
		// cmd.exe 解析 LF 换行的 bat 会报 "xxx 不是内部或外部命令"，
		// 而用户上传的 zip 里很可能是 LF（构建期我们会转，但不能指望所有来源）。
		content = []byte(strings.ReplaceAll(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n", "\r\n"))
	}
	target := filepath.Join(root, stagedInstallerName(isWindows))
	if err := os.WriteFile(target, content, 0o755); err != nil {
		return "", fmt.Errorf("落位安装脚本失败: %w", err)
	}
	// WriteFile 的 mode 会被 umask 削掉执行位，bash 直接跑会 permission denied。
	if err := os.Chmod(target, 0o755); err != nil {
		return "", fmt.Errorf("设置安装脚本执行位失败: %w", err)
	}
	return target, nil
}

// installerEnv 拼出注入给包内脚本的环境变量。
//
// 参数走环境变量而不是渲染进脚本体：脚本是包里的原样字节，更新器不该改写它，
// 否则「策略由包决定」又变成了「由更新器改写决定」。
//
// 先剔掉继承环境里的同名项再追加：execve 允许重复键，但子进程取哪一个
// 由 libc/shell 决定，留着重复项等于埋一个「有时生效」的坑。
func installerEnv(root, tempDir, extractedDir, mode, tag, fromVersion string) []string {
	injected := map[string]string{
		"ZVIEWER_UPDATE_ROOT":      root,
		"ZVIEWER_UPDATE_TEMP":      tempDir,
		"ZVIEWER_UPDATE_EXTRACTED": extractedDir,
		"ZVIEWER_UPDATE_MODE":      mode,
		"ZVIEWER_UPDATE_TAG":       tag,
		"ZVIEWER_UPDATE_FROM":      fromVersion,
	}
	env := make([]string, 0, len(os.Environ())+len(injected))
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, replaced := injected[name]; replaced {
			continue
		}
		env = append(env, entry)
	}
	for name, value := range injected {
		env = append(env, name+"="+value)
	}
	return env
}

// installScript 决定这次用哪份安装脚本，并把它落到安装根目录。
//
// 优先级：更新包自带 > 内嵌模板。包内脚本就是新版本的安装策略；
// 模板只服务于 5.4 之前那些不认识这份脚本的旧包，保证升级路径不断。
func (s *Service) installScript(root, tempDir, extractedDir string, isWindows bool, mode, tag string) (string, error) {
	packaged, err := findPackagedInstaller(extractedDir, isWindows)
	if err != nil {
		return "", err
	}
	if packaged != nil {
		logf("使用更新包内置安装脚本 %s（契约 v%d，模式 %s）", packaged.Name, packaged.API, mode)
		return stagePackagedInstaller(root, packaged, isWindows)
	}
	logf("更新包未携带 install-update 脚本，回退内置模板（旧包兼容路径）")
	switch {
	case isWindows:
		return writeApplyUpdateBat(root, tempDir, extractedDir)
	case mode == "docker":
		return writeDockerUpdateSh(root, tempDir, extractedDir)
	default:
		return writeApplyUpdateSh(root, tempDir, extractedDir)
	}
}
