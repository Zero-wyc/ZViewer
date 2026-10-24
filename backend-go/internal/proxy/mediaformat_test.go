package proxy

import "testing"

func TestDetectMediaFormat(t *testing.T) {
	cases := map[string]MediaFormat{
		"movie.mp4": FormatMP4,
		"movie.MP4": FormatMP4,
		"a.b.mkv":   FormatMKV,
		"x.m2ts":    FormatTS,
		"x.ts":      FormatTS,
		"noext":     FormatUnknown,
		"":          FormatUnknown,
		"trailing.": FormatUnknown,
		// 未下完的临时文件不能当成可播放媒体
		"movie.mkv.part": FormatUnknown,
		"archive.zip":    FormatUnknown,
	}
	for in, want := range cases {
		if got := DetectMediaFormat(in); got != want {
			t.Errorf("DetectMediaFormat(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestContentTypeForFormat(t *testing.T) {
	cases := map[MediaFormat]string{
		FormatMP4:     "video/mp4",
		FormatMKV:     "video/x-matroska",
		FormatTS:      "video/mp2t",
		FormatUnknown: "application/octet-stream",
	}
	for in, want := range cases {
		if got := ContentTypeForFormat(in); got != want {
			t.Errorf("ContentTypeForFormat(%q) = %q, want %q", in, got, want)
		}
	}
}
