package api

import (
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"strings"

	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
)

// registerBilibiliBrowseRoutes 挂载 B站 内容浏览域的 15 个端点。
//
// 对应 routes/stream/bilibili-{videos,comments,lists,favorites,bangumi}.routes.ts。
// 全部要求登录 ZViewer 账号；只有收藏夹/追番额外要求已绑定 B站。
func (s *Server) registerBilibiliBrowseRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/bilibili/view", s.Auth.Require(s.handleBilibiliView))
	mux.HandleFunc("GET /api/stream/bilibili/region-new", s.Auth.Require(s.handleBilibiliRegionNew))
	mux.HandleFunc("GET /api/stream/bilibili/related", s.Auth.Require(s.handleBilibiliRelated))
	mux.HandleFunc("GET /api/stream/bilibili/search", s.Auth.Require(s.handleBilibiliSearch))
	mux.HandleFunc("GET /api/stream/bilibili/comments", s.Auth.Require(s.handleBilibiliComments))
	mux.HandleFunc("GET /api/stream/bilibili/comment-replies", s.Auth.Require(s.handleBilibiliCommentReplies))
	mux.HandleFunc("GET /api/stream/bilibili/link-meta", s.Auth.Require(s.handleBilibiliLinkMeta))
	mux.HandleFunc("GET /api/stream/bilibili/collection-videos", s.Auth.Require(s.handleBilibiliCollectionVideos))
	mux.HandleFunc("GET /api/stream/bilibili/fav-videos", s.Auth.Require(s.handleBilibiliFavVideos))
	mux.HandleFunc("GET /api/stream/bilibili/fav-folders", s.Auth.Require(s.handleBilibiliFavFolders))
	mux.HandleFunc("GET /api/stream/bilibili/fav-list-videos", s.Auth.Require(s.handleBilibiliFavListVideos))
	mux.HandleFunc("POST /api/stream/bilibili/fav/collect", s.Auth.Require(s.handleBilibiliFavCollect))
	mux.HandleFunc("GET /api/stream/bilibili/fav/status", s.Auth.Require(s.handleBilibiliFavStatus))
	mux.HandleFunc("GET /api/stream/bilibili/following-bangumi", s.Auth.Require(s.handleBilibiliFollowingBangumi))
	mux.HandleFunc("GET /api/stream/bilibili/bangumi-episodes", s.Auth.Require(s.handleBilibiliBangumiEpisodes))
}

// biliNumber 复刻 JS 的 Number(x)：空串是 0，非法文本是 NaN。
//
// 复用 subtitles.go 的 jsNumber（它已经处理了空串=0 这个关键差异），
// 这里只把「解析失败」翻成 NaN，方便后面直接照抄 `|| fallback` 的写法。
func biliNumber(raw string) float64 {
	value, err := jsNumber(raw)
	if err != nil {
		return math.NaN()
	}
	return value
}

// jsIntOr 复刻 `Math.max(Number(x) || fallback, min)` 这一类取值。
func jsIntOr(raw string, fallback, min int) int {
	value := biliNumber(raw)
	if math.IsNaN(value) || value == 0 {
		value = float64(fallback)
	}
	if value < float64(min) {
		return min
	}
	return int(value)
}

// jsIntClamp 复刻 `Math.min(Math.max(Number(x) || fallback, min), max)`。
func jsIntClamp(raw string, fallback, min, max int) int {
	value := jsIntOr(raw, fallback, min)
	if value > max {
		return max
	}
	return value
}

// jsFloor 复刻 `Math.floor(Number(x))`；NaN 时返回 0。
func jsFloor(raw string) int64 {
	value := biliNumber(raw)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return int64(math.Floor(value))
}

// bilibiliUpstreamFail 输出 502，并优先透出上游文案。
//
// Node 的 catch 是 `res.status(502).json({success:false,message: err.message})`，
// 失败文案（含 B站 业务错误原文）是给用户看的，不能统一换成兜底句。
func bilibiliUpstreamFail(w http.ResponseWriter, scope string, err error, fallback string) {
	log.Printf("[bilibili] %s error: %v", scope, err)
	message := fallback
	if err != nil && err.Error() != "" {
		message = err.Error()
	}
	httpx.Fail(w, http.StatusBadGateway, message)
}

// handleBilibiliView 按 BV 号取视频摘要（添加视频弹窗「搜索」）。
func (s *Server) handleBilibiliView(w http.ResponseWriter, r *http.Request) {
	bvid := strings.TrimSpace(r.URL.Query().Get("bvid"))
	if !bilibili.IsValidBvid(bvid) {
		httpx.Fail(w, http.StatusBadRequest, "BV 号格式无效")
		return
	}
	summary, err := s.Bilibili.VideoSummary(r.Context(), bvid, s.requestCookie(r))
	if err != nil {
		bilibiliUpstreamFail(w, "view", err, "获取视频信息失败")
		return
	}
	httpx.OK(w, map[string]any{
		"success":  true,
		"bvid":     summary.Bvid,
		"title":    summary.Title,
		"pic":      summary.Pic,
		"duration": summary.Duration,
		"upName":   summary.UpName,
		"cid":      summary.Cid,
		"pages":    summary.Pages,
	})
}

// handleBilibiliRegionNew 音乐分区榜（一起听「哔哩哔哩」页）。
func (s *Server) handleBilibiliRegionNew(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	rid := jsIntOr(query.Get("rid"), 3, 0)
	if rid == 0 {
		rid = 3
	}
	items, err := s.Bilibili.RegionRanking(r.Context(), rid, s.requestCookie(r))
	if err != nil {
		bilibiliUpstreamFail(w, "region-new", err, "获取分区视频失败")
		return
	}

	ps := jsIntClamp(query.Get("ps"), 24, 1, 100)
	pn := jsIntOr(query.Get("pn"), 1, 1)
	// ranking/v2 是全量榜单：本地切页，total 供前端算总页数。
	start := (pn - 1) * ps
	if start > len(items) {
		start = len(items)
	}
	end := start + ps
	if end > len(items) {
		end = len(items)
	}
	httpx.OK(w, map[string]any{
		"success": true,
		"items":   items[start:end],
		"total":   len(items),
	})
}

// handleBilibiliRelated 相关推荐（自动连播）。
func (s *Server) handleBilibiliRelated(w http.ResponseWriter, r *http.Request) {
	bvid := strings.TrimSpace(r.URL.Query().Get("bvid"))
	if !bilibili.IsValidBvid(bvid) {
		httpx.Fail(w, http.StatusBadRequest, "BV 号格式无效")
		return
	}
	items, err := s.Bilibili.RelatedVideos(r.Context(), bvid, s.requestCookie(r))
	if err != nil {
		if errors.Is(err, bilibili.ErrVideoNotFound) {
			httpx.Fail(w, http.StatusNotFound, "视频不存在")
			return
		}
		bilibiliUpstreamFail(w, "related", err, "获取相关推荐失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "items": items})
}

// handleBilibiliSearch 视频搜索（search / tag / mixed 三模式）。
func (s *Server) handleBilibiliSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	keyword := strings.TrimSpace(query.Get("keyword"))
	if keyword == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少关键词")
		return
	}
	pn := jsIntOr(query.Get("pn"), 1, 1)
	mode := bilibili.ParseSearchMode(query.Get("mode"))

	items, total, err := s.Bilibili.Search(r.Context(), keyword, s.requestCookie(r), pn, mode)
	if err != nil {
		bilibiliUpstreamFail(w, "search", err, "搜索失败")
		return
	}
	payload := map[string]any{"success": true, "items": items}
	// total 为 null 时前端按「页满即有下一页」估算，因此键必须存在。
	payload["total"] = nil
	if total != nil {
		payload["total"] = *total
	}
	httpx.OK(w, payload)
}

// handleBilibiliComments 主楼评论（游标分页）。
func (s *Server) handleBilibiliComments(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	bvid := strings.TrimSpace(query.Get("bvid"))
	if !bilibili.IsValidBvid(bvid) {
		httpx.Fail(w, http.StatusBadRequest, "BV 号格式无效")
		return
	}
	mode := 2
	if query.Get("mode") == "3" {
		mode = 3
	}
	var next int64
	if raw := jsFloor(query.Get("next")); raw > 0 {
		next = raw
	}

	result, err := s.Bilibili.Comments(r.Context(), bvid, s.requestCookie(r), mode, next)
	if err != nil {
		bilibiliUpstreamFail(w, "comments", err, "获取评论失败")
		return
	}
	payload := map[string]any{
		"success":      true,
		"total":        result.Total,
		"replies":      result.Replies,
		"loginLimited": result.LoginLimited,
	}
	payload["next"] = nil
	if result.Next != nil {
		payload["next"] = *result.Next
	}
	httpx.OK(w, payload)
}

// handleBilibiliCommentReplies 楼中楼回复（pn 分页）。
func (s *Server) handleBilibiliCommentReplies(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	bvid := strings.TrimSpace(query.Get("bvid"))
	rpid := jsFloor(query.Get("rpid"))
	if !bilibili.IsValidBvid(bvid) || rpid <= 0 {
		httpx.Fail(w, http.StatusBadRequest, "参数无效")
		return
	}
	pn := jsIntOr(query.Get("pn"), 1, 1)
	ps := jsIntClamp(query.Get("ps"), 10, 1, 20)

	total, replies, err := s.Bilibili.CommentReplies(r.Context(), bvid, s.requestCookie(r), rpid, pn, ps)
	if err != nil {
		bilibiliUpstreamFail(w, "comment-replies", err, "获取回复失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "total": total, "replies": replies})
}

// handleBilibiliLinkMeta 解析合辑/系列/收藏夹链接。
func (s *Server) handleBilibiliLinkMeta(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少链接")
		return
	}
	meta, err := s.Bilibili.LinkMetaOf(r.Context(), rawURL, s.requestCookie(r))
	if err != nil {
		switch {
		case errors.Is(err, bilibili.ErrInvalidLink):
			httpx.Fail(w, http.StatusBadRequest, "链接无效")
		case errors.Is(err, bilibili.ErrUnsupportedLink):
			httpx.Fail(w, http.StatusBadRequest, "无法识别的链接：支持合集、系列或收藏夹页面链接")
		default:
			bilibiliUpstreamFail(w, "link-meta", err, "解析链接失败")
		}
		return
	}
	payload := map[string]any{
		"success": true,
		"kind":    string(meta.Kind),
		"mid":     meta.Mid,
		"listId":  meta.ListID,
		"title":   meta.Title,
		"total":   nil,
	}
	if meta.Total != nil {
		payload["total"] = *meta.Total
	}
	httpx.OK(w, payload)
}

// handleBilibiliCollectionVideos 合集/系列视频分页。
func (s *Server) handleBilibiliCollectionVideos(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	mid := jsFloor(query.Get("mid"))
	sid := jsFloor(query.Get("sid"))
	if mid <= 0 || sid <= 0 {
		httpx.Fail(w, http.StatusBadRequest, "参数无效")
		return
	}
	kind := bilibili.LinkSeason
	if query.Get("kind") == "series" {
		kind = bilibili.LinkSeries
	}
	pn := jsIntOr(query.Get("pn"), 1, 1)
	ps := jsIntClamp(query.Get("ps"), 20, 1, 20)

	items, total, err := s.Bilibili.CollectionVideos(r.Context(), s.requestCookie(r), mid, sid, kind, pn, ps)
	if err != nil {
		bilibiliUpstreamFail(w, "collection-videos", err, "获取合集视频失败")
		return
	}
	payload := map[string]any{"success": true, "items": items, "total": nil}
	if total != nil {
		payload["total"] = *total
	}
	httpx.OK(w, payload)
}

// handleBilibiliFavVideos 登录用户的收藏视频（默认/指定收藏夹）。
func (s *Server) handleBilibiliFavVideos(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	ps := jsIntClamp(query.Get("ps"), 20, 1, 50)
	pn := jsIntOr(query.Get("pn"), 1, 1)
	mediaID := jsFloor(query.Get("mediaId"))

	folderTitle, items, total, err := s.Bilibili.FavVideos(r.Context(), s.requestCookie(r), mediaID, pn, ps)
	if err != nil {
		switch {
		case errors.Is(err, bilibili.ErrBiliNotLoggedIn):
			httpx.Fail(w, http.StatusUnauthorized, "B站 未登录")
		case errors.Is(err, bilibili.ErrCredentialExpired):
			httpx.Fail(w, http.StatusUnauthorized, "B站 凭证失效")
		default:
			bilibiliUpstreamFail(w, "fav-videos", err, "获取收藏视频失败")
		}
		return
	}
	payload := map[string]any{
		"success":     true,
		"folderTitle": folderTitle,
		"items":       items,
		"total":       nil,
	}
	if total != nil {
		payload["total"] = *total
	}
	httpx.OK(w, payload)
}

// handleBilibiliFavFolders 登录用户的收藏夹列表。
func (s *Server) handleBilibiliFavFolders(w http.ResponseWriter, r *http.Request) {
	folders, err := s.Bilibili.FavFolders(r.Context(), s.requestCookie(r))
	if err != nil {
		switch {
		case errors.Is(err, bilibili.ErrBiliNotLoggedIn):
			httpx.Fail(w, http.StatusUnauthorized, "B站 未登录")
		case errors.Is(err, bilibili.ErrCredentialExpired):
			httpx.Fail(w, http.StatusUnauthorized, "B站 凭证失效")
		default:
			bilibiliUpstreamFail(w, "fav-folders", err, "获取收藏夹列表失败")
		}
		return
	}
	httpx.OK(w, map[string]any{"success": true, "folders": folders})
}

// handleBilibiliFavListVideos 任意公开收藏夹的视频分页。
func (s *Server) handleBilibiliFavListVideos(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	fid := jsFloor(query.Get("fid"))
	if fid <= 0 {
		httpx.Fail(w, http.StatusBadRequest, "参数无效")
		return
	}
	pn := jsIntOr(query.Get("pn"), 1, 1)
	ps := jsIntClamp(query.Get("ps"), 20, 1, 50)

	items, total, err := s.Bilibili.FavListVideos(r.Context(), s.requestCookie(r), fid, pn, ps)
	if err != nil {
		bilibiliUpstreamFail(w, "fav-list-videos", err, "获取收藏夹视频失败")
		return
	}
	payload := map[string]any{"success": true, "items": items, "total": nil}
	if total != nil {
		payload["total"] = *total
	}
	httpx.OK(w, payload)
}

// bilibiliFavCollectBody 是收藏请求体。
//
// MediaID 用 RawMessage 是为了区分「传了数字 mediaId」与「传了标题」——
// Node 是 `typeof req.body?.mediaId === 'number'`，两条分支的兜底标题不同。
type bilibiliFavCollectBody struct {
	Bvid        string          `json:"bvid"`
	MediaID     json.RawMessage `json:"mediaId"`
	FolderTitle string          `json:"folderTitle"`
	Action      string          `json:"action"`
}

// handleBilibiliFavCollect 收藏 / 取消收藏视频。
func (s *Server) handleBilibiliFavCollect(w http.ResponseWriter, r *http.Request) {
	var body bilibiliFavCollectBody
	_ = httpx.DecodeJSON(r, &body)

	bvid := strings.TrimSpace(body.Bvid)
	if !bilibili.IsValidBvid(bvid) {
		httpx.Fail(w, http.StatusBadRequest, "BV 号格式无效")
		return
	}

	// Math.floor(Number(body.mediaId))：非法/缺失一律 0。
	var mediaID float64
	mediaIDIsNumber := false
	if len(body.MediaID) > 0 && string(body.MediaID) != "null" {
		raw := strings.TrimSpace(string(body.MediaID))
		mediaIDIsNumber = !strings.HasPrefix(raw, `"`)
		if mediaIDIsNumber {
			_ = json.Unmarshal(body.MediaID, &mediaID)
		} else {
			var asString string
			if json.Unmarshal(body.MediaID, &asString) == nil {
				mediaID = biliNumber(asString)
			}
		}
	}
	if math.IsNaN(mediaID) || math.IsInf(mediaID, 0) {
		mediaID = 0
	}

	folderTitle := strings.TrimSpace(body.FolderTitle)
	if folderTitle == "" {
		folderTitle = "Music"
	}

	folderID, title, err := s.Bilibili.FavCollect(
		r.Context(), s.requestCookie(r), bvid,
		int64(math.Floor(mediaID)), mediaIDIsNumber, folderTitle,
		body.Action == "remove",
	)
	if err != nil {
		switch {
		case errors.Is(err, bilibili.ErrBiliNotLoggedIn):
			httpx.Fail(w, http.StatusUnauthorized, "B站 未登录")
		case errors.Is(err, bilibili.ErrMissingCSRF):
			httpx.Fail(w, http.StatusUnauthorized, "B站 凭证缺少 csrf")
		case errors.Is(err, bilibili.ErrVideoNotFound):
			httpx.Fail(w, http.StatusNotFound, "视频不存在")
		case errors.Is(err, bilibili.ErrFolderMissing):
			httpx.Fail(w, http.StatusNotFound, "尚未收藏到「"+folderTitle+"」")
		case errors.Is(err, bilibili.ErrCreateFolder):
			bilibiliUpstreamFail(w, "fav/collect", err, "创建收藏夹失败")
		default:
			bilibiliUpstreamFail(w, "fav/collect", err, "收藏失败")
		}
		return
	}

	action := "add"
	if body.Action == "remove" {
		action = "remove"
	}
	httpx.OK(w, map[string]any{
		"success":     true,
		"action":      action,
		"folderId":    folderID,
		"folderTitle": title,
	})
}

// handleBilibiliFavStatus 查询视频是否已收藏。
func (s *Server) handleBilibiliFavStatus(w http.ResponseWriter, r *http.Request) {
	bvid := strings.TrimSpace(r.URL.Query().Get("bvid"))
	if !bilibili.IsValidBvid(bvid) {
		httpx.Fail(w, http.StatusBadRequest, "BV 号格式无效")
		return
	}
	status, err := s.Bilibili.FavStatusOf(r.Context(), s.requestCookie(r), bvid)
	if err != nil {
		switch {
		case errors.Is(err, bilibili.ErrBiliNotLoggedIn):
			httpx.Fail(w, http.StatusUnauthorized, "B站 未登录")
		case errors.Is(err, bilibili.ErrVideoNotFound):
			httpx.Fail(w, http.StatusNotFound, "视频不存在")
		default:
			bilibiliUpstreamFail(w, "fav/status", err, "查询收藏状态失败")
		}
		return
	}
	payload := map[string]any{"success": true, "collected": status.Collected}
	// 未收藏时 folderId / folderTitle 整个键消失（Node 是 undefined 被丢弃）。
	if status.Collected {
		payload["folderId"] = status.FolderID
		payload["folderTitle"] = status.FolderTitle
	}
	httpx.OK(w, payload)
}

// handleBilibiliFollowingBangumi 关注的番剧列表。
func (s *Server) handleBilibiliFollowingBangumi(w http.ResponseWriter, r *http.Request) {
	cookie := s.requestCookie(r)
	if cookie == "" {
		httpx.Fail(w, http.StatusUnauthorized, "未登录 B站")
		return
	}

	query := r.URL.Query()
	pn := 1
	if raw := strings.TrimSpace(query.Get("page")); raw != "" {
		if value := biliNumber(raw); !math.IsNaN(value) && value > 0 {
			pn = int(value)
		}
	}
	ps := 50
	if raw := strings.TrimSpace(query.Get("pageSize")); raw != "" {
		if value := biliNumber(raw); !math.IsNaN(value) && value > 0 {
			ps = int(value)
		}
	}

	userID, _ := bilibiliUserID(r)
	items, err := s.Bilibili.FollowingBangumi(r.Context(), userID, cookie, pn, ps)
	if err != nil {
		switch {
		case errors.Is(err, bilibili.ErrBiliNotLoggedIn):
			httpx.Fail(w, http.StatusUnauthorized, "未登录 B站")
		case errors.Is(err, bilibili.ErrNoBiliMid):
			httpx.Fail(w, http.StatusBadRequest, "无法获取 B站 用户 ID")
		default:
			bilibiliUpstreamFail(w, "following-bangumi", err, "获取关注番剧列表失败")
		}
		return
	}
	httpx.OK(w, map[string]any{"success": true, "list": items})
}

// handleBilibiliBangumiEpisodes 番剧集数列表。
func (s *Server) handleBilibiliBangumiEpisodes(w http.ResponseWriter, r *http.Request) {
	seasonID := strings.TrimSpace(r.URL.Query().Get("seasonId"))
	if seasonID == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 seasonId 参数")
		return
	}
	episodes, err := s.Bilibili.BangumiEpisodes(r.Context(), s.requestCookie(r), seasonID)
	if err != nil {
		bilibiliUpstreamFail(w, "bangumi-episodes", err, "获取番剧集数失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "episodes": episodes})
}
