package controller

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareDatabaseInitializesMissingFileOnce(t *testing.T) {
	root := t.TempDir()
	database := backendDatabasePath(root, nil)
	calls := 0
	initialize := func() ([]byte, error) {
		calls++
		if err := os.MkdirAll(filepath.Dir(database), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(database, []byte("existing data"), 0o600); err != nil {
			t.Fatal(err)
		}
		return []byte("  [完成] 数据库已初始化\r\n  初始管理员: root / test-password-123\r\n  密码只显示这一次\r\n"), nil
	}
	admin, err := prepareDatabase(root, nil, initialize)
	if err != nil || admin == nil || admin.Username != "root" || admin.Password != "test-password-123" {
		t.Fatalf("unexpected first-run result: admin=%v error=%v", admin != nil, err)
	}
	admin, err = prepareDatabase(root, nil, initialize)
	if err != nil || admin != nil || calls != 1 {
		t.Fatalf("existing database was initialized again: calls=%d error=%v", calls, err)
	}
}

func TestPrepareDatabasePreservesExistingFiles(t *testing.T) {
	for _, contents := range []string{"", "invalid database must not be replaced"} {
		t.Run(contents, func(t *testing.T) {
			root := t.TempDir()
			database := filepath.Join(root, "old.sqlite")
			if err := os.WriteFile(database, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			admin, err := prepareDatabase(root, []string{"DATABASE_URL=" + database}, func() ([]byte, error) {
				t.Fatal("must not initialize an existing file")
				return nil, nil
			})
			got, readErr := os.ReadFile(database)
			if err != nil || readErr != nil || admin != nil || string(got) != contents {
				t.Fatalf("existing file changed: error=%v readError=%v", err, readErr)
			}
		})
	}
}

func TestBackendDatabasePathHonorsEnvironment(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	absDatabase := filepath.Join(root, "old", "users.sqlite")
	for _, test := range []struct {
		env  []string
		want string
	}{
		{nil, filepath.Join(root, "config", "dev.sqlite")},
		{[]string{"PROJECT_ROOT=" + project}, filepath.Join(project, "config", "dev.sqlite")},
		{[]string{"CONFIG_DIR=data", "DATABASE_URL=users.sqlite"}, filepath.Join(root, "data", "users.sqlite")},
		{[]string{"CONFIG_DIR=data", "DATABASE_URL=" + absDatabase}, absDatabase},
	} {
		if got := backendDatabasePath(root, test.env); got != test.want {
			t.Errorf("path=%q want=%q", got, test.want)
		}
	}
}

func TestPrepareDatabaseReportsFailureWithoutPassword(t *testing.T) {
	_, err := prepareDatabase(t.TempDir(), nil, func() ([]byte, error) {
		return []byte("  初始管理员: root / secret-test-password\ninitialization failed: disk full"), errors.New("exit status 1")
	})
	if err == nil || !strings.Contains(err.Error(), "disk full") || strings.Contains(err.Error(), "secret-test-password") {
		t.Fatalf("unexpected sanitized initialization error: %v", err)
	}
}

// Opt-in acceptance against the exact shipped backend, with an isolated database.
func TestEnsureDatabasePackagedBackend(t *testing.T) {
	exe := os.Getenv("ZVIEWER_TEST_BACKEND")
	if exe == "" {
		t.Skip("ZVIEWER_TEST_BACKEND is not set")
	}
	root := t.TempDir()
	var admin InitialAdmin
	deliveries := 0
	c := &Controller{root: root, dir: filepath.Join(root, "state"), onInitialAdmin: func(value InitialAdmin) {
		admin = value
		deliveries++
	}}
	env := append(os.Environ(), "PROJECT_ROOT="+root, "CONFIG_DIR="+filepath.Join(root, "config"), "DATABASE_URL=dev.sqlite")
	if err := c.ensureDatabase(exe, env); err != nil {
		t.Fatal(err)
	}
	if deliveries != 1 || admin.Username != "root" || admin.Password != "root" {
		t.Fatal("initial admin was not delivered to the local window callback")
	}
	database := backendDatabasePath(root, env)
	before, err := os.ReadFile(database)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.ensureDatabase(exe, env); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(database)
	if err != nil || !bytes.Equal(before, after) || deliveries != 1 {
		t.Fatal("second start changed the database or recreated the administrator")
	}
	for _, event := range c.events {
		if strings.Contains(event.Message, admin.Password) {
			t.Fatal("administrator password leaked to logs")
		}
	}
}
