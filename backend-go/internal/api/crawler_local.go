/**
 * 本机爬虫引擎（Go 实现）。
 *
 * 全网搜片的站点列表与搜索现在直接由后端进程内的 internal/crawler 完成，
 * 不再需要 127.0.0.1:3789 上的 Python 进程。规则仍存在 crawler/data/rules，
 * 与桌面端「爬虫引擎」管理页（Python/后续 Go 版）共用同一批文件。
 *
 * 回退：找不到爬虫根目录时 localCrawler() 返回 nil，调用方沿用原来的 3789 转发，
 * 这样老安装（只有 runtime/crawler/engine、没有 data）也不会突然搜不了。
 */
package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

var (
	crawlerMu       sync.Mutex
	crawlerResolved bool
	crawlerService  *crawler.SearchService
)

// crawlerRoot 找爬虫根目录（其下有 data/rules）。
//
// 优先级：CRAWLER_ROOT → ZVIEWER_CRAWLER_ROOT（桌面壳注入）→ exe 同级
// crawler/ 或 runtime/crawler/ → 工作目录 crawler/。都没有则返回空。
func crawlerRoot() string {
	for _, name := range []string{"CRAWLER_ROOT", "ZVIEWER_CRAWLER_ROOT"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	candidates := make([]string, 0, 4)
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "crawler"),
			filepath.Join(dir, "runtime", "crawler"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "crawler"),
			filepath.Join(wd, "..", "crawler"),
		)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

// localCrawler 返回进程内的搜索服务；没有可用规则目录时返回 nil。
//
// 单例是刻意的：规则目录、搜索日志、脚本运行时都是进程级资源，
// 每个请求重建会丢日志并反复初始化 goja。
func localCrawler() *crawler.SearchService {
	crawlerMu.Lock()
	defer crawlerMu.Unlock()
	if crawlerResolved {
		return crawlerService
	}
	crawlerResolved = true

	root := crawlerRoot()
	if root == "" {
		return nil
	}
	store, err := crawler.NewRuleStore(filepath.Join(root, "data", "rules"))
	if err != nil {
		return nil
	}
	fetcher := crawler.NewFetcher(crawler.FetcherOptions{
		Timeout: 25 * time.Second,
		Retries: 1,
	})
	logStore, _ := crawler.NewSearchLogStore(
		filepath.Join(root, "data", "search-log.json"),
		crawler.DefaultSearchLogLimit,
	)
	service := crawler.NewSearchService(crawler.SearchOptions{
		Store:   store,
		Fetcher: fetcher,
		Log:     logStore,
	})
	service.SetJSRuntime(crawler.NewJSRunner(fetcher))
	crawlerService = service
	return service
}

// resetLocalCrawler 仅供测试：丢掉单例，下次调用重新探测目录。
func resetLocalCrawler() {
	crawlerMu.Lock()
	defer crawlerMu.Unlock()
	crawlerResolved = false
	crawlerService = nil
}

// crawlerErrorStatus 把引擎错误码映射成 HTTP 状态。
//
// challenge_required 用 409（与 Python 引擎一致），前端据此弹验证窗；
// 参数/规则类错误是 400，上游抓取失败是 502，其余 500。
func crawlerErrorStatus(code string) int {
	switch code {
	case "challenge_required":
		return 409
	case "site_required", "keyword_required", "site_not_found", "site_forbidden", "rule_error":
		return 400
	case "fetch_error":
		return 502
	case "llm_error", "config_error":
		return 500
	default:
		return 500
	}
}

// writeCrawlerError 把引擎错误写成前端认识的形状。
//
// challenge_required 必须原样带 details（challengeId / proxyUrl 在 details 里），
// 前端靠它渲染验证 iframe；其它错误走 message 兜底即可。
func writeCrawlerError(w http.ResponseWriter, err error) {
	engineErr, ok := err.(*crawler.EngineError)
	if !ok {
		httpx.InternalError(w, "POST /api/crawler/search", err)
		return
	}
	if engineErr.Code == "challenge_required" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(engineErr.ToMap())
		return
	}
	httpx.Fail(w, crawlerErrorStatus(engineErr.Code), engineErr.Message)
}
