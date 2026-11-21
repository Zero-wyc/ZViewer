package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"zviewer/backend/internal/crawler"
)

// newManageEnv 准备一个带 config.json 的临时爬虫根目录，返回可直接调 handler 的 Server。
func newManageEnv(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	config := `{"llm":{"base_url":"http://llm.invalid/v1","api_key":"sk-secret-key-1234","model":"fake-model"}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(config), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv("CRAWLER_ROOT", dir)
	t.Setenv("ZVIEWER_CRAWLER_ROOT", "")
	resetLocalCrawler()
	t.Cleanup(resetLocalCrawler)
	return &Server{}, dir
}

func doJSON(t *testing.T, handler http.HandlerFunc, method, target string, body any) (int, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	var decoded map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &decoded)
	return recorder.Code, decoded
}

func sampleRuleBody(url string) map[string]any {
	return map[string]any{"rule": map[string]any{
		"name": "测试站",
		"site": "example.com",
		"search": map[string]any{
			"request": map[string]any{"url": url + "?q={keyword}"},
		},
		"parse": map[string]any{
			"container": ".item",
			"fields": map[string]any{
				"title": map[string]any{"selector": ".t"},
				"url":   map[string]any{"selector": "a", "attr": "href"},
			},
		},
	}}
}

func TestManageRulesCRUD(t *testing.T) {
	server, _ := newManageEnv(t)

	status, body := doJSON(t, server.handleCrawlerStatus, "GET", "/api/crawler/status", nil)
	if status != 200 || body["engine"] != "go" || body["rules"].(float64) != 0 {
		t.Fatalf("status = %d %+v", status, body)
	}
	if body["llmConfigured"] != true || body["model"] != "fake-model" {
		t.Errorf("status config fields = %+v", body)
	}

	status, saved := doJSON(t, server.handleCrawlerRuleSave, "POST", "/api/crawler/rules", sampleRuleBody("https://example.com/s"))
	if status != 200 || saved["success"] != true {
		t.Fatalf("save = %d %+v", status, saved)
	}
	rule := saved["rule"].(map[string]any)
	ruleID := rule["id"].(string)

	_, listed := doJSON(t, server.handleCrawlerRulesList, "GET", "/api/crawler/rules", nil)
	if listed["count"].(float64) != 1 {
		t.Errorf("list = %+v", listed)
	}

	request := httptest.NewRequest("GET", "/api/crawler/rules/"+ruleID, nil)
	request.SetPathValue("id", ruleID)
	recorder := httptest.NewRecorder()
	server.handleCrawlerRuleGet(recorder, request)
	if recorder.Code != 200 {
		t.Fatalf("get = %d %s", recorder.Code, recorder.Body.String())
	}

	// 更新：enabled=false（GUI 开关走的就是这条）。
	updateRequest := httptest.NewRequest("PUT", "/api/crawler/rules/"+ruleID, bytes.NewReader([]byte(`{"patch":{"enabled":false}}`)))
	updateRequest.SetPathValue("id", ruleID)
	updateRecorder := httptest.NewRecorder()
	server.handleCrawlerRuleUpdate(updateRecorder, updateRequest)
	if updateRecorder.Code != 200 {
		t.Fatalf("update = %d %s", updateRecorder.Code, updateRecorder.Body.String())
	}
	var updated map[string]any
	_ = json.Unmarshal(updateRecorder.Body.Bytes(), &updated)
	if updated["rule"].(map[string]any)["enabled"] != false {
		t.Errorf("enabled not patched: %+v", updated["rule"])
	}

	// 删除。
	delRequest := httptest.NewRequest("DELETE", "/api/crawler/rules/"+ruleID, nil)
	delRequest.SetPathValue("id", ruleID)
	delRecorder := httptest.NewRecorder()
	server.handleCrawlerRuleDelete(delRecorder, delRequest)
	if delRecorder.Code != 200 {
		t.Fatalf("delete = %d %s", delRecorder.Code, delRecorder.Body.String())
	}
	_, listed = doJSON(t, server.handleCrawlerRulesList, "GET", "/api/crawler/rules", nil)
	if listed["count"].(float64) != 0 {
		t.Errorf("rule not deleted: %+v", listed)
	}

	// 再删一次 → 404。
	delRecorder = httptest.NewRecorder()
	server.handleCrawlerRuleDelete(delRecorder, delRequest)
	if delRecorder.Code != 404 {
		t.Errorf("second delete = %d", delRecorder.Code)
	}
}

func TestManageAccounts(t *testing.T) {
	server, _ := newManageEnv(t)

	status, body := doJSON(t, server.handleCrawlerAccountSave, "POST", "/api/crawler/accounts", map[string]any{
		"account": map[string]any{"name": "站点账号", "site": "example.com", "cookies": "sid=secretvalue12345"},
	})
	if status != 200 || body["success"] != true {
		t.Fatalf("save account = %d %+v", status, body)
	}
	account := body["account"].(map[string]any)
	accountID := account["id"].(string)
	if account["cookies"] == "sid=secretvalue12345" {
		t.Error("cookies leaked in masked view")
	}

	_, listed := doJSON(t, server.handleCrawlerAccountsList, "GET", "/api/crawler/accounts", nil)
	if listed["count"].(float64) != 1 {
		t.Errorf("accounts = %+v", listed)
	}

	getRequest := httptest.NewRequest("GET", "/api/crawler/accounts/"+accountID, nil)
	getRequest.SetPathValue("id", accountID)
	getRecorder := httptest.NewRecorder()
	server.handleCrawlerAccountGet(getRecorder, getRequest)
	if getRecorder.Code != 200 {
		t.Fatalf("get account = %d", getRecorder.Code)
	}

	delRequest := httptest.NewRequest("DELETE", "/api/crawler/accounts/"+accountID, nil)
	delRequest.SetPathValue("id", accountID)
	delRecorder := httptest.NewRecorder()
	server.handleCrawlerAccountDelete(delRecorder, delRequest)
	if delRecorder.Code != 200 {
		t.Fatalf("delete account = %d", delRecorder.Code)
	}
}

func TestManageConfigMaskedKey(t *testing.T) {
	server, dir := newManageEnv(t)

	status, body := doJSON(t, server.handleCrawlerConfigGet, "GET", "/api/crawler/config", nil)
	if status != 200 {
		t.Fatalf("config get = %d", status)
	}
	config := body["config"].(map[string]any)
	llm := config["llm"].(map[string]any)
	if llm["api_key"] == "sk-secret-key-1234" {
		t.Error("api_key not masked")
	}
	masked := llm["api_key"].(string)

	// 把掩码原样回传 + 改模型：Key 必须保持不变。
	status, body = doJSON(t, server.handleCrawlerConfigPut, "PUT", "/api/crawler/config", map[string]any{
		"llm": map[string]any{"api_key": masked, "model": "new-model"},
	})
	if status != 200 {
		t.Fatalf("config put = %d %+v", status, body)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	var onDisk map[string]any
	_ = json.Unmarshal(raw, &onDisk)
	if onDisk["llm"].(map[string]any)["api_key"] != "sk-secret-key-1234" {
		t.Errorf("api_key overwritten by mask: %v", onDisk["llm"])
	}
	if onDisk["llm"].(map[string]any)["model"] != "new-model" {
		t.Errorf("model not saved: %v", onDisk["llm"])
	}
}

func TestManageChallenges(t *testing.T) {
	server, _ := newManageEnv(t)
	status, body := doJSON(t, server.handleCrawlerChallenges, "GET", "/api/crawler/challenges", nil)
	if status != 200 || body["count"].(float64) != 0 {
		t.Fatalf("challenges = %d %+v", status, body)
	}
	status, body = doJSON(t, server.handleCrawlerChallengeClear, "POST", "/api/crawler/challenges/clear", nil)
	if status != 200 || body["success"] != true {
		t.Fatalf("clear = %d %+v", status, body)
	}
}

func TestCrawlerConfigViewHidesKey(t *testing.T) {
	config := &crawler.EngineConfig{LLM: crawler.LLMConfig{APIKey: "sk-plain"}}
	view := crawlerConfigView(config)
	llm := view["llm"].(map[string]any)
	if llm["api_key"] == "sk-plain" {
		t.Error("key leaked")
	}
	if view["llmConfigured"] != true {
		t.Error("llmConfigured should be true")
	}
}
