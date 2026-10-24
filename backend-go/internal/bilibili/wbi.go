package bilibili

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// mixinKeyEncTable 是 WBI mixinKey 的字符抽取表（B站 前端硬编码常量）。
var mixinKeyEncTable = [32]int{
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
	27, 43, 5, 49, 33, 9, 20, 42, 19, 29, 28, 14, 7, 41, 12, 1,
}

// wbiKeyTTL 是 WBI 密钥缓存时长。
const wbiKeyTTL = 30 * time.Minute

type wbiKeys struct {
	imgKey    string
	subKey    string
	fetchedAt time.Time
}

// WBIManager 管理 WBI 密钥的拉取与缓存。
//
// 按 Cookie 隔离缓存：登录态与匿名态拿到的密钥不同，混用会导致签名校验失败。
type WBIManager struct {
	client *Client

	mu    sync.Mutex
	cache map[string]wbiKeys
}

// NewWBIManager 构造 WBI 管理器。
func NewWBIManager(client *Client) *WBIManager {
	return &WBIManager{client: client, cache: make(map[string]wbiKeys, 4)}
}

// cookieCacheKey 把 Cookie 摘要成缓存键，避免明文 Cookie 长期驻留内存。
func cookieCacheKey(cookie string) string {
	if cookie == "" {
		return "anonymous"
	}
	sum := sha256.Sum256([]byte(cookie))
	return hex.EncodeToString(sum[:])[:16]
}

// MixinKey 由 imgKey + subKey 派生出实际参与签名的 32 位 key。
func MixinKey(imgKey, subKey string) string {
	raw := imgKey + subKey
	var b strings.Builder
	for _, idx := range mixinKeyEncTable {
		// 越界时 JS 取到 undefined，join 后表现为空串；这里同样跳过。
		if idx >= 0 && idx < len(raw) {
			b.WriteByte(raw[idx])
		}
	}
	out := b.String()
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

// SignParams 对参数做 WBI 签名，返回带 wts 与 w_rid 的新参数集。
//
// 签名算法：按键名排序 → encodeURIComponent 拼接 → 末尾接 mixinKey → MD5。
// 空值参数不参与签名（B站 服务端同样跳过）。
func SignParams(params *Params, imgKey, subKey string) *Params {
	return signParamsAt(params, imgKey, subKey, time.Now().Unix())
}

// signParamsAt 用固定 wts 签名，供跨语言对拍使用。
func signParamsAt(params *Params, imgKey, subKey string, wts int64) *Params {
	mixin := MixinKey(imgKey, subKey)
	signed := params.Clone()
	signed.Set("wts", strconv.FormatInt(wts, 10))

	keys := make([]string, 0, len(signed.keys))
	for _, k := range signed.keys {
		if v := signed.vals[k]; v != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	var q strings.Builder
	for i, k := range keys {
		if i > 0 {
			q.WriteByte('&')
		}
		q.WriteString(encodeComponent(k))
		q.WriteByte('=')
		q.WriteString(encodeComponent(signed.vals[k]))
	}

	sum := md5.Sum([]byte(q.String() + mixin))
	signed.Set("w_rid", hex.EncodeToString(sum[:]))
	return signed
}

// Keys 取当前 Cookie 对应的 WBI 密钥，缓存过期时自动刷新。
func (m *WBIManager) Keys(ctx context.Context, cookie string) (imgKey, subKey string, err error) {
	key := cookieCacheKey(cookie)

	m.mu.Lock()
	cached, ok := m.cache[key]
	m.mu.Unlock()
	if ok && time.Since(cached.fetchedAt) < wbiKeyTTL {
		return cached.imgKey, cached.subKey, nil
	}

	pair, err := m.fetchKeys(ctx, cookie)
	if err != nil {
		return "", "", err
	}
	m.mu.Lock()
	m.cache[key] = pair
	m.mu.Unlock()
	return pair.imgKey, pair.subKey, nil
}

// ClearCache 清空全部密钥缓存（签名校验失败时调用，下次自动重取）。
func (m *WBIManager) ClearCache() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cache = make(map[string]wbiKeys, 4)
}

// fetchKeys 直接请求 nav 接口提取 imgKey / subKey（不读缓存）。
func (m *WBIManager) fetchKeys(ctx context.Context, cookie string) (wbiKeys, error) {
	// ignoreBizCode 是关键：匿名 nav 现在返回 code=-101（账号未登录），
	// 但 data.wbi_img 仍照常下发。按业务码抛错会让未登录下所有签名接口不可用。
	env, err := m.client.Fetch(ctx, "https://api.bilibili.com/x/web-interface/nav", FetchOptions{
		Cookie:        cookie,
		IgnoreBizCode: true,
	})
	if err != nil {
		return wbiKeys{}, err
	}
	var nav struct {
		WbiImg struct {
			ImgURL string `json:"img_url"`
			SubURL string `json:"sub_url"`
		} `json:"wbi_img"`
	}
	if _, err := DecodeDataInto(env, &nav); err != nil {
		return wbiKeys{}, err
	}
	if nav.WbiImg.ImgURL == "" || nav.WbiImg.SubURL == "" {
		return wbiKeys{}, errors.New("从 B站 nav 接口获取 WBI key 失败")
	}
	imgKey := keyFromURL(nav.WbiImg.ImgURL)
	subKey := keyFromURL(nav.WbiImg.SubURL)
	if imgKey == "" || subKey == "" {
		return wbiKeys{}, errors.New("无法从 WBI 图片 URL 中提取 key")
	}
	return wbiKeys{imgKey: imgKey, subKey: subKey, fetchedAt: time.Now()}, nil
}

// keyFromURL 从 `https://i0.hdslb.com/bfs/wbi/<key>.png` 里取出 `<key>`。
func keyFromURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	path := parsed.Path
	base := path
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		base = path[idx+1:]
	}
	if idx := strings.LastIndex(base, "."); idx > 0 {
		base = base[:idx]
	}
	return base
}
