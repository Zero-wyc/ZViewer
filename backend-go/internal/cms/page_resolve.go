package cms

import (
	"context"
	"html"
	"log"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// 采集站「分享页」二次解析。
//
// 苹果 CMS V10 的采集接口会把同一部剧拆成多条线路，其中带 `_m3u8` 后缀的
// 线路给的是真 m3u8，而第 0 条线路（名字叫 `feifan` / `dytt` / `liangzi` 这类）
// 给的是一张分享页：`https://vod.example.com/share/<hash>`。
//
// 分享页本身是 text/html，真链写在内联脚本里，各站变量名还不统一：
//
//	const url = "/20230329/10135_3e7ea150/index.m3u8?sign=b761e5df..."
//	var main = "/20220404/794_e47294f5/index.m3u8?sign=68f4afb9..."
//
// 直接把分享页当媒体地址交给播放器，浏览器下载到的是 HTML，表现是
// 「能加载、黑屏 / 时长 0」。这里把分享页抓下来，从脚本里捞真实地址。

const (
	// pageResolveTimeout 是抓分享页的等待上限。分享页通常 1-3KB，8s 足够。
	pageResolveTimeout = 8 * time.Second
	// pageResolveMaxBody 兜住异常大页面（整个 m3u8 也就几十 KB，
	// 这里给 1MiB 是防「站点把视频 base64 塞进 HTML」这种极端情况）。
	pageResolveMaxBody = 1 << 20
)

var (
	// 引号包裹的绝对媒体地址。JSON 里的 `\/` 已在匹配前反转义。
	absMediaPattern = regexp.MustCompile(
		`(?i)["'](https?://[^"'\s<>]+?\.(?:m3u8|mp4|flv|mkv)(?:\?[^"'\s<>]*)?)["']`)
	// 引号包裹的站内相对地址。
	relMediaPattern = regexp.MustCompile(
		`(?i)["'](/[^"'\s<>]+?\.(?:m3u8|mp4|flv|mkv)(?:\?[^"'\s<>]*)?)["']`)
)

// resolvePlayablePage 判断 link 是否已经是媒体地址；不是则把它当播放页抓下来，
// 从页面里提取真实媒体地址。
//
// 返回 ok=false 表示「不是媒体地址，也没能从页面里找到」——调用方应保持原样，
// 不要把错误升级成解析失败：行为与改造前一致，只是多了成功的可能。
func resolvePlayablePage(
	ctx context.Context, link string, headers map[string]string,
) (string, MediaFormat, bool) {
	if format := DetectMediaFormat(link); format != FormatUnknown {
		return link, format, true
	}

	result := fetchText(ctx, link, headers, pageResolveTimeout)
	if result.Status < 200 || result.Status >= 300 || result.Body == "" {
		log.Printf("[cms] 分享页解析跳过 status=%d len=%d err=%s url=%s",
			result.Status, len(result.Body), result.Error, link)
		return "", FormatUnknown, false
	}
	body := result.Body
	if len(body) > pageResolveMaxBody {
		body = body[:pageResolveMaxBody]
	}
	// JSON 内联脚本会把斜杠转义成 `\/`，HTML 又会把 & 转义成 `&amp;`；
	// 两种转义都要还原，否则要么匹配不到，要么签名参数被截断。
	body = strings.ReplaceAll(body, `\/`, "/")
	body = html.UnescapeString(body)

	if match := absMediaPattern.FindStringSubmatch(body); len(match) > 1 {
		return match[1], DetectMediaFormat(match[1]), true
	}
	if match := relMediaPattern.FindStringSubmatch(body); len(match) > 1 {
		base, err := url.Parse(link)
		if err != nil {
			return "", FormatUnknown, false
		}
		ref, err := url.Parse(match[1])
		if err != nil {
			return "", FormatUnknown, false
		}
		absolute := base.ResolveReference(ref).String()
		return absolute, DetectMediaFormat(absolute), true
	}
	return "", FormatUnknown, false
}
