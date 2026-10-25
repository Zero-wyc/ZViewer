package chinese

import "testing"

// 期望值全部来自 Node 侧 opencc-js 的实际输出（同一次会话里跑的）：
//
//	Converter({from:'cn', to:'tw'}) / Converter({from:'tw', to:'cn'})
func TestToTraditional(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{input: "孤独摇滚", want: "孤獨搖滾"},
		{input: "进击的巨人", want: "進擊的巨人"},
		{input: "软件视频", want: "軟件視頻"},
		// 词典特例：逐字转会得到「干隆」，词组词典把它保住。
		{input: "乾隆", want: "乾隆"},
		{input: "里面", want: "裡面"},
		{input: "头发", want: "頭髮"},
		{input: "周杰伦", want: "周杰倫"},
		{input: "后来", want: "後來"},
		{input: "面条", want: "麵條"},
		{input: "忧郁的台湾乌龟", want: "憂鬱的臺灣烏龜"},
		// 非中文原样返回。
		{input: "リコリス", want: "リコリス"},
		{input: "ABC123", want: "ABC123"},
		{input: "", want: ""},
	}
	for _, c := range cases {
		t.Run(c.input, func(t *testing.T) {
			if got := ToTraditional(c.input); got != c.want {
				t.Errorf("ToTraditional(%q) = %q，期望 %q", c.input, got, c.want)
			}
		})
	}
}

func TestToSimplified(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{input: "繁體字測試", want: "繁体字测试"},
		{input: "憂鬱的臺灣烏龜", want: "忧郁的台湾乌龟"},
		{input: "孤獨搖滾", want: "孤独摇滚"},
		{input: "乾隆", want: "乾隆"},
		{input: "ABC123", want: "ABC123"},
		{input: "", want: ""},
	}
	for _, c := range cases {
		t.Run(c.input, func(t *testing.T) {
			if got := ToSimplified(c.input); got != c.want {
				t.Errorf("ToSimplified(%q) = %q，期望 %q", c.input, got, c.want)
			}
		})
	}
}

func TestLanguageDetection(t *testing.T) {
	if !IsSimplifiedChinese("孤独摇滚") {
		t.Error("简体串应判为简体")
	}
	if IsSimplifiedChinese("孤獨搖滾") {
		t.Error("繁体串不该判为简体")
	}
	if !IsTraditionalChinese("孤獨搖滾") {
		t.Error("繁体串应判为繁体")
	}
	if IsTraditionalChinese("ABC") || IsSimplifiedChinese("ABC") {
		t.Error("非中文不该判定为任一侧")
	}
}

// 同一份词典连跑两次必须幂等（最长匹配不能出现 A→B→C 的链式替换）。
func TestConversionIsIdempotent(t *testing.T) {
	once := ToTraditional("进击的巨人 鬼灭之刃")
	twice := ToTraditional(once)
	if once != twice {
		t.Errorf("二次转换漂移：%q -> %q", once, twice)
	}
}

// CRLF 检出（Windows 上 core.autocrlf=true 的默认行为）不能让 value 带上 \r。
func TestParseDictionaryToleratesCRLF(t *testing.T) {
	lf := parseDictionary("周杰伦\t周杰倫\n乾隆\t乾隆\n")
	crlf := parseDictionary("周杰伦\t周杰倫\r\n乾隆\t乾隆\r\n")
	if len(lf.table) != 2 || len(crlf.table) != 2 {
		t.Fatalf("词条数 = %d / %d，期望 2 / 2", len(lf.table), len(crlf.table))
	}
	for key, value := range lf.table {
		if crlf.table[key] != value {
			t.Errorf("%s 的值 = %q，期望 %q", key, crlf.table[key], value)
		}
	}
}
