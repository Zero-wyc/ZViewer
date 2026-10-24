package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// SystemSettings 是 "system_settings" 表中与 Go 侧当前功能相关的字段子集。
//
// 该表由 TypeORM 以 synchronize 方式生成，Go 版只读取自己认识的列，
// 新增列由 Node 版继续维护，两边互不覆盖。
type SystemSettings struct {
	ID                      int64
	AutoDeleteInactiveRooms bool
	AutoDeleteAfterHours    int
	RoomDefaultMusicVolume  int
	RegistrationMode        string
	RoomCreationMode        string
	RoomPermissionMatrix    json.RawMessage
	// RoomMultiInstanceLogin 为 true 时允许同一账号多端同时进入同一房间
	// （仅供测试）。默认 false：重复进入会被 ALREADY_IN_ROOM 挡下。
	RoomMultiInstanceLogin    bool
	BetaFeaturesEnabled       bool
	DashDisabled              bool
	BilibiliDefaultParseMode  string
	BilibiliPgcDefaultMode    string
	PlaysvideoEnabled         bool
	AnnounceAutoPopupOnUpdate bool
}

// Settings 提供系统设置读取。
type Settings struct {
	conn *sql.DB
}

// NewSettings 构造设置仓库。
func NewSettings(conn *sql.DB) *Settings { return &Settings{conn: conn} }

// Get 读取唯一一行设置。
//
// 与 Node 版 getSystemSettings 行为一致：表为空时返回内置默认值，
// 而不是写入一行——写库时机仍由 Node 版（或后续 Settings 迁移）决定。
func (s *Settings) Get(ctx context.Context) (*SystemSettings, error) {
	var (
		settings SystemSettings
		matrix   sql.NullString
	)
	err := s.conn.QueryRowContext(ctx, `
		SELECT "id", "autoDeleteInactiveRooms", "autoDeleteAfterHours", "roomDefaultMusicVolume",
		       "registrationMode", "roomCreationMode", "roomPermissionMatrix",
		       "roomMultiInstanceLogin", "betaFeaturesEnabled",
		       "dashDisabled", "bilibiliDefaultParseMode", "bilibiliPgcDefaultMode",
		       "playsvideoEnabled", "announceAutoPopupOnUpdate"
		FROM "system_settings" ORDER BY "id" ASC LIMIT 1
	`).Scan(
		&settings.ID, &settings.AutoDeleteInactiveRooms, &settings.AutoDeleteAfterHours,
		&settings.RoomDefaultMusicVolume, &settings.RegistrationMode, &settings.RoomCreationMode,
		&matrix, &settings.RoomMultiInstanceLogin, &settings.BetaFeaturesEnabled, &settings.DashDisabled,
		&settings.BilibiliDefaultParseMode, &settings.BilibiliPgcDefaultMode,
		&settings.PlaysvideoEnabled, &settings.AnnounceAutoPopupOnUpdate,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultSettings(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取系统设置失败: %w", err)
	}
	if matrix.Valid && matrix.String != "" {
		settings.RoomPermissionMatrix = json.RawMessage(matrix.String)
	}
	return &settings, nil
}

// defaultSettings 与 Node 版列默认值保持一致。
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
		AnnounceAutoPopupOnUpdate: true,
	}
}
