-- ZViewer 数据库结构（唯一事实源）
--
-- 这份 DDL 是从 TypeORM 生成的线上库逐字导出的形态，**不要手改**：
-- Go 侧的 `VerifySchema` 按表名 + user 表关键列校验，列语义（CHECK 取值、
-- UNIQUE 约束、DEFAULT 里的 datetime('now')）都是前后端共同依赖的契约。
--
-- 用途只有一个：`zviewer-server --init-db` 在新机器上初始化空库。
-- 已有库不会被这套 DDL 触碰（启动路径只做 VerifySchema + EnsureIndexes）。
--
-- 建表顺序按外键依赖：room 在最前，引用它的表在后。

CREATE TABLE IF NOT EXISTS "room" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "roomId" varchar NOT NULL,
  "name" varchar,
  "password" varchar,
  "maxViewers" integer NOT NULL DEFAULT (10),
  "status" varchar CHECK( "status" IN ('active','closed') ) NOT NULL DEFAULT ('active'),
  "mode" varchar CHECK( "mode" IN ('screen-share','watch-together','listen-together') ) NOT NULL DEFAULT ('screen-share'),
  "shareMethod" varchar CHECK( "shareMethod" IN ('webrtc','stream-push') ) NOT NULL DEFAULT ('webrtc'),
  "streamKey" varchar,
  "requireApproval" boolean NOT NULL DEFAULT (0),
  "ownerUserId" integer,
  "mutedViewers" text NOT NULL DEFAULT ('[]'),
  "approvedViewers" text NOT NULL DEFAULT ('[]'),
  "moderators" text NOT NULL DEFAULT ('[]'),
  "voiceMuted" text NOT NULL DEFAULT ('[]'),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
  "lastAccessedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  CONSTRAINT "UQ_45770efde052e41dee06d89c85c" UNIQUE ("roomId")
);

CREATE TABLE IF NOT EXISTS "user" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "username" varchar NOT NULL,
  "passwordHash" varchar NOT NULL,
  "role" varchar CHECK( "role" IN ('root','admin','user','guest') ) NOT NULL DEFAULT ('guest'),
  "status" varchar CHECK( "status" IN ('active','pending') ) NOT NULL DEFAULT ('pending'),
  "avatar" varchar,
  "tokenInvalidBefore" datetime,
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT "UQ_78a916df40e02a9deb1c4b75edb" UNIQUE ("username")
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
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
);

CREATE TABLE IF NOT EXISTS "bilibili_credential" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "userId" varchar NOT NULL,
  "cookie" text NOT NULL,
  "refreshToken" text,
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT "UQ_584a7b84cd938ca2185390464c7" UNIQUE ("userId")
);

CREATE TABLE IF NOT EXISTS "comment" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "roomId" varchar NOT NULL,
  "username" varchar NOT NULL,
  "content" varchar NOT NULL,
  "isDanmaku" boolean NOT NULL DEFAULT (0),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "danmaku_track" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "trackId" varchar NOT NULL,
  "roomId" varchar NOT NULL,
  "label" varchar NOT NULL,
  "source" text NOT NULL,
  "items" text NOT NULL,
  "offset" double NOT NULL DEFAULT (0),
  "hidden" boolean NOT NULL DEFAULT (0),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "movie" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "roomId" varchar NOT NULL,
  "url" varchar NOT NULL,
  "title" varchar NOT NULL,
  "cover" varchar,
  "source" varchar,
  "audioUrl" varchar,
  "format" varchar,
  "videoCodec" varchar,
  "audioCodec" varchar,
  "duration" float,
  "cid" integer,
  "currentQn" integer,
  "acceptQuality" text,
  "pages" text,
  "currentPage" integer,
  "serverUrl" varchar,
  "path" varchar,
  "username" varchar,
  "password" varchar,
  "directLink" boolean NOT NULL DEFAULT (0),
  "wasmEngine" boolean NOT NULL DEFAULT (0),
  "playsvideoEnabled" boolean NOT NULL DEFAULT (1),
  "cliOnly" boolean NOT NULL DEFAULT (0),
  "multiVersion" boolean NOT NULL DEFAULT (0),
  "sourceMeta" text,
  "order" integer NOT NULL DEFAULT (0),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
  "sourceMountId" integer,
  "serverProxy" boolean NOT NULL DEFAULT (0),
  CONSTRAINT "FK_57adbb52d507cee958568376a2b" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "music_playback_states" (
  "roomId" varchar(50) PRIMARY KEY NOT NULL,
  "trackSongId" integer,
  "trackKey" text,
  "isPlaying" boolean NOT NULL DEFAULT (0),
  "positionSec" double NOT NULL DEFAULT (0),
  "playMode" varchar(20) NOT NULL DEFAULT ('sequence'),
  "lastUpdatedAt" bigint NOT NULL,
  "hostSocketId" varchar(50),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT "FK_2e193fbae181ec89918248d21de" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "music_queue_item" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "roomId" varchar NOT NULL,
  "source" text NOT NULL DEFAULT ('ncm'),
  "songId" integer NOT NULL,
  "sourceId" text,
  "name" text NOT NULL,
  "artist" text NOT NULL,
  "album" text NOT NULL,
  "cover" text,
  "durationMs" integer NOT NULL,
  "vip" boolean NOT NULL DEFAULT (0),
  "order" integer NOT NULL,
  "addedBy" integer NOT NULL DEFAULT (0),
  "recommended" boolean NOT NULL DEFAULT (0),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "ncm_credential" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "userId" integer NOT NULL,
  "cookies" text NOT NULL,
  "nickname" text,
  "avatarUrl" text,
  "vipType" integer,
  "vipStatus" integer,
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT "UQ_8784f26ab8cf90c9c2b82f9f7b6" UNIQUE ("userId")
);

CREATE TABLE IF NOT EXISTS "playback_states" (
  "roomId" varchar(50) PRIMARY KEY NOT NULL,
  "sourceUrl" text NOT NULL,
  "sourceType" varchar(50) NOT NULL,
  "audioUrl" text,
  "format" varchar(20),
  "videoCodec" varchar(50),
  "audioCodec" varchar(50),
  "cid" bigint,
  "isPlaying" boolean NOT NULL DEFAULT (0),
  "currentTime" double NOT NULL,
  "playbackRate" double NOT NULL DEFAULT (1),
  "duration" double NOT NULL DEFAULT (0),
  "currentQn" integer,
  "acceptQuality" text,
  "headers" text,
  "isPreview" boolean NOT NULL DEFAULT (0),
  "previewTitle" varchar(200),
  "bufferMode" boolean NOT NULL DEFAULT (0),
  "currentMovieId" integer,
  "lastUpdatedAt" bigint NOT NULL,
  "hostSocketId" varchar(50),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
  "noProxyFallback" boolean,
  "metadata" text,
  CONSTRAINT "FK_0b6bb13f02277263045c6aa108e" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "room_danmaku_meta" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "roomId" varchar NOT NULL,
  "blockKeywords" text NOT NULL DEFAULT ('[]'),
  "deletedLog" text NOT NULL DEFAULT ('[]'),
  "realtimeLog" text NOT NULL DEFAULT ('[]'),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "server_folder" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "name" varchar NOT NULL,
  "absPath" varchar NOT NULL,
  "readonly" boolean NOT NULL DEFAULT (0),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "roomId" varchar NOT NULL,
  "socketId" varchar NOT NULL,
  "role" varchar CHECK( "role" IN ('sharer','viewer') ) NOT NULL,
  "userId" integer,
  "startedAt" datetime NOT NULL DEFAULT (datetime('now')),
  "endedAt" datetime,
  "guestId" varchar,
  CONSTRAINT "FK_6bfcd8b79900d13de31fc4098f2" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "system_settings" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "autoDeleteInactiveRooms" boolean NOT NULL DEFAULT (1),
  "autoDeleteAfterHours" integer NOT NULL DEFAULT (24),
  "roomDefaultMusicVolume" integer NOT NULL DEFAULT (50),
  "dataSourceConfig" json,
  "registrationMode" text NOT NULL DEFAULT ('approval'),
  "roomCreationMode" text NOT NULL DEFAULT ('admin-only'),
  "roomPermissionMatrix" json,
  "betaFeaturesEnabled" boolean NOT NULL DEFAULT (0),
  "dashDisabled" boolean NOT NULL DEFAULT (0),
  "bilibiliDefaultParseMode" text NOT NULL DEFAULT ('mp4'),
  "bilibiliPgcDefaultMode" text NOT NULL DEFAULT ('mp4'),
  "cdnAccelerate" boolean NOT NULL DEFAULT (0),
  "playsvideoEnabled" boolean NOT NULL DEFAULT (1),
  "cdnProxyUrl" text NOT NULL DEFAULT ('https://gh-proxy.com'),
  "roomMultiInstanceLogin" boolean NOT NULL DEFAULT (0),
  "livekitExternalUrl" text NOT NULL DEFAULT (''),
  "announceAutoPopupOnUpdate" boolean NOT NULL DEFAULT (1),
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "user_mount" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "userId" integer NOT NULL,
  "type" varchar CHECK( "type" IN ('webdav','ftp','openlist','emby','jellyfin') ) NOT NULL,
  "name" varchar NOT NULL,
  "serverUrl" varchar,
  "port" integer,
  "path" varchar,
  "username" varchar,
  "password" varchar,
  "indexUrl" varchar,
  "apiKey" varchar,
  "embyUserId" varchar,
  "directLink" boolean NOT NULL DEFAULT (0),
  "httpsDirect" boolean,
  "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
  "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
);
