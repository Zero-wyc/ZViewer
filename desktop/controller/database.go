package controller

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// InitialAdmin is delivered only to the local window, never to logs or snapshots.
type InitialAdmin struct {
	Username string
	Password string
}

var initialAdminPattern = regexp.MustCompile(`(?m)^[\t ]*初始管理员:\s*(\S+)\s*/\s*(\S+)[\t ]*\r?$`)

// Match the backend's PROJECT_ROOT / CONFIG_DIR / DATABASE_URL path rules.
func backendDatabasePath(root string, env []string) string {
	values := make(map[string]string)
	for _, entry := range env {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[strings.ToUpper(key)] = value
		}
	}
	projectRoot := strings.TrimSpace(values["PROJECT_ROOT"])
	if projectRoot == "" {
		projectRoot = root
	}
	configDir := values["CONFIG_DIR"]
	if configDir == "" {
		configDir = filepath.Join(projectRoot, "config")
	}
	database := values["DATABASE_URL"]
	if database == "" {
		database = "dev.sqlite"
	}
	if !filepath.IsAbs(database) {
		database = filepath.Join(configDir, database)
	}
	if !filepath.IsAbs(database) {
		database = filepath.Join(root, database)
	}
	return filepath.Clean(database)
}

func prepareDatabase(root string, env []string, initialize func() ([]byte, error)) (*InitialAdmin, error) {
	database := backendDatabasePath(root, env)
	info, err := os.Stat(database)
	if err == nil {
		if info.IsDir() {
			return nil, fmt.Errorf("数据库路径是目录：%s", database)
		}
		// Existing, empty or invalid databases belong to backend validation.
		// Never reset them or run initialization over them.
		return nil, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("无法检查数据库 %s：%w", database, err)
	}
	output, err := initialize()
	if err != nil {
		safeOutput := initialAdminPattern.ReplaceAllString(string(output), "初始管理员: [已隐藏]")
		return nil, fmt.Errorf("首次启动数据库初始化失败：%w\n%s", err, strings.TrimSpace(safeOutput))
	}
	if info, err := os.Stat(database); err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("初始化未生成数据库文件：%s", database)
	}
	match := initialAdminPattern.FindStringSubmatch(string(output))
	if len(match) != 3 {
		return nil, fmt.Errorf("数据库已初始化，但后端未返回初始管理员登录信息：%s", database)
	}
	return &InitialAdmin{Username: match[1], Password: match[2]}, nil
}

func (c *Controller) ensureDatabase(exe string, env []string) error {
	admin, err := prepareDatabase(c.root, env, func() ([]byte, error) {
		c.log("首次启动，正在初始化本地数据库", "backend", "INFO")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, exe, "--init-db")
		cmd.Dir, cmd.Env = c.root, env
		hideWindow(cmd)
		output, err := cmd.CombinedOutput()
		if ctx.Err() != nil {
			return output, fmt.Errorf("初始化超过 30 秒：%w", ctx.Err())
		}
		return output, err
	})
	if err != nil {
		return err
	}
	if admin != nil {
		c.log("数据库初始化完成；初始管理员登录信息将在本机窗口中显示", "backend", "INFO")
		if c.onInitialAdmin != nil {
			c.onInitialAdmin(*admin)
		}
	}
	return nil
}
