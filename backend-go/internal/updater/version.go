package updater

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// LocalVersion 读取本机版本号。
//
// 口径与 Node 的 getLocalVersion 一致：项目根 package.json 的 version；
// 读不到就返回 "0.0.0"（版本号只影响更新提示，不该阻断任何流程）。
//
// 第二个候选 `<root>/runtime/package.json` 是给 GUI 分发包留的：那里根目录
// 是壳的目录，后端产物与其 package.json 都收在 runtime/ 下。
func LocalVersion(root string) string {
	for _, path := range []string{
		filepath.Join(root, "package.json"),
		filepath.Join(root, "runtime", "package.json"),
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var pkg struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(raw, &pkg); err == nil && pkg.Version != "" {
			log.Printf("[updater] 本地版本: %s (读取自 %s)", pkg.Version, path)
			return pkg.Version
		}
	}
	log.Printf("[updater] 读取版本号失败: %s", filepath.Join(root, "package.json"))
	return "0.0.0"
}

// IsDevVersion 判断版本号是否为 CI 的 dev 构建（0.0.0-dev.<sha>）。
//
// dev 构建无法与正式版做语义化比较，检查更新时一律视为「有更新」。
func IsDevVersion(version string) bool {
	return strings.HasPrefix(version, "0.0.0-dev.")
}

// PlatformAssetName 返回当前平台的发布产物名。
//
// 与 Node 的 getPlatformAssetName 一致：Windows 只有 zip，其它平台 tar.gz。
// goos 显式传入，测试才能覆盖两个分支。
func PlatformAssetName(goos string) string {
	if goos == "windows" {
		return "zviewer-windows-x64.zip"
	}
	return "zviewer-linux-x64.tar.gz"
}

// CompareVersions 比较两个版本号，返回 >0 表示 a 更新。
//
// 复刻 Node 的 compareVersions：先剥一个前导 `v`，按 `-` 切出数值核与
// prerelease 后缀，数值核逐段 `Number(x) || 0` 比较（段数不同按 0 补齐）；
// 数值相同则「无 prerelease 者更新」，两者都有 prerelease 时按字典序。
//
// 逐段用 `Number(x) || 0` 而不是严格整数解析，是因为 CI 会产出
// `0.0.0-dev.<sha>` 这种段：`Number('0-dev...')` 是 NaN，Node 静默按 0 处理，
// Go 侧必须同样宽松，否则会遇到「Node 认为相等、Go 认为更旧」。
func CompareVersions(a, b string) int {
	pa, pva := parseVersion(a)
	pb, pvb := parseVersion(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var va, vb float64
		if i < len(pa) {
			va = pa[i]
		}
		if i < len(pb) {
			vb = pb[i]
		}
		if va > vb {
			return 1
		}
		if va < vb {
			return -1
		}
	}
	if pva == "" && pvb != "" {
		return 1
	}
	if pva != "" && pvb == "" {
		return -1
	}
	if pva != pvb {
		return strings.Compare(pva, pvb)
	}
	return 0
}

// parseVersion 拆出数值核与 prerelease 后缀。
func parseVersion(v string) ([]float64, string) {
	normalized := strings.TrimPrefix(v, "v")
	core := normalized
	pre := ""
	if idx := strings.Index(normalized, "-"); idx >= 0 {
		core = normalized[:idx]
		pre = normalized[idx+1:]
	}
	segments := strings.Split(core, ".")
	parts := make([]float64, 0, len(segments))
	for _, seg := range segments {
		parts = append(parts, jsNumberOrZero(seg))
	}
	return parts, pre
}

// jsNumberOrZero 是 `Number(x) || 0` 的 Go 版。
//
// JS 的 Number 对空串、空白串、非数字串分别给 0 / 0 / NaN，三者经 `|| 0`
// 都归零；ParseFloat 恰好也只在这些情况下失败（它比 Number 更严格一点，
// 不接受 0x 前缀与 Infinity 字面量，但版本号里不会出现）。
func jsNumberOrZero(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	// `Number('NaN')` 是 NaN，NaN||0 也是 0。
	if f != f {
		return 0
	}
	return f
}
