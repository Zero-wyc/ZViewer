package traffic

import "testing"

// Windows `netstat -e` 的英文与中文输出：字节行是「标签 + 两个千分位数字」。
const windowsNetstatEN = `
Interface Statistics

                           Received            Sent

Bytes                     1,857,485,134     424,213,945
Unicast packets               2,153,441         987,233
Non-unicast packets              12,345           6,789
Discards                              0               0
Errors                                3               1
Unknown protocols                    17
`

const windowsNetstatZH = `
接口统计

                           已接收             已发送

字节                      12,345,678        87,654,321
单播数据包                    100,000           90,000
非单播数据包                    1,000              500
丢弃                              0                0
错误                              0                0
未知协议
`

func TestParseWindowsNetstatEnglish(t *testing.T) {
	got := parseWindowsNetstat(windowsNetstatEN)
	if got.rx != 1857485134 || got.tx != 424213945 {
		t.Fatalf("解析结果 %+v，期望 rx=1857485134 tx=424213945", got)
	}
}

func TestParseWindowsNetstatChinese(t *testing.T) {
	got := parseWindowsNetstat(windowsNetstatZH)
	if got.rx != 12345678 || got.tx != 87654321 {
		t.Fatalf("解析结果 %+v，期望 rx=12345678 tx=87654321", got)
	}
}

// 只有表头 / 空输出的系统（命令不可用）不能当成 0 流量上报。
func TestParseWindowsNetstatEmpty(t *testing.T) {
	if got := parseWindowsNetstat("Interface Statistics\n\n"); got.rx != 0 || got.tx != 0 {
		t.Fatalf("空输出应返回零值，得到 %+v", got)
	}
}

func TestParseGroupedNumber(t *testing.T) {
	cases := map[string]int64{
		"1,857,485,134": 1857485134,
		"424.213.945":   424213945,
		"0":             0,
	}
	for raw, want := range cases {
		got, err := parseGroupedNumber(raw)
		if err != nil || got != want {
			t.Fatalf("parseGroupedNumber(%q) = %d, %v；期望 %d", raw, got, err, want)
		}
	}
	if _, err := parseGroupedNumber("Bytes"); err == nil {
		t.Fatal("非数字应当报错，否则表头会被当成流量")
	}
}
