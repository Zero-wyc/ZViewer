package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"zviewer/backend/internal/anime"
	"zviewer/backend/internal/httpx"
)

// 动漫源路由，对应 routes/animeSources.ts（挂载在 /api/stream/anime）。
//
//   GET  /sources    列出数据源
//   GET  /search     按关键词搜索
//   GET  /episodes   取分集
//   POST /resolve    解析播放地址
//
// /proxy 在 proxy.go 里与另外三个数据源共用同一实现。

func (s *Server) registerAnimeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/anime/sources", s.Auth.Require(s.handleAnimeSources))
	mux.HandleFunc("GET /api/stream/anime/search", s.Auth.Require(s.handleAnimeSearch))
	mux.HandleFunc("GET /api/stream/anime/episodes", s.Auth.Require(s.handleAnimeEpisodes))
	mux.HandleFunc("POST /api/stream/anime/resolve", s.Auth.Require(s.handleAnimeResolve))
}

// animeUpstreamFail 数据源报错统一回 502。
//
// 文案优先用上游错误本身（前端会直接展示「该源不可用」的具体原因），
// 空错误才退回兜底文案。
func animeUpstreamFail(w http.ResponseWriter, scope string, err error, fallback string) {
	log.Printf("[animeSources] %s error: %v", scope, err)
	message := fallback
	if err != nil && err.Error() != "" {
		message = err.Error()
	}
	httpx.Fail(w, http.StatusBadGateway, message)
}

// handleAnimeSources 列出可用番剧数据源。
func (s *Server) handleAnimeSources(w http.ResponseWriter, r *http.Request) {
	sources, err := s.Anime.List(r.Context())
	if err != nil {
		log.Printf("[animeSources] list sources error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "获取番剧数据源列表失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "sources": sources})
}

// animeProvider 解析 source 参数并取数据源；失败时已写好响应，返回 nil。
func (s *Server) animeProvider(w http.ResponseWriter, r *http.Request, sourceParam string) anime.Provider {
	trimmed := strings.TrimSpace(sourceParam)
	if trimmed == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return nil
	}
	provider := s.Anime.Get(r.Context(), trimmed)
	if provider == nil {
		httpx.Fail(w, http.StatusBadRequest, "未知的番剧数据源")
		return nil
	}
	return provider
}

// handleAnimeSearch 搜索番剧。
func (s *Server) handleAnimeSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	provider := s.animeProvider(w, r, query.Get("source"))
	if provider == nil {
		return
	}
	keyword := strings.TrimSpace(query.Get("keyword"))
	if keyword == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 keyword 参数")
		return
	}

	results, err := provider.Search(r.Context(), keyword)
	if err != nil {
		animeUpstreamFail(w, "search", err, "搜索番剧数据源失败")
		return
	}
	if results == nil {
		results = []anime.SearchResult{}
	}
	httpx.OK(w, map[string]any{"success": true, "results": results})
}

// handleAnimeEpisodes 取分集列表。
func (s *Server) handleAnimeEpisodes(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	provider := s.animeProvider(w, r, query.Get("source"))
	if provider == nil {
		return
	}
	identifier := strings.TrimSpace(query.Get("identifier"))
	if identifier == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 identifier 参数")
		return
	}

	episodes, err := provider.Episodes(r.Context(), identifier)
	if err != nil {
		animeUpstreamFail(w, "episodes", err, "获取集数列表失败")
		return
	}
	if episodes == nil {
		episodes = []anime.Episode{}
	}
	httpx.OK(w, map[string]any{"success": true, "episodes": episodes})
}

// animeResolveResponse 是解析成功的响应体。
type animeResolveResponse struct {
	Success    bool              `json:"success"`
	URL        string            `json:"url"`
	Headers    map[string]string `json:"headers,omitempty"`
	Format     string            `json:"format,omitempty"`
	AudioURL   string            `json:"audioUrl,omitempty"`
	VideoCodec string            `json:"videoCodec,omitempty"`
	AudioCodec string            `json:"audioCodec,omitempty"`
	Duration   *float64          `json:"duration,omitempty"`
}

// handleAnimeResolve 解析播放地址。
func (s *Server) handleAnimeResolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source  any             `json:"source"`
		Episode json.RawMessage `json:"episode"`
	}
	// 请求体缺失/非法按空对象处理（Node 是 req.body 为空时的兜底）。
	_ = httpx.DecodeJSON(r, &body)

	source, _ := body.Source.(string)
	provider := s.animeProvider(w, r, source)
	if provider == nil {
		return
	}

	// `!episode || typeof episode !== 'object'`：数组也算 object，会一路传到底
	// （只是取不到任何字段），这里保持一致。
	raw, ok := decodeEpisodeObject(body.Episode)
	if !ok {
		httpx.Fail(w, http.StatusBadRequest, "缺少 episode 参数")
		return
	}

	result, err := provider.PlaybackURL(r.Context(), normalizeAnimeEpisode(raw))
	if err != nil {
		animeUpstreamFail(w, "resolve", err, "解析播放地址失败")
		return
	}
	if result == nil {
		httpx.Fail(w, http.StatusNotFound, "无法解析播放地址")
		return
	}

	httpx.OK(w, animeResolveResponse{
		Success:    true,
		URL:        result.URL,
		Headers:    result.Headers,
		Format:     result.Format,
		AudioURL:   result.AudioURL,
		VideoCodec: result.VideoCodec,
		AudioCodec: result.AudioCodec,
		Duration:   result.Duration,
	})
}

// normalizeAnimeEpisode 把前端传来的 episode 规整成内部结构。
//
// 规则见 normalizeEpisodeFields（与 anisubs 的 /resolve 共用）。
func normalizeAnimeEpisode(raw map[string]any) anime.Episode {
	id, title, episodeNumber, params := normalizeEpisodeFields(raw)
	return anime.Episode{
		ID:             id,
		Title:          title,
		EpisodeNumber:  int(episodeNumber),
		PlaybackParams: params,
	}
}
