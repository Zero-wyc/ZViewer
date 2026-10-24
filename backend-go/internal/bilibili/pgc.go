package bilibili

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"strconv"
	"strings"
)

// PgcEpisodeInfo 是番剧/影视的一集。
type PgcEpisodeInfo struct {
	EpID        int64  `json:"epId"`
	Cid         int64  `json:"cid"`
	Bvid        string `json:"bvid"`
	Aid         int64  `json:"aid,omitempty"`
	Title       string `json:"title"`
	LongTitle   string `json:"longTitle,omitempty"`
	Badge       string `json:"badge"`
	Status      int    `json:"status"`
	DurationSec int    `json:"durationSec"`
}

// PgcSeasonInfo 是整季信息。
type PgcSeasonInfo struct {
	SeasonID int64            `json:"seasonId"`
	Title    string           `json:"title"`
	Cover    string           `json:"cover,omitempty"`
	Episodes []PgcEpisodeInfo `json:"episodes"`
}

// PgcError 是 PGC 业务错误，Code 为归一化错误码。
type PgcError struct {
	Code    string
	Message string
}

func (e *PgcError) Error() string { return e.Message }

type pgcEpisodeRaw struct {
	ID        int64  `json:"id"`
	EpID      int64  `json:"ep_id"`
	Cid       int64  `json:"cid"`
	Bvid      string `json:"bvid"`
	Aid       int64  `json:"aid"`
	Badge     string `json:"badge"`
	Status    *int   `json:"status"`
	Duration  int64  `json:"duration"` // 毫秒
	Title     string `json:"title"`
	LongTitle string `json:"long_title"`
}

type pgcSeasonResult struct {
	SeasonID    int64           `json:"season_id"`
	Title       string          `json:"title"`
	Cover       string          `json:"cover"`
	Episodes    []pgcEpisodeRaw `json:"episodes"`
	MainSection *struct {
		Episodes []pgcEpisodeRaw `json:"episodes"`
	} `json:"main_section"`
	Section []struct {
		Episodes []pgcEpisodeRaw `json:"episodes"`
	} `json:"section"`
}

// pgcPayload 抽层 PGC 响应的载荷位置。
//
// PGC 与 UGC 最容易搞混的一点：载荷在顶层 result（不是 data），
// 但少数接口又包在 data.result 下，两处都得认。
type pgcPayload struct {
	Result json.RawMessage `json:"result"`
	Data   *struct {
		Result json.RawMessage `json:"result"`
	} `json:"data"`
}

// raw 返回实际载荷，缺失时返回 nil。
func (p *pgcPayload) raw() json.RawMessage {
	if len(p.Result) > 0 && string(p.Result) != "null" {
		return p.Result
	}
	if p.Data != nil && len(p.Data.Result) > 0 && string(p.Data.Result) != "null" {
		return p.Data.Result
	}
	return nil
}

// pgcPayloadFrom 从响应外壳里取 PGC 载荷。
//
// 实测 PGC 接口把载荷放**顶层 result**（UGC 才放 data），少数接口又包一层
// data.result，两条路径都要认；只读 data 会得到空载荷。
func pgcPayloadFrom(env *Envelope) json.RawMessage {
	if len(env.Result) > 0 && string(env.Result) != "null" {
		return env.Result
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	var inner pgcPayload
	if err := json.Unmarshal(env.Data, &inner); err != nil {
		return nil
	}
	return inner.raw()
}

func normalizeImageURL(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "//") {
		return "https:" + raw
	}
	if strings.HasPrefix(raw, "http://") {
		return "https://" + raw[7:]
	}
	return raw
}

func mapEpisodes(raw []pgcEpisodeRaw) []PgcEpisodeInfo {
	out := make([]PgcEpisodeInfo, 0, len(raw))
	for idx, item := range raw {
		epID := item.EpID
		if epID == 0 {
			epID = item.ID
		}
		title := item.Title
		if title == "" {
			title = strconv.Itoa(idx + 1)
		}
		status := 2
		if item.Status != nil {
			status = *item.Status
		}
		if epID <= 0 || item.Cid <= 0 {
			continue
		}
		out = append(out, PgcEpisodeInfo{
			EpID:      epID,
			Cid:       item.Cid,
			Bvid:      item.Bvid,
			Aid:       item.Aid,
			Title:     title,
			LongTitle: item.LongTitle,
			Badge:     item.Badge,
			Status:    status,
			// 毫秒转秒，四舍五入（对齐 Math.round，避免 89.6s 被截成 89s）
			DurationSec: int(math.Round(float64(item.Duration) / 1000)),
		})
	}
	return out
}

func (s *Service) fetchSeasonByQuery(ctx context.Context, query, cookie string) (*PgcSeasonInfo, error) {
	env, err := s.Client.Fetch(ctx, "https://api.bilibili.com/pgc/view/web/season?"+query,
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, mapPgcBizError(err)
	}

	rawPayload := pgcPayloadFrom(env)
	if rawPayload == nil {
		return nil, &PgcError{Code: "INFO_FAILED", Message: "获取番剧信息失败"}
	}
	var result pgcSeasonResult
	if err := json.Unmarshal(rawPayload, &result); err != nil {
		return nil, &PgcError{Code: "INFO_FAILED", Message: "获取番剧信息失败"}
	}

	var rawEpisodes []pgcEpisodeRaw
	switch {
	case len(result.Episodes) > 0:
		rawEpisodes = result.Episodes
	case result.MainSection != nil && len(result.MainSection.Episodes) > 0:
		rawEpisodes = result.MainSection.Episodes
	case len(result.Section) > 0:
		for _, sec := range result.Section {
			rawEpisodes = append(rawEpisodes, sec.Episodes...)
		}
	}

	episodes := mapEpisodes(rawEpisodes)
	if len(episodes) == 0 {
		return nil, &PgcError{Code: "EP_NOT_FOUND", Message: "该番剧暂无可用分集"}
	}

	return &PgcSeasonInfo{
		SeasonID: result.SeasonID,
		Title:    result.Title,
		Cover:    normalizeImageURL(result.Cover),
		Episodes: episodes,
	}, nil
}

// FetchSeasonByEpID 按 ep_id 反查整季信息（缓存 10 分钟）。
func (s *Service) FetchSeasonByEpID(ctx context.Context, epID int64, cookie string) (*PgcSeasonInfo, error) {
	if cached, ok := s.Caches.GetSeasonByEpID(epID); ok {
		log.Printf("[bilibili-pgc] season served from cache: ep_id=%d", epID)
		return &cached, nil
	}
	info, err := s.fetchSeasonByQuery(ctx, "ep_id="+strconv.FormatInt(epID, 10), cookie)
	if err != nil {
		return nil, err
	}
	s.Caches.SetSeasonByEpID(epID, *info)
	return info, nil
}

// FetchSeasonBySeasonID 按 season_id 获取整季信息（ss 链接入口，不缓存）。
func (s *Service) FetchSeasonBySeasonID(ctx context.Context, seasonID int64, cookie string) (*PgcSeasonInfo, error) {
	return s.fetchSeasonByQuery(ctx, "season_id="+strconv.FormatInt(seasonID, 10), cookie)
}

// mapPgcBizError 把 BizError 归一为 PgcError。
func mapPgcBizError(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "[-404]"):
		return &PgcError{Code: "EP_NOT_FOUND", Message: "该番剧或集数不存在/已下架"}
	case strings.Contains(msg, "[-403]"), strings.Contains(msg, "[-514]"):
		return &PgcError{Code: "NO_PERMISSION", Message: "该内容为付费影视或大会员专享，请使用大会员账号解析"}
	case strings.Contains(msg, "[-10403]"), strings.Contains(msg, "地区"):
		return &PgcError{Code: "REGION_LIMITED", Message: "该内容存在地区观看限制"}
	case strings.Contains(msg, "[-101]"), strings.Contains(msg, "账号未登录"):
		return &PgcError{Code: "NOT_LOGGED_IN", Message: "获取 480P 以上清晰度需要登录 B站 账号"}
	}
	return err
}

// GetPgcPlayURL 获取 PGC 播放地址（pgc/player/web/playurl v1）。
//
// 与 UGC 的差异：走 SESSDATA 鉴权、没有 WBI 签名、不带 platform=html5
// （实测对 PGC 无效果差异，传了反而可能改变返回格式）。
func (s *Service) GetPgcPlayURL(ctx context.Context, epID, cid int64, cookie string, qn, fnval int, codec string) (*PlayURLResult, error) {
	qs := NewParams().
		Set("ep_id", strconv.FormatInt(epID, 10)).
		Set("cid", strconv.FormatInt(cid, 10)).
		Set("qn", strconv.Itoa(qn)).
		Set("fnver", "0").
		Set("fnval", strconv.Itoa(fnval)).
		Set("fourk", "1")

	env, err := s.Client.Fetch(ctx, "https://api.bilibili.com/pgc/player/web/playurl?"+qs.Encode(),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, mapPgcBizError(err)
	}

	rawPayload := pgcPayloadFrom(env)
	if rawPayload == nil {
		return nil, nil
	}
	var data rawPlayURLData
	if err := json.Unmarshal(rawPayload, &data); err != nil {
		return nil, nil
	}
	return NormalizePlayURLData(&data, qn, codec)
}
