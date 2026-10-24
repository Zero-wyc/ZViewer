package bilibili

import (
	"regexp"
	"strconv"
	"time"
)

// 各类缓存的 TTL，与 cache.ts 一一对应。
const (
	vipCacheTTL        = 5 * time.Minute
	userInfoCacheTTL   = 5 * time.Minute
	videoInfoCacheTTL  = 2 * time.Minute
	seasonByEpCacheTTL = 10 * time.Minute
)

// UserInfo 是 B站 账号信息（用于前端展示绑定状态）。
type UserInfo struct {
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	Mid       int64  `json:"mid,omitempty"`
	VipStatus int    `json:"vipStatus,omitempty"`
	VipType   int    `json:"vipType,omitempty"`
}

// VideoPage 是视频的一个分集（P）。
type VideoPage struct {
	Cid      int64  `json:"cid"`
	Page     int    `json:"page"`
	Part     string `json:"part"`
	Duration int    `json:"duration"`
}

// VideoStat 是视频统计数据。
type VideoStat struct {
	View     int64 `json:"view"`
	Danmaku  int64 `json:"danmaku"`
	Reply    int64 `json:"reply"`
	Favorite int64 `json:"favorite"`
	Coin     int64 `json:"coin"`
	Share    int64 `json:"share"`
	Like     int64 `json:"like"`
}

// VideoInfo 是解析 chain 使用的视频元信息。
type VideoInfo struct {
	Bvid     string      `json:"bvid"`
	Aid      int64       `json:"aid"`
	Cid      int64       `json:"cid"`
	Title    string      `json:"title"`
	Pic      string      `json:"pic,omitempty"`
	Duration int         `json:"duration"`
	Pages    []VideoPage `json:"pages"`
	Stat     *VideoStat  `json:"stat,omitempty"`
}

// Caches 集中管理解析链路的短期缓存。
//
// 分成独立实例而不是一个 map，是为了让各类型各自的 TTL 与容量互不影响。
type Caches struct {
	vip        *ttlCache[bool]
	userInfo   *ttlCache[UserInfo]
	videoInfo  *ttlCache[VideoInfo]
	seasonByEp *ttlCache[PgcSeasonInfo]

	// 字幕三件套的 TTL 互不相同（成功 10 分钟 / 失败 60 秒 / 元数据 5 分钟），
	// 这也是必须拆成独立实例的直接原因。
	subtitle        *ttlCache[subtitleCacheEntry]
	subtitleFailure *ttlCache[string]
	subtitleMeta    *ttlCache[subtitleMeta]
}

// NewCaches 构造缓存集合。
func NewCaches() *Caches {
	return &Caches{
		vip:             newTTLCache[bool](vipCacheTTL),
		userInfo:        newTTLCache[UserInfo](userInfoCacheTTL),
		videoInfo:       newTTLCache[VideoInfo](videoInfoCacheTTL),
		seasonByEp:      newTTLCache[PgcSeasonInfo](seasonByEpCacheTTL),
		subtitle:        newTTLCache[subtitleCacheEntry](subtitleSuccessTTL),
		subtitleFailure: newTTLCache[string](subtitleFailureTTL),
		subtitleMeta:    newTTLCache[subtitleMeta](subtitleMetaTTL),
	}
}

// vipCacheKeyRe 提取 Cookie 中的 DedeUserID。
var vipCacheKeyRe = regexp.MustCompile(`(?:^|;\s*)DedeUserID=(\d+)`)

// normalizeVipCacheKey 把 VIP 缓存键归一化为 mid。
//
// Cookie 会随刷新轮换（SESSDATA 变、DedeUserID 不变），直接拿整串做键
// 会让缓存频繁穿透，等于没缓存。
func normalizeVipCacheKey(cookie string) string {
	if m := vipCacheKeyRe.FindStringSubmatch(cookie); len(m) == 2 {
		return "mid:" + m[1]
	}
	return cookie
}

func (c *Caches) GetVipStatus(cookie string) (bool, bool) {
	return c.vip.Get(normalizeVipCacheKey(cookie))
}

func (c *Caches) SetVipStatus(cookie string, isVip bool) {
	c.vip.Set(normalizeVipCacheKey(cookie), isVip)
}

func (c *Caches) InvalidateVip(cookie string) {
	c.vip.Delete(normalizeVipCacheKey(cookie))
}

func (c *Caches) GetUserInfo(userID string) (UserInfo, bool) { return c.userInfo.Get(userID) }

func (c *Caches) SetUserInfo(userID string, info UserInfo) { c.userInfo.Set(userID, info) }

func (c *Caches) InvalidateUserInfo(userID string) { c.userInfo.Delete(userID) }

func (c *Caches) GetVideoInfo(bvid string) (VideoInfo, bool) { return c.videoInfo.Get(bvid) }

func (c *Caches) SetVideoInfo(bvid string, info VideoInfo) { c.videoInfo.Set(bvid, info) }

func (c *Caches) GetSeasonByEpID(epID int64) (PgcSeasonInfo, bool) {
	return c.seasonByEp.Get(int64Key(epID))
}

func (c *Caches) SetSeasonByEpID(epID int64, season PgcSeasonInfo) {
	c.seasonByEp.Set(int64Key(epID), season)
}

func (c *Caches) GetSubtitle(key string) (subtitleCacheEntry, bool) { return c.subtitle.Get(key) }

func (c *Caches) SetSubtitle(key string, entry subtitleCacheEntry) { c.subtitle.Set(key, entry) }

func (c *Caches) GetSubtitleFailure(key string) (string, bool) { return c.subtitleFailure.Get(key) }

func (c *Caches) SetSubtitleFailure(key, reason string) { c.subtitleFailure.Set(key, reason) }

func (c *Caches) GetSubtitleMeta(bvid string) (subtitleMeta, bool) { return c.subtitleMeta.Get(bvid) }

func (c *Caches) SetSubtitleMeta(bvid string, meta subtitleMeta) { c.subtitleMeta.Set(bvid, meta) }

func int64Key(v int64) string { return strconv.FormatInt(v, 10) }
