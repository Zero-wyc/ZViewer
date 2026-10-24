package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// SystemSettings 对应 "system_settings" 表（单行）。
//
// 该表由 TypeORM 以 synchronize 方式生成，Go 侧读写全部认识的列；
// 新增列由 Node 版继续维护——**两边列名必须同时更新**，否则
// `Save` 的整行 UPDATE 会把新列覆盖回旧值。
type SystemSettings struct {
	ID                      int64
	AutoDeleteInactiveRooms bool
	AutoDeleteAfterHours    int
	RoomDefaultMusicVolume  int
	// DataSourceConfig 是动漫源配置（json 列）。nil 表示未配置（DB 里是 NULL）。
	DataSourceConfig json.RawMessage
	RegistrationMode string
	RoomCreationMode string
	// RoomPermissionMatrix 是房间权限矩阵（json 列）。nil 表示未配置。
	RoomPermissionMatrix json.RawMessage
	// RoomMultiInstanceLogin 为 true 时允许同一账号多端同时进入同一房间
	// （仅供测试）。默认 false：重复进入会被 ALREADY_IN_ROOM 挡下。
	RoomMultiInstanceLogin    bool
	BetaFeaturesEnabled       bool
	DashDisabled              bool
	BilibiliDefaultParseMode  string
	BilibiliPgcDefaultMode    string
	PlaysvideoEnabled         bool
	CdnAccelerate             bool
	CdnProxyURL               string
	LivekitExternalURL        string
	AnnounceAutoPopupOnUpdate bool
}

// Settings 提供系统设置读写。
type Settings struct {
	conn *sql.DB
}

// NewSettings 构造设置仓库。
func NewSettings(conn *sql.DB) *Settings { return &Settings{conn: conn} }

const settingsColumns = `"id", "autoDeleteInactiveRooms", "autoDeleteAfterHours",
	"roomDefaultMusicVolume", "dataSourceConfig", "registrationMode", "roomCreationMode",
	"roomPermissionMatrix", "roomMultiInstanceLogin", "betaFeaturesEnabled",
	"dashDisabled", "bilibiliDefaultParseMode", "bilibiliPgcDefaultMode",
	"playsvideoEnabled", "cdnAccelerate", "cdnProxyUrl", "livekitExternalUrl",
	"announceAutoPopupOnUpdate"`

// Get 读取唯一一行设置。
//
// 与 Node 版 getSystemSettings 的**读取语义**一致：表为空时返回内置默认值。
// 但这里**不落库**——写库时机由 GetOrCreate 与 Save 决定。差别只体现在
// 「读了一次但什么都没改」是否留下一条默认行，对响应无影响。
func (s *Settings) Get(ctx context.Context) (*SystemSettings, error) {
	row := s.conn.QueryRowContext(ctx,
		`SELECT `+settingsColumns+` FROM "system_settings" ORDER BY "id" ASC LIMIT 1`)
	cfg, err := scanSettings(row)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultSettings(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取系统设置失败: %w", err)
	}
	return cfg, nil
}

// GetOrCreate 读取设置，表为空时按默认值**插入一行**。
//
// 复刻 Node 的 getSystemSettings：`findOne` 找不到就 create + save。
// 管理端 PUT 走的正是这条路径，所以「校验失败但已建默认行」是 Node 的
// 既有行为，别在这里"顺手修正"成延迟写入。
func (s *Settings) GetOrCreate(ctx context.Context) (*SystemSettings, error) {
	cfg, err := s.Get(ctx)
	if err != nil {
		return nil, err
	}
	if cfg.ID != 0 {
		return cfg, nil
	}
	if err := s.Save(ctx, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Save 整行写入设置（对应 TypeORM 的 `settingsRepo.save`）。
//
// ID 为 0 走 INSERT 并回填自增主键，否则整行 UPDATE。整行覆盖是有意的：
// Node 是「读到实体、改几个字段、整行 save」，部分列更新会让
// 「未提交的字段保持原值」这种语义在两端分叉。
func (s *Settings) Save(ctx context.Context, cfg *SystemSettings) error {
	now := FormatSQLiteTime(time.Now())
	args := []any{
		cfg.AutoDeleteInactiveRooms, cfg.AutoDeleteAfterHours, cfg.RoomDefaultMusicVolume,
		nullableRawJSON(cfg.DataSourceConfig), cfg.RegistrationMode, cfg.RoomCreationMode,
		nullableRawJSON(cfg.RoomPermissionMatrix), cfg.RoomMultiInstanceLogin, cfg.BetaFeaturesEnabled,
		cfg.DashDisabled, cfg.BilibiliDefaultParseMode, cfg.BilibiliPgcDefaultMode,
		cfg.PlaysvideoEnabled, cfg.CdnAccelerate, cfg.CdnProxyURL, cfg.LivekitExternalURL,
		cfg.AnnounceAutoPopupOnUpdate, now,
	}

	if cfg.ID > 0 {
		_, err := s.conn.ExecContext(ctx, `
			UPDATE "system_settings" SET
				"autoDeleteInactiveRooms" = ?, "autoDeleteAfterHours" = ?,
				"roomDefaultMusicVolume" = ?, "dataSourceConfig" = ?,
				"registrationMode" = ?, "roomCreationMode" = ?,
				"roomPermissionMatrix" = ?, "roomMultiInstanceLogin" = ?,
				"betaFeaturesEnabled" = ?, "dashDisabled" = ?,
				"bilibiliDefaultParseMode" = ?, "bilibiliPgcDefaultMode" = ?,
				"playsvideoEnabled" = ?, "cdnAccelerate" = ?, "cdnProxyUrl" = ?,
				"livekitExternalUrl" = ?, "announceAutoPopupOnUpdate" = ?,
				"updatedAt" = ?
			WHERE "id" = ?`, append(args, cfg.ID)...)
		if err != nil {
			return fmt.Errorf("保存系统设置失败: %w", err)
		}
		return nil
	}

	res, err := s.conn.ExecContext(ctx, `
		INSERT INTO "system_settings" (
			"autoDeleteInactiveRooms", "autoDeleteAfterHours", "roomDefaultMusicVolume",
			"dataSourceConfig", "registrationMode", "roomCreationMode",
			"roomPermissionMatrix", "roomMultiInstanceLogin", "betaFeaturesEnabled",
			"dashDisabled", "bilibiliDefaultParseMode", "bilibiliPgcDefaultMode",
			"playsvideoEnabled", "cdnAccelerate", "cdnProxyUrl", "livekitExternalUrl",
			"announceAutoPopupOnUpdate", "updatedAt"
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args...)
	if err != nil {
		return fmt.Errorf("创建系统设置失败: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fmt.Errorf("读取系统设置主键失败: %w", err)
	}
	cfg.ID = id
	return nil
}

// nullableRawJSON 把「空 JSON」写成 NULL。
//
// json.RawMessage 的零值是 nil，直接当参数会写成 NULL（正确）；
// 但空串也会被 sqlite 当成空文本，这里统一收敛成 NULL。
func nullableRawJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

// defaultSettings 与 Node 版 DEFAULT_SETTINGS / 列默认值保持一致。
func defaultSettings() *SystemSettings {
	return &SystemSettings{
		AutoDeleteInactiveRooms:   true,
		AutoDeleteAfterHours:      24,
		RoomDefaultMusicVolume:    50,
		RegistrationMode:          "approval",
		RoomCreationMode:          "admin-only",
		BetaFeaturesEnabled:       false,
		DashDisabled:              false,
		BilibiliDefaultParseMode:  "mp4",
		BilibiliPgcDefaultMode:    "mp4",
		PlaysvideoEnabled:         true,
		CdnAccelerate:             false,
		CdnProxyURL:               "https://gh-proxy.com",
		LivekitExternalURL:        "",
		AnnounceAutoPopupOnUpdate: true,
	}
}

func scanSettings(row rowScanner) (*SystemSettings, error) {
	var (
		cfg     SystemSettings
		dataSrc sql.NullString
		matrix  sql.NullString
	)
	if err := row.Scan(
		&cfg.ID, &cfg.AutoDeleteInactiveRooms, &cfg.AutoDeleteAfterHours,
		&cfg.RoomDefaultMusicVolume, &dataSrc, &cfg.RegistrationMode, &cfg.RoomCreationMode,
		&matrix, &cfg.RoomMultiInstanceLogin, &cfg.BetaFeaturesEnabled, &cfg.DashDisabled,
		&cfg.BilibiliDefaultParseMode, &cfg.BilibiliPgcDefaultMode,
		&cfg.PlaysvideoEnabled, &cfg.CdnAccelerate, &cfg.CdnProxyURL, &cfg.LivekitExternalURL,
		&cfg.AnnounceAutoPopupOnUpdate,
	); err != nil {
		return nil, err
	}
	if dataSrc.Valid && dataSrc.String != "" {
		cfg.DataSourceConfig = json.RawMessage(dataSrc.String)
	}
	if matrix.Valid && matrix.String != "" {
		cfg.RoomPermissionMatrix = json.RawMessage(matrix.String)
	}
	return &cfg, nil
}
