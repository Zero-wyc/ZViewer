package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/kazumi"
	"zviewer/backend/internal/ttlcache"
)

// Kazumi 独立路由，对应 routes/kazumi.ts（挂载在 /api/stream/kazumi）。
//
//	GET  /sources    列出数据源
//	GET  /search     搜索
//	GET  /episodes   取分集
//	POST /resolve    解析播放地址（6 分钟缓存 + 单飞）
//
// /proxy 在 proxy.go 里与另外三个数据源共用同一实现。

// kazumiResolveTTLMs 是解析结果缓存时长（6 分钟，对齐 /cms/resolve）。
const kazumiResolveTTLMs = 6 * 60 * 1000

// kazumiResolveCacheSize 是解析缓存容量上限。
const kazumiResolveCacheSize = 500

// kazumiResolveCache 是 /resolve 的结果缓存。
var kazumiResolveCache = ttlcache.New[*kazumi.PlaybackURL](kazumiResolveTTLMs, kazumiResolveCacheSize)

func (s *Server) registerKazumiRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/kazumi/sources", s.Auth.Require(s.handleKazumiSources))
	mux.HandleFunc("GET /api/stream/kazumi/search", s.Auth.Require(s.handleKazumiSearch))
	mux.HandleFunc("GET /api/stream/kazumi/episodes", s.Auth.Require(s.handleKazumiEpisodes))
	mux.HandleFunc("POST /api/stream/kazumi/resolve", s.Auth.Require(s.handleKazumiResolve))
}

// handleKazumiSources 列出可用数据源。
//
// 这里失败是 500（不是 502）：规则构建失败属于「本机配置/网络」问题，
// Node 侧同样是 500。
func (s *Server) handleKazumiSources(w http.ResponseWriter, r *http.Request) {
	sources, err := s.Kazumi.List(r.Context())
	if err != nil {
		log.Printf("[kazumi] list sources error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	log.Printf("[kazumi] /sources returned %d sources", len(sources))
	httpx.OK(w, map[string]any{"success": true, "sources": sources})
}

// kazumiProvider 校验 source 参数并取数据源；失败时已写好响应，返回 nil。
func (s *Server) kazumiProvider(w http.ResponseWriter, r *http.Request, raw string) kazumi.Provider {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return nil
	}
	provider, err := s.Kazumi.Get(r.Context(), trimmed)
	if err != nil {
		log.Printf("[kazumi] load rules error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return nil
	}
	if provider == nil {
		httpx.Fail(w, http.StatusBadRequest, "未知的数据源")
		return nil
	}
	return provider
}

// handleKazumiSearch 搜索番剧。
func (s *Server) handleKazumiSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	// 校验顺序与 Node 一致：source → keyword → provider。
	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return
	}
	keyword := strings.TrimSpace(query.Get("keyword"))
	if keyword == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 keyword 参数")
		return
	}
	provider := s.kazumiProvider(w, r, source)
	if provider == nil {
		return
	}

	results, err := provider.Search(r.Context(), keyword)
	if err != nil {
		log.Printf("[kazumi] search error: %v", err)
		httpx.Fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if results == nil {
		results = []kazumi.SearchResult{}
	}
	httpx.OK(w, map[string]any{"success": true, "results": results})
}

// handleKazumiEpisodes 取分集列表。
func (s *Server) handleKazumiEpisodes(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return
	}
	identifier := strings.TrimSpace(query.Get("identifier"))
	if identifier == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 identifier 参数")
		return
	}
	provider := s.kazumiProvider(w, r, source)
	if provider == nil {
		return
	}

	episodes, err := provider.Episodes(r.Context(), identifier)
	if err != nil {
		log.Printf("[kazumi] episodes error: %v", err)
		httpx.Fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if episodes == nil {
		episodes = []kazumi.Episode{}
	}
	httpx.OK(w, map[string]any{"success": true, "episodes": episodes})
}

// errKazumiUnresolvable 是「源认识这一集但没有可播地址」的哨兵错误（映射成 404）。
var errKazumiUnresolvable = errors.New("无法解析播放地址")

// handleKazumiResolve 解析播放地址。
func (s *Server) handleKazumiResolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source  any             `json:"source"`
		Episode json.RawMessage `json:"episode"`
	}
	_ = httpx.DecodeJSON(r, &body)

	source, _ := body.Source.(string)
	if strings.TrimSpace(source) == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return
	}
	rawEpisode, ok := decodeEpisodeObject(body.Episode)
	if !ok {
		httpx.Fail(w, http.StatusBadRequest, "缺少 episode 参数")
		return
	}
	provider := s.kazumiProvider(w, r, source)
	if provider == nil {
		return
	}

	id, title, episodeNumber, params := normalizeEpisodeFields(rawEpisode)
	episode := kazumi.Episode{
		ID:             id,
		Title:          title,
		EpisodeNumber:  episodeNumber,
		PlaybackParams: params,
	}

	// 缓存键 = 源 + 稳定序列化的播放参数：同一集换标题不该重新解析。
	cacheKey := strings.TrimSpace(source) + "|" + stableJSON(episode.PlaybackParams)
	result, err := kazumiResolveCache.Run(cacheKey, func() (*kazumi.PlaybackURL, error) {
		resolved, err := provider.PlaybackURL(r.Context(), episode)
		if err != nil {
			return nil, err
		}
		if resolved == nil {
			return nil, errKazumiUnresolvable
		}
		return resolved, nil
	})
	if err != nil {
		if errors.Is(err, errKazumiUnresolvable) {
			httpx.Fail(w, http.StatusNotFound, "无法解析播放地址")
			return
		}
		log.Printf("[kazumi] resolve error: %v", err)
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
