package bilibili

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// 收藏夹：浏览、收藏/取消收藏、收藏状态。
//
// 对应 bilibili-favorites.routes.ts。收藏夹 id（fid）与用户 mid 是两套值：
// 默认收藏夹的 id 恰好等于 mid，因此「没传 mediaId」时用 mid 去 list 里找。

// FavFolder 是收藏夹条目。
type FavFolder struct {
	ID         int64  `json:"id"`
	Title      string `json:"title"`
	MediaCount int64  `json:"mediaCount"`
	Cover      string `json:"cover"`
}

// FavStatus 是「这个视频收在哪个夹」的查询结果。
type FavStatus struct {
	Collected   bool
	FolderID    int64
	FolderTitle string
}

var (
	// ErrBiliNotLoggedIn 表示用户还没绑定 B站（路由层回 401）。
	ErrBiliNotLoggedIn = errors.New("B站 未登录")
	// ErrCredentialExpired 表示凭证在但 nav 拿不到 mid（路由层回 401）。
	ErrCredentialExpired = errors.New("B站 凭证失效")
	// ErrMissingCSRF 表示 Cookie 里没有 bili_jct，写操作必然失败。
	ErrMissingCSRF = errors.New("B站 凭证缺少 csrf")
	// ErrFolderMissing 表示目标收藏夹不存在（取消收藏时按「尚未收藏」处理）。
	ErrFolderMissing = errors.New("收藏夹不存在")
	// ErrCreateFolder 表示创建收藏夹后没拿到 id。
	ErrCreateFolder = errors.New("创建收藏夹失败")
)

// navMid 取当前 Cookie 对应账号的 mid。
//
// 用 nav 而不是直接从 Cookie 里抠 DedeUserID：前者能顺带验证凭证是否还有效，
// 失效时回「B站 凭证失效」，比让后面每个接口各自 -101 更清楚。
func (s *Service) navMid(ctx context.Context, cookie string) (int64, error) {
	if cookie == "" {
		return 0, ErrBiliNotLoggedIn
	}
	nav, err := s.Nav(ctx, cookie)
	if err != nil {
		return 0, err
	}
	if nav.Mid == 0 {
		return 0, ErrCredentialExpired
	}
	return nav.Mid, nil
}

// favFolderRow 是 created/list(-all) 的条目（字段随接口不同）。
type favFolderRaw struct {
	ID         int64  `json:"id"`
	Title      string `json:"title"`
	MediaCount int64  `json:"media_count"`
	Cover      string `json:"cover"`
	FavState   int    `json:"fav_state"`
}

// listAllFolders 取用户的全部收藏夹（精简版，无封面）。
func (s *Service) listAllFolders(ctx context.Context, cookie string, mid int64) ([]favFolderRaw, error) {
	env, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=%d", mid),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var payload struct {
		List []favFolderRaw `json:"list"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, err
	}
	return payload.List, nil
}

// FavVideos 取登录用户指定收藏夹（缺省为默认收藏夹）的视频。
func (s *Service) FavVideos(ctx context.Context, cookie string, mediaID int64, pn, ps int) (string, []ListItem, *int64, error) {
	if cookie == "" {
		return "", nil, nil, ErrBiliNotLoggedIn
	}
	mid, err := s.navMid(ctx, cookie)
	if err != nil {
		return "", nil, nil, err
	}
	folders, err := s.listAllFolders(ctx, cookie, mid)
	if err != nil {
		return "", nil, nil, err
	}

	// 选择顺序：显式 mediaId 命中 → 默认夹（id == mid）→ 第一个 → 显式 mediaId 兜底。
	var folder *favFolderRaw
	if mediaID > 0 {
		for i := range folders {
			if folders[i].ID == mediaID {
				folder = &folders[i]
				break
			}
		}
	}
	if folder == nil {
		for i := range folders {
			if folders[i].ID == mid {
				folder = &folders[i]
				break
			}
		}
	}
	if folder == nil && len(folders) > 0 {
		folder = &folders[0]
	}
	if folder == nil && mediaID > 0 {
		folder = &favFolderRaw{ID: mediaID}
	}
	if folder == nil {
		return "", []ListItem{}, nil, nil
	}

	env, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/v3/fav/resource/list?media_id=%d&pn=%d&ps=%d&keyword=", folder.ID, pn, ps),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return "", nil, nil, err
	}
	var payload struct {
		Info *struct {
			Total      *int64 `json:"total"`
			MediaCount *int64 `json:"media_count"`
		} `json:"info"`
		Medias []struct {
			Bvid     string `json:"bvid"`
			Title    string `json:"title"`
			Cover    string `json:"cover"`
			Duration int    `json:"duration"`
			FavTime  int64  `json:"fav_time"`
			Upper    struct {
				Name string `json:"name"`
			} `json:"upper"`
			CntInfo *struct {
				Play    *int64 `json:"play"`
				Danmaku *int64 `json:"danmaku"`
			} `json:"cnt_info"`
			Stat *struct {
				View    *int64 `json:"view"`
				Danmaku *int64 `json:"danmaku"`
			} `json:"stat"`
		} `json:"medias"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return "", nil, nil, err
	}

	items := make([]ListItem, 0, len(payload.Medias))
	for _, m := range payload.Medias {
		if m.Bvid == "" {
			continue
		}
		items = append(items, ListItem{
			Bvid:     m.Bvid,
			Title:    m.Title,
			Pic:      NormalizeImageURL(m.Cover),
			UpName:   m.Upper.Name,
			View:     pickCount(m.CntInfo, m.Stat, true),
			Danmaku:  pickCount(m.CntInfo, m.Stat, false),
			Duration: m.Duration,
			Date:     m.FavTime,
		})
	}

	var total *int64
	if payload.Info != nil {
		total = firstInt(payload.Info.Total, payload.Info.MediaCount)
	}
	title := folder.Title
	if title == "" {
		title = "默认收藏夹"
	}
	return title, items, total, nil
}

// pickCount 复刻 `cnt_info?.play ?? stat?.view ?? 0`（点赞/弹幕的字段名不同）。
func pickCount(cntInfo *struct {
	Play    *int64 `json:"play"`
	Danmaku *int64 `json:"danmaku"`
}, stat *struct {
	View    *int64 `json:"view"`
	Danmaku *int64 `json:"danmaku"`
}, isView bool) int64 {
	if cntInfo != nil {
		if isView && cntInfo.Play != nil {
			return *cntInfo.Play
		}
		if !isView && cntInfo.Danmaku != nil {
			return *cntInfo.Danmaku
		}
	}
	if stat != nil {
		if isView && stat.View != nil {
			return *stat.View
		}
		if !isView && stat.Danmaku != nil {
			return *stat.Danmaku
		}
	}
	return 0
}

// FavFolders 取登录用户的收藏夹列表（带封面，左列切换用）。
//
// 分页版 created/list 的条目带 cover；精简版 created/list-all 没有。
// ps 上限 20，循环拉全（自建收藏夹数量有限，20 页是防御性截断）。
func (s *Service) FavFolders(ctx context.Context, cookie string) ([]FavFolder, error) {
	if cookie == "" {
		return nil, ErrBiliNotLoggedIn
	}
	mid, err := s.navMid(ctx, cookie)
	if err != nil {
		return nil, err
	}

	raw := make([]favFolderRaw, 0, 8)
	// 初值必须是「无穷大」：Node 是 Number.POSITIVE_INFINITY，第一轮才进得去。
	total := int64(math.MaxInt64)
	for pn := 1; pn <= 20 && int64(len(raw)) < total; pn++ {
		env, err := s.Client.Fetch(ctx,
			fmt.Sprintf("https://api.bilibili.com/x/v3/fav/folder/created/list?up_mid=%d&pn=%d&ps=20", mid, pn),
			FetchOptions{Cookie: cookie})
		if err != nil {
			return nil, err
		}
		var payload struct {
			Count *int64         `json:"count"`
			List  []favFolderRaw `json:"list"`
		}
		if _, err := DecodeDataInto(env, &payload); err != nil {
			return nil, err
		}
		if payload.Count != nil {
			total = *payload.Count
		} else {
			total = int64(len(raw))
		}
		if len(payload.List) == 0 {
			break
		}
		raw = append(raw, payload.List...)
	}

	folders := make([]FavFolder, 0, len(raw))
	for _, f := range raw {
		title := f.Title
		if title == "" {
			title = "默认收藏夹"
		}
		cover := ""
		if f.Cover != "" {
			cover = NormalizeImageURL(f.Cover)
		}
		folders = append(folders, FavFolder{
			ID:         f.ID,
			Title:      title,
			MediaCount: f.MediaCount,
			Cover:      cover,
		})
	}
	return folders, nil
}

// FavListVideos 取任意公开收藏夹的视频（5 分钟缓存）。
func (s *Service) FavListVideos(ctx context.Context, cookie string, fid int64, pn, ps int) ([]ListItem, *int64, error) {
	cacheKey := fmt.Sprintf("%d|%d|%d", fid, pn, ps)
	if cached, ok := s.Browse.favList.Get(cacheKey); ok {
		return cached.Items, cached.Total, nil
	}

	env, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/v3/fav/resource/list?media_id=%d&pn=%d&ps=%d&keyword=&type=0&tid=0&platform=web&order=mtime", fid, pn, ps),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, nil, err
	}
	var payload struct {
		Info *struct {
			Title      string `json:"title"`
			Total      *int64 `json:"total"`
			MediaCount *int64 `json:"media_count"`
		} `json:"info"`
		Medias []struct {
			Bvid     string `json:"bvid"`
			Title    string `json:"title"`
			Cover    string `json:"cover"`
			Duration int    `json:"duration"`
			FavTime  int64  `json:"fav_time"`
			Upper    struct {
				Name string `json:"name"`
			} `json:"upper"`
			CntInfo *struct {
				Play    *int64 `json:"play"`
				Danmaku *int64 `json:"danmaku"`
			} `json:"cnt_info"`
			Stat *struct {
				View    *int64 `json:"view"`
				Danmaku *int64 `json:"danmaku"`
			} `json:"stat"`
		} `json:"medias"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, nil, err
	}

	items := make([]ListItem, 0, len(payload.Medias))
	for _, m := range payload.Medias {
		if m.Bvid == "" {
			continue
		}
		items = append(items, ListItem{
			Bvid:     m.Bvid,
			Title:    m.Title,
			Pic:      NormalizeImageURL(m.Cover),
			UpName:   m.Upper.Name,
			View:     pickCount(m.CntInfo, m.Stat, true),
			Danmaku:  pickCount(m.CntInfo, m.Stat, false),
			Duration: m.Duration,
			Date:     m.FavTime,
		})
	}
	var total *int64
	if payload.Info != nil {
		total = firstInt(payload.Info.Total, payload.Info.MediaCount)
	}
	if len(items) > 0 {
		s.Browse.favList.Set(cacheKey, listCacheEntry{Items: items, Total: total})
	}
	return items, total, nil
}

// FavCollect 收藏 / 取消收藏视频，返回目标收藏夹。
//
// 流程：bvid → aid → 定位（或按标题创建）收藏夹 → resource/deal。
// add_media_ids / del_media_ids 必须是**逗号分隔的纯数字**：传 JSON 数组
// 字符串（带方括号）会被 B站 解析成非法参数回 -400。
func (s *Service) FavCollect(ctx context.Context, cookie, bvid string, mediaID int64, mediaIDIsNumber bool, folderTitle string, remove bool) (int64, string, error) {
	if cookie == "" {
		return 0, "", ErrBiliNotLoggedIn
	}
	csrf := ExtractCSRF(cookie)
	if csrf == "" {
		return 0, "", ErrMissingCSRF
	}

	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/view?bvid="+encodeComponent(bvid),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return 0, "", err
	}
	var view struct {
		Aid int64 `json:"aid"`
	}
	if _, err := DecodeDataInto(env, &view); err != nil {
		return 0, "", err
	}
	if view.Aid == 0 {
		return 0, "", ErrVideoNotFound
	}

	midCookie := ExtractMid(cookie)
	targetID := int64(0)
	if mediaID > 0 {
		targetID = mediaID
	}
	// mediaId 以数字传入时初始标题留空（随后从夹列表里补真名）；
	// 以字符串传入（前端「新建夹」场景）先用调用方给的标题。
	targetTitle := folderTitle
	if mediaIDIsNumber {
		targetTitle = ""
	}

	if targetID == 0 {
		folders, err := s.listAllFolders(ctx, cookie, stringToInt(midCookie))
		if err != nil {
			return 0, "", err
		}
		var existing *favFolderRaw
		for i := range folders {
			if folders[i].Title == folderTitle {
				existing = &folders[i]
				break
			}
		}
		if existing != nil {
			targetID = existing.ID
		} else if remove {
			// 取消收藏时目标夹不存在 = 本来就没收藏，别顺手建一个空夹。
			return 0, "", ErrFolderMissing
		} else {
			created, err := s.postForm(ctx,
				"https://api.bilibili.com/x/v3/fav/folder/add",
				url.Values{"title": {folderTitle}, "privacy": {"0"}, "csrf": {csrf}},
				cookie)
			if err != nil {
				return 0, "", err
			}
			var createdPayload struct {
				ID int64 `json:"id"`
			}
			if _, err := DecodeDataInto(created, &createdPayload); err != nil {
				return 0, "", err
			}
			targetID = createdPayload.ID
			targetTitle = folderTitle
		}
		if targetID == 0 {
			return 0, "", ErrCreateFolder
		}
	} else {
		folders, err := s.listAllFolders(ctx, cookie, stringToInt(midCookie))
		if err != nil {
			return 0, "", err
		}
		for i := range folders {
			if folders[i].ID == targetID {
				targetTitle = folders[i].Title
				break
			}
		}
	}

	form := url.Values{
		"rid":           {strconv.FormatInt(view.Aid, 10)},
		"type":          {"2"},
		"add_media_ids": {""},
		"del_media_ids": {""},
		"csrf":          {csrf},
	}
	if remove {
		form.Set("del_media_ids", strconv.FormatInt(targetID, 10))
	} else {
		form.Set("add_media_ids", strconv.FormatInt(targetID, 10))
	}
	if _, err := s.postForm(ctx, "https://api.bilibili.com/x/v3/fav/resource/deal", form, cookie); err != nil {
		return 0, "", err
	}
	return targetID, targetTitle, nil
}

// FavStatusOf 查询视频是否已收藏（任一自建收藏夹的 fav_state=1 即算）。
func (s *Service) FavStatusOf(ctx context.Context, cookie, bvid string) (*FavStatus, error) {
	if cookie == "" {
		return nil, ErrBiliNotLoggedIn
	}
	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/web-interface/view?bvid="+encodeComponent(bvid),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var view struct {
		Aid int64 `json:"aid"`
	}
	if _, err := DecodeDataInto(env, &view); err != nil {
		return nil, err
	}
	if view.Aid == 0 {
		return nil, ErrVideoNotFound
	}

	foldersEnv, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/v3/fav/folder/created/list-all?rid=%d&type=2&up_mid=%s", view.Aid, ExtractMid(cookie)),
		FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var payload struct {
		List []favFolderRaw `json:"list"`
	}
	if _, err := DecodeDataInto(foldersEnv, &payload); err != nil {
		return nil, err
	}
	for _, f := range payload.List {
		if f.FavState == 1 {
			return &FavStatus{Collected: true, FolderID: f.ID, FolderTitle: f.Title}, nil
		}
	}
	return &FavStatus{}, nil
}

// stringToInt 把 Cookie 里的 mid 字符串转成数字（解析失败按 0）。
func stringToInt(raw string) int64 {
	if raw == "" {
		return 0
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// postForm 发起一次表单 POST 并解析 B站 响应外壳。
//
// 写操作**不重试**：收藏/取消收藏重复投递会把刚做出的变更再翻一次，
// 比失败更难收拾（Node 侧的重试针对的是 412 风控，这里退化为直接报错）。
func (s *Service) postForm(ctx context.Context, target string, form url.Values, cookie string) (*Envelope, error) {
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, target, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Referer", "https://www.bilibili.com")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	resp, err := s.Client.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("B站 API 请求失败 [%d] %s: %s", resp.StatusCode, http.StatusText(resp.StatusCode), target)
	}
	var env Envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return nil, fmt.Errorf("B站 接口返回异常响应（非 JSON）: %s", target)
	}
	if env.Code != 0 {
		return nil, &BizError{Code: env.Code, Message: env.Message, URL: target}
	}
	return &env, nil
}
