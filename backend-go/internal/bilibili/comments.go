package bilibili

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
)

// 评论区：主楼（reply/main）+ 楼中楼（reply/reply）。
//
// 对应 bilibili-comments.routes.ts 的服务层部分。两条链路都依赖
// 「bvid → aid」缓存与 buvid 风控 Cookie，所以放在同一个文件里。

// CommentsResult 是主楼评论的一次分页。
type CommentsResult struct {
	Total        int64
	Replies      []CommentItem
	Next         *int64
	LoginLimited bool
}

// rawReply 是 reply/main 与 reply/reply 的原始回复结构（字段子集）。
type rawReply struct {
	Rpid   int64 `json:"rpid"`
	Mid    int64 `json:"mid"`
	Like   int64 `json:"like"`
	Rcount int64 `json:"rcount"`
	Ctime  int64 `json:"ctime"`
	Member struct {
		Uname  string `json:"uname"`
		Avatar string `json:"avatar"`
	} `json:"member"`
	Content struct {
		Message string `json:"message"`
		Emote   map[string]struct {
			URL string `json:"url"`
		} `json:"emote"`
	} `json:"content"`
	ReplyControl struct {
		Location string `json:"location"`
	} `json:"reply_control"`
}

// ipLocationPattern 去掉「IP属地：」前缀，前端只显示地名。
var ipLocationPattern = regexp.MustCompile(`^IP属地[:：]\s*`)

// mapReply 把原始回复归一化成前端结构；rpid 缺失的条目丢弃。
func mapReply(raw rawReply) (CommentItem, bool) {
	if raw.Rpid == 0 {
		return CommentItem{}, false
	}
	emote := make(map[string]string, len(raw.Content.Emote))
	for key, value := range raw.Content.Emote {
		if value.URL != "" {
			emote[key] = NormalizeImageURL(value.URL)
		}
	}
	return CommentItem{
		Rpid:       raw.Rpid,
		Mid:        raw.Mid,
		Name:       raw.Member.Uname,
		Avatar:     NormalizeImageURL(raw.Member.Avatar),
		Content:    raw.Content.Message,
		Time:       raw.Ctime,
		Like:       raw.Like,
		ReplyCount: raw.Rcount,
		Emote:      emote,
		Location:   ipLocationPattern.ReplaceAllString(raw.ReplyControl.Location, ""),
	}, true
}

// Comments 取主楼评论。
//
// reply/main 需要 WBI 签名 + buvid cookie：少了 buvid 会直接命中 -352 风控。
// 未登录游客 B站 只开放前 3 条主楼（is_end 提前为 true），登录态才完整分页，
// 因此响应里要带 loginLimited 让前端提示「登录后查看全部」。
func (s *Service) Comments(ctx context.Context, bvid, cookie string, mode int, next int64) (*CommentsResult, error) {
	commentCookie := s.commentCookie(cookie)
	aid, replyCount, err := s.resolveAid(ctx, bvid, commentCookie)
	if err != nil {
		return nil, err
	}

	imgKey, subKey, err := s.WBI.Keys(ctx, commentCookie)
	if err != nil {
		return nil, err
	}
	signed := SignParams(NewParams().
		Set("oid", strconv.FormatInt(aid, 10)).
		Set("type", "1").
		Set("mode", strconv.Itoa(mode)).
		Set("next", strconv.FormatInt(next, 10)).
		Set("ps", "20").
		Set("plat", "1").
		Set("web_location", "1315875"), imgKey, subKey)

	env, err := s.Client.Fetch(ctx,
		"https://api.bilibili.com/x/v2/reply/main?"+signed.Encode(),
		FetchOptions{Cookie: commentCookie})
	if err != nil {
		return nil, err
	}
	var payload struct {
		Cursor *struct {
			AllCount int64 `json:"all_count"`
			Next     int64 `json:"next"`
			IsEnd    bool  `json:"is_end"`
		} `json:"cursor"`
		Replies []rawReply `json:"replies"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return nil, err
	}

	result := &CommentsResult{
		Total:        replyCount,
		Replies:      make([]CommentItem, 0, len(payload.Replies)),
		LoginLimited: cookie == "",
	}
	if payload.Cursor != nil {
		result.Total = payload.Cursor.AllCount
		// is_end 为真时不再给游标：前端据此停止「加载更多」。
		if !payload.Cursor.IsEnd && payload.Cursor.Next > 0 {
			nextCursor := payload.Cursor.Next
			result.Next = &nextCursor
		}
	}
	for _, raw := range payload.Replies {
		if item, ok := mapReply(raw); ok {
			result.Replies = append(result.Replies, item)
		}
	}
	return result, nil
}

// CommentReplies 取楼中楼回复（旧版 pn 分页，匿名可用）。
func (s *Service) CommentReplies(ctx context.Context, bvid, cookie string, rpid int64, pn, ps int) (int64, []CommentItem, error) {
	commentCookie := s.commentCookie(cookie)
	aid, _, err := s.resolveAid(ctx, bvid, commentCookie)
	if err != nil {
		return 0, nil, err
	}
	env, err := s.Client.Fetch(ctx,
		fmt.Sprintf("https://api.bilibili.com/x/v2/reply/reply?type=1&oid=%d&root=%d&pn=%d&ps=%d", aid, rpid, pn, ps),
		FetchOptions{Cookie: commentCookie})
	if err != nil {
		return 0, nil, err
	}
	var payload struct {
		Page *struct {
			Count int64 `json:"count"`
		} `json:"page"`
		Replies []rawReply `json:"replies"`
	}
	if _, err := DecodeDataInto(env, &payload); err != nil {
		return 0, nil, err
	}
	var total int64
	if payload.Page != nil {
		total = payload.Page.Count
	}
	replies := make([]CommentItem, 0, len(payload.Replies))
	for _, raw := range payload.Replies {
		if item, ok := mapReply(raw); ok {
			replies = append(replies, item)
		}
	}
	return total, replies, nil
}

// commentCookie 组装评论请求 Cookie：用户登录态 + buvid。
//
// buvid 是游客风控的必需品（reply/main 缺它会 -352），登录态下也带上，
// 与 Node 的 buildBiliCommentCookie 完全一致。
func (s *Service) commentCookie(userCookie string) string {
	buvid := s.buvidCookie()
	switch {
	case userCookie != "" && buvid != "":
		return userCookie + "; " + buvid
	case userCookie != "":
		return userCookie
	default:
		return buvid
	}
}

// buvidCookie 取 finger/spi 下发的 buvid3/buvid4，进程内只取一次。
//
// 失败静默：取不到时靠用户登录 Cookie 兜底，不要因为风控 Cookie 拿不到
// 就让整页评论空白。
func (s *Service) buvidCookie() string {
	s.Browse.buvidMu.Lock()
	defer s.Browse.buvidMu.Unlock()
	if s.Browse.buvid != "" {
		return s.Browse.buvid
	}
	resp, body, err := s.rawGet(context.Background(), "https://api.bilibili.com/x/frontend/finger/spi", "")
	if err != nil {
		return ""
	}
	// 只关心响应头之外的东西；body 读完即释放。
	_ = resp

	var payload struct {
		Data struct {
			B3 string `json:"b_3"`
			B4 string `json:"b_4"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	if payload.Data.B3 == "" {
		return ""
	}
	cookie := "buvid3=" + payload.Data.B3
	if payload.Data.B4 != "" {
		cookie += "; buvid4=" + payload.Data.B4
	}
	s.Browse.buvid = cookie
	return cookie
}

// resolveAid 把 bvid 换成 aid 并缓存 10 分钟（主楼/楼中楼都要 oid）。
func (s *Service) resolveAid(ctx context.Context, bvid, cookie string) (int64, int64, error) {
	if cached, ok := s.Browse.aid.Get(bvid); ok {
		return cached.Aid, cached.Reply, nil
	}
	info, err := s.GetVideoInfo(ctx, bvid, cookie)
	if err != nil {
		return 0, 0, err
	}
	if info == nil || info.Aid == 0 {
		return 0, 0, ErrVideoNotFound
	}
	var reply int64
	if info.Stat != nil {
		reply = info.Stat.Reply
	}
	s.Browse.aid.Set(bvid, aidInfo{Aid: info.Aid, Reply: reply})
	return info.Aid, reply, nil
}
