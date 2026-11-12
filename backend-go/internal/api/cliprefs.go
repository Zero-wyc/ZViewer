package api

// 「允许 CLI 使用房主 B站 身份解析」的系统开关。
//
// 为什么不写 system_settings：这张表是整行表，Go 侧刻意不改表结构
// ——多一列会让存量库的 SELECT 直接失败（启动即炸），而 --init-db 只服务空库。
// 与 updater 的「更新源」、房间悬浮入口同处理，配置落在
// `<config>/cli-prefs.json`：config/ 在自动更新时会被备份还原，不会丢。

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const cliPrefsFileName = "cli-prefs.json"

// cliPrefs 用指针接住「字段缺失」：缺失按开启处理，
// 老安装升级上来即可直接使用，不需要管理员先去设置页开一次。
type cliPrefs struct {
	AllowHostResolveForCli *bool `json:"allowHostResolveForCli"`
}

// CLIPrefs 是解析后的偏好（带默认值）。
type CLIPrefs struct {
	// AllowHostResolveForCli 为 true 时，CLI 观众可以选择用房间房主的
	// B站 身份解析直链（观众自己不需要登录 B站）。
	AllowHostResolveForCli bool
}

func cliPrefsPath(configDir string) string {
	return filepath.Join(configDir, cliPrefsFileName)
}

// readCLIPrefs 读取偏好；文件缺失或格式不对时按开启处理。
//
// 读失败不报错：这个开关只影响 CLI 的解析来源选择，
// 不该因为它把整个设置页拦死。
func readCLIPrefs(configDir string) CLIPrefs {
	prefs := CLIPrefs{AllowHostResolveForCli: true}
	raw, err := os.ReadFile(cliPrefsPath(configDir))
	if err != nil {
		return prefs
	}
	var stored cliPrefs
	if err := json.Unmarshal(raw, &stored); err != nil {
		return prefs
	}
	if stored.AllowHostResolveForCli != nil {
		prefs.AllowHostResolveForCli = *stored.AllowHostResolveForCli
	}
	return prefs
}

// writeCLIPrefs 原子写入（先写 .tmp 再 rename，避免半截文件）。
func writeCLIPrefs(configDir string, prefs CLIPrefs) error {
	path := cliPrefsPath(configDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	stored := cliPrefs{AllowHostResolveForCli: &prefs.AllowHostResolveForCli}
	raw, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

// cliPrefs 是 Server 侧的便捷包装（Cfg 为 nil 时按默认开启）。
func (s *Server) cliPrefs() CLIPrefs {
	if s.Cfg == nil {
		return CLIPrefs{AllowHostResolveForCli: true}
	}
	return readCLIPrefs(s.Cfg.ConfigDir)
}
