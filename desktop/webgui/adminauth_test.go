package webgui

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	_ "modernc.org/sqlite"
)

// seedAdminDB 在 <root>/config/dev.sqlite 建一张最小 user 表并插入一条账号。
// 只建登录需要的三列（passwordHash/role/status），其余列与鉴权无关。
func seedAdminDB(t *testing.T, root, username, password, role, status string) {
	t.Helper()
	dir := filepath.Join(root, "config")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建 config 目录失败: %v", err)
	}
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "dev.sqlite")))
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Exec(`CREATE TABLE "user" (
		"id" INTEGER PRIMARY KEY AUTOINCREMENT,
		"username" TEXT NOT NULL,
		"passwordHash" TEXT NOT NULL,
		"role" TEXT NOT NULL,
		"status" TEXT NOT NULL
	)`); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("生成哈希失败: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)`,
		username, string(hash), role, status,
	); err != nil {
		t.Fatalf("插入账号失败: %v", err)
	}
}

// 库还不存在时（后端从未跑过）必须能用 root/root 进控制台，否则用户没有
// 别的入口去点「启动服务」。
func TestVerifyAdminLoginFallsBackWhenDatabaseMissing(t *testing.T) {
	root := t.TempDir()

	verdict := verifyAdminLogin(root, "root", "root")
	if !verdict.OK {
		t.Fatalf("库缺失时应允许 root/root，实际被拒绝：%s", verdict.Reason)
	}
	if verdict.DatabaseReady {
		t.Error("库缺失时 DatabaseReady 应为 false")
	}
	if !verdict.MustChangePassword {
		t.Error("兜底口令应提示改密")
	}

	if verdict := verifyAdminLogin(root, "root", "wrong"); verdict.OK {
		t.Error("库缺失时错误密码不应通过")
	} else if !strings.Contains(verdict.Reason, "尚未初始化") {
		t.Errorf("失败原因应提示库未初始化，实际：%q", verdict.Reason)
	}

	if verdict := verifyAdminLogin(root, "admin", "root"); verdict.OK {
		t.Error("兜底只认 root 这个用户名")
	}
}

// 库存在时一律以数据库为准，兜底口令必须失效。
func TestVerifyAdminLoginUsesDatabase(t *testing.T) {
	root := t.TempDir()
	seedAdminDB(t, root, "root", "Secret123", "root", "active")

	verdict := verifyAdminLogin(root, "root", "Secret123")
	if !verdict.OK {
		t.Fatalf("正确密码应通过，实际：%s", verdict.Reason)
	}
	if !verdict.DatabaseReady {
		t.Error("DatabaseReady 应为 true")
	}
	if verdict.MustChangePassword {
		t.Error("非默认口令不应提示改密")
	}

	// 关键：库一旦存在，root/root 就不能再当万能钥匙。
	if verdict := verifyAdminLogin(root, "root", "root"); verdict.OK {
		t.Error("库存在时兜底口令必须失效")
	}

	if verdict := verifyAdminLogin(root, "root", "wrong"); verdict.OK {
		t.Error("错误密码不应通过")
	} else if verdict.Reason != "用户名或密码错误" {
		t.Errorf("密码错误文案应统一，实际：%q", verdict.Reason)
	}

	if verdict := verifyAdminLogin(root, "ghost", "Secret123"); verdict.OK {
		t.Error("不存在的账号不应通过")
	}
}

// 只有 role=root 能进控制台；admin/user 属于业务账号，不该拿到控制台权限。
func TestVerifyAdminLoginRejectsNonRoot(t *testing.T) {
	root := t.TempDir()
	seedAdminDB(t, root, "alice", "Secret123", "admin", "active")

	verdict := verifyAdminLogin(root, "alice", "Secret123")
	if verdict.OK {
		t.Fatal("admin 角色不应允许登录控制台")
	}
	if !strings.Contains(verdict.Reason, "超级管理员") {
		t.Errorf("失败原因应说明需要超级管理员，实际：%q", verdict.Reason)
	}
}

// 待审核/停用的账号与后端登录保持一致，一律拒绝。
func TestVerifyAdminLoginRejectsInactiveStatus(t *testing.T) {
	cases := []struct {
		status string
		want   string
	}{
		{"pending", "审核"},
		{"disabled", "停用"},
	}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			root := t.TempDir()
			seedAdminDB(t, root, "root", "Secret123", "root", tc.status)
			verdict := verifyAdminLogin(root, "root", "Secret123")
			if verdict.OK {
				t.Fatalf("status=%s 不应通过", tc.status)
			}
			if !strings.Contains(verdict.Reason, tc.want) {
				t.Errorf("status=%s 的失败原因应包含 %q，实际：%q", tc.status, tc.want, verdict.Reason)
			}
		})
	}
}

// 用户名首尾空格要容忍（浏览器自动填充/手机输入法常带空格），密码不裁剪。
func TestVerifyAdminLoginTrimsUsername(t *testing.T) {
	root := t.TempDir()
	seedAdminDB(t, root, "root", "Secret 123 ", "root", "active")

	if verdict := verifyAdminLogin(root, "  root  ", "Secret 123 "); !verdict.OK {
		t.Fatalf("用户名两侧空格应被忽略，密码原样比较；实际：%s", verdict.Reason)
	}
}

func TestDefaultPort(t *testing.T) {
	if DefaultPort != 3332 {
		t.Fatalf("网页控制台默认端口应为 3332，实际 %d", DefaultPort)
	}
}
