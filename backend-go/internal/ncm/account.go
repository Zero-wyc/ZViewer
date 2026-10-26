package ncm

import (
	"context"
	"log"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/store"
)

// LoginStatus 是 `/api/music/login/status` 的响应（字段与前端约定一致）。
type LoginStatus struct {
	LoggedIn  bool    `json:"loggedIn"`
	Nickname  *string `json:"nickname"`
	AvatarURL *string `json:"avatarUrl"`
	VIPType   *int64  `json:"vipType"`
	VIPStatus *int64  `json:"vipStatus"`
}

// GetLoginStatus 查询用户的网易云登录状态。
//
// 游客（userId<=0）直接返回未登录；有凭证时按需补全昵称/头像/会员信息。
// 补全失败不能影响「登录状态」本身，否则音乐面板会整体报错。
func (s *Service) GetLoginStatus(ctx context.Context, userID int64) (*LoginStatus, error) {
	credential, err := s.LoadCredential(ctx, userID)
	if err != nil {
		return nil, err
	}
	if credential != nil {
		s.refreshProfileIfNeeded(ctx, credential)
	}
	status := &LoginStatus{LoggedIn: credential != nil}
	if credential != nil {
		status.Nickname = credential.Nickname
		status.AvatarURL = credential.AvatarURL
		status.VIPType = credential.VIPType
		status.VIPStatus = credential.VIPStatus
	}
	return status, nil
}

// refreshProfileIfNeeded 用凭证 cookie 实时补全账号资料与会员信息并回写。
//
// 触发条件：凭证存在且 vipType 为空/0（买了会员之后存量缓存会被误判成普通用户）。
// 任何一步失败都只告警、**不落库**——对应 Node 那个被 try/catch 包住的整体逻辑。
func (s *Service) refreshProfileIfNeeded(ctx context.Context, credential *store.NcmCredential) {
	if credential.VIPType != nil && *credential.VIPType != 0 {
		return
	}
	cookieHeader := CookieHeaderFor(credential)
	if cookieHeader == "" {
		return
	}

	// 1) /user/account 补昵称/头像/vipType
	profileResp, err := s.Call(ctx, "/user/account", cookieHeader)
	if err != nil {
		log.Printf("[ncm] login/status 账号资料补全失败: %v", err)
		return
	}
	profile := ExtractProfile(profileResp.Body)
	mergeProfileIntoCredential(credential, profile)

	// 2) profile 仍判定不出会员 → /vip/info 三档兜底
	if credential.VIPType == nil || *credential.VIPType == 0 {
		vipResp, err := s.Call(ctx, "/vip/info", cookieHeader)
		if err != nil {
			log.Printf("[ncm] login/status 会员信息补全失败: %v", err)
			return
		}
		applyVIPInfo(credential, vipResp.Body, profile)
	}

	if err := s.Creds.Save(ctx, credential.UserID, credential.Cookies, store.NcmProfilePatch{
		Nickname:  credential.Nickname,
		AvatarURL: credential.AvatarURL,
		VIPType:   credential.VIPType,
		VIPStatus: credential.VIPStatus,
	}); err != nil {
		log.Printf("[ncm] login/status 账号资料回写失败: %v", err)
	}
}

// applyVIPInfo 用 /vip/info 的三档会员对象兜底 VIP 判定。
//
// 为什么要这一层：`profile.vipType` 对部分黑胶会员不反映实际状态
// （Hydrogen 走 /vip/info 同因）。三档分别是 associator（黑胶）、
// musicPackage（音乐包）、redplus（黑胶 PLUS），任一在有效期内就算会员；
// SVIP 只能从会员图标 URL 里认（接口没有独立字段）。
func applyVIPInfo(credential *store.NcmCredential, body any, profile *Profile) {
	root, ok := body.(map[string]any)
	if !ok {
		return
	}
	data, ok := root["data"].(map[string]any)
	if !ok {
		return
	}

	now := time.Now().UnixMilli()
	legacyLevel := int64Or(data["redVipLevel"], 0)
	legacyIcon, _ := data["redVipDynamicIconUrl"].(string)
	active := legacyLevel > 0 || legacyIcon != ""
	svip := isSVIPIcon(legacyIcon)

	for _, slotKey := range []string{"associator", "musicPackage", "redplus"} {
		slot, ok := data[slotKey].(map[string]any)
		if !ok {
			continue
		}
		vipCode := int64Or(slot["vipCode"], 0)
		expireTime := int64Or(slot["expireTime"], 0)
		slotIcon, _ := slot["iconUrl"].(string)
		if expireTime > now || (expireTime == 0 && vipCode > 0) {
			active = true
			if isSVIPIcon(slotIcon) {
				svip = true
			}
		}
	}

	status := int64(0)
	if active {
		status = 1
	}
	credential.VIPStatus = &status
	switch {
	case active && svip:
		vipType := int64(11)
		credential.VIPType = &vipType
	case active:
		vipType := int64(10)
		credential.VIPType = &vipType
	case profile != nil && profile.VIPType != nil:
		credential.VIPType = profile.VIPType
	}
}

// isSVIPIcon 判断会员图标 URL 是否指向 SVIP（对应 `icon.toLowerCase().includes('svip')`）。
func isSVIPIcon(iconURL string) bool {
	return strings.Contains(strings.ToLower(iconURL), "svip")
}

// mergeProfileIntoCredential 用 profile 的非 nil 字段覆盖凭证（对应 JS 的 `??`）。
func mergeProfileIntoCredential(credential *store.NcmCredential, profile *Profile) {
	if credential == nil || profile == nil {
		return
	}
	if profile.Nickname != nil {
		credential.Nickname = profile.Nickname
	}
	if profile.AvatarURL != nil {
		credential.AvatarURL = profile.AvatarURL
	}
	if profile.VIPType != nil {
		credential.VIPType = profile.VIPType
	}
	if profile.VIPStatus != nil {
		credential.VIPStatus = profile.VIPStatus
	}
}

// AlbumWithFullSongs 取专辑详情并补齐被截断的歌曲列表。
//
// 网易云 `/album/{id}` 在带 MUSIC_U 的登录态下会把 songs 截断（例如只给 50 首），
// 匿名上下文反而给全量；`album.size` 是总数。所以 songs 少于 size 时再用
// 匿名请求补一次，匿名结果更全就整单采用，否则回退主结果。
//
// 解析失败返回 (nil, nil)，由路由层回 502。
//
// albumID 用 float64：Node 只校验 `Number.isFinite(id) && id > 0`，**不要求整数**，
// `?id=1.5` 会原样拼进上游 URL。这里同样按 JS 的数字字面量输出（1 不写成 1.0）。
func (s *Service) AlbumWithFullSongs(ctx context.Context, albumID float64, cookieHeader string) (any, error) {
	path := "/album?id=" + strconv.FormatFloat(albumID, 'f', -1, 64)
	primary, err := s.Call(ctx, path, cookieHeader)
	if err != nil {
		return nil, err
	}
	body, ok := primary.Body.(map[string]any)
	if !ok {
		return nil, nil
	}

	size := int64(0)
	if album, ok := body["album"].(map[string]any); ok {
		size = int64Or(album["size"], 0)
	}
	songs, _ := body["songs"].([]any)
	if size <= int64(len(songs)) {
		return body, nil
	}

	anonymous, err := s.Call(ctx, path, "")
	if err != nil {
		log.Printf("[ncm] 专辑匿名补齐失败: %v", err)
		return body, nil
	}
	anonBody, ok := anonymous.Body.(map[string]any)
	if !ok {
		return body, nil
	}
	anonSongs, _ := anonBody["songs"].([]any)
	if len(anonSongs) > len(songs) {
		return anonBody, nil
	}
	return body, nil
}

// int64Or 把 JSON 数值转 int64，类型不符时用兜底值（对应 `typeof x === 'number' ? x : fallback`）。
func int64Or(value any, fallback int64) int64 {
	number, ok := toFloat(value)
	if !ok {
		return fallback
	}
	return int64(number)
}
