package ncm

import (
	"context"
	"net/url"
	"strconv"
	"strings"
)

// MusicUser 是点歌「用户」页使用的网易云用户摘要。
//
// 上游不同接口（搜索 / 关注 / 粉丝）返回的用户字段基本一致，但外层键不同；
// 统一在这里归一化，前端只负责展示。
type MusicUser struct {
	UserID        int64  `json:"userId"`
	Nickname      string `json:"nickname"`
	AvatarURL     string `json:"avatarUrl"`
	Signature     string `json:"signature"`
	Follows       int64  `json:"follows"`
	Followeds     int64  `json:"followeds"`
	PlaylistCount int64  `json:"playlistCount"`
}

// MusicPlaylist 是用户主页里的公开歌单摘要。
type MusicPlaylist struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Cover       string `json:"cover"`
	TrackCount  int64  `json:"trackCount"`
	CreatorID   int64  `json:"creatorId,omitempty"`
	CreatorName string `json:"creatorName,omitempty"`
	Description string `json:"description,omitempty"`
}

// MusicSong 与前端 NcmSong 完全同构，前端拿到即可直接入队。
type MusicSong struct {
	SongID     int64  `json:"songId"`
	Name       string `json:"name"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	Cover      string `json:"cover"`
	DurationMs int64  `json:"durationMs"`
	VIP        bool   `json:"vip"`
}

// SearchUsers 搜索网易云用户（cloudsearch type=1002）。
func (s *Service) SearchUsers(ctx context.Context, keywords string, limit, offset int, cookie string) ([]MusicUser, int64, error) {
	query := url.Values{}
	query.Set("keywords", keywords)
	query.Set("type", "1002")
	query.Set("limit", strconv.Itoa(limit))
	query.Set("offset", strconv.Itoa(offset))
	result, err := s.Call(ctx, "/cloudsearch?"+query.Encode(), cookie)
	if err == nil {
		if users, total, ok := parseUserSearch(result.Body); ok {
			return users, total, nil
		}
	}
	fallbackErr := err
	fallback, fallbackCallErr := s.Call(ctx, "/search?"+query.Encode(), cookie)
	if fallbackCallErr != nil {
		if fallbackErr != nil {
			return nil, 0, fallbackErr
		}
		return nil, 0, fallbackCallErr
	}
	users, total, _ := parseUserSearch(fallback.Body)
	return users, total, nil
}

// UserFollows 读取某个用户关注的人（uid 由调用方解析；空则用当前账号）。
func (s *Service) UserFollows(ctx context.Context, uid int64, limit, offset int, order bool, cookie string) ([]MusicUser, bool, error) {
	query := url.Values{}
	query.Set("uid", strconv.FormatInt(uid, 10))
	query.Set("limit", strconv.Itoa(limit))
	query.Set("offset", strconv.Itoa(offset))
	query.Set("order", strconv.FormatBool(order))
	result, err := s.Call(ctx, "/user/follows?"+query.Encode(), cookie)
	if err != nil {
		return nil, false, err
	}
	root := musicObject(result.Body)
	users := musicUsers(root["follow"])
	return users, musicBool(root["more"]), nil
}

// UserFolloweds 读取某个用户的粉丝列表。
func (s *Service) UserFolloweds(ctx context.Context, uid int64, limit, offset int, cookie string) ([]MusicUser, bool, error) {
	query := url.Values{}
	query.Set("uid", strconv.FormatInt(uid, 10))
	query.Set("limit", strconv.Itoa(limit))
	query.Set("offset", strconv.Itoa(offset))
	result, err := s.Call(ctx, "/user/followeds?"+query.Encode(), cookie)
	if err != nil {
		return nil, false, err
	}
	root := musicObject(result.Body)
	users := musicUsers(root["followeds"])
	return users, musicBool(root["more"]), nil
}

// UserPlaylists 读取某个用户的公开歌单（自建 + 收藏，取决于隐私设置）。
func (s *Service) UserPlaylists(ctx context.Context, uid int64, limit, offset int, cookie string) ([]MusicPlaylist, bool, error) {
	query := url.Values{}
	query.Set("uid", strconv.FormatInt(uid, 10))
	query.Set("limit", strconv.Itoa(limit))
	query.Set("offset", strconv.Itoa(offset))
	result, err := s.Call(ctx, "/user/playlist?"+query.Encode(), cookie)
	if err != nil {
		return nil, false, err
	}
	root := musicObject(result.Body)
	raw, _ := root["playlist"].([]any)
	out := make([]MusicPlaylist, 0, len(raw))
	for _, item := range raw {
		playlist := musicObject(item)
		id := musicNumber(playlist["id"])
		if id <= 0 {
			continue
		}
		creator := musicObject(playlist["creator"])
		out = append(out, MusicPlaylist{
			ID:          id,
			Name:        musicText(playlist["name"]),
			Cover:       musicText(playlist["coverImgUrl"]),
			TrackCount:  musicNumber(playlist["trackCount"]),
			CreatorID:   musicNumber(creator["userId"]),
			CreatorName: musicText(creator["nickname"]),
			Description: musicText(playlist["description"]),
		})
	}
	return out, musicBool(root["more"]), nil
}

// PlaylistSongs 解析歌单歌曲并归一化成前端队列条目。
//
// 复用 /playlist/track/all 的两段式实现（先取 trackIds，再批量取详情），
// 所以这里不用重复处理网易云的截断逻辑。
func (s *Service) PlaylistSongs(ctx context.Context, playlistID int64, limit, offset int, cookie string) ([]MusicSong, error) {
	query := url.Values{}
	query.Set("id", strconv.FormatInt(playlistID, 10))
	query.Set("limit", strconv.Itoa(limit))
	query.Set("offset", strconv.Itoa(offset))
	result, err := s.Call(ctx, "/playlist/track/all?"+query.Encode(), cookie)
	if err != nil {
		return nil, err
	}
	root := musicObject(result.Body)
	raw, _ := root["songs"].([]any)
	out := make([]MusicSong, 0, len(raw))
	for _, item := range raw {
		song := musicObject(item)
		id := musicNumber(song["id"])
		if id <= 0 {
			continue
		}
		album := musicObject(song["al"])
		if len(album) == 0 {
			album = musicObject(song["album"])
		}
		artists := musicNames(song["ar"])
		if len(artists) == 0 {
			artists = musicNames(song["artists"])
		}
		duration := musicNumber(song["dt"])
		if duration <= 0 {
			duration = musicNumber(song["duration"])
		}
		out = append(out, MusicSong{
			SongID:     id,
			Name:       musicText(song["name"]),
			Artist:     strings.Join(artists, " / "),
			Album:      musicText(album["name"]),
			Cover:      musicText(album["picUrl"]),
			DurationMs: duration,
			VIP:        feeIsVIP(musicNumber(song["fee"])),
		})
	}
	return out, nil
}

// CurrentAccountUID 用当前生效凭证取网易云账号 uid。
//
// 凭证表存的是 ZViewer 用户 id，网易云 uid 只能从 /user/account 取；
// 关注/粉丝接口默认查看「当前账号」，所以需要这一层解析。
func (s *Service) CurrentAccountUID(ctx context.Context, cookie string) (int64, error) {
	result, err := s.Call(ctx, "/user/account", cookie)
	if err != nil {
		return 0, err
	}
	root := musicObject(result.Body)
	account := musicObject(root["account"])
	if uid := musicNumber(account["id"]); uid > 0 {
		return uid, nil
	}
	profile := musicObject(root["profile"])
	return musicNumber(profile["userId"]), nil
}

// parseUserSearch 解析 cloudsearch / search 的用户搜索结果。
func parseUserSearch(body any) ([]MusicUser, int64, bool) {
	root := musicObject(body)
	result, ok := root["result"].(map[string]any)
	if !ok {
		return nil, 0, false
	}
	users := musicUsers(result["userprofiles"])
	if users == nil {
		return nil, 0, false
	}
	total := musicNumber(result["userprofileCount"])
	if total <= 0 {
		total = int64(len(users))
	}
	return users, total, true
}

// musicUsers 归一化上游用户数组。
func musicUsers(raw any) []MusicUser {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]MusicUser, 0, len(list))
	for _, item := range list {
		user := musicObject(item)
		uid := musicNumber(user["userId"])
		if uid <= 0 {
			continue
		}
		out = append(out, MusicUser{
			UserID:        uid,
			Nickname:      musicText(user["nickname"]),
			AvatarURL:     musicText(user["avatarUrl"]),
			Signature:     musicText(user["signature"]),
			Follows:       musicNumber(user["follows"]),
			Followeds:     musicNumber(user["followeds"]),
			PlaylistCount: musicNumber(user["playlistCount"]),
		})
	}
	return out
}

// musicNames 取 [{name}] 数组里的名字（歌手/艺人字段）。
func musicNames(raw any) []string {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		object := musicObject(item)
		if name := musicText(object["name"]); name != "" {
			out = append(out, name)
		}
	}
	return out
}

func musicObject(value any) map[string]any {
	object, _ := value.(map[string]any)
	return object
}

func musicText(value any) string {
	text, _ := value.(string)
	return text
}

func musicNumber(value any) int64 {
	number, _ := toFloat(value)
	return int64(number)
}

func musicBool(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func feeIsVIP(fee int64) bool {
	return fee == 1 || fee == 4
}
