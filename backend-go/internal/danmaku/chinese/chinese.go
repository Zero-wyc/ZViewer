package chinese

import (
	"embed"
	"fmt"
	"strings"
	"sync"
)

// 简繁转换，对应 services/danmaku/chinese-convert.ts。
//
// Node 侧用 opencc-js。这里有个容易看漏的结构：`ConverterFactory` 把
// **每个字典组编译成一棵 Trie**（组内多份词表 merge 进同一棵），组与组之间
// 才是「依次过一遍」的多趟转换：
//
//	toTraditional: [STCharacters + STPhrases] → [TWVariants]
//	toSimplified : [TWVariantsRev + TWVariantsRevPhrases] → [TSCharacters + TSPhrases]
//
// 组内合并是有语义的：`周杰伦 → 周杰倫`、`面条 → 麪條`、`乾隆`（繁→简时不许
// 变成「干隆」）全靠「长词优先」。要是把 STCharacters 和 STPhrases 拆成两趟，
// 逐字那一趟会先把 `杰→傑`、`发→發` 改掉，词条就再也匹配不上了——实测确实
// 会得到 `周傑倫`、`頭發` 这种半对半错的结果。
//
// 词典由 `scripts/gen-opencc-data.js` 从 node_modules 里的 opencc-js 原样导出。
// 别自己手编对照表：难就难在「哪些词不该逐字转」，那正是词表里写死的特例。

//go:embed data/*.tsv
var dataFS embed.FS

// 词典分组（文件名 -> 转换方向）。顺序与 opencc-js 的 preset 一致。
const (
	// 简 → 繁
	dictSTCharacters = "data/s2t-0-st-characters.tsv"
	dictSTPhrases    = "data/s2t-1-st-phrases.tsv"
	dictTWVariants   = "data/s2t-2-tw-variants.tsv"

	// 繁 → 简
	dictTWVariantsRev        = "data/t2s-0-tw-variants-rev.tsv"
	dictTWVariantsRevPhrases = "data/t2s-1-tw-variants-rev-phrases.tsv"
	dictTSCharacters         = "data/t2s-2-ts-characters.tsv"
	dictTSPhrases            = "data/t2s-3-ts-phrases.tsv"
)

// dictionary 是一份「最长匹配」词典。
type dictionary struct {
	table  map[string]string
	maxLen int // 最长词条的字数（用于限制回退比较的长度）
}

// apply 对文本跑一遍最长匹配替换（对应 opencc-js 的 Trie.convert）。
//
// 逐字推进：在当前位置尝试尽可能长的词条，命中就整段替换，否则原样输出一个字。
// 与「正则全局替换」的区别是：替换后的文本**不会**被同一份词典再次扫描，
// 所以不会出现 A→B、B→C 的链式错乱。
func (d *dictionary) apply(text string) string {
	if text == "" || len(d.table) == 0 {
		return text
	}
	runes := []rune(text)
	var builder strings.Builder
	builder.Grow(len(text))

	for i := 0; i < len(runes); {
		limit := d.maxLen
		if remaining := len(runes) - i; remaining < limit {
			limit = remaining
		}
		matched := 0
		value := ""
		for length := limit; length >= 1; length-- {
			if candidate, ok := d.table[string(runes[i:i+length])]; ok {
				matched, value = length, candidate
				break
			}
		}
		if matched > 0 {
			builder.WriteString(value)
			i += matched
			continue
		}
		builder.WriteRune(runes[i])
		i++
	}
	return builder.String()
}

// loadGroup 把一组词表合并成**一棵** Trie（对应 opencc-js 的 loadDictGroup）。
//
// 后加载的覆盖先加载的：同一个键出现在两份词表里时，与 opencc-js 的
// `addWord` 覆写行为一致。
func loadGroup(names ...string) *dictionary {
	merged := &dictionary{table: make(map[string]string, 4096), maxLen: 1}
	for _, name := range names {
		part := loadDictionary(name)
		for key, value := range part.table {
			merged.table[key] = value
		}
		if part.maxLen > merged.maxLen {
			merged.maxLen = part.maxLen
		}
	}
	return merged
}

// loadDictionary 读取一份内置词典。
func loadDictionary(name string) *dictionary {
	raw, err := dataFS.ReadFile(name)
	if err != nil {
		// embed 的文件一定存在；真缺了说明构建产物不对，早点炸掉比静默降级好。
		panic(fmt.Sprintf("简繁词典缺失: %s (%v)", name, err))
	}
	table := make(map[string]string, 4096)
	maxLen := 1
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "\t")
		if !ok || key == "" {
			continue
		}
		table[key] = value
		if length := len([]rune(key)); length > maxLen {
			maxLen = length
		}
	}
	return &dictionary{table: table, maxLen: maxLen}
}

var (
	// 词典总量约 1MB（STPhrases 就占 980KB），首次用到才加载。
	s2tOnce  sync.Once
	s2tChain []*dictionary

	t2sOnce  sync.Once
	t2sChain []*dictionary
)

func traditionalChain() []*dictionary {
	s2tOnce.Do(func() {
		s2tChain = []*dictionary{
			loadGroup(dictSTCharacters, dictSTPhrases),
			loadGroup(dictTWVariants),
		}
	})
	return s2tChain
}

func simplifiedChain() []*dictionary {
	t2sOnce.Do(func() {
		t2sChain = []*dictionary{
			loadGroup(dictTWVariantsRev, dictTWVariantsRevPhrases),
			loadGroup(dictTSCharacters, dictTSPhrases),
		}
	})
	return t2sChain
}

// convert 依次过每一份词典（等价于 opencc-js 的 ConverterFactory）。
func convert(text string, chain []*dictionary) string {
	for _, dict := range chain {
		text = dict.apply(text)
	}
	return text
}

// ToTraditional 把简体中文转成繁体（台湾用词）。
func ToTraditional(input string) string {
	if input == "" {
		return input
	}
	return convert(input, traditionalChain())
}

// ToSimplified 把繁体中文转成简体。
func ToSimplified(input string) string {
	if input == "" {
		return input
	}
	return convert(input, simplifiedChain())
}

// containsChinese 判断是否含中文字符。
func containsChinese(input string) bool {
	for _, char := range input {
		if char >= 0x4e00 && char <= 0x9fff {
			return true
		}
	}
	return false
}

// IsSimplifiedChinese 判断是否含简体独有字（转换后有差异即认为有简体）。
func IsSimplifiedChinese(input string) bool {
	if input == "" || !containsChinese(input) {
		return false
	}
	return ToTraditional(input) != input
}

// IsTraditionalChinese 判断是否为繁体。
func IsTraditionalChinese(input string) bool {
	if input == "" || !containsChinese(input) {
		return false
	}
	return ToSimplified(input) != input
}
