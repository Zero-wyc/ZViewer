package api

// 房间界面上的显示开关（管理端「基础设置」里可改）。
//
// 为什么落在文件而不是数据库：`system_settings` 是整行表，Go 侧刻意不改表结构
// ——多一列会让存量库的 SELECT 直接失败（启动即炸），而 `--init-db` 只服务空库。
// 这与 updater 的「更新源」开关同一处理方式，配置落在 `<config>/ui-prefs.json`：
// config/ 在自动更新时会被备份还原，不会丢。
//
// live2dEnabled 也放这里，理由同上。它以前挂在 betaFeaturesEnabled 上，等于
// 「想关影片推送面板就得把房间角色一起关掉」；拆出来之后角色可以独立转正。

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const uiPrefsFileName = "ui-prefs.json"

// uiPrefs 用指针接住「字段缺失」：缺失按默认（显示）处理，
// 这样老安装升级上来不会被静默关掉两个入口。
type uiPrefs struct {
	ShowVoiceChatButton *bool `json:"showVoiceChatButton"`
	ShowTrafficPanel    *bool `json:"showTrafficPanel"`
	// Live2DEnabled 控制房间里是否出现悬浮角色（右下角圆钮 + 画面底部模型）。
	// 默认**开**：功能已经完整（同步、动捕、模型库都在），关掉只是给不想看
	// 角色的部署留一个干净的房间。
	Live2DEnabled *bool `json:"live2dEnabled"`
}

// UIPrefs 是解析后的偏好（带默认值）。
type UIPrefs struct {
	ShowVoiceChatButton bool
	ShowTrafficPanel    bool
	Live2DEnabled       bool
}

func uiPrefsPath(configDir string) string {
	return filepath.Join(configDir, uiPrefsFileName)
}

// readUIPrefs 读取偏好；文件缺失或格式不对时按「都显示」处理。
//
// 读失败不报错：这两个开关只影响界面上是否显示悬浮按钮，
// 不该因为它把整个设置页拦死。
func readUIPrefs(configDir string) UIPrefs {
	prefs := UIPrefs{
		ShowVoiceChatButton: true,
		ShowTrafficPanel:    true,
		Live2DEnabled:       true,
	}
	raw, err := os.ReadFile(uiPrefsPath(configDir))
	if err != nil {
		return prefs
	}
	var stored uiPrefs
	if err := json.Unmarshal(raw, &stored); err != nil {
		return prefs
	}
	if stored.ShowVoiceChatButton != nil {
		prefs.ShowVoiceChatButton = *stored.ShowVoiceChatButton
	}
	if stored.ShowTrafficPanel != nil {
		prefs.ShowTrafficPanel = *stored.ShowTrafficPanel
	}
	if stored.Live2DEnabled != nil {
		prefs.Live2DEnabled = *stored.Live2DEnabled
	}
	return prefs
}

// writeUIPrefs 原子写入（先写 .tmp 再 rename，避免半截文件）。
func writeUIPrefs(configDir string, prefs UIPrefs) error {
	path := uiPrefsPath(configDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	stored := uiPrefs{
		ShowVoiceChatButton: &prefs.ShowVoiceChatButton,
		ShowTrafficPanel:    &prefs.ShowTrafficPanel,
		Live2DEnabled:       &prefs.Live2DEnabled,
	}
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

// readUIPrefsFromServer 是 Server 侧的便捷包装（cfg 为 nil 时按默认）。
func (s *Server) uiPrefs() UIPrefs {
	if s.Cfg == nil {
		return UIPrefs{
			ShowVoiceChatButton: true,
			ShowTrafficPanel:    true,
			Live2DEnabled:       true,
		}
	}
	return readUIPrefs(s.Cfg.ConfigDir)
}
