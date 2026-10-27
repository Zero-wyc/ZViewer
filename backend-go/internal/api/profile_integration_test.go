package api_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/anime"
	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/api"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/danmaku"
	"zviewer/backend/internal/kazumi"
	"zviewer/backend/internal/ncm"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/serverfiles"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/subtitle"
)

// userDDL / auditDDL 与现有库（TypeORM 生成）逐字一致。
//
// 测试自建这两张表而不是复制 config/dev.sqlite：
// 那个文件是运行数据、不在版本控制里，靠它做测试等于在别人机器上跑不起来。
const userDDL = `CREATE TABLE "user" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"username" varchar NOT NULL,
	"passwordHash" varchar NOT NULL,
	"role" varchar CHECK( "role" IN ('root','admin','user','guest') ) NOT NULL DEFAULT ('guest'),
	"status" varchar CHECK( "status" IN ('active','pending') ) NOT NULL DEFAULT ('pending'),
	"avatar" varchar,
	"tokenInvalidBefore" datetime,
	"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
	"updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
	CONSTRAINT "UQ_user_username" UNIQUE ("username")
)`

const serverFolderDDL = `CREATE TABLE "server_folder" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"name" varchar NOT NULL,
	"absPath" varchar NOT NULL,
	"readonly" boolean NOT NULL DEFAULT (0),
	"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
	"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
)`

const auditDDL = `CREATE TABLE "audit_logs" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"actorUserId" integer,
	"actorUsername" varchar,
	"actorRole" varchar NOT NULL DEFAULT ('system'),
	"action" varchar NOT NULL,
	"target" varchar,
	"ip" varchar,
	"success" boolean NOT NULL DEFAULT (1),
	"detail" varchar,
	"createdAt" datetime NOT NULL DEFAULT (datetime('now'))
)`

// settingsDDL 供管理端设置端点使用；列集合必须与 TypeORM 生成的表一致，
// 否则「整行 UPDATE」会在测试里通过、在真实库上因缺列而失败。
const settingsDDL = `CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"autoDeleteInactiveRooms" boolean NOT NULL DEFAULT (1),
	"autoDeleteAfterHours" INTEGER NOT NULL DEFAULT (24),
	"roomDefaultMusicVolume" INTEGER NOT NULL DEFAULT (50),
	"dataSourceConfig" json,
	"registrationMode" TEXT NOT NULL DEFAULT ('approval'),
	"roomCreationMode" TEXT NOT NULL DEFAULT ('admin-only'),
	"roomPermissionMatrix" json,
	"betaFeaturesEnabled" boolean NOT NULL DEFAULT (0),
	"dashDisabled" boolean NOT NULL DEFAULT (0),
	"bilibiliDefaultParseMode" TEXT NOT NULL DEFAULT ('mp4'),
	"bilibiliPgcDefaultMode" TEXT NOT NULL DEFAULT ('mp4'),
	"cdnAccelerate" boolean NOT NULL DEFAULT (0),
	"playsvideoEnabled" boolean NOT NULL DEFAULT (1),
	"cdnProxyUrl" TEXT NOT NULL DEFAULT ('https://gh-proxy.com'),
	"roomMultiInstanceLogin" boolean NOT NULL DEFAULT (0),
	"livekitExternalUrl" TEXT NOT NULL DEFAULT (''),
	"announceAutoPopupOnUpdate" boolean NOT NULL DEFAULT (1),
	"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
	"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
)`

// roomDDL / sessionDDL 供管理端房间端点使用。
const roomDDL = `CREATE TABLE "room" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"roomId" varchar NOT NULL,
	"name" varchar,
	"password" varchar,
	"maxViewers" INTEGER NOT NULL DEFAULT (10),
	"status" varchar NOT NULL DEFAULT ('active'),
	"mode" varchar NOT NULL DEFAULT ('screen-share'),
	"shareMethod" varchar NOT NULL DEFAULT ('webrtc'),
	"streamKey" varchar,
	"requireApproval" boolean NOT NULL DEFAULT (0),
	"ownerUserId" INTEGER,
	"mutedViewers" TEXT NOT NULL DEFAULT ('[]'),
	"approvedViewers" TEXT NOT NULL DEFAULT ('[]'),
	"moderators" TEXT NOT NULL DEFAULT ('[]'),
	"voiceMuted" TEXT NOT NULL DEFAULT ('[]'),
	"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
	"updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
	"lastAccessedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`

const sessionDDL = `CREATE TABLE "session" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"roomId" varchar NOT NULL,
	"socketId" varchar NOT NULL,
	"role" varchar NOT NULL,
	"userId" INTEGER,
	"startedAt" datetime NOT NULL DEFAULT (datetime('now')),
	"endedAt" datetime,
	"guestId" varchar
)`

// roomRelationDDLs 是房间级联删除会扫到的关联表（列只保留测试用得到的 roomId）。
const roomRelationDDLs = `
CREATE TABLE "movie" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "url" varchar NOT NULL DEFAULT (''), "title" varchar NOT NULL DEFAULT (''), "cover" varchar, "source" varchar, "audioUrl" varchar, "format" varchar, "videoCodec" varchar, "audioCodec" varchar, "duration" float, "cid" integer, "currentQn" integer, "acceptQuality" text, "pages" text, "currentPage" integer, "serverUrl" varchar, "path" varchar, "username" varchar, "password" varchar, "directLink" boolean NOT NULL DEFAULT (0), "wasmEngine" boolean NOT NULL DEFAULT (0), "playsvideoEnabled" boolean NOT NULL DEFAULT (1), "cliOnly" boolean NOT NULL DEFAULT (0), "multiVersion" boolean NOT NULL DEFAULT (0), "sourceMeta" text, "order" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "sourceMountId" integer, "serverProxy" boolean NOT NULL DEFAULT (0));
CREATE TABLE "user_mount" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "type" varchar NOT NULL, "name" varchar NOT NULL, "serverUrl" varchar, "port" integer, "path" varchar, "username" varchar, "password" varchar, "indexUrl" varchar, "apiKey" varchar, "embyUserId" varchar, "directLink" boolean NOT NULL DEFAULT (0), "httpsDirect" boolean, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "comment" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
CREATE TABLE "playback_states" ("roomId" varchar PRIMARY KEY NOT NULL, "sourceUrl" TEXT);
CREATE TABLE "music_playback_states" ("roomId" varchar PRIMARY KEY NOT NULL, "trackKey" TEXT);
CREATE TABLE "music_queue_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
CREATE TABLE "danmaku_track" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
CREATE TABLE "room_danmaku_meta" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);`

type testEnv struct {
	handler http.Handler
	conn    *sql.DB
	tokens  *auth.Manager
	avatars string
	// uploads 是服务器文件默认根（uploads:/）的绝对路径。
	uploads string
	users   *store.Users
	audit   *store.Audit
	// dist 是前端产物目录（静态托管用例往里放 index.html / assets）
	dist     string
	teardown func()
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.sqlite")

	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	for _, ddl := range []string{userDDL, auditDDL, serverFolderDDL, settingsDDL, roomDDL, sessionDDL} {
		if _, err := conn.Exec(ddl); err != nil {
			t.Fatalf("建表失败: %v", err)
		}
	}
	for _, ddl := range strings.Split(roomRelationDDLs, ";") {
		if strings.TrimSpace(ddl) == "" {
			continue
		}
		if _, err := conn.Exec(ddl); err != nil {
			t.Fatalf("建关联表失败: %v", err)
		}
	}

	cfg := &config.Config{
		ProjectRoot:  dir,
		ConfigDir:    dir,
		DatabasePath: dbPath,
		UploadsDir:   filepath.Join(dir, "uploads"),
		AvatarsDir:   filepath.Join(dir, "uploads", "avatars"),
		MediaDir:     filepath.Join(dir, "media"),
		FrontendDist: filepath.Join(dir, "dist"),
	}
	if err := os.MkdirAll(cfg.AvatarsDir, 0o755); err != nil {
		t.Fatalf("创建头像目录失败: %v", err)
	}

	tokens, err := auth.NewManager(dir)
	if err != nil {
		t.Fatalf("初始化令牌管理器失败: %v", err)
	}

	users := store.NewUsers(conn)
	settings := store.NewSettings(conn)
	audit := store.NewAudit(conn)

	serverFolders := store.NewServerFolders(conn)
	filesRegistry := serverfiles.NewRegistry(serverFolders, cfg.UploadsDir)
	movies := store.NewMovies(conn)
	rooms := store.NewRooms(conn)
	mounts := store.NewMounts(conn)
	streamResolver := proxy.NewStreamResolver(movies, rooms, mounts)

	srv := api.New(api.Deps{
		Cfg:      cfg,
		DB:       conn,
		Users:    users,
		Settings: settings,
		Audit:    audit,
		Tokens:   tokens,
		Auth:     auth.NewAuthenticator(tokens, users),

		ServerFolders: serverFolders,
		Files:         filesRegistry,
		Subtitles:     subtitle.NewService(streamResolver, filesRegistry),
		Anime:         anime.NewService(settings, bilibili.NewService(conn)),
		AniSubs:       anisubs.NewService(settings),
		Kazumi:        kazumi.NewService(settings),
		Danmaku:       danmaku.NewService(bilibili.NewService(conn)),
		NCM:           ncm.NewService(conn),

		// 字幕端点的 requireMovieReadAccess 要读 movie 行。
		Movies: movies,
		Mounts: mounts,
		Stream: streamResolver,

		// 管理端房间端点要读写 room / session；RoomSvc 保持 nil，
		// 于是删除走 store 的级联（房间层的内存清理由 internal/room 的测试覆盖）。
		Rooms: rooms,
	})

	return &testEnv{
		handler:  srv.Handler(),
		conn:     conn,
		tokens:   tokens,
		avatars:  cfg.AvatarsDir,
		uploads:  cfg.UploadsDir,
		users:    users,
		audit:    audit,
		dist:     cfg.FrontendDist,
		teardown: func() { conn.Close() },
	}
}

// seedUser 直接插库：注册接口有注册模式限制，测试不该依赖它。
func (e *testEnv) seedUser(t *testing.T, username, password, role, status string) int64 {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("生成哈希失败: %v", err)
	}
	res, err := e.conn.Exec(
		`INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)`,
		username, string(hash), role, status,
	)
	if err != nil {
		t.Fatalf("插入用户失败: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func (e *testEnv) token(t *testing.T, id int64, role, username string) string {
	t.Helper()
	tokens, err := e.tokens.Generate(id, role, username)
	if err != nil {
		t.Fatalf("签发令牌失败: %v", err)
	}
	return tokens.AccessToken
}

// guestToken 必须走 GenerateGuest：游客令牌带 guestId，
// 用 Generate(0,'guest',...) 签出来的会被 assertActive 判成失效。
func (e *testEnv) guestToken(t *testing.T) string {
	t.Helper()
	tokens, err := e.tokens.GenerateGuest("")
	if err != nil {
		t.Fatalf("签发游客令牌失败: %v", err)
	}
	return tokens.AccessToken
}

type apiResponse struct {
	status int
	body   map[string]any
	raw    string
}

func (r apiResponse) message() string {
	if msg, ok := r.body["message"].(string); ok {
		return msg
	}
	return ""
}

func (r apiResponse) userField(field string) any {
	user, ok := r.body["user"].(map[string]any)
	if !ok {
		return nil
	}
	return user[field]
}

func (e *testEnv) do(t *testing.T, method, path, token string, body any) apiResponse {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)

	resp := apiResponse{status: rec.Code, raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp.body)
	return resp
}

// doMultipart 上传头像文件。
func (e *testEnv) doMultipart(t *testing.T, path, token, field, filename, contentType string, content []byte) apiResponse {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, filename))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("构造 multipart 失败: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("写入 multipart 失败: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 multipart 失败: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, path, &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)

	resp := apiResponse{status: rec.Code, raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp.body)
	return resp
}

// TestChangePasswordFlow 覆盖改密的全部关键分支。
func TestChangePasswordFlow(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "root", "root-old-pw", "root", "active")
	token := env.token(t, id, "root", "root")

	t.Run("游客被拒", func(t *testing.T) {
		guest := env.guestToken(t)
		resp := env.do(t, http.MethodPatch, "/api/auth/password", guest,
			map[string]string{"oldPassword": "x", "newPassword": "yyyy"})
		if resp.status != http.StatusForbidden || resp.message() != "游客无法修改密码" {
			t.Fatalf("期望 403 游客无法修改密码，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("新密码过短被拒", func(t *testing.T) {
		resp := env.do(t, http.MethodPatch, "/api/auth/password", token,
			map[string]string{"oldPassword": "root-old-pw", "newPassword": "abc"})
		if resp.status != http.StatusBadRequest {
			t.Fatalf("期望 400，实际 %d", resp.status)
		}
	})

	t.Run("原密码错误", func(t *testing.T) {
		resp := env.do(t, http.MethodPatch, "/api/auth/password", token,
			map[string]string{"oldPassword": "wrong", "newPassword": "root-new-pw"})
		if resp.status != http.StatusUnauthorized || resp.message() != "原密码错误" {
			t.Fatalf("期望 401 原密码错误，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("改密成功并吊销旧令牌", func(t *testing.T) {
		resp := env.do(t, http.MethodPatch, "/api/auth/password", token,
			map[string]string{"oldPassword": "root-old-pw", "newPassword": "root-new-pw"})
		if resp.status != http.StatusOK {
			t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
		}
		if resp.body["success"] != true {
			t.Fatalf("期望 success=true，实际 %v", resp.body)
		}
		// 弱密码应带回提示，强密码不带
		if hint, ok := resp.body["passwordHint"].(string); !ok || hint == "" {
			t.Fatalf("期望返回 passwordHint，实际 %v", resp.body)
		}

		// 旧 token 必须立刻失效（这是改密的真正目的）
		me := env.do(t, http.MethodGet, "/api/auth/me", token, nil)
		if me.status != http.StatusUnauthorized {
			t.Fatalf("旧令牌应失效，实际 %d", me.status)
		}

		// 新密码能登录，旧密码不能
		loginOld := env.do(t, http.MethodPost, "/api/auth/login", "",
			map[string]string{"username": "root", "password": "root-old-pw"})
		if loginOld.status != http.StatusUnauthorized {
			t.Fatalf("旧密码应登录失败，实际 %d", loginOld.status)
		}
		loginNew := env.do(t, http.MethodPost, "/api/auth/login", "",
			map[string]string{"username": "root", "password": "root-new-pw"})
		if loginNew.status != http.StatusOK {
			t.Fatalf("新密码应登录成功，实际 %d %s", loginNew.status, loginNew.raw)
		}
	})

	t.Run("审计记录已写入", func(t *testing.T) {
		var count int
		err := env.conn.QueryRow(
			`SELECT COUNT(*) FROM "audit_logs" WHERE "action" = 'password_changed' AND "actorUsername" = 'root'`,
		).Scan(&count)
		if err != nil {
			t.Fatalf("查询审计失败: %v", err)
		}
		if count != 1 {
			t.Fatalf("期望 1 条 password_changed 审计，实际 %d", count)
		}
	})
}

// TestPasswordRateLimit 验证每用户 1 分钟 3 次的限制。
func TestPasswordRateLimit(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "ratelimit", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "ratelimit")

	for i := 0; i < 3; i++ {
		resp := env.do(t, http.MethodPatch, "/api/auth/password", token,
			map[string]string{"oldPassword": "wrong", "newPassword": "pass-5678"})
		if resp.status != http.StatusUnauthorized {
			t.Fatalf("第 %d 次期望 401，实际 %d", i+1, resp.status)
		}
	}

	resp := env.do(t, http.MethodPatch, "/api/auth/password", token,
		map[string]string{"oldPassword": "pass-1234", "newPassword": "pass-5678"})
	if resp.status != http.StatusTooManyRequests {
		t.Fatalf("第 4 次期望 429，实际 %d", resp.status)
	}
	if resp.message() != "操作过于频繁，请稍后再试" {
		t.Fatalf("429 文案不一致: %q", resp.message())
	}
}

// TestChangeUsername 覆盖 root-only 与非空校验。
func TestChangeUsername(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root", "root-pw", "root", "active")
	otherID := env.seedUser(t, "taken", "pw1234", "user", "active")
	rootToken := env.token(t, rootID, "root", "root")
	userToken := env.token(t, otherID, "user", "taken")

	t.Run("非 root 被拒", func(t *testing.T) {
		resp := env.do(t, http.MethodPatch, "/api/auth/username", userToken,
			map[string]string{"username": "newname"})
		if resp.status != http.StatusForbidden || resp.message() != "仅 root 可修改用户名" {
			t.Fatalf("期望 403，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("空用户名被拒", func(t *testing.T) {
		resp := env.do(t, http.MethodPatch, "/api/auth/username", rootToken,
			map[string]string{"username": "   "})
		if resp.status != http.StatusBadRequest || resp.message() != "用户名不能为空" {
			t.Fatalf("期望 400，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("重名冲突", func(t *testing.T) {
		resp := env.do(t, http.MethodPatch, "/api/auth/username", rootToken,
			map[string]string{"username": "taken"})
		if resp.status != http.StatusConflict || resp.message() != "用户名已存在" {
			t.Fatalf("期望 409，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("改成功并返回新用户名", func(t *testing.T) {
		resp := env.do(t, http.MethodPatch, "/api/auth/username", rootToken,
			map[string]string{"username": "  新管理员  "})
		if resp.status != http.StatusOK {
			t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
		}
		if got := resp.userField("username"); got != "新管理员" {
			t.Fatalf("期望 trim 后的用户名，实际 %v", got)
		}
		// 改名不改 id，也不吊销令牌（与 Node 版一致）
		me := env.do(t, http.MethodGet, "/api/auth/me", rootToken, nil)
		if me.status != http.StatusOK {
			t.Fatalf("改名后令牌应仍有效，实际 %d", me.status)
		}
		if got := me.userField("username"); got != "新管理员" {
			t.Fatalf("/me 应返回新用户名，实际 %v", got)
		}
	})
}

// TestAvatarLifecycle 覆盖上传 → 静态访问 → 删除。
func TestAvatarLifecycle(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "avatar", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "avatar")

	t.Run("游客被拒", func(t *testing.T) {
		guest := env.guestToken(t)
		resp := env.doMultipart(t, "/api/auth/avatar", guest, "avatar", "g.png", "image/png", []byte("x"))
		if resp.status != http.StatusForbidden || resp.message() != "游客无法设置头像" {
			t.Fatalf("期望 403，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("非图片被拒", func(t *testing.T) {
		resp := env.doMultipart(t, "/api/auth/avatar", token, "avatar", "a.txt", "text/plain", []byte("hello"))
		if resp.status != http.StatusBadRequest || !strings.Contains(resp.message(), "JPG / PNG / GIF / WEBP") {
			t.Fatalf("期望 400 格式提示，实际 %d %q", resp.status, resp.message())
		}
	})

	t.Run("缺文件字段", func(t *testing.T) {
		resp := env.doMultipart(t, "/api/auth/avatar", token, "file", "a.png", "image/png", []byte("x"))
		if resp.status != http.StatusBadRequest || resp.message() != "未接收到头像文件" {
			t.Fatalf("期望 400 未接收到文件，实际 %d %q", resp.status, resp.message())
		}
	})

	var firstURL string
	t.Run("上传成功", func(t *testing.T) {
		resp := env.doMultipart(t, "/api/auth/avatar", token, "avatar", "my-photo.PNG", "image/png",
			validAvatar(t))
		if resp.status != http.StatusOK {
			t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
		}
		avatar, _ := resp.userField("avatar").(string)
		if !strings.HasPrefix(avatar, "/uploads/avatars/") {
			t.Fatalf("头像 URL 前缀不对: %q", avatar)
		}
		// 扩展名统一小写，文件名以 <userId>- 开头
		if !strings.HasSuffix(avatar, ".png") {
			t.Fatalf("扩展名应小写为 .png，实际 %q", avatar)
		}
		if !strings.HasPrefix(filepath.Base(avatar), fmt.Sprintf("%d-", id)) {
			t.Fatalf("文件名应以用户 ID 开头，实际 %q", filepath.Base(avatar))
		}
		firstURL = avatar

		// 静态访问：头像必须能匿名 GET（<img> 不带 Authorization）
		req := httptest.NewRequest(http.MethodGet, avatar, nil)
		rec := httptest.NewRecorder()
		env.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("头像应可匿名访问，实际 %d", rec.Code)
		}

		// 库里的 avatar 列必须同步
		user, err := env.users.FindByID(req.Context(), id)
		if err != nil {
			t.Fatalf("读取用户失败: %v", err)
		}
		if user.Avatar == nil || *user.Avatar != avatar {
			t.Fatalf("库中头像与返回不一致: %v", user.Avatar)
		}
	})

	t.Run("二次上传会清掉旧文件", func(t *testing.T) {
		oldName := filepath.Base(firstURL)
		resp := env.doMultipart(t, "/api/auth/avatar", token, "avatar", "second.jpg", "image/jpeg",
			validAvatar(t))
		if resp.status != http.StatusOK {
			t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
		}
		if _, err := os.Stat(filepath.Join(env.avatars, oldName)); !os.IsNotExist(err) {
			t.Fatalf("旧头像文件应被删除，实际 err=%v", err)
		}
	})

	t.Run("删除头像", func(t *testing.T) {
		user, _ := env.users.FindByID(t.Context(), id)
		if user.Avatar == nil {
			t.Fatal("前置条件不满足：应已有头像")
		}
		fileName := filepath.Base(*user.Avatar)

		resp := env.do(t, http.MethodDelete, "/api/auth/avatar", token, nil)
		if resp.status != http.StatusOK {
			t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
		}
		if avatar := resp.userField("avatar"); avatar != nil {
			t.Fatalf("删除后 avatar 应为 null，实际 %v", avatar)
		}
		if _, err := os.Stat(filepath.Join(env.avatars, fileName)); !os.IsNotExist(err) {
			t.Fatalf("头像文件应被删除，实际 err=%v", err)
		}
	})
}

// TestAvatarOversize 验证 5MB 上限。
func TestAvatarOversize(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "big", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "big")

	oversize := bytes.Repeat([]byte("a"), 6*1024*1024)
	resp := env.doMultipart(t, "/api/auth/avatar", token, "avatar", "big.png", "image/png", oversize)
	if resp.status != http.StatusBadRequest {
		t.Fatalf("超限应 400，实际 %d %s", resp.status, resp.raw)
	}
	if !strings.Contains(resp.raw, "5MB") {
		t.Fatalf("超限文案应提示 5MB，实际 %s", resp.raw)
	}
	// 不能留下半截文件
	entries, _ := os.ReadDir(env.avatars)
	if len(entries) != 0 {
		t.Fatalf("超限请求不应留下文件，实际 %d 个", len(entries))
	}
}

func validAvatar(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
