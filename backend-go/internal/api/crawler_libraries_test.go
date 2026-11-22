package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 地址清洗是「一键改配置」最容易出事的地方：一个空行或重复地址就会让
// services 反复拉同一份规则。这里把规则钉死。
func TestNormalizeCrawlerLibraryURLs(t *testing.T) {
	got, err := normalizeCrawlerLibraryURLs([]string{
		"  https://a.example/rules.json  ",
		"",
		"https://a.example/rules.json",
		"https://b.example/index.json",
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	want := []string{"https://a.example/rules.json", "https://b.example/index.json"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}

	if _, err := normalizeCrawlerLibraryURLs([]string{"ftp://a.example/rules.json"}); err == nil {
		t.Fatal("非 http(s) 地址必须报错")
	}
	if _, err := normalizeCrawlerLibraryURLs([]string{"https://" + strings.Repeat("a", 600)}); err == nil {
		t.Fatal("超长地址必须报错")
	}
	many := make([]string, 31)
	for index := range many {
		many[index] = "https://a.example/rules.json"
	}
	if _, err := normalizeCrawlerLibraryURLs(many); err == nil {
		t.Fatal("超过 30 条必须报错")
	}
}

// 三个内置库都必须有配置键，且键名与服务自己解析的 json tag 一致。
func TestCrawlerLibraryConfigKeys(t *testing.T) {
	cases := map[string]string{
		crawlerLibraryAniSubs: "aniSubsSubscriptions",
		crawlerLibraryKazumi:  "kazumiRules",
		crawlerLibraryCMS:     "cmsSources",
	}
	for library, want := range cases {
		if got := crawlerLibraryConfigKeys[library]; got != want {
			t.Errorf("%s config key = %q, want %q", library, got, want)
		}
	}
	// local 由「站点规则」管理，不该出现在可写配置里。
	if _, ok := crawlerLibraryConfigKeys[crawlerLibraryLocal]; ok {
		t.Fatal("本地规则不应有 dataSourceConfig 键")
	}
}

// 未知库的配置读写必须在碰 Settings 之前就拒绝（&Server{} 没有 Settings，
// 一旦走到后面会 panic，正好用来证明短路位置）。
func TestCrawlerLibraryConfigRejectsUnknown(t *testing.T) {
	server := &Server{}
	cases := []struct {
		name    string
		handler http.HandlerFunc
		method  string
		body    any
	}{
		{"get", server.handleCrawlerLibraryConfigGet, http.MethodGet, nil},
		{"put", server.handleCrawlerLibraryConfigPut, http.MethodPut, map[string]any{"urls": []string{}}},
	}
	for _, item := range cases {
		request := httptest.NewRequest(item.method, "/api/crawler/libraries/nope/config", nil)
		request.SetPathValue("id", "nope")
		recorder := httptest.NewRecorder()
		item.handler(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: code = %d", item.name, recorder.Code)
		}
		if !strings.Contains(recorder.Body.String(), "没有可配置项") {
			t.Fatalf("%s: body = %s", item.name, recorder.Body.String())
		}
	}
}

// 非法地址必须在写库之前被拦下。
func TestCrawlerLibraryConfigRejectsBadURLs(t *testing.T) {
	server := &Server{}
	request := httptest.NewRequest(http.MethodPut, "/api/crawler/libraries/kazumi/config", strings.NewReader(`{"urls":["not-a-url"]}`))
	request.SetPathValue("id", crawlerLibraryKazumi)
	recorder := httptest.NewRecorder()
	server.handleCrawlerLibraryConfigPut(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("code = %d body = %s", recorder.Code, recorder.Body.String())
	}
}

// 统一搜索只认四个库名，其它一律报错（不静默回落到本地规则，
// 否则界面写错一个字母就会以为搜的是内置库）。
func TestCrawlerLibrarySearchRejectsUnknown(t *testing.T) {
	server := &Server{}
	if _, err := server.crawlerLibrarySearch(context.Background(), "tvbox", "关键词", 10); err == nil {
		t.Fatal("未知库必须报错")
	}
}

// limit 语义：<=0 不截断；nil 也要序列化成空数组而不是 null。
func TestCrawlerLimitItems(t *testing.T) {
	items := []map[string]any{{"id": "1"}, {"id": "2"}, {"id": "3"}}
	if got := crawlerLimitItems(items, 2); len(got) != 2 {
		t.Fatalf("limit=2 got %d", len(got))
	}
	if got := crawlerLimitItems(items, 0); len(got) != 3 {
		t.Fatalf("limit=0 got %d", len(got))
	}
	var nilItems []map[string]any
	encoded, err := json.Marshal(crawlerLimitItems(nilItems, 5))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(encoded) != "[]" {
		t.Fatalf("nil 应序列化成 []，实际 %s", encoded)
	}
}
