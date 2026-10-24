package proxy

import (
	"errors"
	"testing"
)

func TestParseRangeHeader(t *testing.T) {
	const size = int64(1000)
	cases := []struct {
		name     string
		header   string
		fileSize int64
		maxChunk int64
		want     *Range
		wantErr  bool
	}{
		{name: "无 Range", header: "", fileSize: size},
		{name: "开放式", header: "bytes=0-", fileSize: size, maxChunk: MaxRangeChunkBytes,
			want: &Range{0, 999}},
		{name: "显式区间", header: "bytes=100-200", fileSize: size, maxChunk: MaxRangeChunkBytes,
			want: &Range{100, 200}},
		{name: "尾部 suffix", header: "bytes=-500", fileSize: size, maxChunk: MaxRangeChunkBytes,
			want: &Range{500, 999}},
		{name: "suffix 超过文件长度", header: "bytes=-5000", fileSize: size, maxChunk: MaxRangeChunkBytes,
			want: &Range{0, 999}},
		{name: "suffix 受分片上限约束仍取尾部", header: "bytes=-500", fileSize: size, maxChunk: 100,
			want: &Range{900, 999}},
		{name: "开放式被截断为分片", header: "bytes=0-", fileSize: 20 << 20, maxChunk: MaxRangeChunkBytes,
			want: &Range{0, MaxRangeChunkBytes - 1}},
		{name: "显式大区间也被收敛", header: "bytes=0-15000000", fileSize: 20 << 20, maxChunk: MaxRangeChunkBytes,
			want: &Range{0, MaxRangeChunkBytes - 1}},
		{name: "空 filesize", header: "bytes=0-", fileSize: 0, wantErr: true},
		{name: "起点越界", header: "bytes=2000-", fileSize: size, wantErr: true},
		{name: "终点小于起点", header: "bytes=500-100", fileSize: size, wantErr: true},
		{name: "非法格式", header: "bytes=abc", fileSize: size, wantErr: true},
		{name: "多段不支持", header: "bytes=0-10,20-30", fileSize: size, wantErr: true},
		{name: "缺单位", header: "0-100", fileSize: size, wantErr: true},
		{name: "suffix 为 0", header: "bytes=-0", fileSize: size, wantErr: true},
		{name: "两端都空", header: "bytes=-", fileSize: size, wantErr: true},
		{name: "终点超界自动收敛", header: "bytes=900-5000", fileSize: size, maxChunk: MaxRangeChunkBytes,
			want: &Range{900, 999}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ParseRangeHeader(c.header, c.fileSize, c.maxChunk)
			if c.wantErr {
				if !errors.Is(err, ErrRangeInvalid) {
					t.Fatalf("期望 ErrRangeInvalid，实际 %v（%+v）", err, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if c.want == nil {
				if got != nil {
					t.Fatalf("期望 nil，实际 %+v", got)
				}
				return
			}
			if got == nil || *got != *c.want {
				t.Fatalf("期望 %+v，实际 %+v", *c.want, got)
			}
		})
	}
}

func TestClampRangeHeader(t *testing.T) {
	const chunk = MaxRangeChunkBytes
	cases := []struct{ name, in, want string }{
		{"空值", "", ""},
		{"开放式收敛", "bytes=0-", "bytes=0-8388607"},
		{"开放式非零起点", "bytes=1024-", "bytes=1024-8389631"},
		// 显式 end 必须原样透传：dash.js 的 4K segment 常超过 8MB，
		// 截断会让 fragment 不完整、播放持续缓冲
		{"显式区间不截断", "bytes=0-15000000", "bytes=0-15000000"},
		{"尾部 suffix 透传", "bytes=-500", "bytes=-500"},
		{"多段透传", "bytes=0-10,20-30", "bytes=0-10,20-30"},
		{"非法透传", "bytes=abc", "bytes=abc"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ClampRangeHeader(c.in, chunk); got != c.want {
				t.Fatalf("ClampRangeHeader(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestClampRangeHeaderDisabled(t *testing.T) {
	// maxChunk<=0 表示不限制（AVPlayer 专用流要完整范围）
	if got := ClampRangeHeader("bytes=0-", 0); got != "bytes=0-" {
		t.Fatalf("不限速时应原样返回，实际 %q", got)
	}
}
