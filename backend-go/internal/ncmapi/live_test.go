package ncmapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// TestLiveUpstream 是可选的真实上游对拍。
//
// 默认跳过（单测不该依赖外网）。要跑：
//
//	NCM_LIVE=1 go test ./internal/ncmapi/ -run TestLiveUpstream -v
//
// 它验证的是「我们手写的 weapi/eapi/linuxapi 加密能否被网易云接受」——单测
// 只能验形状，通道是否真的通必须打一次线上接口。匿名请求即可：匿名返回
// code=200 说明加密与参数都合法（风控只会让 code=460，不会让加密解密失败）。
func TestLiveUpstream(t *testing.T) {
	if os.Getenv("NCM_LIVE") == "" {
		t.Skip("未设置 NCM_LIVE=1，跳过真实上游对拍")
	}
	server := httptest.NewServer(NewHandler())
	defer server.Close()

	cases := []struct {
		path string
		want int
	}{
		{"/banner?type=0", 200},
		{"/cloudsearch?keywords=%E5%91%A8%E6%9D%B0%E4%BC%A6&limit=3", 200},
		{"/toplist", 200},
		{"/song/detail?ids=347230", 200},
		{"/lyric?id=347230", 200},
		{"/song/url/v1?id=347230&level=exhigh", 200},
		{"/search?keywords=test&limit=3", 200},
		{"/search/suggest?keywords=test", 200},
		{"/playlist/detail?id=24381616", 200},
		// 匿名时这个接口回 200 + account/profile 为 null，而不是 301
		// （301 是 likelist/user/cloud 这类强登录接口的表现）。
		{"/user/account", 200},
		{"/likelist?uid=1", 301},
		{"/user/cloud", 301},
	}
	for _, item := range cases {
		response, err := http.Get(server.URL + item.path)
		if err != nil {
			t.Fatalf("%s 请求失败: %v", item.path, err)
		}
		var body map[string]any
		decodeErr := json.NewDecoder(response.Body).Decode(&body)
		_ = response.Body.Close()
		if decodeErr != nil {
			t.Fatalf("%s 响应不是 JSON: %v", item.path, decodeErr)
		}
		code, _ := body["code"].(float64)
		if int(code) != item.want {
			t.Errorf("%s 返回 code=%v，期望 %d；body=%.200v", item.path, body["code"], item.want, body)
			continue
		}
		t.Logf("%-45s code=%v", item.path, body["code"])
	}
}

// TestLiveCloudUploadRequiresLogin 验证 `/cloud` 真的挂在路由上、multipart 能被
// 解析、并且匿名时按未登录拒绝（而不是 404「接口不存在」）。
//
// 只跑这一小段是因为真实上传会往账号云盘里塞一首歌，必须由用户在前端确认；
// 完整链路由 cloud_test.go 的桩测试覆盖。
func TestLiveCloudUploadRequiresLogin(t *testing.T) {
	if os.Getenv("NCM_LIVE") == "" {
		t.Skip("未设置 NCM_LIVE=1，跳过真实上游对拍")
	}
	body, contentType := cloudUploadBody(t)
	request := httptest.NewRequest(http.MethodPost, LoopbackBase+"/cloud", body)
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401（匿名）；响应 %s", recorder.Code, recorder.Body.String())
	}
	var parsed map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("响应不是 JSON: %s", recorder.Body.String())
	}
	if msg := upstreamMsg(parsed, ""); msg == "" {
		t.Errorf("缺少错误文案: %s", recorder.Body.String())
	}
	t.Logf("匿名上传按预期被拒绝: %s", recorder.Body.String())
}
