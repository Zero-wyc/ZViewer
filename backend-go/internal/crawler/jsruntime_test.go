package crawler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newRunner() JSRunner {
	return NewJSRunner(NewFetcher(FetcherOptions{Timeout: 5 * time.Second, Retries: 0}))
}

func runScript(t *testing.T, source string, payload map[string]any, timeoutSec float64) map[string]any {
	t.Helper()
	outcome, err := newRunner().Run(source, payload, timeoutSec)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return outcome
}

func TestJSRunnerReturnsObject(t *testing.T) {
	outcome := runScript(t, `return { title: "流浪地球", list: [1,2,3].map(n => n * 2) };`, nil, 5)
	if !boolValue(outcome["ok"]) {
		t.Fatalf("failed: %v", outcome["error"])
	}
	result, ok := outcome["result"].(map[string]any)
	if !ok {
		t.Fatalf("result type %T", outcome["result"])
	}
	if result["title"] != "流浪地球" {
		t.Errorf("title = %v", result["title"])
	}
}

func TestJSRunnerSyntaxError(t *testing.T) {
	outcome := runScript(t, `return {;`, nil, 5)
	if boolValue(outcome["ok"]) {
		t.Fatal("syntax error should fail")
	}
	message, _ := outcome["error"].(string)
	if message == "" {
		t.Error("error message missing")
	}
}

func TestJSRunnerRuntimeError(t *testing.T) {
	outcome := runScript(t, `throw new Error("boom");`, nil, 5)
	if boolValue(outcome["ok"]) {
		t.Fatal("throw should fail")
	}
	if !strings.Contains(stringOr(outcome["error"]), "boom") {
		t.Errorf("error = %v", outcome["error"])
	}
}

func TestJSRunnerConsole(t *testing.T) {
	outcome := runScript(t, `console.log("a", 1, {b:2}); console.error("bad"); return {ok:1};`, nil, 5)
	logs, ok := outcome["logs"].([]string)
	if !ok || len(logs) != 2 {
		t.Fatalf("logs = %#v", outcome["logs"])
	}
	if logs[0] != `a 1 {"b":2}` {
		t.Errorf("first log = %q", logs[0])
	}
	if logs[1] != "bad" {
		t.Errorf("second log = %q", logs[1])
	}
}

func TestJSRunnerPayloadShape(t *testing.T) {
	payload := map[string]any{
		"keyword": "流浪地球",
		"site":    "example.com",
		"rule":    map[string]any{"name": "示例站", "site": "example.com"},
	}
	outcome := runScript(t, `return {
		flat: keyword,
		inputKw: input.keyword,
		ctxSite: ctx.site,
		ruleName: rule.name,
	};`, payload, 5)
	if !boolValue(outcome["ok"]) {
		t.Fatalf("failed: %v", outcome["error"])
	}
	result := outcome["result"].(map[string]any)
	for key, want := range map[string]string{
		"flat":     "流浪地球",
		"inputKw":  "流浪地球",
		"ctxSite":  "example.com",
		"ruleName": "示例站",
	} {
		if result[key] != want {
			t.Errorf("%s = %v, want %s", key, result[key], want)
		}
	}
}

func TestJSRunnerFetchJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Referer") != "https://example.com/" {
			t.Errorf("header not forwarded: %q", r.Header.Get("Referer"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"list":[{"t":"a"},{"t":"b"}]}}`))
	}))
	defer server.Close()

	outcome := runScript(t, `
		const res = await fetch("`+server.URL+`", { headers: { Referer: "https://example.com/" } });
		const body = await res.json();
		return { status: res.status, ok: res.ok, count: body.data.list.length, first: body.data.list[0].t };
	`, nil, 5)
	if !boolValue(outcome["ok"]) {
		t.Fatalf("failed: %v", outcome["error"])
	}
	result := outcome["result"].(map[string]any)
	if toFloat(result["status"]) != 200 || !boolValue(result["ok"]) {
		t.Errorf("status = %v ok = %v", result["status"], result["ok"])
	}
	if toFloat(result["count"]) != 2 || result["first"] != "a" {
		t.Errorf("body = %+v", result)
	}
}

func TestJSRunnerFetchText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("hello"))
	}))
	defer server.Close()
	outcome := runScript(t, `
		const res = await fetch("`+server.URL+`");
		return { text: await res.text(), header: res.headers.get("content-type") };
	`, nil, 5)
	if !boolValue(outcome["ok"]) {
		t.Fatalf("failed: %v", outcome["error"])
	}
	result := outcome["result"].(map[string]any)
	if result["text"] != "hello" {
		t.Errorf("text = %v", result["text"])
	}
}

func TestJSRunnerURL(t *testing.T) {
	outcome := runScript(t, `
		const u = new URL("https://example.com/a/b?x=1&y=2#top");
		const rel = new URL("../c", "https://example.com/a/b");
		const params = new URLSearchParams("q=%E6%B5%81&page=2");
		params.append("extra", "1");
		return {
			host: u.host,
			path: u.pathname,
			search: u.search,
			q: u.searchParams.get("x"),
			relPath: rel.pathname,
			encoded: params.toString(),
			hasQ: params.has("q"),
		};
	`, nil, 5)
	if !boolValue(outcome["ok"]) {
		t.Fatalf("failed: %v", outcome["error"])
	}
	result := outcome["result"].(map[string]any)
	if result["host"] != "example.com" || result["path"] != "/a/b" {
		t.Errorf("url = %+v", result)
	}
	if result["search"] != "?x=1&y=2" || result["q"] != "1" {
		t.Errorf("search = %v q = %v", result["search"], result["q"])
	}
	if result["relPath"] != "/c" {
		t.Errorf("relative resolve = %v", result["relPath"])
	}
	if result["encoded"] != "extra=1&page=2&q=%E6%B5%81" {
		t.Errorf("params = %v", result["encoded"])
	}
	if !boolValue(result["hasQ"]) {
		t.Errorf("has() = %v", result["hasQ"])
	}
}

func TestJSRunnerBase64(t *testing.T) {
	outcome := runScript(t, `return { enc: btoa("hi"), dec: atob("aGk=") };`, nil, 5)
	if !boolValue(outcome["ok"]) {
		t.Fatalf("failed: %v", outcome["error"])
	}
	result := outcome["result"].(map[string]any)
	if result["enc"] != "aGk=" || result["dec"] != "hi" {
		t.Errorf("base64 = %+v", result)
	}
}

func TestJSRunnerSetTimeout(t *testing.T) {
	outcome := runScript(t, `
		const value = await new Promise((resolve) => {
			setTimeout(() => resolve("later"), 10);
		});
		return { value };
	`, nil, 5)
	if !boolValue(outcome["ok"]) {
		t.Fatalf("failed: %v", outcome["error"])
	}
	if outcome["result"].(map[string]any)["value"] != "later" {
		t.Errorf("timer result = %+v", outcome["result"])
	}
}

func TestJSRunnerTimeout(t *testing.T) {
	started := time.Now()
	outcome := runScript(t, `while (true) {}`, nil, 0.15)
	if boolValue(outcome["ok"]) {
		t.Fatal("infinite loop should time out")
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Errorf("timeout took too long: %s", elapsed)
	}
	if !strings.Contains(stringOr(outcome["error"]), "超时") {
		t.Errorf("error = %v", outcome["error"])
	}
}

func TestJSRunnerEmptySource(t *testing.T) {
	outcome, err := newRunner().Run("   ", nil, 5)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if boolValue(outcome["ok"]) {
		t.Error("empty script should fail")
	}
}

// 脚本规则的端到端：search.mode=script 直接给 items。
func TestSearchWithScriptMode(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("script mode should not fetch")
	}))
	defer shutdown()
	wrapper.service.SetJSRuntime(newRunner())
	rule := &Rule{
		Name:    "脚本站",
		Site:    "script.example.com",
		Enabled: true,
		Search: Search{
			Mode: "script",
			Script: Script{
				Runtime: "node",
				Source:  `return { items: [{ title: input.keyword + "-1", url: "https://script.example.com/1" }] };`,
			},
		},
		// 与 Python 一致：parse 段即使不参与（script 直接给 items）也要能过校验。
		Parse: Parse{Type: "html", Container: ".x", Fields: map[string]Field{
			"title": {Selector: ".t"}, "url": {Selector: "a"},
		}},
	}
	if _, err := store.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	result, err := wrapper.service.Search("脚本站", "流浪地球", "", "guest", 0, nil, true)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if result["count"].(int) != 1 {
		t.Fatalf("count = %v", result["count"])
	}
	item := result["items"].([]map[string]any)[0]
	if item["title"] != "流浪地球-1" {
		t.Errorf("title = %v", item["title"])
	}
	if result["mode"] != "script" {
		t.Errorf("mode = %v", result["mode"])
	}
}

// parse.type=script：抓 HTML 后交给脚本解析。
func TestSearchWithScriptParse(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleHTML))
	}))
	defer shutdown()
	wrapper.service.SetJSRuntime(newRunner())
	rule := ruleForServer(wrapper.baseURL, ".result-item")
	rule.Parse = Parse{
		Type: "script",
		Script: Script{
			Runtime: "node",
			Source: `const titles = [...html.matchAll(/class="title"[^>]*>([^<]+)</g)].map(m => m[1]);
				return { items: titles.map((t, i) => ({ title: t, url: "https://x/" + i })) };`,
		},
	}
	if _, err := store.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	result, err := wrapper.service.Search("本地站", "x", "", "guest", 0, nil, true)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	// sampleHTML 里有 4 个 .title（含「重复条目」「缺链接」），清洗后全保留。
	if result["count"].(int) != 4 {
		t.Fatalf("count = %v (items=%+v)", result["count"], result["items"])
	}
}
