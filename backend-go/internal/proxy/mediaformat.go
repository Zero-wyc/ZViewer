package proxy

import "strings"

// MediaFormat 是容器格式的归一化枚举（对应 mediaFormat.ts 的 MediaFormat）。
type MediaFormat string

const (
	FormatMP4     MediaFormat = "mp4"
	FormatWebm    MediaFormat = "webm"
	FormatMKV     MediaFormat = "mkv"
	FormatAVI     MediaFormat = "avi"
	FormatFLV     MediaFormat = "flv"
	FormatWMV     MediaFormat = "wmv"
	FormatMOV     MediaFormat = "mov"
	FormatTS      MediaFormat = "ts"
	FormatUnknown MediaFormat = "unknown"
)

var formatByExt = map[string]MediaFormat{
	"mp4":  FormatMP4,
	"m4v":  FormatMP4,
	"webm": FormatWebm,
	"mkv":  FormatMKV,
	"avi":  FormatAVI,
	"flv":  FormatFLV,
	"wmv":  FormatWMV,
	"mov":  FormatMOV,
	"m2ts": FormatTS,
	"ts":   FormatTS,
}

var contentTypeByFormat = map[MediaFormat]string{
	FormatMP4:     "video/mp4",
	FormatWebm:    "video/webm",
	FormatMKV:     "video/x-matroska",
	FormatAVI:     "video/x-msvideo",
	FormatFLV:     "video/x-flv",
	FormatWMV:     "video/x-ms-wmv",
	FormatMOV:     "video/quicktime",
	FormatTS:      "video/mp2t",
	FormatUnknown: "application/octet-stream",
}

// DetectMediaFormat 按扩展名判断容器格式。
//
// 只认最后一个点后面那段，且点不能在末尾（`a.mkv.tmp` 之类要落到 unknown，
// 否则会把未下完的临时文件当成可播放媒体）。
func DetectMediaFormat(filename string) MediaFormat {
	if filename == "" {
		return FormatUnknown
	}
	idx := strings.LastIndex(filename, ".")
	if idx < 0 || idx == len(filename)-1 {
		return FormatUnknown
	}
	if f, ok := formatByExt[strings.ToLower(filename[idx+1:])]; ok {
		return f
	}
	return FormatUnknown
}

// ContentTypeForFormat 返回该容器对应的 MIME。
//
// 上游（OpenList 的 raw_url 指向各家网盘）经常把 Content-Type 报成
// application/octet-stream，播放器据此判断会用错解码器；这里按扩展名兜底。
func ContentTypeForFormat(f MediaFormat) string {
	if ct, ok := contentTypeByFormat[f]; ok {
		return ct
	}
	return "application/octet-stream"
}
