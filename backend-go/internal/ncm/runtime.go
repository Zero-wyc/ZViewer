package ncm

import (
	"log"
	"os"
	"strings"

	"zviewer/backend/internal/ncmapi"
)

// StartBundled 决定音乐接口的来源，返回基地址与停止函数。
//
// 优先级：
//  1. 显式 NCM_API_BASE —— 运维指定外部服务（compose 的 ncm、自建
//     NeteaseCloudMusicApi、增强版），内置实现不启动；
//  2. NCM_LOOPBACK=1 —— 进程内实现改挂回环 TCP，只为能用 curl 看原始响应；
//  3. 默认 —— 进程内实现（internal/ncmapi），请求由自定义 RoundTripper 直达
//     handler，不监听端口、不起子进程、不需要 Node 运行时。
//
// 凭证始终由后端自己的 per-user 凭证库管理，与谁提供协议无关。
func StartBundled(base string) (string, func()) {
	if os.Getenv("NCM_API_BASE") != "" {
		return base, func() {}
	}
	if loopback := strings.ToLower(strings.TrimSpace(os.Getenv("NCM_LOOPBACK"))); loopback == "1" || loopback == "true" {
		if local, stop, err := ncmapi.Listen(); err == nil {
			log.Printf("[ncm] 音乐接口由进程内实现提供（回环 TCP，排障模式）: %s", local)
			return local, stop
		} else {
			log.Printf("[ncm] 回环模式启动失败，改为进程内直连: %v", err)
		}
	}
	local, stop := ncmapi.StartInProcess()
	log.Print("[ncm] 音乐接口由进程内实现提供（不监听端口）")
	return local, stop
}
