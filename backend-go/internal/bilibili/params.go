package bilibili

import "strings"

const upperhex = "0123456789ABCDEF"

// encodeComponent 与 JS 的 encodeURIComponent 逐字节一致。
//
// 为什么不能直接用 url.QueryEscape：
//  1. QueryEscape 把空格编成 '+'，encodeURIComponent 编成 "%20"；
//  2. QueryEscape 会转义 ! ( ) * 和单引号（编成 %21/%28/%29/%2A/%27），
//     而 encodeURIComponent 保留这五个字符。
//
// 注意别在注释里连写两个单引号：gofmt 会重排文档注释，把它们改写成弯引号，
// 于是中文说明里莫名其妙多出一个 ” 来。
//
// 这两点都会破坏 WBI 签名：w_rid 是对「排序后的 query 串 + mixinKey」做 MD5，
// 我这边编出的串若与 B站 服务器重算时用的串不同，签名立刻失效——症状是
// 搜索、view、playurl 全部返回 -403/-352，而签名代码看起来完全正常。
func encodeComponent(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			b.WriteByte(c)
		case c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(upperhex[c>>4])
			b.WriteByte(upperhex[c&0x0f])
		}
	}
	return b.String()
}

// Params 是保持插入顺序的查询参数容器。
//
// 用有序结构而非 map，是为了让 Encode() 产出的 URL 与 Node 版逐字符一致，
// 便于跨语言对拍时直接 diff 请求地址。
type Params struct {
	keys []string
	vals map[string]string
}

// NewParams 构造空参数集。
func NewParams() *Params {
	return &Params{vals: make(map[string]string, 8)}
}

// Set 写入参数；已存在的键保留原插入位置（与 JS 对象赋值语义一致）。
func (p *Params) Set(key, value string) *Params {
	if _, ok := p.vals[key]; !ok {
		p.keys = append(p.keys, key)
	}
	p.vals[key] = value
	return p
}

// Get 读取参数值。
func (p *Params) Get(key string) string { return p.vals[key] }

// Clone 深拷贝，供签名时追加 wts/w_rid 而不污染调用方参数。
func (p *Params) Clone() *Params {
	out := NewParams()
	for _, k := range p.keys {
		out.Set(k, p.vals[k])
	}
	return out
}

// Encode 按插入顺序拼成 query 串（不带前导 '?'）。
func (p *Params) Encode() string {
	var b strings.Builder
	for i, k := range p.keys {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(encodeComponent(k))
		b.WriteByte('=')
		b.WriteString(encodeComponent(p.vals[k]))
	}
	return b.String()
}
