package webgui

// 网页控制台的登录口径：直接校验 ZViewer 的超级管理员账号（user 表 role=root）。
//
// 为什么读库而不是调 3333 的登录接口：控制台的设计前提是「后端没起来也能用」，
// 而首次部署、后端崩溃正是它最该可用的时刻——那时候调后端登录接口必然失败，
// 用户就永远点不到「启动服务」。
//
// 数据库路径按 PROJECT_ROOT / CONFIG_DIR / DATABASE_URL 解析（与后端一致），
// 每次登录现开现关：管理员在 ZViewer 后台改了密码，下一次登录立即生效，
// 不需要重启控制台。连接只做 SELECT，不写任何东西。

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"zviewer/desktop/controller"

	// modernc 是纯 Go 实现，不需要 CGO；与后端使用同一个驱动，避免两套 SQLite。
	_ "modernc.org/sqlite"
)

// 与 backend-go/internal/auth 的角色/状态常量一致。
// 两个 module 不能直接互相 import，改动时两边同改。
const (
	adminRoleRoot      = "root"
	adminStatusActive  = "active"
	adminStatusPending = "pending"
)

// 库还没初始化时（后端从未跑过）用的兜底账号，与后端 SeedAdmin 的默认值一致。
// 选定这个策略的理由：控制台必须先能进去，否则用户没有别的入口去初始化后端。
const (
	fallbackAdminUsername = "root"
	fallbackAdminPassword = "root"
)

// adminQueryTimeout 限制单次查库，避免磁盘慢/锁等待把登录请求挂住。
const adminQueryTimeout = 3 * time.Second

// adminVerdict 是一次登录校验的结论。
type adminVerdict struct {
	// OK 表示账号密码通过。
	OK bool
	// Reason 是给浏览器看的失败原因，不含任何会泄露账号存在性的细节。
	Reason string
	// DatabaseReady 表示这次真的读到了 user 表；false 说明用的是兜底口令。
	DatabaseReady bool
	// MustChangePassword 表示仍在使用初始口令 root，与后端登录返回的语义一致。
	MustChangePassword bool
}

// verifyAdminLogin 校验用户名+密码。
//
// 分支顺序刻意如此：库缺失/不可读一律走兜底，而不是报错——把「控制台进不去」
// 变成「先用 root/root 进去把后端初始化起来」。
func verifyAdminLogin(root, username, password string) adminVerdict {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return adminVerdict{Reason: "请输入用户名和密码"}
	}
	if strings.TrimSpace(root) == "" {
		return fallbackVerdict(username, password)
	}

	path := controller.BackendDatabasePath(root)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return fallbackVerdict(username, password)
	}

	verdict, err := checkAdminAccount(path, username, password)
	if err != nil {
		// 表还没建、库文件损坏、驱动打不开：都当作「库未就绪」。
		// 真实的读取错误仍要留痕，否则用户只会看到「请用 root/root」而不知道为什么。
		fallback := fallbackVerdict(username, password)
		fallback.Reason = fallback.Reason + "（数据库不可用：" + err.Error() + "）"
		return fallback
	}
	return verdict
}

// fallbackVerdict 是库未初始化时的判定。
func fallbackVerdict(username, password string) adminVerdict {
	if username == fallbackAdminUsername && password == fallbackAdminPassword {
		return adminVerdict{OK: true, MustChangePassword: true}
	}
	return adminVerdict{Reason: "数据库尚未初始化，首次请用 root / root 登录"}
}

// checkAdminAccount 在已有数据库上校验账号。返回错误表示「库/表读不出来」，
// 与「账号密码不对」是两回事。
func checkAdminAccount(path, username, password string) (adminVerdict, error) {
	conn, err := openAdminDB(path)
	if err != nil {
		return adminVerdict{}, err
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), adminQueryTimeout)
	defer cancel()

	var hash, role, status string
	err = conn.QueryRowContext(ctx,
		`SELECT "passwordHash", "role", "status" FROM "user" WHERE "username" = ? LIMIT 1`,
		username,
	).Scan(&hash, &role, &status)

	if errors.Is(err, sql.ErrNoRows) {
		// 用户不存在与密码错误返回同一句，避免被拿来枚举账号。
		return adminVerdict{DatabaseReady: true, Reason: "用户名或密码错误"}, nil
	}
	if err != nil {
		return adminVerdict{}, err
	}

	if role != adminRoleRoot {
		return adminVerdict{DatabaseReady: true, Reason: "只有 ZViewer 超级管理员可以登录控制台"}, nil
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return adminVerdict{DatabaseReady: true, Reason: "用户名或密码错误"}, nil
	}
	switch status {
	case adminStatusActive:
	case adminStatusPending:
		return adminVerdict{DatabaseReady: true, Reason: "账号正在审核中，请稍后再试"}, nil
	default:
		return adminVerdict{DatabaseReady: true, Reason: "账号已停用"}, nil
	}

	// 与后端一致：root 还在用初始口令时提示改密（不改也能用，只是强提示）。
	mustChange := bcrypt.CompareHashAndPassword([]byte(hash), []byte("root")) == nil
	return adminVerdict{OK: true, DatabaseReady: true, MustChangePassword: mustChange}, nil
}

// openAdminDB 打开后端数据库。
//
// 不加 mode=ro：后端默认 WAL，只读模式在没有 -shm 写权限时可能打不开；
// 我们只发 SELECT，多进程读本来就是 SQLite 支持的。连接数锁到 1，
// 且每次登录后关闭，不会长期占着后端的库。
func openAdminDB(path string) (*sql.DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	dsn := "file:" + url.PathEscape(filepath.ToSlash(abs)) + "?_pragma=busy_timeout(3000)"
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	return conn, nil
}
