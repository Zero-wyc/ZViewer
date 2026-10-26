package ncm

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// cloudStubCaller 按路径返回固定响应，并记录调用顺序。
type cloudStubCaller struct {
	mu         sync.Mutex
	paths      []string
	alloc      int
	skipUpload bool
}

func (c *cloudStubCaller) Do(_ context.Context, call Call) (*upstreamResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.paths = append(c.paths, call.Path)
	var body string
	switch call.Path {
	case "/api/cloud/upload/check":
		if c.skipUpload {
			body = `{"code":200,"needUpload":false,"songId":123}`
		} else {
			body = `{"code":200,"needUpload":true,"songId":123}`
		}
	case "/api/nos/token/alloc":
		c.alloc++
		if c.alloc == 1 {
			body = `{"code":200,"result":{"resourceId":"res-1"}}`
		} else {
			body = `{"code":200,"result":{"objectKey":"aa/bb/cc.mp3","token":"tok-1"}}`
		}
	case "/api/upload/cloud/info/v2":
		body = `{"code":200,"songId":456}`
	case "/api/cloud/pub/v2":
		body = `{"code":200,"songId":456}`
	default:
		body = `{"code":404}`
	}
	return &upstreamResult{Status: 200, Body: []byte(body)}, nil
}

// cloudUploadBody 构造一个最小 multipart 请求体。
func cloudUploadBody(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	part, err := writer.CreateFormFile("songFile", "测试 歌曲.mp3")
	if err != nil {
		t.Fatalf("构造 multipart 失败: %v", err)
	}
	if _, err := part.Write([]byte("not-a-real-mp3-but-enough")); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 multipart 失败: %v", err)
	}
	return buffer, writer.FormDataContentType()
}

// TestCloudUploadFullFlow 覆盖「需要上传」的完整链路：
// check → alloc(resourceId) → alloc(上传凭证) → LBS → NOS 上传 → info → pub。
func TestCloudUploadFullFlow(t *testing.T) {
	var uploadedHeaders http.Header
	var uploadedLength int
	var uploadedPath string
	nos := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/lbs") {
			_, _ = w.Write([]byte(`{"upload":["` + "http://" + r.Host + `/nos"]}`))
			return
		}
		// 用 RequestURI 取原始形态：URL.Path 会把 %2F 解码回 "/"
		uploadedPath = r.RequestURI
		uploadedHeaders = r.Header.Clone()
		raw, _ := io.ReadAll(r.Body)
		uploadedLength = len(raw)
		w.WriteHeader(http.StatusOK)
	}))
	defer nos.Close()

	previous := lbsEndpoint
	lbsEndpoint = nos.URL + "/lbs"
	defer func() { lbsEndpoint = previous }()

	caller := &cloudStubCaller{}
	handler := newAPIWith(caller)
	handler.nos = nos.Client()

	body, contentType := cloudUploadBody(t)
	result, err := handler.upload(context.Background(), "MUSIC_U=abc; __csrf=xyz", contentType, body)
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	parsed, _ := result.Body.(map[string]any)
	if code := numberField(parsed, "code", 0); code != 200 {
		t.Errorf("code = %d，期望 200", code)
	}
	if songID := textField(parsed, "songId"); songID != "456" {
		t.Errorf("songId = %q，期望 456（以发布结果为准）", songID)
	}

	// 顺序必须与 Node 一致，alloc 出现两次（resourceId 与上传凭证）
	want := []string{
		"/api/cloud/upload/check",
		"/api/nos/token/alloc",
		"/api/nos/token/alloc",
		"/api/upload/cloud/info/v2",
		"/api/cloud/pub/v2",
	}
	if strings.Join(caller.paths, ",") != strings.Join(want, ",") {
		t.Errorf("上游调用顺序 = %v，期望 %v", caller.paths, want)
	}

	// 上传请求的关键点：objectKey 的 "/" 必须编码成 %2F，且三个头要对得上
	if !strings.Contains(uploadedPath, "/jd-musicrep-privatecloud-audio-public/aa%2Fbb%2Fcc.mp3") {
		t.Errorf("上传路径 = %q，objectKey 未按 %%2F 编码", uploadedPath)
	}
	if got := uploadedHeaders.Get("x-nos-token"); got != "tok-1" {
		t.Errorf("x-nos-token = %q", got)
	}
	if got := uploadedHeaders.Get("Content-MD5"); len(got) != 32 {
		t.Errorf("Content-MD5 不是 32 位 hex: %q", got)
	}
	if uploadedLength != len("not-a-real-mp3-but-enough") {
		t.Errorf("上传字节数 = %d，期望 %d", uploadedLength, len("not-a-real-mp3-but-enough"))
	}
}

// TestCloudUploadSkipsUploadWhenExists 覆盖「文件已存在」：check 回 needUpload=false，
// 不应再取上传凭证、也不该碰存储节点。
func TestCloudUploadSkipsUploadWhenExists(t *testing.T) {
	caller := &cloudStubCaller{skipUpload: true}
	handler := newAPIWith(caller)

	body, contentType := cloudUploadBody(t)
	if _, err := handler.upload(context.Background(), "", contentType, body); err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	want := []string{"/api/cloud/upload/check", "/api/nos/token/alloc", "/api/upload/cloud/info/v2", "/api/cloud/pub/v2"}
	if strings.Join(caller.paths, ",") != strings.Join(want, ",") {
		t.Errorf("上游调用顺序 = %v，期望 %v", caller.paths, want)
	}
}

// TestCloudUploadRejectsNonMultipart 覆盖参数错误。
func TestCloudUploadRejectsNonMultipart(t *testing.T) {
	handler := newAPIWith(&cloudStubCaller{})
	_, err := handler.upload(context.Background(), "", "application/json", strings.NewReader("{}"))
	var detail *apiError
	if !errors.As(err, &detail) || detail.Status != http.StatusBadRequest {
		t.Fatalf("错误 = %v，期望 400", err)
	}
}

// TestFilenameHelpers 对齐 Node 的 getFileExtension / sanitizeFilename。
func TestFilenameHelpers(t *testing.T) {
	if got := fileExtension("A.FLAC"); got != "flac" {
		t.Errorf("fileExtension = %q", got)
	}
	if got := fileExtension("noext"); got != "mp3" {
		t.Errorf("无后缀应回落 mp3，实际 %q", got)
	}
	if got := sanitizeFilename("周杰伦 - 稻香.mp3"); got != "周杰伦-稻香" {
		t.Errorf("sanitizeFilename = %q", got)
	}
	if got := sanitizeFilename(""); got != "unknown" {
		t.Errorf("空名应为 unknown，实际 %q", got)
	}
}
