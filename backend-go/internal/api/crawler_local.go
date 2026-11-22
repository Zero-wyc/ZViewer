/**
 * 本机爬虫引擎（Go 实现）。
 *
 * 全网搜片的站点列表与搜索现在直接由后端进程内的 internal/crawler 完成，
 * 不再需要 127.0.0.1:3789 上的 Python 进程。规则仍存在 crawler/data/rules，
 * 与桌面端「爬虫引擎」管理页共用同一批文件。
 *
 * 装配细节在 internal/crawler/runtime.go（MCP stdio 入口也用同一套），
 * 这里只保留「进程级单例 + 目录探测 + 错误映射」。
 *
 * 回退：找不到爬虫根目录时 localCrawler() 返回 nil，调用方沿用原来的 3789 转发，
 * 这样老安装（只有 runtime/crawler/engine、没有 data）也不会突然搜不了。
 */
package api

import (
	"encoding/json"
	"net/http"
	"sync"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

var (
	crawlerMu       sync.Mutex
	crawlerResolved bool
	crawlerBundle   *crawler.Runtime
)

// localCrawlerBundle 是引擎单例的类型别名。
//
// 别名而不是新类型：管理接口里大量 bundle.Store / bundle.Browser 的写法保持原样，
// 结构体字段也不会因为两处各写一份而走偏。
type localCrawlerBundle = crawler.Runtime

// crawlerRoot 找爬虫根目录（其下有 data/rules 或 docs）。候选顺序见 crawler.ResolveRoot。
func crawlerRoot() string {
	return crawler.ResolveRoot()
}

// localBundle 返回进程内的引擎；没有可用规则目录时返回 nil。
//
// 单例是刻意的：规则目录、搜索日志、脚本运行时都是进程级资源，
// 每个请求重建会丢日志并反复初始化 goja。
func localBundle() *localCrawlerBundle {
	crawlerMu.Lock()
	defer crawlerMu.Unlock()
	if crawlerResolved {
		return crawlerBundle
	}
	crawlerResolved = true

	root := crawlerRoot()
	if root == "" {
		return nil
	}
	bundle, err := crawler.Boot(root)
	if err != nil {
		return nil
	}
	crawlerBundle = bundle
	return crawlerBundle
}

// localCrawler 返回进程内的搜索服务；没有可用规则目录时返回 nil。
func localCrawler() *crawler.SearchService {
	if bundle := localBundle(); bundle != nil {
		return bundle.Search
	}
	return nil
}

// localPlayResolver 返回进程内的播放解析器；没有可用规则目录时返回 nil。
func localPlayResolver() *crawler.PlayResolver {
	if bundle := localBundle(); bundle != nil {
		return bundle.Play
	}
	return nil
}

// localChallengeStore 返回进程内的验证会话表；没有可用规则目录时返回 nil。
func localChallengeStore() *crawler.ChallengeStore {
	if bundle := localBundle(); bundle != nil {
		return bundle.Challenges
	}
	return nil
}

// resetLocalCrawler 仅供测试：丢掉单例，下次调用重新探测目录。
func resetLocalCrawler() {
	crawlerMu.Lock()
	defer crawlerMu.Unlock()
	crawlerResolved = false
	crawlerBundle = nil
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
		httpx.InternalError(w, "crawler", err)
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
