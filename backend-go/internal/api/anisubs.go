package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/ttlcache"
)

// ani-subs 路由，对应 routes/anisubs.ts（挂载在 /api/stream/anisubs）。
//
//   GET  /sources    列出数据源
//   GET  /search     搜索
//   GET  /episodes   取分集
//   POST /resolve    解析播放地址（6 分钟缓存 + 单飞）
//
// /proxy 在 proxy.go 里与另外三个数据源共用同一实现。

// anisubsResolveTTLMs 是解析结果缓存时长（6 分钟）。
//
// 源站页面抓取 + 递归解析很慢（TLS 回退更慢），而 ani 源的直链只需几分钟有效。
// 6 分钟窗口让同一集的多人与 seek 重载共享一次解析。
const anisubsResolveTTLMs = 6 * 60 * 1000

// anisubsResolveCacheSize 是解析缓存容量上限。
const anisubsResolveCacheSize = 500

// anisubsResolveCache 是 /resolve 的结果缓存。
var anisubsResolveCache = ttlcache.New[*anisubs.PlaybackURL](anisubsResolveTTLMs, anisubsResolveCacheSize)

func (s *Server) registerAniSubsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/anisubs/sources", s.Auth.Require(s.handleAniSubsSources))
	mux.HandleFunc("GET /api/stream/anisubs/search", s.Auth.Require(s.handleAniSubsSearch))
	mux.HandleFunc("GET /api/stream/anisubs/episodes", s.Auth.Require(s.handleAniSubsEpisodes))
	mux.HandleFunc("POST /api/stream/anisubs/resolve", s.Auth.Require(s.handleAniSubsResolve))
}

// handleAniSubsSources 列出可用数据源。
func (s *Server) handleAniSubsSources(w http.ResponseWriter, r *http.Request) {
	sources := s.AniSubs.List(r.Context())
	log.Printf("[anisubs] /sources returned %d sources", len(sources))
	httpx.OK(w, map[string]any{"success": true, "sources": sources})
}

// aniSubsProvider 解析 source 参数并取数据源；失败时已写好响应，返回 nil。
func (s *Server) aniSubsProvider(w http.ResponseWriter, r *http.Request, sourceParam string) anisubs.Provider {
	trimmed := strings.TrimSpace(sourceParam)
	if trimmed == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return nil
	}
	provider := s.AniSubs.Get(r.Context(), trimmed)
	if provider == nil {
		httpx.Fail(w, http.StatusBadRequest, "未知的数据源")
		return nil
	}
	return provider
}

// handleAniSubsSearch 搜索番剧。
func (s *Server) handleAniSubsSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	provider := s.aniSubsProvider(w, r, query.Get("source"))
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
		log.Printf("[anisubs] search error: %v", err)
		httpx.Fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if results == nil {
		results = []anisubs.SearchResult{}
	}
	httpx.OK(w, map[string]any{"success": true, "results": results})
}

// handleAniSubsEpisodes 取分集列表。
func (s *Server) handleAniSubsEpisodes(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	provider := s.aniSubsProvider(w, r, query.Get("source"))
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
		log.Printf("[anisubs] episodes error: %v", err)
		httpx.Fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if episodes == nil {
		episodes = []anisubs.Episode{}
	}
	httpx.OK(w, map[string]any{"success": true, "episodes": episodes})
}

// anisubsResolveResponse 是解析成功的响应体。
type anisubsResolveResponse struct {
	Success bool              `json:"success"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Format  string            `json:"format,omitempty"`
}

// handleAniSubsResolve 解析播放地址。
func (s *Server) handleAniSubsResolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source  any             `json:"source"`
		Episode json.RawMessage `json:"episode"`
	}
	_ = httpx.DecodeJSON(r, &body)

	source, _ := body.Source.(string)
	provider := s.aniSubsProvider(w, r, source)
	if provider == nil {
		return
	}

	raw, ok := decodeEpisodeObject(body.Episode)
	if !ok {
		httpx.Fail(w, http.StatusBadRequest, "缺少 episode 参数")
		return
	}
	episode := normalizeAniSubsEpisode(raw)

	// 缓存键用「源 + 稳定序列化的播放参数」：同一集的不同标题不该重复解析。
	cacheKey := strings.TrimSpace(source) + "|" + stableJSON(episode.PlaybackParams)
	result, err := anisubsResolveCache.Run(cacheKey, func() (*anisubs.PlaybackURL, error) {
		resolved, err := provider.PlaybackURL(r.Context(), episode)
		if err != nil {
			return nil, err
		}
		if resolved == nil {
			return nil, errAnisubsUnresolvable
		}
		return resolved, nil
	})
	if err != nil {
		// 「解析不到地址」是 404（源认识这一集但没有可播地址），
		// 其余（上游抓取失败等）是 502。
		if errors.Is(err, errAnisubsUnresolvable) {
			httpx.Fail(w, http.StatusNotFound, "无法解析播放地址")
			return
		}
		log.Printf("[anisubs] resolve error: %v", err)
		httpx.Fail(w, http.StatusBadGateway, err.Error())
		return
	}

	httpx.OK(w, anisubsResolveResponse{
		Success: true,
		URL:     result.URL,
		Headers: result.Headers,
		Format:  result.Format,
	})
}

// errAnisubsUnresolvable 是「源返回空结果」的哨兵错误（映射成 404）。
var errAnisubsUnresolvable = errors.New("无法解析播放地址")

// decodeEpisodeObject 解析请求体里的 episode。
//
// `!episode || typeof episode !== 'object'` 在 JS 里放行数组（数组也是 object），
// 只是一路取不到字段。这里保持一致：数组当空对象处理。
func decodeEpisodeObject(raw json.RawMessage) (map[string]any, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	if object, ok := value.(map[string]any); ok {
		return object, true
	}
	if _, ok := value.([]any); ok {
		return map[string]any{}, true
	}
	return nil, false
}

// normalizeAniSubsEpisode 把前端传来的 episode 规整成内部结构。
func normalizeAniSubsEpisode(raw map[string]any) anisubs.Episode {
	id, title, episodeNumber, params := normalizeEpisodeFields(raw)
	return anisubs.Episode{
		ID:             id,
		Title:          title,
		EpisodeNumber:  episodeNumber,
		PlaybackParams: params,
	}
}

// stableJSON 生成稳定的参数指纹（Go 的 encoding/json 会按键名排序）。
func stableJSON(value map[string]any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "undefined"
	}
	return string(encoded)
}
