package bilibili

import (
	"bytes"
	"compress/flate"
	"testing"
)

// 弹幕 XML 的解析全部集中在一个正则 + 一轮实体解码上，
// 真实响应的内容不稳定（受 CDN 缓存与弹幕池影响），不适合当断言基准，
// 所以这里用手写 XML 覆盖各类畸形输入。
const sampleDanmakuXML = `<?xml version="1.0" encoding="UTF-8"?><i>
<chatserver>chat.bilibili.com</chatserver><chatid>170001</chatid>
<d p="12.345,1,25,16777215,1700000000,0,abc123,987654321">普通弹幕</d>
<d p="0.5,5,18,255,0,0,def456,987654322">顶部 &amp; 尖括号 &lt;tag&gt; 引号 &quot;q&quot; 单引号 &#39;s&#39;</d>
<d p="1.0,1,25,16777215">只有四段字段仍应保留（少于四段才丢）</d>
<d p="2.0,4,18,65280,1700000001,0,ghi789,">缺 dmid</d>
<d p="3.0,1,25">只有三段也要丢弃</d>
</i>`

func TestParseDanmakuXML(t *testing.T) {
	items := ParseDanmakuXML(sampleDanmakuXML)

	// 5 条里只有 3 段字段那条要丢弃；4 段的保留（与 danmaku.ts 的 `parts.length < 4` 一致）。
	if len(items) != 4 {
		t.Fatalf("期望解析出 4 条，实际 %d 条: %+v", len(items), items)
	}

	first := items[0]
	if first.ID != "987654321" {
		t.Errorf("id 应取 p 属性第 8 段，实际 %q", first.ID)
	}
	if first.Content != "普通弹幕" {
		t.Errorf("正文解析错误: %q", first.Content)
	}
	// time 是 parseFloat 语义，小数必须保留。
	if first.Time != 12.345 {
		t.Errorf("time 期望 12.345，实际 %v", first.Time)
	}
	if first.Mode != 1 || first.Size != 25 || first.Color != 16777215 {
		t.Errorf("mode/size/color 解析错误: %+v", first)
	}
	if first.SendTime == nil || *first.SendTime != 1700000000 {
		t.Errorf("sendTime 期望 1700000000，实际 %v", first.SendTime)
	}

	second := items[1]
	want := `顶部 & 尖括号 <tag> 引号 "q" 单引号 's'`
	if second.Content != want {
		t.Errorf("实体解码错误:\n 期望 %q\n 实际 %q", want, second.Content)
	}

	// 缺 dmid 时要用「毫秒时间戳-序号」兜底，保证前端 key 唯一。
	third := items[3]
	if third.ID == "" {
		t.Error("缺 dmid 时未能生成兜底 id")
	}
	if third.SendTime == nil || *third.SendTime != 1700000001 {
		t.Errorf("sendTime 期望 1700000001，实际 %v", third.SendTime)
	}
}

func TestParseDanmakuXMLEmptyPool(t *testing.T) {
	// cid=170001 这类视频的弹幕功能已关闭，接口返回 200 + 只有 <text> 说明。
	// 此时必须是空切片而不是报错，否则前端会弹错误提示。
	xml := `<?xml version="1.0" encoding="UTF-8"?><i><chatid>170001</chatid>` +
		`<maxlimit>1500</maxlimit><state>2</state><text>本视频弹幕功能已关闭</text></i>`
	items := ParseDanmakuXML(xml)
	if len(items) != 0 {
		t.Fatalf("期望 0 条，实际 %d 条", len(items))
	}
	if items == nil {
		t.Error("应返回空切片而非 nil，避免 JSON 里变成 null")
	}
}

// 真实响应是裸 deflate（无 zlib 头），Node 的 undici 会自动解，Go 不会。
// 这里固化一份「裸 deflate 压缩后的真实响应」，防止以后有人把解码顺序改回去。
func TestDecodeBodyRawDeflate(t *testing.T) {
	plain := []byte(`<i><d p="1,1,25,16777215,0,0,x,1">hi</d></i>`)

	var buf bytes.Buffer
	fw, err := flate.NewWriter(&buf, flate.DefaultCompression)
	if err != nil {
		t.Fatalf("构造 flate writer 失败: %v", err)
	}
	if _, err := fw.Write(plain); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := fw.Close(); err != nil {
		t.Fatalf("关闭失败: %v", err)
	}

	got, err := decodeBody(buf.Bytes(), "deflate")
	if err != nil {
		t.Fatalf("裸 deflate 解码失败: %v", err)
	}
	if string(got) != string(plain) {
		t.Errorf("解码结果不符:\n 期望 %q\n 实际 %q", plain, got)
	}

	// identity / 空编码应原样返回。
	if out, err := decodeBody(plain, ""); err != nil || string(out) != string(plain) {
		t.Errorf("空编码应原样返回，实际 err=%v out=%q", err, out)
	}
	if out, err := decodeBody(plain, "identity"); err != nil || string(out) != string(plain) {
		t.Errorf("identity 应原样返回，实际 err=%v out=%q", err, out)
	}
}
