package bilibili

import (
	"context"
	"log"
)

// rawVideoInfo 是 view 接口的原始响应。
type rawVideoInfo struct {
	Bvid     string `json:"bvid"`
	Aid      int64  `json:"aid"`
	Cid      int64  `json:"cid"`
	Title    string `json:"title"`
	Pic      string `json:"pic"`
	Duration int    `json:"duration"`
	Pages    []struct {
		Cid      int64  `json:"cid"`
		Page     int    `json:"page"`
		Part     string `json:"part"`
		Duration int    `json:"duration"`
	} `json:"pages"`
	Stat *struct {
		View     int64 `json:"view"`
		Danmaku  int64 `json:"danmaku"`
		Reply    int64 `json:"reply"`
		Favorite int64 `json:"favorite"`
		Coin     int64 `json:"coin"`
		Share    int64 `json:"share"`
		Like     int64 `json:"like"`
	} `json:"stat"`
}

func normalizeVideoInfo(raw *rawVideoInfo) *VideoInfo {
	if raw == nil {
		return nil
	}
	info := &VideoInfo{
		Bvid:     raw.Bvid,
		Aid:      raw.Aid,
		Cid:      raw.Cid,
		Title:    raw.Title,
		Pic:      raw.Pic,
		Duration: raw.Duration,
		Pages:    make([]VideoPage, 0, len(raw.Pages)),
	}
	for _, p := range raw.Pages {
		info.Pages = append(info.Pages, VideoPage{Cid: p.Cid, Page: p.Page, Part: p.Part, Duration: p.Duration})
	}
	if raw.Stat != nil {
		info.Stat = &VideoStat{
			View: raw.Stat.View, Danmaku: raw.Stat.Danmaku, Reply: raw.Stat.Reply,
			Favorite: raw.Stat.Favorite, Coin: raw.Stat.Coin, Share: raw.Stat.Share, Like: raw.Stat.Like,
		}
	}
	return info
}

// GetVideoInfo 获取视频信息，WBI 签名接口失败时降级到未签名接口。
func (s *Service) GetVideoInfo(ctx context.Context, bvid, cookie string) (*VideoInfo, error) {
	imgKey, subKey, err := s.WBI.Keys(ctx, cookie)
	if err == nil {
		signed := SignParams(NewParams().Set("bvid", bvid), imgKey, subKey)
		env, fetchErr := s.Client.Fetch(ctx,
			"https://api.bilibili.com/x/web-interface/wbi/view?"+signed.Encode(),
			FetchOptions{Cookie: cookie})
		if fetchErr == nil {
			var raw rawVideoInfo
			if _, decodeErr := DecodeDataInto(env, &raw); decodeErr == nil {
				return normalizeVideoInfo(&raw), nil
			} else {
				err = decodeErr
			}
		} else {
			err = fetchErr
		}
	}

	// 降级路径：清掉密钥缓存，下次调用重新取（密钥过期是 WBI 失败的常见原因）。
	log.Printf("[bilibili] WBI view 失败，降级到未签名接口: %v", err)
	s.WBI.ClearCache()
	env, legacyErr := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/view?bvid="+encodeComponent(bvid),
		FetchOptions{Cookie: cookie})
	if legacyErr != nil {
		return nil, legacyErr
	}
	var raw rawVideoInfo
	if _, decodeErr := DecodeDataInto(env, &raw); decodeErr != nil {
		return nil, decodeErr
	}
	return normalizeVideoInfo(&raw), nil
}
