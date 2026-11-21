package crawler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func ruleForServer(serverURL, container string) *Rule {
	return &Rule{
		Name:    "本地站",
		Site:    hostOfServer(serverURL),
		Enabled: true,
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{Method: "GET", URL: serverURL + "/search?q={keyword}"},
		},
		Parse: Parse{
			Type:      "html",
			Container: container,
			Fields: map[string]Field{
				"title": {Selector: ".title"},
				"url":   {Selector: ".title", Attr: "href"},
				"cover": {Selector: "img.cover", Attr: "src"},
			},
		},
	}
}

func hostOfServer(serverURL string) string {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return "127.0.0.1"
	}
	return parsed.Host
}

func TestSearchHTTP(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Query().Get("q"), "流浪地球") {
			t.Errorf("keyword not substituted: %q", r.URL.Query().Get("q"))
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(sampleHTML))
	}))
	defer shutdown()
	if _, err := store.Save(ruleForServer(wrapper.baseURL, ".result-item"), ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	result, err := wrapper.service.Search("本地站", "流浪地球", "", "guest", 0, nil, true)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if result["count"].(int) != 2 {
		t.Fatalf("count = %v", result["count"])
	}
	items := result["items"].([]map[string]any)
	if items[0]["title"] != "流浪地球 4K 高清" {
		t.Errorf("title = %v", items[0]["title"])
	}
	if result["mode"] != "http" {
		t.Errorf("mode = %v", result["mode"])
	}
}

// testService 把 httptest server 与 service 绑在一起，省去反推 baseURL。
type testService struct {
	service *SearchService
	store   *RuleStore
	baseURL string
}

func newTestServiceWithURL(t *testing.T, handler http.Handler) (*testService, *RuleStore, func()) {
	t.Helper()
	server := httptest.NewServer(handler)
	store, err := NewRuleStore(t.TempDir())
	if err != nil {
		server.Close()
		t.Fatalf("store: %v", err)
	}
	return &testService{
		service: NewSearchService(SearchOptions{
			Store:   store,
			Fetcher: NewFetcher(FetcherOptions{Retries: 0, Timeout: 5 * time.Second}),
		}),
		store:   store,
		baseURL: server.URL,
	}, store, server.Close
}

func TestSearchEmptyResultWarns(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body><div class="none">空</div></body></html>`))
	}))
	defer shutdown()
	if _, err := store.Save(ruleForServer(wrapper.baseURL, ".result-item"), ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	result, err := wrapper.service.Search("本地站", "x", "", "guest", 0, nil, true)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if result["count"].(int) != 0 {
		t.Fatalf("count = %v", result["count"])
	}
	warnings := result["warnings"].([]string)
	joined := strings.Join(warnings, "|")
	if !strings.Contains(joined, "未解析到结果") {
		t.Errorf("warnings = %s", joined)
	}
}

func TestSearchChallengeDetected(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`<html><head><title>安全验证</title></head><body><div id="captcha">请完成验证</div></body></html>`))
	}))
	defer shutdown()
	rule := ruleForServer(wrapper.baseURL, ".result-item")
	rule.Challenge = Challenge{Enabled: true, Statuses: []int{403}}
	if _, err := store.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	_, err := wrapper.service.Search("本地站", "x", "", "guest", 0, nil, true)
	if err == nil {
		t.Fatal("want challenge error, got nil")
	}
	if code := ErrorCode(err); code != "challenge_required" {
		t.Fatalf("code = %s, message = %s", code, err.Error())
	}
	if !strings.Contains(err.Error(), "安全验证") && !strings.Contains(err.Error(), "status:403") {
		t.Errorf("message = %s", err.Error())
	}
}

func TestSearchVisibilityForbidden(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleHTML))
	}))
	defer shutdown()
	rule := ruleForServer(wrapper.baseURL, ".result-item")
	rule.Visibility = "root"
	if _, err := store.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	_, err := wrapper.service.Search("本地站", "x", "", "guest", 0, nil, true)
	if err == nil || ErrorCode(err) != "site_forbidden" {
		t.Fatalf("want site_forbidden, got %v", err)
	}
	if _, err := wrapper.service.Search("本地站", "x", "", "root", 0, nil, true); err != nil {
		t.Fatalf("root should pass: %v", err)
	}
}

func TestSearchResolveRuleForms(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleHTML))
	}))
	defer shutdown()
	rule := ruleForServer(wrapper.baseURL, ".result-item")
	rule.Name = "按名字找"
	saved, err := store.Save(rule, "")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	// 三种解析方式都应命中：id、域名、名称。
	for _, key := range []string{saved.ID, hostOfServer(wrapper.baseURL), "按名字找"} {
		found, err := wrapper.service.ResolveRule(key)
		if err != nil {
			t.Errorf("resolve %q: %v", key, err)
			continue
		}
		if found.ID != saved.ID {
			t.Errorf("resolve %q -> %s", key, found.ID)
		}
	}
	if _, err := wrapper.service.ResolveRule(""); err == nil || ErrorCode(err) != "site_required" {
		t.Errorf("empty site should fail with site_required, got %v", err)
	}
	if _, err := wrapper.service.ResolveRule("不存在.com"); err == nil || ErrorCode(err) != "site_not_found" {
		t.Errorf("unknown site should fail with site_not_found, got %v", err)
	}
}

func TestSearchRecordsStats(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleHTML))
	}))
	defer shutdown()
	saved, err := store.Save(ruleForServer(wrapper.baseURL, ".result-item"), "")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := wrapper.service.Search("本地站", "x", "", "guest", 0, nil, true); err != nil {
		t.Fatalf("search: %v", err)
	}
	reloaded, err := store.Get(saved.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if reloaded.Stats.Searches != 1 || reloaded.Stats.Successes != 1 {
		t.Errorf("stats = %+v", reloaded.Stats)
	}
}

func TestSearchLogStore(t *testing.T) {
	// 容量下限是 10（与 Python 的 max(10, limit) 一致）。
	log, err := NewSearchLogStore(t.TempDir()+"/search-log.json", 3)
	if err != nil {
		t.Fatalf("new log: %v", err)
	}
	for index := 0; index < 12; index++ {
		log.Append(map[string]any{"site": "a.com", "ok": index%2 == 0, "source": "search", "count": index})
	}
	if log.Count() != 10 {
		t.Fatalf("count = %d", log.Count())
	}
	entries := log.List(10, "", false, "")
	if len(entries) != 10 {
		t.Fatalf("list = %d", len(entries))
	}
	// 最新的在最前。
	if entries[0]["count"] != 11 {
		t.Errorf("newest first failed: %v", entries[0]["count"])
	}
	// 失败筛选：ok=false 的只有 count=3（index 3 是奇数）→ 以及被截掉的条目。
	failures := log.List(10, "", true, "")
	if len(failures) == 0 {
		t.Error("expected failures")
	}
	for _, entry := range failures {
		if boolValue(entry["ok"]) {
			t.Errorf("failures filter leaked ok entry: %v", entry)
		}
	}
	if cleared := log.Clear(); cleared != 10 {
		t.Errorf("cleared = %d", cleared)
	}
	if log.Count() != 0 {
		t.Errorf("count after clear = %d", log.Count())
	}
}

func TestCleanItemsFromScript(t *testing.T) {
	rule := &Rule{Parse: Parse{Limit: 2, DedupeBy: "url"}}
	raw := []any{
		map[string]any{"title": "A", "url": "u1", "extra": map[string]any{"k": "v"}},
		map[string]any{"title": "A", "url": "u1"},
		map[string]any{"title": "B"},
		"not an object",
		map[string]any{"title": "C", "url": "u2"},
		map[string]any{"title": "D", "url": "u3"},
	}
	items, skipped, err := cleanItems(raw, rule)
	if err != nil {
		t.Fatalf("clean: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("limit not applied: %d", len(items))
	}
	if skipped != 2 {
		t.Errorf("skipped = %d", skipped)
	}
	if _, ok := items[0]["extra"].(map[string]any); !ok {
		t.Errorf("extra lost: %+v", items[0])
	}
}

func TestTestRuleReportsFailure(t *testing.T) {
	wrapper, _, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleHTML))
	}))
	defer shutdown()
	bad := ruleForServer(wrapper.baseURL, ".result-item")
	bad.Search.Request.URL = "" // 校验阶段就该拒绝
	result := wrapper.service.TestRule(bad, "x", 0)
	if result["ok"].(bool) {
		t.Fatalf("expected failure: %+v", result)
	}
	if result["code"] != "rule_error" {
		t.Errorf("code = %v", result["code"])
	}
}
