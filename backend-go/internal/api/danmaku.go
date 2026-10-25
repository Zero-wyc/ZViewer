package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"zviewer/backend/internal/danmaku"
	"zviewer/backend/internal/danmaku/chinese"
	"zviewer/backend/internal/httpx"
)

// 多源弹幕路由，对应 routes/danmaku.ts（挂载在 /api/stream/danmaku）。
//
//	GET  /sources    列出弹幕源
//	GET  /search     搜索（简繁三路并行 + 去重 + 模糊优先排序）
//	GET  /episodes   取分集
//	POST /fetch      取弹幕

func (s *Server) registerDanmakuRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/danmaku/sources", s.Auth.Require(s.handleDanmakuSources))
	mux.HandleFunc("GET /api/stream/danmaku/search", s.Auth.Require(s.handleDanmakuSearch))
	mux.HandleFunc("GET /api/stream/danmaku/episodes", s.Auth.Require(s.handleDanmakuEpisodes))
	mux.HandleFunc("POST /api/stream/danmaku/fetch", s.Auth.Require(s.handleDanmakuFetch))
}

// handleDanmakuSources 列出弹幕源。
func (s *Server) handleDanmakuSources(w http.ResponseWriter, r *http.Request) {
	httpx.OK(w, map[string]any{"success": true, "sources": s.Danmaku.List()})
}

// danmakuProvider 校验 source 参数并取 provider；失败时已写好响应，返回 nil。
func (s *Server) danmakuProvider(w http.ResponseWriter, raw string) danmaku.Provider {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return nil
	}
	provider := s.Danmaku.Get(trimmed)
	if provider == nil {
		httpx.Fail(w, http.StatusBadRequest, "未知的弹幕源")
		return nil
	}
	return provider
}

// danmakuContext 组装 provider 上下文（只有 B站 用得上登录态）。
func (s *Server) danmakuContext(r *http.Request) danmaku.Context {
	return danmaku.Context{Cookie: s.requestCookie(r)}
}

// handleDanmakuSearch 搜索番剧/视频。
//
// 关键词会派生三个变体（原文 / 繁体 / 简体）并行搜索：巴哈姆特是繁体站，
// 简体关键词不转繁体根本搜不到；弹弹play 反过来对简体更友好。
// 合并时按「标题命中任一变体」优先排序，其余保持原序跟在后面。
func (s *Server) handleDanmakuSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
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
	provider := s.danmakuProvider(w, source)
	if provider == nil {
		return
	}

	keywords := keywordVariants(keyword)
	pc := s.danmakuContext(r)

	// 并行搜索，按原关键词顺序合并（等价于 Promise.allSettled 的结果序）。
	results := make([][]danmaku.SearchResult, len(keywords))
	failures := make([]error, len(keywords))
	var wg sync.WaitGroup
	for index, variant := range keywords {
		wg.Add(1)
		go func(slot int, text string) {
			defer wg.Done()
			found, err := provider.Search(r.Context(), text, pc)
			if err != nil {
				failures[slot] = err
				return
			}
			results[slot] = found
		}(index, variant)
	}
	wg.Wait()

	all := make([]danmaku.SearchResult, 0, 40)
	var firstError error
	for index := range keywords {
		if failures[index] != nil {
			if firstError == nil {
				firstError = failures[index]
			}
			continue
		}
		all = append(all, results[index]...)
	}
	if len(all) == 0 && firstError != nil {
		log.Printf("[danmaku] search error: %v", firstError)
		httpx.Fail(w, http.StatusBadGateway, firstError.Error())
		return
	}

	// 按 id（没有 id 就按标题）去重。
	seen := make(map[string]bool, len(all))
	deduped := make([]danmaku.SearchResult, 0, len(all))
	for _, item := range all {
		key := item.ID
		if key == "" {
			key = item.Title
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		deduped = append(deduped, item)
	}

	lowered := make([]string, 0, len(keywords))
	for _, variant := range keywords {
		lowered = append(lowered, strings.ToLower(variant))
	}
	matched := make([]danmaku.SearchResult, 0, len(deduped))
	others := make([]danmaku.SearchResult, 0, len(deduped))
	for _, item := range deduped {
		title := strings.ToLower(item.Title)
		hit := false
		for _, variant := range lowered {
			if strings.Contains(title, variant) {
				hit = true
				break
			}
		}
		if hit {
			matched = append(matched, item)
		} else {
			others = append(others, item)
		}
	}

	httpx.OK(w, map[string]any{"success": true, "results": append(matched, others...)})
}

// keywordVariants 生成去重后的关键词变体（原文 + 繁体 + 简体）。
func keywordVariants(keyword string) []string {
	variants := make([]string, 0, 3)
	seen := make(map[string]bool, 3)
	for _, candidate := range []string{keyword, chinese.ToTraditional(keyword), chinese.ToSimplified(keyword)} {
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		variants = append(variants, candidate)
	}
	return variants
}

// handleDanmakuEpisodes 取分集列表。
func (s *Server) handleDanmakuEpisodes(w http.ResponseWriter, r *http.Request) {
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
	provider := s.danmakuProvider(w, source)
	if provider == nil {
		return
	}

	episodes, err := provider.Episodes(r.Context(), identifier, s.danmakuContext(r))
	if err != nil {
		log.Printf("[danmaku] episodes error: %v", err)
		httpx.Fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if episodes == nil {
		episodes = []danmaku.Episode{}
	}
	httpx.OK(w, map[string]any{"success": true, "episodes": episodes})
}

// handleDanmakuFetch 取某一集的弹幕。
func (s *Server) handleDanmakuFetch(w http.ResponseWriter, r *http.Request) {
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
	provider := s.danmakuProvider(w, source)
	if provider == nil {
		return
	}

	id, title, episodeNumber, params := normalizeEpisodeFields(rawEpisode)
	items, err := provider.Danmaku(r.Context(), danmaku.Episode{
		ID:             id,
		Title:          title,
		EpisodeNumber:  episodeNumber,
		PlaybackParams: params,
	}, s.danmakuContext(r))
	if err != nil {
		log.Printf("[danmaku] fetch error: %v", err)
		httpx.Fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if items == nil {
		items = []danmaku.Item{}
	}
	httpx.OK(w, map[string]any{"success": true, "danmaku": items})
}
