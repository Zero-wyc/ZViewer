package danmaku

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/webfetch"
)

// 弹弹play 弹幕源，对应 providers/dandanplay.ts 与 providers/dandanplay-credentials.ts。
//
// 2026-06-25 起所有接口都要签名认证（AppId/AppSecret 由 DevCenter 申请）。
// 凭证跟 Node 一样以 AES-256-CBC 密文内置在源码里，运行时解密——明文不进仓库。

const (
	dandanAPIBase = "https://api.dandanplay.net"
	// 这段 UA 里 `Chrome/537.0.0.0` 是 Node 侧的原始笔误，照抄：请求头变了
	// 有可能影响对方的风控判定。
	dandanUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/537.0.0.0 Safari/537.36"
	dandanTimeout   = 10 * time.Second

	// 统一弹幕模式。
	modeScroll = 0
	modeTop    = 1
	modeBottom = 2
)

// 凭证密文（与 dandanplay-credentials.ts 逐字相同）。
const (
	dandanCipherAppID     = "95s9nfJw9/YvPyAQWqCRAw=="
	dandanCipherAppSecret = "yYjKsgNaZKOAezPpT4aXfvTY2rTcwjt3OfbthKzFNBw6VBJ5x8lm+sXeX4lapT6M"

	// Node 把密钥/IV 拆成多段再拼接，这里合并成最终字符串，效果相同：
	// key = [_k1.._k5] = "dandanplayopenplatform2026"，
	// iv  = [_i1,_i2]   = "zviewerservice"。
	dandanKeyMaterial = "dandanplayopenplatform2026"
	dandanIVMaterial  = "zviewerservice"
)

var (
	dandanOnce        sync.Once
	dandanAppID       string
	dandanAppSecret   string
	dandanCredentials error
)

// loadDandanCredentials 解密内置凭证（只跑一次）。
func loadDandanCredentials() (string, string, error) {
	dandanOnce.Do(func() {
		appID, err := decryptDandanSecret(dandanCipherAppID)
		if err != nil {
			dandanCredentials = fmt.Errorf("弹弹play 凭证解密失败: %w", err)
			return
		}
		secret, err := decryptDandanSecret(dandanCipherAppSecret)
		if err != nil {
			dandanCredentials = fmt.Errorf("弹弹play 凭证解密失败: %w", err)
			return
		}
		dandanAppID, dandanAppSecret = appID, secret
	})
	return dandanAppID, dandanAppSecret, dandanCredentials
}

// decryptDandanSecret 解密一段凭证密文（AES-256-CBC + PKCS#7）。
//
// 与 Node 的 aes-256-cbc 对齐：key = sha256(keyMaterial)，iv = sha256(ivMaterial)[:16]。
func decryptDandanSecret(cipherTextBase64 string) (string, error) {
	keySum := sha256.Sum256([]byte(dandanKeyMaterial))
	ivSum := sha256.Sum256([]byte(dandanIVMaterial))

	block, err := aes.NewCipher(keySum[:])
	if err != nil {
		return "", err
	}
	payload, err := base64.StdEncoding.DecodeString(cipherTextBase64)
	if err != nil {
		return "", err
	}
	if len(payload) == 0 || len(payload)%aes.BlockSize != 0 {
		return "", errors.New("密文长度不是分组的整数倍")
	}
	plain := make([]byte, len(payload))
	cipher.NewCBCDecrypter(block, ivSum[:aes.BlockSize]).CryptBlocks(plain, payload)

	// 去掉 PKCS#7 填充（Node 的 decipher.final() 做的是同一件事）。
	padding := int(plain[len(plain)-1])
	if padding == 0 || padding > aes.BlockSize || padding > len(plain) {
		return "", errors.New("填充不合法（凭证密文可能已损坏）")
	}
	for _, value := range plain[len(plain)-padding:] {
		if int(value) != padding {
			return "", errors.New("填充不合法（凭证密文可能已损坏）")
		}
	}
	return string(plain[:len(plain)-padding]), nil
}

// buildDandanSignature 计算签名：base64(sha256(AppId + Timestamp + Path + AppSecret))。
//
// Path 只含路径（带 /api/v2 前缀、不含 query），大小写敏感。
func buildDandanSignature(appID, appSecret, timestamp, path string) string {
	sum := sha256.Sum256([]byte(appID + timestamp + path + appSecret))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// dandanAPIError 是弹弹play 返回的业务错误。
type dandanAPIError struct {
	Message string
}

func (e *dandanAPIError) Error() string { return e.Message }

// dandanGet 发一次签名请求并解析 JSON。
func dandanGet(ctx context.Context, path string, params map[string]string) (any, error) {
	appID, appSecret, err := loadDandanCredentials()
	if err != nil {
		return nil, err
	}
	if appID == "" || appSecret == "" {
		return nil, errors.New("弹弹play请求失败：开放平台凭证未正确加载。" +
			"请在弹弹play DevCenter (https://devcenter.dandanplay.net) 申请 AppId 和 AppSecret，" +
			"并更新 dandanplay-credentials.ts 中的密文。")
	}

	target := dandanAPIBase + path
	if len(params) > 0 {
		values := url.Values{}
		for key, value := range params {
			values.Set(key, value)
		}
		target += "?" + values.Encode()
	}

	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	result := webfetch.Fetch(ctx, target, webfetch.Options{
		Timeout: dandanTimeout,
		Headers: map[string]string{
			"User-Agent":  dandanUserAgent,
			"Accept":      "application/json",
			"X-AppId":     appID,
			"X-Timestamp": timestamp,
			"X-Signature": buildDandanSignature(appID, appSecret, timestamp, path),
		},
	})
	if result.Status == 0 {
		if strings.HasPrefix(result.Error, "请求超时") {
			return nil, fmt.Errorf("弹弹play请求超时（%ds）：%s", int(dandanTimeout/time.Second), target)
		}
		return nil, fmt.Errorf("弹弹play请求网络错误：%s", result.Error)
	}

	if result.Status == 401 || result.Status == 403 {
		detail := dandanErrorDetail(result.Body)
		if detail == "" {
			detail = "请检查 dandanplay-credentials.ts 中的凭证密文是否正确"
		}
		return nil, fmt.Errorf("弹弹play 认证失败 [HTTP %d]：%s（path=%s）", result.Status, detail, path)
	}
	if !result.OK {
		detail := dandanErrorDetail(result.Body)
		if detail != "" {
			return nil, fmt.Errorf("弹弹play API 请求失败 [HTTP %d]：%s（%s）", result.Status, detail, target)
		}
		return nil, fmt.Errorf("弹弹play API 请求失败 [HTTP %d]（%s）", result.Status, target)
	}

	var document any
	if err := json.Unmarshal([]byte(result.Body), &document); err != nil {
		return nil, fmt.Errorf("弹弹play API 响应解析失败：%v", err)
	}
	return document, nil
}

// dandanErrorDetail 从错误响应里取一条可读信息。
func dandanErrorDetail(body string) string {
	var payload struct {
		ErrorMessage string `json:"errorMessage"`
		Message      string `json:"message"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return ""
	}
	if payload.ErrorMessage != "" {
		return payload.ErrorMessage
	}
	return payload.Message
}

// mapDandanMode 把弹弹play 的 mode 映射到统一格式。
//
// 弹弹play：0=滚动, 1=底部, 2=顶部, 3=特殊；统一：0=滚动, 1=顶部, 2=底部。
// 注意 1 与 2 是**反的**，照抄容易写错。
func mapDandanMode(rawMode int) int {
	switch rawMode {
	case 0:
		return modeScroll
	case 1:
		return modeBottom
	case 2:
		return modeTop
	}
	return modeScroll
}

// parseCommentParams 解析 `p` 字段：time,mode,size,color,...
func parseCommentParams(p any) (timeSeconds float64, mode, size, color int) {
	text, ok := p.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return 0, modeScroll, 25, 0xffffff
	}
	parts := strings.Split(text, ",")

	timeSeconds = 0
	if len(parts) > 0 {
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64); err == nil {
			timeSeconds = parsed
		}
	}

	rawMode := 0
	if len(parts) > 1 {
		if parsed, ok := parseIntPrefix(parts[1], 10); ok {
			rawMode = int(parsed)
		}
	}
	mode = mapDandanMode(rawMode)

	size = 25
	if len(parts) > 2 {
		if parsed, ok := parseIntPrefix(parts[2], 10); ok && parsed > 0 {
			size = int(parsed)
		}
	}

	color = 0xffffff
	if len(parts) > 3 {
		if parsed, ok := parseIntPrefix(parts[3], 10); ok {
			color = int(parsed)
		}
	}
	return timeSeconds, mode, size, color
}

// dandanplayProvider 是弹弹play 弹幕源。
type dandanplayProvider struct{}

func (p *dandanplayProvider) Name() string { return "弹弹 play" }

func (p *dandanplayProvider) Search(ctx context.Context, keyword string, _ Context) ([]SearchResult, error) {
	document, err := dandanGet(ctx, "/api/v2/search/anime", map[string]string{"keyword": keyword})
	if err != nil {
		return nil, err
	}
	payload, _ := document.(map[string]any)
	if success, ok := payload["success"].(bool); !ok || !success {
		message, _ := payload["errorMessage"].(string)
		if message == "" {
			message = "弹弹play 搜索失败"
		}
		return nil, &dandanAPIError{Message: message}
	}

	list, _ := payload["animes"].([]any)
	if len(list) > 20 {
		list = list[:20]
	}
	results := make([]SearchResult, 0, len(list))
	for _, entry := range list {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		animeID, _ := item["animeId"].(float64)
		result := SearchResult{
			ID:     formatNumber(animeID),
			Title:  stringField(item, "animeTitle"),
			Source: "dandanplay",
			Extra:  map[string]any{"animeId": animeID},
		}
		if cover := stringField(item, "imageUrl"); cover != "" {
			result.Cover = strPtr(cover)
		}
		// description = [typeDescription, started].filter(Boolean).join(' / ')
		parts := make([]string, 0, 2)
		for _, key := range []string{"typeDescription", "started"} {
			if value := stringField(item, key); value != "" {
				parts = append(parts, value)
			}
		}
		result.Description = strPtr(strings.Join(parts, " / "))
		results = append(results, result)
	}
	return results, nil
}

func (p *dandanplayProvider) Episodes(ctx context.Context, identifier string, _ Context) ([]Episode, error) {
	animeID, ok := parseIntPrefix(onlyDigits(identifier), 10)
	if !ok || animeID <= 0 {
		return nil, errors.New("无法解析弹弹play animeId")
	}

	document, err := dandanGet(ctx, "/api/v2/bangumi/"+strconv.FormatInt(animeID, 10), nil)
	if err != nil {
		return nil, err
	}
	payload, _ := document.(map[string]any)
	if success, ok := payload["success"].(bool); !ok || !success {
		message, _ := payload["errorMessage"].(string)
		if message == "" {
			message = "弹弹play 获取番剧详情失败"
		}
		return nil, &dandanAPIError{Message: message}
	}

	bangumi, _ := payload["bangumi"].(map[string]any)
	animeTitle := stringField(bangumi, "animeTitle")
	episodes, _ := bangumi["episodes"].([]any)
	if len(episodes) == 0 {
		title := animeTitle
		if title == "" {
			title = "第 1 集"
		}
		return []Episode{{
			ID:             formatNumber(animeID) + "-1",
			Title:          title,
			EpisodeNumber:  1,
			PlaybackParams: map[string]any{"animeId": animeID},
		}}, nil
	}

	results := make([]Episode, 0, len(episodes))
	for index, entry := range episodes {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		episodeID, _ := item["episodeId"].(float64)

		title := animeTitle
		if episodeTitle := stringField(item, "episodeTitle"); episodeTitle != "" {
			if title == "" {
				title = episodeTitle
			} else {
				title = title + " - " + episodeTitle
			}
		}

		// episodeNumber 可能是数字或字符串，都没有就按序号。
		number := float64(index + 1)
		switch typed := item["episodeNumber"].(type) {
		case float64:
			number = typed
		case string:
			if parsed, ok := parseIntPrefix(typed, 10); ok {
				number = float64(parsed)
			}
		}

		results = append(results, Episode{
			ID:             formatNumber(animeID) + "-" + formatNumber(episodeID),
			Title:          title,
			EpisodeNumber:  number,
			PlaybackParams: map[string]any{"animeId": animeID, "episodeId": episodeID},
		})
	}
	return results, nil
}

func (p *dandanplayProvider) Danmaku(ctx context.Context, episode Episode, _ Context) ([]Item, error) {
	episodeID, ok := episodeIDOf(episode)
	if !ok || episodeID <= 0 {
		return nil, errors.New("缺少有效的弹弹play episodeId")
	}

	document, err := dandanGet(ctx,
		"/api/v2/comment/"+strconv.FormatInt(episodeID, 10),
		map[string]string{"withRelated": "false", "chConvert": "0"})
	if err != nil {
		return nil, err
	}
	payload, _ := document.(map[string]any)
	comments, _ := payload["comments"].([]any)

	items := make([]Item, 0, len(comments))
	for _, entry := range comments {
		comment, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		content, ok := comment["m"].(string)
		if !ok || strings.TrimSpace(content) == "" {
			continue
		}
		timeSeconds, mode, size, color := parseCommentParams(comment["p"])

		id := ""
		switch typed := comment["cid"].(type) {
		case float64:
			id = formatNumber(typed)
		case string:
			id = typed
		}
		if id == "" {
			id = fmt.Sprintf("%d-%s", time.Now().UnixMilli(), randomSuffix())
		}

		items = append(items, Item{
			ID:      id,
			Content: content,
			Time:    timeSeconds,
			Mode:    mode,
			Color:   color,
			Size:    size,
		})
	}
	return items, nil
}

// episodeIDOf 取 playbackParams.episodeId（必须是数字）。
func episodeIDOf(episode Episode) (int64, bool) {
	value, present := episode.PlaybackParams["episodeId"]
	if !present {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	}
	return 0, false
}

// stringField 取对象里的字符串字段（缺失/null 给空串）。
func stringField(object map[string]any, key string) string {
	value, ok := object[key].(string)
	if !ok {
		return ""
	}
	return value
}
