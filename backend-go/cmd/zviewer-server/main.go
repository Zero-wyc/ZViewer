// Command zviewer-server 是 ZViewer 后端的 Go 实现。
//
// 迁移策略：与 Node 版**共用同一个 SQLite 数据库和同一份 config/**，
// 保留旧表并显式升级播放元数据可空列；两个进程不能同时运行——
// 端口只能二选一（默认都是 3333），避免两边同时写库。
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
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
	"zviewer/backend/internal/share"
	"zviewer/backend/internal/share/sfu"
	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/ssl"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/subtitle"
	"zviewer/backend/internal/updater"
	"zviewer/backend/internal/voicertc"
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

	// v4（Node）→ v5（Go）升级收尾：删掉 Node 版专属、Go 版不再使用的文件。
	// 放在最早期（不依赖 DB、不依赖网络），幂等；只有「发布包布局」才做目录级清理，
	// 源码树（.git / frontend/src）一律不碰。清理失败只记日志，不影响启动。
	if cleaned := updater.CleanLegacyArtifacts(cfg.ProjectRoot, cfg.MediaDir, log.Printf); !cleaned.Empty() {
		log.Printf("[cleanup] 已清理 v4 遗留文件 %d 项（约 %.1f MB）：%s",
			len(cleaned.Removed), float64(cleaned.Freed)/(1<<20), strings.Join(cleaned.Removed, ", "))
	}

	// `--init-db` 是唯一的建表入口，只用于空库（新机器 / 新克隆仓库）。
	// 必须走 OpenForInit：此时库里还没有表，Open 的结构校验会直接失败。
	if args := os.Args[1:]; hasFlag(args, "--init-db") {
		initConn, err := db.OpenForInit(cfg.DatabasePath, cfg.SQLiteWAL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  [错误] %v\n", err)
			os.Exit(1)
		}
		defer initConn.Close()

		ctx := context.Background()
		if err := db.InitSchema(ctx, initConn); err != nil {
			fmt.Fprintf(os.Stderr, "  [错误] %v\n", err)
			os.Exit(1)
		}
		if err := db.EnsureIndexes(ctx, initConn); err != nil {
			fmt.Fprintf(os.Stderr, "  [错误] %v\n", err)
			os.Exit(1)
		}
		adminUser, _ := flagValue(args, "--admin-user")
		password, created, err := db.SeedAdmin(ctx, initConn, adminUser)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  [错误] %v\n", err)
			os.Exit(1)
		}
		// 建完再自检一遍：确保 schema.sql 与 VerifySchema 的口径没有分叉。
		if err := db.VerifySchema(initConn); err != nil {
			fmt.Fprintf(os.Stderr, "  [错误] 建表后自检失败: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("  [完成] 数据库已初始化: %s\n", cfg.DatabasePath)
		fmt.Printf("         表 %d 张，日志模式 %s\n", len(db.RequiredTables), journalLabel(cfg.SQLiteWAL))
		if created {
			name, _ := flagValue(args, "--admin-user")
			if name == "" {
				name = "root"
			}
			fmt.Printf("\n  初始管理员: %s / %s\n", name, password)
			fmt.Println("  初始密码默认为 root，请立刻登录并在「个人设置」里修改。")
		}
		return
	}

	conn, err := db.Open(cfg.DatabasePath, cfg.SQLiteWAL)
	if err != nil {
		// 首次启动（库文件不存在）自动初始化：分发版解压即用，不需要用户
		// 先敲一条命令。**只在库不存在时**这么做——库存在但结构不符仍然直接
		// 报错退出，绝不自动补表改列。
		if !errors.Is(err, db.ErrNotExist) {
			log.Fatalf("[db] %v", err)
		}
		log.Printf("[db] 首次启动，正在初始化数据库: %s", cfg.DatabasePath)
		if bootErr := bootstrapFreshDatabase(cfg); bootErr != nil {
			log.Fatalf("[db] 数据库初始化失败: %v", bootErr)
		}
		conn, err = db.Open(cfg.DatabasePath, cfg.SQLiteWAL)
		if err != nil {
			log.Fatalf("[db] %v", err)
		}
	}
	defer conn.Close()

	// 补建 Go 侧需要的索引（幂等，不改表结构）。放在最早期：后面的
	// 业务查询都假设这些索引已经存在。
	if err := db.EnsureIndexes(context.Background(), conn); err != nil {
		log.Fatalf("[db] %v", err)
	}

	// `--backup-db <目标文件>` 是独立的热备份入口：快照写完即退出，
	// 不启动 HTTP/Socket 服务，也不会动源库。用于 cron / 桌面壳的定时备份。
	if args := os.Args[1:]; hasFlag(args, "--backup-db") {
		dest, ok := flagValue(args, "--backup-db")
		if !ok {
			fmt.Fprintln(os.Stderr, "用法: zviewer-server --backup-db <目标文件>")
			os.Exit(1)
		}
		if err := db.Backup(context.Background(), conn, dest); err != nil {
			fmt.Fprintf(os.Stderr, "  [错误] %v\n", err)
			os.Exit(1)
		}
		info, statErr := os.Stat(dest)
		if statErr == nil {
			fmt.Printf("  [完成] 数据库已备份到 %s（%.1f KB）\n", dest, float64(info.Size())/1024)
		} else {
			fmt.Printf("  [完成] 数据库已备份到 %s\n", dest)
		}
		return
	}

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
	// 媒体服务（RTMP 收流 + HTTP-FLV 分发）默认就由本进程托管：
	// 单文件部署没有外部编排，与 LiveKit 同理。起不来只降级不致命
	// （端口可能被运维自己的 NMS 占着，此时退回「探测外部服务」）。
	if err := streamPush.Start(); err != nil {
		log.Printf("[nms] 推流服务降级为外部探测模式: %v", err)
	}
	// 一起听的播放基线：内存 + DB。isHostOnline 需要核对连接是否还在，
	// 所以要在拿到 Hub 之后再注入一次。
	musicMemory := room.NewMusicMemory(conn)
	musicMemory.SetLogger(log.Default())
	musicMemory.SetHub(hub)
	// 自建媒体面：屏幕共享中继与语音共用**同一个** Media。
	//
	// 共用的意义不是省内存，而是省端口：一个 Media 只有一对 UDP/TCP listener，
	// 语音与共享各建一个就是两对端口。
	var (
		shareRelay *share.Relay
		mediaPlane *sfu.Media
		// roomSvc 在这里先声明、稍后赋值：语音控制面要拿它判房主，而它
		// 又要接收语音控制面，构造顺序天然成环。用闭包延迟解引用，
		// 语音真正用到 IsHost 时房间服务早就装配好了。
		roomSvc *room.Service
	)
	// 媒体 TCP 端口为 0 = 不启用（只发生在网页端口恰好是 3337 时，见 config）。
	// 绝不能把它当成「与 UDP 同号」传下去：那会把网页端口绑走，后端自己起不来。
	engineOptions := sfu.EngineOptions{
		Port:            cfg.ShareMediaPort,
		PublicIP:        cfg.ShareMediaPublicIP,
		IncludeLoopback: cfg.ShareMediaPublicIP == "",
		DisableTCP:      cfg.ShareMediaTCPPort == 0,
	}
	if !engineOptions.DisableTCP {
		engineOptions.TCPPort = cfg.ShareMediaTCPPort
	}
	if engine, engineErr := sfu.NewEngine(engineOptions); engineErr != nil {
		// 媒体端口不可用：共享退回直连，语音报「暂不可用」。
		// 宁可降级，也不要留一个半死的媒体面把两个功能一起卡住。
		log.Printf("[media] 媒体端口不可用，屏幕共享回退直连、语音不可用: %v", engineErr)
	} else if cfg.ShareRelay {
		shareRelay = share.NewRelay(share.RelayDeps{
			Settings:  engine.Settings(),
			Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 64}),
			Emit: func(socketID string, message share.ServerMessage) {
				hub.EmitTo(socketID, share.Event, message)
			},
			Logger: log.Default(),
		})
		mediaPlane = shareRelay.Media()
		log.Printf("[share] 屏幕共享中继已启用，媒体端口 %s", engine.Describe())
	} else {
		// 共享仍走直连，但语音需要媒体面：事件回调不接（语音的 ConfigureVoice 自带 emit）。
		mediaPlane = sfu.NewMedia(sfu.MediaOptions{Settings: engine.Settings()})
		log.Printf("[voice] 语音已启用，媒体端口 %s", engine.Describe())
	}

	// 语音控制面。媒体面没起来时为 nil，/api/voice/status 会报不可用。
	voiceRTC := voicertc.New(voicertc.Deps{
		Media: mediaPlane,
		Emit: func(socketID string, message voicertc.ServerMessage) {
			hub.EmitTo(socketID, voicertc.Event, message)
		},
		IsHost: func(ctx context.Context, socketID, roomID string) (bool, error) {
			if roomSvc == nil {
				// 语音消息不可能早于房间服务构造（事件注册就在它里面）。
				return false, nil
			}
			return roomSvc.IsRoomHost(ctx, socketID, roomID)
		},
		Logger: log.Default(),
	})

	roomSvc = room.NewService(room.Deps{
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

		ShareRelay: shareRelay,
		ShareTree: share.TreePolicy{
			HostChildren:   cfg.ShareTreeHostChildren,
			ViewerChildren: cfg.ShareTreeViewerChildren,
			MaxDepth:       cfg.ShareTreeMaxDepth,
		},
		VoiceRTC: voiceRTC,
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
		NCM:           ncm.NewService(conn),
		NMS:           streamPush,
		VoiceRTC:      voiceRTC,
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
	log.Printf("[start] 一起听音乐接口=进程内实现（无外部服务、无子进程）")
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
	// 媒体服务随进程退出：先断推流/拉流连接，再关 HTTP。
	_ = streamPush.Close(ctx)
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
	// IPv6 字面量必须加方括号：HOST="::" 直接拼会得到 ":::3333"，Listen 直接失败。
	// start-prod.ps1 就是显式设 HOST="::" 来要双栈，Node 版能接受这种写法。
	return net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
}

func journalLabel(wal bool) string {
	if wal {
		return "WAL（默认）"
	}
	return "delete（SQLITE_WAL=0 显式关闭）"
}

// bootstrapFreshDatabase 初始化一个全新的库：建表、补索引、创建初始管理员。
//
// 只在库文件不存在时调用（见启动路径）。密码随机，写进
// `<CONFIG_DIR>/initial-admin.txt`（0600）并打到日志——用户首次登录后应改密并删掉该文件。
func bootstrapFreshDatabase(cfg *config.Config) error {
	ctx := context.Background()
	conn, err := db.OpenForInit(cfg.DatabasePath, cfg.SQLiteWAL)
	if err != nil {
		return err
	}
	defer conn.Close()

	if err := db.InitSchema(ctx, conn); err != nil {
		return err
	}
	if err := db.EnsureIndexes(ctx, conn); err != nil {
		return err
	}
	password, created, err := db.SeedAdmin(ctx, conn, "")
	if err != nil {
		return err
	}
	if created {
		path := filepath.Join(cfg.ConfigDir, "initial-admin.txt")
		content := "用户名: root\n密码: " + password + "\n\n首次登录后请立即修改密码，并删除本文件。\n"
		if werr := os.WriteFile(path, []byte(content), 0o600); werr != nil {
			return fmt.Errorf("写入初始密码文件失败: %w", werr)
		}
		log.Printf("[db] 已创建初始管理员 root，密码写入 %s", path)
	}
	return db.VerifySchema(conn)
}

// hasFlag 判断命令行里是否带某个开关。
func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag || strings.HasPrefix(a, flag+"=") {
			return true
		}
	}
	return false
}

// flagValue 取 `--flag value` 或 `--flag=value` 的值。
func flagValue(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag {
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				return args[i+1], true
			}
			return "", false
		}
		if strings.HasPrefix(a, flag+"=") {
			v := strings.TrimPrefix(a, flag+"=")
			return v, v != ""
		}
	}
	return "", false
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
