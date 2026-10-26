package room

import (
	"net/url"
	"strings"
)

// Strip device-local image proxies from the wire and newly persisted metadata.
// Legacy rows are repaired in responses, without rewriting the user's queue.
func portableMusicCover(source string) string {
	candidate := source
	for depth := 0; depth < 5; depth++ {
		if strings.HasPrefix(candidate, "//") {
			candidate = "https:" + candidate
		}
		parsed, err := url.Parse(candidate)
		if err != nil || (parsed.Scheme != "" && parsed.Scheme != "http" && parsed.Scheme != "https") {
			return source
		}
		host := strings.ToLower(parsed.Hostname())
		for _, domain := range []string{"hdslb.com", "biliimg.com", "bilivideo.com", "bilibili.com"} {
			if host == domain || strings.HasSuffix(host, "."+domain) {
				parsed.Scheme = "https"
				return parsed.String()
			}
		}
		if !strings.HasSuffix(parsed.Path, "/api/stream/proxy-image") {
			return source
		}
		candidate = parsed.Query().Get("url")
		if candidate == "" {
			return source
		}
	}
	return source
}
