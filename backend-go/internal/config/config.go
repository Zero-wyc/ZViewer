// Package config 集中解析运行环境与数据路径。
//
// 与 backend/src/services/paths.ts、server-env.ts 逐条对齐：
// 环境变量优先、默认值落在 <project-root>/config/ 下，
// 目的只有一个——让 Go 版与 Node 版读到同一份 config/、同一个 .env。
package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// CORSConfig 描述跨域策略，等价于 Node 侧 parseCorsOrigin 的三种形态：
// 任意来源（反射 Origin）/ 关闭 / 白名单。
type CORSConfig struct {
	// AllowAll 为 true 时反射请求的 Origin（credentials 场景不能写 '*'）
	AllowAll bool
	// Disabled 为 true 时不下发任何 CORS 头
	Disabled bool
	// Origins 为显式白名单
	Origins []string
}

// Config 是进程级只读配置，启动时解析一次。
type Config struct {
	ProjectRoot  string
	ConfigDir    string
	DatabasePath string
	UploadsDir   string
	AvatarsDir   string
	MediaDir     string
	FrontendDist string

	Port int
	Host string

	CORS   CORSConfig
	UseTLS bool

	StartedAt    time.Time
	RestartCount int

	// NCMAPIBase 是内部网易云 API 服务地址（一起听音乐模块的上游）。
	//
	// 与 Node 版不同：那边用 `@neteasecloudmusicapienhanced/api` 在本进程内起
	// 一个 127.0.0.1:36530 的服务；Go 版通过 HTTP 调用独立服务。
	// 显式配置优先；GUI 未配置时由随包 ncm 组件提供私有回环地址。
	// 服务不可用时转发、流等端点返回 503 NCM_UNAVAILABLE，登录状态仍保留缓存。
	NCMAPIBase string

	// SQLiteWAL 为 true 时把数据库切到 WAL 日志模式。
	//
	// **默认开启**（Node 后端已于 2026-10-25 删除，不再有第二个进程按
	// journal_mode=delete 打开同一个库）。WAL 下读不会被写阻塞，崩溃恢复
	// 只要重放 -wal 文件；代价是库里多出 `-wal` / `-shm` 两个旁文件，
	// 备份不能直接复制主文件（见 `db.Backup`）。
	// 需要退回旧模式时显式设 `SQLITE_WAL=0`。
	SQLiteWAL bool
}

// Load 解析配置。调用前应先调用 LoadDotEnv。
func Load() (*Config, error) {
	root := resolveProjectRoot()
	configDir := envOr("CONFIG_DIR", filepath.Join(root, "config"))

	cfg := &Config{
		ProjectRoot:  root,
		ConfigDir:    configDir,
		DatabasePath: resolveDatabasePath(configDir),
		UploadsDir:   envOr("UPLOADS_DIR", filepath.Join(configDir, "uploads")),
		MediaDir:     envOr("MEDIA_DIR", filepath.Join(configDir, "media")),
		FrontendDist: filepath.Join(root, "frontend", "dist"),
		Port:         3333,
		Host:         os.Getenv("HOST"),
		CORS:         parseCORSOrigin(os.Getenv("CORS_ORIGIN")),
		UseTLS:       os.Getenv("HTTPS") == "true",
		StartedAt:    time.Now(),
		SQLiteWAL:    os.Getenv("SQLITE_WAL") != "0",
	}
	cfg.AvatarsDir = envOr("AVATARS_DIR", filepath.Join(cfg.UploadsDir, "avatars"))
	cfg.NCMAPIBase = envOr("NCM_API_BASE", "http://127.0.0.1:36530")

	if raw := os.Getenv("PORT"); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil || port <= 0 || port > 65535 {
			return nil, fmt.Errorf("PORT 非法: %q", raw)
		}
		cfg.Port = port
	}
	if raw := os.Getenv("RESTART_COUNT"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			cfg.RestartCount = n
		}
	}
	return cfg, nil
}

// EnsureDirs 创建全部数据目录（与 paths.ts#ensureDataDirs 等价）。
func (c *Config) EnsureDirs() error {
	dirs := []string{c.ConfigDir, c.UploadsDir, c.AvatarsDir, c.MediaDir, filepath.Dir(c.DatabasePath)}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("创建目录失败 %s: %w", dir, err)
		}
	}
	return nil
}

// resolveProjectRoot 定位项目根目录。
//
// Node 版的规则是：PROJECT_ROOT 环境变量 > pkg 运行时取 execPath 目录 > 源码运行时上溯三级。
// Go 版是单一二进制，没有"源码运行"这一层，因此补一条更实用的兜底：
// 从工作目录向上找同时含 frontend/ 与 backend/ 的目录，找不到再退回可执行文件目录。
func resolveProjectRoot() string {
	if v := strings.TrimSpace(os.Getenv("PROJECT_ROOT")); v != "" {
		return v
	}
	if cwd, err := os.Getwd(); err == nil {
		if found := findProjectRootUpward(cwd); found != "" {
			return found
		}
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if found := findProjectRootUpward(dir); found != "" {
			return found
		}
		return dir
	}
	cwd, _ := os.Getwd()
	return cwd
}

// findProjectRootUpward 逐级向上探测项目特征目录。
//
// 判据是「同时有 frontend 与后端源码目录」。**backend-go 也算后端目录**：
// 删掉 Node 的 backend/ 之后，只认 backend 会让 `go run` 从 backend-go 起步时
// 一路向上找不到根，最后退到临时目录——表现为「数据库空了、设置全丢」，
// 而且只在开发态（go run 的 exe 在 TEMP）才出现，很难联想到根目录探测。
func findProjectRootUpward(start string) string {
	dir := start
	for i := 0; i < 8; i++ {
		hasFrontend := isDir(filepath.Join(dir, "frontend"))
		hasBackend := isDir(filepath.Join(dir, "backend")) || isDir(filepath.Join(dir, "backend-go"))
		if hasFrontend && hasBackend {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// resolveDatabasePath 复刻 paths.ts 的 DATABASE_URL 规则：
// 绝对路径原样使用；相对路径相对 CONFIG_DIR 解析（而非 cwd）。
func resolveDatabasePath(configDir string) string {
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		return filepath.Join(configDir, "dev.sqlite")
	}
	if filepath.IsAbs(raw) {
		return raw
	}
	return filepath.Join(configDir, raw)
}

func parseCORSOrigin(value string) CORSConfig {
	switch {
	case value == "":
		return CORSConfig{AllowAll: true}
	case value == "false":
		return CORSConfig{Disabled: true}
	case value == "*":
		return CORSConfig{AllowAll: true}
	default:
		parts := strings.Split(value, ",")
		origins := make([]string, 0, len(parts))
		for _, p := range parts {
			if v := strings.TrimSpace(p); v != "" {
				origins = append(origins, v)
			}
		}
		return CORSConfig{Origins: origins}
	}
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func isDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// LoadDotEnv 读取项目根与当前工作目录下的 .env，语义对齐 dotenv：
// 不覆盖已存在的环境变量，支持 KEY=VALUE、# 注释与成对引号。
func LoadDotEnv(projectRoot string) {
	candidates := []string{filepath.Join(projectRoot, ".env"), filepath.Join(projectRoot, "backend", ".env")}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, ".env"))
	}
	for _, path := range candidates {
		loadOneDotEnv(path)
	}
}

func loadOneDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			switch {
			case value[0] == '"' && value[len(value)-1] == '"':
				value = value[1 : len(value)-1]
			case value[0] == '\'' && value[len(value)-1] == '\'':
				value = value[1 : len(value)-1]
			}
		}
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, value)
		}
	}
}

// describePlatform 仅用于启动日志，确认交叉编译目标。
func describePlatform() string {
	return runtime.GOOS + "/" + runtime.GOARCH
}

// Platform 返回当前构建平台标识（如 windows/amd64）。
func Platform() string { return describePlatform() }

// DetectProjectRoot 在加载 .env 之前先探测项目根：
// 引导阶段 argv/env 里可能还没有 PROJECT_ROOT，需要靠目录特征定位。
func DetectProjectRoot() string { return resolveProjectRoot() }
