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

	"zviewer/backend/internal/anime"
	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/api"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/cms"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/danmaku"
	"zviewer/backend/internal/db"
	"zviewer/backend/internal/kazumi"
	"zviewer/backend/internal/ncm"
	"zviewer/backend/internal/nms"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/realtime"
	"zviewer/backend/internal/room"
	"zviewer/backend/internal/serverfiles"
	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/ssl"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/subtitle"
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

	// `--gen-cert` 是独立的证书签发入口：签完即退出，不连库、不起服务。
	// 必须在 db.Open 之前分流——Node 版也是在 bootstrap() 之前判断的。
	if args := os.Args[1:]; hasFlag(args, "--gen-cert") {
		if hasFlag(args, "--help") || hasFlag(args, "-h") {
			ssl.PrintUsage(os.Stdout)
			return
		}
		if err := ssl.RunGenCert(context.Background(), args, cfg.ConfigDir, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "  [错误] 证书生成失败: %v\n", err)
			fmt.Fprintln(os.Stderr, "  如需继续使用自签证书，请加 --selfsigned 参数")
			os.Exit(1)
		}
		return
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
	sessions := store.NewSessions(conn)
	serverFolders := store.NewServerFolders(conn)

	// 实时层：socket 服务端 → 广播适配器 → 房间业务。
	// 三者是单向依赖（房间层只认接口），所以构造顺序固定，不能调换。
	socketSrv := sio.NewServer(sio.Options{})
	hub := realtime.NewSocketHub(socketSrv)
	// 推流探测器只构造一次：房间 socket 事件与 /api/stream-push 必须拿到
	// 同一个答案，分开构造会让可用性缓存在两边各自漂移。
	streamPush := nms.New(nms.ConfigFromEnv())
	// 一起听的播放基线：内存 + DB。isHostOnline 需要核对连接是否还在，
	// 所以要在拿到 Hub 之后再注入一次。
	musicMemory := room.NewMusicMemory(conn)
	musicMemory.SetLogger(log.Default())
	musicMemory.SetHub(hub)
	roomSvc := room.NewService(room.Deps{
		DB:       conn,
		Rooms:    rooms,
		Sessions: sessions,
		Settings: settings,
		Movies:   movies,
		Comments: store.NewComments(conn),
		Metas:    metas,
		Users:    users,
		Playback: room.NewPlaybackMemory(conn),
		Hub:      hub,
		Logger:   log.Default(),
		Music:    musicMemory,
		NMS:      streamPush,
	})

	// 流凭证解析器与服务器文件注册表都是多处复用（播放 + 字幕），先构造一次。
	streamResolver := proxy.NewStreamResolver(movies, rooms, mounts)
	// 同一个 B站 服务实例同时给 API 与动漫源（B站番剧源）用：
	// 凭证缓存、WBI 密钥、buvid 都在实例内，分成两份会重复握手。
	biliService := bilibili.NewService(conn)
	filesRegistry := serverfiles.NewRegistry(serverFolders, cfg.UploadsDir)

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
		Stream:   streamResolver,
		OpenList: openlist.NewClient(),
		Tokens:   tokens,
		Auth:     auth.NewAuthenticator(tokens, users),
		Bilibili: biliService,
		Bus:      hub,
		RoomSvc:  roomSvc,
		Socket:   socketSrv,

		ServerFolders: serverFolders,
		Files:         filesRegistry,
		Subtitles:     subtitle.NewService(streamResolver, filesRegistry),
		CMS:           cms.NewService(settings),
		Anime:         anime.NewService(settings, biliService),
		AniSubs:       anisubs.NewService(settings),
		Kazumi:        kazumi.NewService(settings),
		Danmaku:       danmaku.NewService(biliService),
		NCM:           ncm.NewService(conn, cfg.NCMAPIBase),
		NMS:           streamPush,
	})

	// 服务器周期心跳：房主掉线后观众端靠它继续推进进度（每 2s 一轮），
	// 顺带每 30s 清理陈旧缓存。必须在开始接客之前启动，否则观众进房后
	// 第一口气要等满一个周期。
	broadcaster := room.NewBroadcaster(roomSvc, log.Default())
	broadcaster.Start()

	// 一起听的服务器心跳：每 2s 广播 music:sync-heartbeat(source='server')，
	// 观众进度唯一权威来源；顺带每 30s 清理陈旧基线缓存。
	musicBroadcaster := room.NewMusicBroadcaster(roomSvc, log.Default())
	musicBroadcaster.Start()

	// 房间清理定时任务：启动即跑一轮，之后每小时删一次长期无人访问的房间。
	// 用可取消的 ctx 而不是空 context：优雅退出时要能停掉。
	cleanupCtx, stopCleanup := context.WithCancel(context.Background())
	stopCleanupScheduler := roomSvc.StartCleanupScheduler(cleanupCtx)

	// HTTPS 模式：证书缺失时自动签一张本机自签证书。
	// 屏幕共享与语音在非安全上下文里会被浏览器禁用，局域网用户靠这张证书
	// 才能用上它们（首次访问需手动信任）。
	certPaths := ssl.Paths(cfg.ConfigDir)
	if cfg.UseTLS {
		if !fileExists(certPaths.CertPath) || !fileExists(certPaths.KeyPath) {
			log.Printf("[HTTPS] SSL 证书不存在，自动生成本地自签证书...")
			if _, err := ssl.EnsureSelfSigned(ssl.SelfSignedOptions{
				Paths: certPaths,
				Log:   func(line string) { log.Print(line) },
			}); err != nil {
				log.Fatalf("[HTTPS] 自签证书生成失败: %v", err)
			}
			log.Printf("[HTTPS] 自签证书生成完成（浏览器首次访问需信任自签证书）")
		}
		log.Printf("[HTTPS] 使用证书: %s", certPaths.CertPath)
	}

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
		var err error
		if cfg.UseTLS {
			err = httpServer.ListenAndServeTLS(certPaths.CertPath, certPaths.KeyPath)
		} else {
			err = httpServer.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
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

	// 先停定时器再落盘：广播器不停的话，落盘期间还会继续改内存状态，
	// 刚写进 DB 的那份立刻就旧了。
	stopCleanupScheduler()
	stopCleanup()
	broadcaster.Stop()
	musicBroadcaster.Stop()
	roomSvc.Playback.FlushAllDirty(ctx)
	musicMemory.FlushAllDirty(ctx)

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

// hasFlag 判断命令行里是否带某个开关。
func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
