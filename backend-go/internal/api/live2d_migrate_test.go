package api

import (
	"os"
	"path/filepath"
	"testing"

	"zviewer/backend/internal/config"
)

// 模型库从「房间私有」改成「服务端公共」时，老布局 live2d/<roomId>/<modelId>/
// 会被列表整批跳过（根下那些 <roomId> 目录里没有入口）。必须搬平，否则用户
// 刚传的模型会凭空消失。
func TestMigrateLegacyLive2DModels(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "live2d")
	srv := &Server{Deps: Deps{Cfg: &config.Config{UploadsDir: dir}}}

	legacy := filepath.Join(root, "ROOM1", "hiyori-abc123")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatalf("建老目录失败: %v", err)
	}
	for _, name := range []string{live2dEntryFile, live2dLegacyMetaFile} {
		if err := os.WriteFile(filepath.Join(legacy, name), []byte(`{"label":"Hiyori"}`), 0o644); err != nil {
			t.Fatalf("写文件失败: %v", err)
		}
	}
	// 已经是新布局的那条不能被搬动。
	current := filepath.Join(root, "koharu-def456")
	if err := os.MkdirAll(current, 0o755); err != nil {
		t.Fatalf("建新目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(current, live2dEntryFile), []byte(`{}`), 0o644); err != nil {
		t.Fatalf("写入口失败: %v", err)
	}

	srv.migrateLegacyLive2DModels()

	if _, err := os.Stat(filepath.Join(root, "hiyori-abc123", live2dEntryFile)); err != nil {
		t.Fatalf("老目录应被搬到库根: %v", err)
	}
	// 显示名靠元数据，迁移后仍然读得到（文件名已换成现役的）。
	if _, err := os.Stat(filepath.Join(root, "hiyori-abc123", live2dMetaFile)); err != nil {
		t.Fatalf("元数据应改成 .meta.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "ROOM1")); !os.IsNotExist(err) {
		t.Errorf("搬空后的房间目录应删掉: %v", err)
	}
	if _, err := os.Stat(filepath.Join(current, live2dEntryFile)); err != nil {
		t.Errorf("新布局的模型不应被搬动: %v", err)
	}

	// 幂等：重复跑不产生任何变化，也不能把已搬好的东西再搬走。
	srv.migrateLegacyLive2DModels()
	if got := len(srv.readLive2DModels()); got != 2 {
		t.Fatalf("重复迁移后应仍是 2 个模型，得到 %d", got)
	}
}
