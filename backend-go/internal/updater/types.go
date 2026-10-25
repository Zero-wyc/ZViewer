// Package updater 是「网页端一键更新」的 Go 实现。
//
// 对应 Node 侧 `services/updater/index.ts` + `services/updater/script-templates.ts`
// + `routes/updater.ts`。行为要点：
//
//   - 版本判定走 GitHub Releases（正式版 / 预发布版两条分支），下载走可选的
//     CDN 前缀；检查更新本身**不走** CDN（避免共享 IP 触发 GitHub 限流）。
//   - 真正落地文件不靠本进程，而是生成一份平台脚本（bat / sh）后 detached
//     启动它：脚本负责停服 → 备份 config → 覆盖文件 → 恢复 config → 重启。
//     本进程随后就被脚本杀掉，因此「更新成功」只能表示脚本已拉起。
//   - 桌面 GUI 托管（ZVIEWER_DESKTOP=1）时整套端点由 handler 层拦成 409，
//     本包不做该判断。
package updater

import "encoding/json"

// 更新阶段。与 Node 的 UpdateStageEvent.stage 一一对应。
const (
	StageDownloading = "downloading"
	StageExtracting  = "extracting"
	StageStarting    = "starting"
	StageDone        = "done"
	StageError       = "error"
)

// UpdateInfo 是 GET /api/system/update/check 的 info 负载。
//
// 字段顺序刻意与 Node 的对象字面量一致：对拍按字节比对 JSON，
// 顺序变了会立刻暴露。
type UpdateInfo struct {
	CurrentVersion string `json:"currentVersion"`
	RemoteVersion  string `json:"remoteVersion"`
	HasUpdate      bool   `json:"hasUpdate"`
	ReleaseNotes   string `json:"releaseNotes"`
	ReleaseURL     string `json:"releaseUrl"`
	PublishedAt    string `json:"publishedAt"`
	DownloadURL    string `json:"downloadUrl"`
	IsPrerelease   bool   `json:"isPrerelease"`
	AssetName      string `json:"assetName"`
	AssetSize      int64  `json:"assetSize"`
	// Source 是本次结果的实际来源（gitcode / github）。按设置的源取数，
	// 不做静默回退：GitCode 失败时整个检查更新报错，由用户自己决定是否换源。
	Source string `json:"source"`
}

// Result 是 apply / upload 的返回体（也是 SSE 里 done 事件的语义来源）。
type Result struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// StageEvent 是一次进度事件。
//
// 不同 stage 的字段集合不同（downloading 带 received/total，done/error 带
// message，extracting/starting 只有 stage），所以序列化必须按 stage 分派 ——
// 用 omitempty 会漏掉 `received: 0`，前端进度条会从 0 直接跳到完成。
type StageEvent struct {
	Stage    string
	Received int64
	Total    int64
	Message  string
}

// MarshalJSON 按 stage 输出对应形状，字段顺序与 Node 一致。
func (e StageEvent) MarshalJSON() ([]byte, error) {
	switch e.Stage {
	case StageDownloading:
		return json.Marshal(struct {
			Stage    string `json:"stage"`
			Received int64  `json:"received"`
			Total    int64  `json:"total"`
		}{e.Stage, e.Received, e.Total})
	case StageDone, StageError:
		return json.Marshal(struct {
			Stage   string `json:"stage"`
			Message string `json:"message"`
		}{e.Stage, e.Message})
	default:
		return json.Marshal(struct {
			Stage string `json:"stage"`
		}{e.Stage})
	}
}

// cdnConfig 是 CDN 加速配置快照（每次更新流程读一次 settings 得到）。
type cdnConfig struct {
	proxyURL string
}

// githubRelease / githubAsset 只声明用得到的字段。
//
// body / published_at 在 GitHub 上可能为 null，用指针接住，
// 避免 null 让整个反序列化失败。GitCode 的差异（无 html_url / published_at，
// 改用 created_at + release_status）在 source.go 的 normalize 里补齐。
type githubRelease struct {
	TagName     string  `json:"tag_name"`
	Name        *string `json:"name"`
	Body        *string `json:"body"`
	HTMLURL     string  `json:"html_url"`
	PublishedAt *string `json:"published_at"`
	CreatedAt   string  `json:"created_at"`
	Prerelease  bool    `json:"prerelease"`
	// ReleaseStatus 是 GitCode 独有字段：pre / latest。
	ReleaseStatus string        `json:"release_status"`
	Assets        []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
	// Type 是 GitCode 独有字段：attach（上传附件）/ source（源码包）。
	Type string `json:"type"`
}
