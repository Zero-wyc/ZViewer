package anisubs

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"zviewer/backend/internal/webfetch"
)

// ===========================================================================
// 合并规则（纯函数）
// ===========================================================================

func TestNormalizeAggregateTitle(t *testing.T) {
	cases := map[string]string{
		"孤独摇滚！":            "孤独摇滚",
		" 孤独 摇滚 ":          "孤独摇滚",
		"【第2季】孤独摇滚":        "第2季孤独摇滚",
		"BOCCHI THE ROCK!": "bocchitherock",
	}
	for input, want := range cases {
		if got := normalizeAggregateTitle(input); got != want {
			t.Errorf("normalizeAggregateTitle(%q) = %q，期望 %q", input, got, want)
		}
	}
	// 标点全抹掉后可能撞车，这就是去重的本意
	if normalizeAggregateTitle("孤独摇滚！") != normalizeAggregateTitle("孤独摇滚") {
		t.Error("标题等价判定失败")
	}
}

func TestMergeAggregateDeduplicatesAcrossSources(t *testing.T) {
	sources := []aggregateSource{{ID: "a", Name: "A站"}, {ID: "b", Name: "B站"}}
	perSource := [][]SearchResult{
		{
			{ID: "https://a/1", Title: "孤独摇滚！", Source: "a"},
			{ID: "https://a/2", Title: "孤独摇滚 第2季", Source: "a"},
		},
		{
			{ID: "https://b/1", Title: "孤独摇滚", Source: "b"},
		},
	}

	merged := mergeAggregate(sources, perSource)
	if len(merged) != 2 {
		t.Fatalf("合并结果 = %+v，期望 2 条", merged)
	}
	// 先出现的胜出，来源是 A站
	if merged[0].Title != "孤独摇滚！" || merged[0].Source != "a" || merged[0].SourceName != "A站" {
		t.Errorf("第 1 条 = %+v", merged[0])
	}
	if len(merged[0].AltSources) != 1 || merged[0].AltSources[0] != "B站" {
		t.Errorf("同名其他站点 = %+v，期望 [B站]", merged[0].AltSources)
	}
	// 第 2 条只出现在 A站
	if merged[1].SourceName != "A站" || len(merged[1].AltSources) != 0 {
		t.Errorf("第 2 条 = %+v", merged[1])
	}
}

func TestMergeAggregateRoundRobin(t *testing.T) {
	// 逐站拼接会让 A站 把列表占满；轮转保证每个站点都能出现在前面。
	sources := []aggregateSource{{ID: "a", Name: "A站"}, {ID: "b", Name: "B站"}}
	perSource := [][]SearchResult{
		{{ID: "a1", Title: "A1", Source: "a"}, {ID: "a2", Title: "A2", Source: "a"}, {ID: "a3", Title: "A3", Source: "a"}},
		{{ID: "b1", Title: "B1", Source: "b"}},
	}
	merged := mergeAggregate(sources, perSource)
	got := make([]string, len(merged))
	for i, item := range merged {
		got[i] = item.Title
	}
	want := []string{"A1", "B1", "A2", "A3"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("顺序 = %v，期望 %v", got, want)
	}
}

func TestMergeAggregateSkipsUnusableRows(t *testing.T) {
	sources := []aggregateSource{{ID: "a", Name: "A站"}}
	perSource := [][]SearchResult{{
		{ID: "", Title: "没有 id", Source: "a"},
		{ID: "https://a/2", Title: "   ", Source: "a"},
		{ID: "https://a/3", Title: "正常", Source: ""},
	}}
	merged := mergeAggregate(sources, perSource)
	if len(merged) != 1 {
		t.Fatalf("结果 = %+v，期望只剩 1 条", merged)
	}
	// 源没给 source 时用站点 id 兜底，否则前端选集路由不到站点
	if merged[0].Source != "a" {
		t.Errorf("source = %q，期望 a", merged[0].Source)
	}
}

func TestMergeAggregateBackfillsCover(t *testing.T) {
	cover := "https://img.example.com/1.jpg"
	sources := []aggregateSource{{ID: "a", Name: "A站"}, {ID: "b", Name: "B站"}}
	perSource := [][]SearchResult{
		{{ID: "a1", Title: "孤独摇滚", Source: "a"}},
		{{ID: "b1", Title: "孤独摇滚!", Source: "b", Cover: &cover}},
	}
	merged := mergeAggregate(sources, perSource)
	if len(merged) != 1 {
		t.Fatalf("结果 = %+v", merged)
	}
	if merged[0].Cover == nil || *merged[0].Cover != cover {
		t.Errorf("封面未用后面那条补齐: %+v", merged[0].Cover)
	}
	// 同站点重复命中不该被记成「别的站点」
	dup := mergeAggregate(sources, [][]SearchResult{
		{{ID: "a1", Title: "孤独摇滚", Source: "a"}, {ID: "a2", Title: "孤独摇滚！", Source: "a"}},
	})
	if len(dup) != 1 || len(dup[0].AltSources) != 0 {
		t.Errorf("同站重复 = %+v", dup)
	}
}

func TestMergeAggregateEmpty(t *testing.T) {
	if got := mergeAggregate(nil, nil); len(got) != 0 {
		t.Errorf("空输入应返回空结果，得到 %+v", got)
	}
	if got := mergeAggregate([]aggregateSource{{ID: "a"}}, [][]SearchResult{nil, nil}); len(got) != 0 {
		t.Errorf("结果数不匹配时应返回空，得到 %+v", got)
	}
}

// ===========================================================================
// 聚合搜索（走假 transport，验证并发与失败语义）
// ===========================================================================

// countingTransport 记录每个 host 被打了多少次，用于验证单飞是否生效。
type countingTransport struct {
	routes  map[string]string
	mu      sync.Mutex
	perHost map[string]int
	delay   time.Duration
}

func (c *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	c.mu.Lock()
	c.perHost[req.URL.Host]++
	c.mu.Unlock()
	if c.delay > 0 {
		time.Sleep(c.delay)
	}
	body, ok := c.routes[req.URL.Host]
	if !ok {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader("not found")),
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Request:    req,
		}, nil
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Request:    req,
	}, nil
}

// aggregateSubscription 是三个 web-selector 源（a 正常、b 正常、dead 404）。
const aggregateSubscription = `{"exportedMediaSourceDataList":{"mediaSources":[
	{"factoryId":"web-selector","arguments":{"name":"A站","searchConfig":{"searchUrl":"https://a.example.com/search?wd={keyword}","subjectFormatId":"a","selectorSubjectFormatA":{"selectLists":"a.item"}}}},
	{"factoryId":"web-selector","arguments":{"name":"B站","searchConfig":{"searchUrl":"https://b.example.com/search?wd={keyword}","subjectFormatId":"a","selectorSubjectFormatA":{"selectLists":"a.item"}}}},
	{"factoryId":"web-selector","arguments":{"name":"死站","searchConfig":{"searchUrl":"https://dead.example.com/search?wd={keyword}","subjectFormatId":"a","selectorSubjectFormatA":{"selectLists":"a.item"}}}}
]}}`

const aggregateHtmlA = `<div>
	<a class="item" href="/subject/1">孤独摇滚！</a>
	<a class="item" href="/subject/2">孤独摇滚 第2季</a>
</div>`

const aggregateHtmlB = `<div>
	<a class="item" href="/subject/9">孤独摇滚</a>
</div>`

func newAggregateService(t *testing.T) *Service {
	t.Helper()
	restore := webfetch.SetTransport(&countingTransport{
		routes: map[string]string{
			"subs.example.com": aggregateSubscription,
			"a.example.com":    aggregateHtmlA,
			"b.example.com":    aggregateHtmlB,
		},
		perHost: map[string]int{},
	})
	t.Cleanup(restore)
	return NewService(newTestSettings(t, `{"aniSubsSubscriptions":["https://subs.example.com/sub.json"]}`))
}

func TestServiceSearchAll(t *testing.T) {
	service := newAggregateService(t)
	results, err := service.SearchAll(context.Background(), "孤独摇滚")
	if err != nil {
		t.Fatalf("聚合搜索失败: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("结果 = %+v，期望 2 条", results)
	}
	if results[0].Title != "孤独摇滚！" || results[0].SourceName != "A站" {
		t.Errorf("第 1 条 = %+v", results[0])
	}
	if len(results[0].AltSources) != 1 || results[0].AltSources[0] != "B站" {
		t.Errorf("同名其他站点 = %+v", results[0].AltSources)
	}
	// 选集要靠 source 回到真实站点
	if !strings.HasPrefix(results[0].Source, "ani_subs_web-selector_") {
		t.Errorf("source = %q", results[0].Source)
	}
	if !strings.HasSuffix(results[0].ID, "/subject/1") {
		t.Errorf("id = %q", results[0].ID)
	}
	// 死站 404 不该影响整体
	if len(results[1:]) != 1 || results[1].SourceName != "A站" {
		t.Errorf("第 2 条 = %+v", results[1])
	}
}

func TestServiceSearchAllAllFailed(t *testing.T) {
	// 只有一个源，且它 404 → 一条都没有时必须是错误，不能静默返回空列表
	subscription := `{"exportedMediaSourceDataList":{"mediaSources":[
		{"factoryId":"web-selector","arguments":{"name":"死站","searchConfig":{"searchUrl":"https://dead.example.com/search?wd={keyword}","subjectFormatId":"a","selectorSubjectFormatA":{"selectLists":"a.item"}}}}
	]}}`
	restore := webfetch.SetTransport(&countingTransport{
		routes:  map[string]string{"subs.example.com": subscription},
		perHost: map[string]int{},
	})
	t.Cleanup(restore)

	service := NewService(newTestSettings(t, `{"aniSubsSubscriptions":["https://subs.example.com/sub.json"]}`))
	results, err := service.SearchAll(context.Background(), "孤独摇滚")
	if err == nil {
		t.Fatalf("全部失败时应报错，得到 %+v", results)
	}
	if !strings.Contains(err.Error(), "所有数据源搜索失败") {
		t.Errorf("错误文案 = %q", err.Error())
	}
}

func TestServiceSearchAllEmptyKeyword(t *testing.T) {
	service := newAggregateService(t)
	results, err := service.SearchAll(context.Background(), "   ")
	if err != nil || len(results) != 0 {
		t.Fatalf("空关键词应直接返回空，得到 %+v / %v", results, err)
	}
}

func TestServiceSearchAllCoalescedSharesOneFetch(t *testing.T) {
	transport := &countingTransport{
		routes: map[string]string{
			"subs.example.com": aggregateSubscription,
			"a.example.com":    aggregateHtmlA,
			"b.example.com":    aggregateHtmlB,
		},
		perHost: map[string]int{},
		delay:   60 * time.Millisecond,
	}
	restore := webfetch.SetTransport(transport)
	t.Cleanup(restore)

	service := NewService(newTestSettings(t, `{"aniSubsSubscriptions":["https://subs.example.com/sub.json"]}`))

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := service.SearchAllCoalesced(context.Background(), "孤独摇滚"); err != nil {
				t.Errorf("并发搜索失败: %v", err)
			}
		}()
	}
	wg.Wait()

	transport.mu.Lock()
	hits := transport.perHost["a.example.com"]
	transport.mu.Unlock()
	if hits != 1 {
		t.Errorf("A站被抓了 %d 次，期望 1 次（并发搜索应共享同一次抓取）", hits)
	}
}
