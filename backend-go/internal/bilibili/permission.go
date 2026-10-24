package bilibili

import (
	"context"
	"database/sql"
	"log"
)

// 与 permission.ts 一致的清晰度常量。
const (
	// DefaultQn 非会员默认清晰度：1080P。
	DefaultQn = 80
	// VipDefaultQn 会员默认清晰度：4K。
	VipDefaultQn = 120
	// QnHDR HDR 真彩（HEVC Main10 / HLG）。
	QnHDR = 125
	// QnDolbyVision 杜比视界（浏览器基本无法解码）。
	QnDolbyVision = 126
	// Qn8K 8K。
	Qn8K = 127
	// AnonymousMaxQn 未登录 B站 时最高可用的清晰度（480P）。
	AnonymousMaxQn = 32
)

// fnval 位标志。
const (
	fnvalMP4         = 1
	fnvalDASH        = 16
	fnvalHDR         = 64
	fnval4K          = 128
	fnvalDolbyAudio  = 256
	fnvalDolbyVision = 512
	fnval8K          = 1024
	fnvalAV1         = 2048
)

// vipOnlyQns 是大会员专属清晰度。
var vipOnlyQns = map[int]bool{112: true, 116: true, 120: true, 125: true, 126: true, 127: true}

// IsVipOnlyQn 判断清晰度是否为大会员专属。
//
// 服务端下载等「绕过前端过滤」的场景要用它做二次强校验，
// 否则前端改个 qn 参数就能下走会员画质。
func IsVipOnlyQn(qn int) bool { return vipOnlyQns[qn] }

// Quality 是一条可选清晰度。
type Quality struct {
	ID         int    `json:"id"`
	Label      string `json:"label"`
	Resolution string `json:"resolution,omitempty"`
}

// qnQualityMap 是 qn 到标签/分辨率的兜底映射。
var qnQualityMap = map[int]Quality{
	127: {ID: 127, Label: "8K 超高清", Resolution: "7680x4320"},
	126: {ID: 126, Label: "杜比视界", Resolution: "3840x2160"},
	125: {ID: 125, Label: "HDR 真彩", Resolution: "3840x2160"},
	120: {ID: 120, Label: "4K 超清", Resolution: "3840x2160"},
	116: {ID: 116, Label: "1080P60", Resolution: "1920x1080"},
	112: {ID: 112, Label: "1080P+", Resolution: "1920x1080"},
	80:  {ID: 80, Label: "1080P", Resolution: "1920x1080"},
	74:  {ID: 74, Label: "720P60", Resolution: "1280x720"},
	64:  {ID: 64, Label: "720P", Resolution: "1280x720"},
	32:  {ID: 32, Label: "480P", Resolution: "854x480"},
	16:  {ID: 16, Label: "360P", Resolution: "640x360"},
}

// Service 聚合 B站 解析所需的全部依赖。
//
// Node 版靠模块级单例把这些串起来；Go 版显式组合，便于测试时替换缓存与客户端。
type Service struct {
	Client *Client
	WBI    *WBIManager
	Caches *Caches
	Creds  *CredentialStore
	// Browse 是一起听「哔哩哔哩」页/收藏夹用到的短 TTL 缓存。
	Browse *BrowseCaches
}

// NewService 构造 B站 解析服务。
func NewService(conn *sql.DB) *Service {
	client := NewClient()
	return &Service{
		Client: client,
		WBI:    NewWBIManager(client),
		Caches: NewCaches(),
		Creds:  NewCredentialStore(conn),
		Browse: NewBrowseCaches(),
	}
}

// GetVipStatus 查询 Cookie 对应账号是否为有效大会员。
//
// 任何异常都返回 false：VIP 判定只影响「默认清晰度」和「试看标记」，
// 不应因为它失败就让整个解析中断（真无权限由 playurl 的业务码兜底）。
func (s *Service) GetVipStatus(ctx context.Context, cookie string) bool {
	if cookie == "" {
		return false
	}
	if cached, ok := s.Caches.GetVipStatus(cookie); ok {
		return cached
	}
	env, err := s.Client.Fetch(ctx, "https://api.bilibili.com/x/web-interface/nav", FetchOptions{Cookie: cookie})
	if err != nil {
		log.Printf("[bilibili] getVipStatus error: %v", err)
		return false
	}
	var nav struct {
		IsLogin   bool `json:"isLogin"`
		VipStatus int  `json:"vipStatus"`
		VipType   int  `json:"vipType"`
	}
	if _, err := DecodeDataInto(env, &nav); err != nil {
		return false
	}
	if !nav.IsLogin {
		s.Caches.SetVipStatus(cookie, false)
		return false
	}
	isVip := nav.VipStatus == 1 || nav.VipType > 0
	s.Caches.SetVipStatus(cookie, isVip)
	return isVip
}

// FilterQualitiesByVip 按会员状态与登录态过滤可用清晰度。
//   - 未登录：只留 480P 及以下；
//   - 已登录非会员：剔除大会员专属档；
//   - 会员：全留。
func FilterQualitiesByVip(list []Quality, isVip, hasCookie bool) []Quality {
	if isVip {
		return list
	}
	if !hasCookie {
		filtered := make([]Quality, 0, len(list))
		for _, q := range list {
			if q.ID <= AnonymousMaxQn {
				filtered = append(filtered, q)
			}
		}
		if len(filtered) == 0 {
			return []Quality{
				{ID: 32, Label: "480P", Resolution: "854x480"},
				{ID: 16, Label: "360P", Resolution: "640x360"},
			}
		}
		return filtered
	}
	filtered := make([]Quality, 0, len(list))
	for _, q := range list {
		if !vipOnlyQns[q.ID] {
			filtered = append(filtered, q)
		}
	}
	if len(filtered) == 0 {
		return []Quality{{ID: 80, Label: "1080P", Resolution: "1920x1080"}}
	}
	return filtered
}

// ComputeFnval 按会员状态与目标 qn 计算 fnval 位标志。
func ComputeFnval(isVip bool, qn int, codec string, allowDolbyVision bool) int {
	if !isVip {
		return fnvalDASH
	}
	fnval := fnvalDASH | fnvalHDR | fnval4K
	if qn == Qn8K {
		fnval |= fnval8K
	}
	if qn == QnDolbyVision && allowDolbyVision {
		fnval |= fnvalDolbyVision
	}
	if codec == "av1" {
		fnval |= fnvalAV1
	}
	return fnval
}

// GetDefaultQn 按会员状态与登录态给出默认清晰度。
func GetDefaultQn(isVip, hasCookie bool) int {
	if !hasCookie {
		return AnonymousMaxQn
	}
	if isVip {
		return VipDefaultQn
	}
	return DefaultQn
}
