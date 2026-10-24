package bilibili

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DanmakuItem 是一条弹幕，字段与 danmaku.ts 的 BilibiliDanmakuItem 对齐。
type DanmakuItem struct {
	ID       string  `json:"id"`
	Content  string  `json:"content"`
	Time     float64 `json:"time"`
	Mode     int     `json:"mode"`
	Color    int     `json:"color"`
	Size     int     `json:"size"`
	SendTime *int64  `json:"sendTime,omitempty"`
}

// danmakuItemRe 匹配 `<d p="参数串">正文</d>`。
//
// 正文用 [^<]* 而不是 .*：B站 会下发 `&lt;` 之类的转义，
// 真出现裸 `<` 说明 XML 本身就坏了，此时宁可少匹配一条也不要把标签吃掉。
var danmakuItemRe = regexp.MustCompile(`<d p="([^"]+)">([^<]*)</d>`)

// GetDanmaku 拉取并解析 B站 弹幕 XML。
//
// cid 是视频分 P 的 cid（不是 aid、也不是 bvid）。
func (s *Service) GetDanmaku(ctx context.Context, cid int64) ([]DanmakuItem, error) {
	url := "https://api.bilibili.com/x/v1/dm/list.so?oid=" + strconv.FormatInt(cid, 10)
	body, _, err := s.Client.FetchRaw(ctx, url, FetchOptions{})
	if err != nil {
		var se *StatusError
		if errors.As(err, &se) {
			// 文案与 danmaku.ts 一致，前端会直接展示。
			return nil, fmt.Errorf("获取 B站 弹幕失败 [%d]", se.Code)
		}
		return nil, err
	}
	return ParseDanmakuXML(string(body)), nil
}

// ParseDanmakuXML 从弹幕 XML 文本里抽出弹幕列表。
//
// 单独导出便于单测：真实响应受 CDN 缓存影响，内容不稳定，不适合当断言基准。
func ParseDanmakuXML(xml string) []DanmakuItem {
	matches := danmakuItemRe.FindAllStringSubmatch(xml, -1)
	items := make([]DanmakuItem, 0, len(matches))
	nowMillis := int64(-1)
	for _, m := range matches {
		parts := strings.Split(m[1], ",")
		if len(parts) < 4 {
			continue
		}
		// p 属性字段序：time,mode,size,color,sendTime,pool,userHash,dmid
		sendTime := (*int64)(nil)
		if len(parts) > 4 && parts[4] != "" {
			if v, ok := parseIntSafe(parts[4]); ok {
				// 保留字段：parseInt 失败时 TS 得到 NaN→JSON null，
				// 这里退化成不输出，避免吐出 0 这种会被误读成「1970 年」的值。
				sendTime = &v
			}
		}
		id := ""
		if len(parts) > 7 {
			id = parts[7]
		}
		if id == "" {
			// 缺 dmid 时用时间戳+序号兜底，保证 key 唯一。
			if nowMillis < 0 {
				nowMillis = time.Now().UnixMilli()
			}
			id = strconv.FormatInt(nowMillis, 10) + "-" + strconv.Itoa(len(items))
		}
		items = append(items, DanmakuItem{
			ID:       id,
			Content:  decodeXMLEntities(m[2]),
			Time:     parseFloatSafe(parts[0]),
			Mode:     parseIntOrZero(parts[1]),
			Size:     parseIntOrZero(parts[2]),
			Color:    parseIntOrZero(parts[3]),
			SendTime: sendTime,
		})
	}
	return items
}

// decodeXMLEntities 解码五个基础实体。
//
// 顺序刻意与 danmaku.ts 一致（&amp; 最先）：这意味着 `&amp;lt;` 会被解成 `<`
// 而不是 `&lt;`，属于原实现的双重解码。这里保留同样行为，
// 因为弹幕正文会直接上屏，两端输出不一致比"正确"更重要。
func decodeXMLEntities(s string) string {
	if !strings.Contains(s, "&") {
		return s
	}
	r := strings.NewReplacer(
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
	)
	return r.Replace(s)
}

// parseIntSafe 解析十进制整数（等价 parseInt(x, 10) 对纯数字串的行为）。
func parseIntSafe(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func parseIntOrZero(s string) int {
	if v, ok := parseIntSafe(s); ok {
		return int(v)
	}
	return 0
}

// parseFloatSafe 解析浮点数，失败返回 0。
func parseFloatSafe(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}
