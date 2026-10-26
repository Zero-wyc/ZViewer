package ncmapi

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/dhowden/tag"
)

// 云盘上传的几个固定值，全部照抄 Node 版 module/cloud.js 与 plugins/songUpload.js。
//
// bucket 是网易云私有云盘的存储桶名（不是用户可见的「我的云盘」）；bitrate 只是
// 上报字段，不影响转码结果，写成 999000 是客户端的历史约定。
const (
	cloudBucket      = "jd-musicrep-privatecloud-audio-public"
	cloudBitrate     = "999000"
	cloudMaxFileSize = 512 << 20
	cloudMaxWait     = 10 * time.Minute
)

// lbsEndpoint 是上传节点查询地址（变量是为了单测能指向本地桩）。
var lbsEndpoint = "https://wanproxy.127.net/lbs"

// cloudUpload 是 `/cloud`：把浏览器上传的音频存进网易云音乐云盘。
//
// 与 Node 版同样的四步链路（缺一步都不行）：
//
//  1. /api/cloud/upload/check      —— 用 md5 判重，返回 needUpload 与 songId
//  2. /api/nos/token/alloc         —— 拿 resourceId（回填云盘信息要用）
//  3. /api/nos/token/alloc + NOS   —— 真正传文件（仅在 needUpload 时）
//  4. /api/upload/cloud/info/v2    —— 写歌曲名/歌手/专辑
//  5. /api/cloud/pub/v2            —— 发布到云盘
//
// 文件先落到临时文件：md5、ID3 元数据、上传三处都要读同一份字节，而 multipart
// 的 part 只能顺序读一次。上传完成后必删。
func (h *Handler) cloudUpload(w http.ResponseWriter, r *http.Request) {
	file, err := receiveCloudFile(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"code": 400, "msg": err.Error()})
		return
	}
	defer file.remove()

	ctx, cancel := context.WithTimeout(r.Context(), cloudMaxWait)
	defer cancel()
	cookie := r.Header.Get("Cookie")
	setCookies := func(result *Result) {
		if result == nil {
			return
		}
		for _, value := range result.Cookies {
			w.Header().Add("Set-Cookie", value)
		}
	}

	check, checkResult, err := h.callJSON(ctx, "/api/cloud/upload/check", cryptoEapi, map[string]any{
		"bitrate": cloudBitrate,
		"ext":     "",
		"length":  file.size,
		"md5":     file.md5,
		"songId":  "0",
		"version": 1,
	}, cookie)
	setCookies(checkResult)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "msg": "云盘判重失败"})
		return
	}
	if code := intField(check, "code", 0); code != 200 {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"code": code, "msg": upstreamMsg(check, "网易云未登录或上传校验失败")})
		return
	}
	songID := stringField(check, "songId")

	// resourceId 走单独一次 alloc（bucket 留空），与 Node 完全一致；
	// 真正的上传凭证在下面用带 bucket 的 alloc 再取一次。
	alloc, allocResult, err := h.callJSON(ctx, "/api/nos/token/alloc", cryptoEapi, map[string]any{
		"bucket":      "",
		"ext":         fileExtension(file.name),
		"filename":    sanitizeFilename(file.name),
		"local":       false,
		"nos_product": 3,
		"type":        "audio",
		"md5":         file.md5,
	}, cookie)
	setCookies(allocResult)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "msg": "获取上传凭证失败"})
		return
	}
	resourceID := nestedString(alloc, "result", "resourceId")
	if resourceID == "" {
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "msg": "获取上传凭证失败"})
		return
	}

	if needUpload, _ := check["needUpload"].(bool); needUpload {
		if err := h.uploadToNOS(ctx, file, cookie, setCookies); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "msg": "文件上传失败: " + err.Error()})
			return
		}
	}

	title, artist, album := readAudioTags(file.path)
	if title == "" {
		title = sanitizeFilename(file.name)
	}
	if artist == "" {
		artist = "未知艺术家"
	}
	if album == "" {
		album = "未知专辑"
	}

	info, infoResult, err := h.callJSON(ctx, "/api/upload/cloud/info/v2", cryptoEapi, map[string]any{
		"md5":        file.md5,
		"songid":     songID,
		"filename":   file.name,
		"song":       title,
		"album":      album,
		"artist":     artist,
		"bitrate":    cloudBitrate,
		"resourceId": resourceID,
	}, cookie)
	setCookies(infoResult)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "msg": "写入云盘信息失败"})
		return
	}
	if code := intField(info, "code", 0); code != 200 {
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": code, "msg": upstreamMsg(info, "写入云盘信息失败")})
		return
	}

	published := songID
	if value := stringField(info, "songId"); value != "" {
		published = value
	}
	result, pubResult, err := h.callJSON(ctx, "/api/cloud/pub/v2", cryptoEapi, map[string]any{
		"songid": published,
	}, cookie)
	setCookies(pubResult)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"code": 502, "msg": "发布到云盘失败"})
		return
	}

	// Node 版返回的是 `{...check, ...pub}`：前端只看 code，其余字段（songId 等）
	// 以发布结果为准。
	merged := make(map[string]any, len(check)+len(result))
	for key, value := range check {
		merged[key] = value
	}
	for key, value := range result {
		merged[key] = value
	}
	if _, ok := merged["code"]; !ok {
		merged["code"] = 200
	}
	writeJSON(w, http.StatusOK, merged)
}

// uploadToNOS 把文件本体传到网易云对象存储。
//
// objectKey 里的 "/" 必须**先**换成 %2F 再拼 URL（Node 就是这么做的）：换成
// url.PathEscape 会把 % 二次编码，签名路径就对不上了。
func (h *Handler) uploadToNOS(ctx context.Context, file *receivedFile, cookie string, setCookies func(*Result)) error {
	alloc, allocResult, err := h.callJSON(ctx, "/api/nos/token/alloc", cryptoWeapi, map[string]any{
		"bucket":      cloudBucket,
		"ext":         fileExtension(file.name),
		"filename":    sanitizeFilename(file.name),
		"local":       false,
		"nos_product": 3,
		"type":        "audio",
		"md5":         file.md5,
	}, cookie)
	setCookies(allocResult)
	if err != nil {
		return errors.New("获取上传节点失败")
	}
	objectKey := nestedString(alloc, "result", "objectKey")
	token := nestedString(alloc, "result", "token")
	if objectKey == "" || token == "" {
		return errors.New("获取上传节点失败")
	}

	node, err := h.uploadNode(ctx)
	if err != nil {
		return err
	}
	target := strings.TrimRight(node, "/") + "/" + cloudBucket + "/" +
		strings.ReplaceAll(objectKey, "/", "%2F") +
		"?offset=0&complete=true&version=1.0"

	body, err := os.Open(file.path)
	if err != nil {
		return errors.New("读取临时文件失败")
	}
	defer body.Close()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, body)
	if err != nil {
		return errors.New("构造上传请求失败")
	}
	request.ContentLength = file.size
	request.Header.Set("x-nos-token", token)
	request.Header.Set("Content-MD5", file.md5)
	request.Header.Set("Content-Type", file.mime)

	response, err := h.nos.Do(request)
	if err != nil {
		return errors.New("上传到存储节点超时或中断")
	}
	defer response.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("存储节点返回 %d: %s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	return nil
}

// uploadNode 取一个可用的上传节点（网易的 LBS 接口）。
func (h *Handler) uploadNode(ctx context.Context) (string, error) {
	endpoint := lbsEndpoint + "?version=1.0&bucketname=" + url.QueryEscape(cloudBucket)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", errors.New("构造节点查询失败")
	}
	response, err := h.nos.Do(request)
	if err != nil {
		return "", errors.New("查询上传节点失败")
	}
	defer response.Body.Close()
	var parsed struct {
		Upload []string `json:"upload"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&parsed); err != nil || len(parsed.Upload) == 0 {
		return "", errors.New("没有可用的上传节点")
	}
	return parsed.Upload[0], nil
}

// receivedFile 是落盘后的上传文件。
type receivedFile struct {
	path string
	name string
	mime string
	size int64
	md5  string
}

// remove 删除临时文件（失败无副作用，只是留个垃圾）。
func (f *receivedFile) remove() { _ = os.Remove(f.path) }

// receiveCloudFile 从 multipart 里取出 songFile，边写临时文件边算 md5。
//
// 文件名不需要 Node 那种 latin1→utf8 的修补：Go 的 multipart 按原始字节解码，
// 中文名到这里已经是正确的 UTF-8。
func receiveCloudFile(r *http.Request) (*receivedFile, error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, errors.New("需要 multipart/form-data 上传请求")
	}
	var received *receivedFile
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, errors.New("读取上传内容失败")
		}
		if part.FileName() == "" || received != nil {
			_ = part.Close()
			continue
		}
		temp, err := os.CreateTemp("", "zv-ncm-cloud-*")
		if err != nil {
			_ = part.Close()
			return nil, errors.New("无法创建临时文件")
		}
		hasher := md5.New()
		size, copyErr := io.Copy(io.MultiWriter(temp, hasher), io.LimitReader(part, cloudMaxFileSize+1))
		closeErr := temp.Close()
		_ = part.Close()
		if copyErr != nil || closeErr != nil {
			_ = os.Remove(temp.Name())
			return nil, errors.New("读取上传内容失败")
		}
		if size > cloudMaxFileSize {
			_ = os.Remove(temp.Name())
			return nil, fmt.Errorf("文件超过 %d MB 上限", cloudMaxFileSize>>20)
		}
		mime := part.Header.Get("Content-Type")
		if mime == "" {
			mime = "audio/mpeg"
		}
		received = &receivedFile{
			path: temp.Name(),
			name: part.FileName(),
			mime: mime,
			size: size,
			md5:  hex.EncodeToString(hasher.Sum(nil)),
		}
	}
	if received == nil {
		return nil, errors.New("缺少 songFile 文件")
	}
	return received, nil
}

// callJSON 调一次上游并把响应解成 map（同时返回原始 Result 供 cookie 落库）。
func (h *Handler) callJSON(
	ctx context.Context,
	path string,
	mode crypto,
	data map[string]any,
	cookie string,
) (map[string]any, *Result, error) {
	result, err := h.caller.Do(ctx, Call{Path: path, Crypto: mode, Data: data, Cookie: cookie})
	if err != nil {
		return nil, nil, err
	}
	var parsed map[string]any
	if len(result.Body) > 0 {
		if err := json.Unmarshal(result.Body, &parsed); err != nil {
			return nil, result, err
		}
	}
	if parsed == nil {
		parsed = map[string]any{}
	}
	return parsed, result, nil
}

// readAudioTags 读 ID3/FLAC/MP4 里的标题、歌手、专辑（读不到就返回空串）。
func readAudioTags(path string) (title, artist, album string) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", ""
	}
	defer file.Close()
	meta, err := tag.ReadFrom(file)
	if err != nil {
		return "", "", ""
	}
	return strings.TrimSpace(meta.Title()), strings.TrimSpace(meta.Artist()), strings.TrimSpace(meta.Album())
}

// fileExtension 取小写后缀（Node 的 getFileExtension）。
func fileExtension(name string) string {
	index := strings.LastIndexByte(name, '.')
	if index < 0 || index == len(name)-1 {
		return "mp3"
	}
	return strings.ToLower(name[index+1:])
}

// sanitizeFilename 去掉后缀、空白，并把点换成下划线（Node 的 sanitizeFilename）。
func sanitizeFilename(name string) string {
	if strings.TrimSpace(name) == "" {
		return "unknown"
	}
	if index := strings.LastIndexByte(name, '.'); index > 0 {
		name = name[:index]
	}
	name = strings.Join(strings.Fields(name), "")
	name = strings.ReplaceAll(name, ".", "_")
	if name == "" {
		return "unknown"
	}
	return name
}

// nestedString 取 map["a"]["b"] 的字符串值。
func nestedString(root map[string]any, keys ...string) string {
	current := root
	for index, key := range keys {
		if index == len(keys)-1 {
			return stringField(current, key)
		}
		next, ok := current[key].(map[string]any)
		if !ok {
			return ""
		}
		current = next
	}
	return ""
}

// stringField 取字符串字段（数字也转成字符串：songId 有时是 number）。
func stringField(root map[string]any, key string) string {
	switch value := root[key].(type) {
	case string:
		return value
	case float64:
		return strings.TrimSuffix(fmt.Sprintf("%.0f", value), ".0")
	case json.Number:
		return value.String()
	default:
		return ""
	}
}

// intField 取整型字段，缺失时返回兜底值。
func intField(root map[string]any, key string, fallback int) int {
	switch value := root[key].(type) {
	case float64:
		return int(value)
	case json.Number:
		if parsed, err := value.Int64(); err == nil {
			return int(parsed)
		}
	}
	return fallback
}

// upstreamMsg 取上游的错误文案。
func upstreamMsg(root map[string]any, fallback string) string {
	for _, key := range []string{"msg", "message", "error"} {
		if value, ok := root[key].(string); ok && value != "" {
			return value
		}
	}
	return fallback
}
