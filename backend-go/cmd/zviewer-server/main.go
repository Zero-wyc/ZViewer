// Command zviewer-server 是 ZViewer 后端的 Go 实现。
//
// 迁移策略：与 Node 版**共用同一个 SQLite 数据库和同一份 config/**，
// 不做数据迁移、不改表结构，因此两个进程不能同时运行——
// 端口只能二选一（默认都是 3333），避免两边同时写库。
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"zviewer/backend/internal/api"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/db"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/store"
)

func main() {
	log.SetFlags(log.LstdFlags)
	log.SetPrefix("")

	// 先定位项目根再读 .env：dotenv 里可能就写着 PROJECT_ROOT / CONFIG_DIR
	root := config.DetectProjectRoot()
	config.LoadDotEnv(root)

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[config] %v", err)
	}
	if err := cfg.EnsureDirs(); err != nil {
		log.Fatalf("[config] %v", err)
	}

	conn, err := db.Open(cfg.DatabasePath, cfg.SQLiteWAL)
	if err != nil {
		log.Fatalf("[db] %v", err)
	}
	defer conn.Close()

	tokens, err := auth.NewManager(cfg.ConfigDir)
	if err != nil {
		log.Fatalf("[auth] %v", err)
	}

	users := store.NewUsers(conn)
	settings := store.NewSettings(conn)
	audit := store.NewAudit(conn)

	movies := store.NewMovies(conn)
	rooms := store.NewRooms(conn)
	mounts := store.NewMounts(conn)
	tracks := store.NewTracks(conn)
	metas := store.NewMetas(conn)

	server := api.New(api.Deps{
		Cfg:      cfg,
		DB:       conn,
		Users:    users,
		Settings: settings,
		Audit:    audit,
		Movies:   movies,
		Rooms:    rooms,
		Mounts:   mounts,
		Tracks:   tracks,
		Metas:    metas,
		Stream:   proxy.NewStreamResolver(movies, rooms, mounts),
		OpenList: openlist.NewClient(),
		Tokens:   tokens,
		Auth:     auth.NewAuthenticator(tokens, users),
		Bilibili: bilibili.NewService(conn),
	})

	httpServer := &http.Server{
		Addr:    listenAddr(cfg),
		Handler: server.Handler(),
		// 只设读头超时：后续的媒体代理、SSE、长轮询都可能有很长的写持续时间，
		// 设 WriteTimeout 会把大文件转发和实时流直接掐断。
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("[start] ZViewer Go 后端 平台=%s 项目根=%s", config.Platform(), cfg.ProjectRoot)
	log.Printf("[start] 数据库=%s (journal=%s)", cfg.DatabasePath, journalLabel(cfg.SQLiteWAL))
	log.Printf("[start] 监听 %s", httpServer.Addr)

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		log.Fatalf("[http] 监听失败: %v", err)
	case sig := <-stop:
		log.Printf("[shutdown] 收到信号 %s，开始优雅退出", sig)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("[shutdown] 强制关闭: %v", err)
	}
	log.Printf("[shutdown] 已退出")
}

func listenAddr(cfg *config.Config) string {
	if cfg.Host == "" {
		// 不指定 host 时监听双栈，与 Node 版默认行为一致
		return fmt.Sprintf(":%d", cfg.Port)
	}
	return fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
}

func journalLabel(wal bool) string {
	if wal {
		return "WAL"
	}
	return "delete（保持 sql.js 原模式）"
}
