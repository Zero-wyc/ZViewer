package crawler

import (
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/andybalholm/cascadia"
)

// HTML 抽取层。Python 版自带一棵 DOM（dom.py，447 行）只为了支撑规则用到的
// 选择器子集；Go 侧直接用 x/net/html + goquery/cascadia，能力是它的超集：
//
//	tag  *  #id  .class  [attr]  [attr=v]  [attr*=v]  [attr^=v]  [attr$=v]
//	[attr~=v]  后代/子代组合子  选择器组  :first-child  :last-child
//	:nth-child(n|odd|even)  :contains("text")  :not(...)
//
// 两处刻意的行为差异（都是 Go 更接近浏览器，不会让旧规则失效）：
//  1. 解析走 HTML5 算法，会补 html/head/body，容忍畸形标签；
//     Python 版按 HTMLParser 事件流直接挂树，不补节点。
//  2. innerHTML 取序列化结果而不是「子节点 outerHTML 手拼」，保留原始引号与注释。

// DOM 是一份解析好的文档。
type DOM struct {
	doc *goquery.Document
}

// ParseHTML 解析 HTML。解析器对畸形输入是容错的，只有 reader 出错才返回错误。
func ParseHTML(text string) (*DOM, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(text))
	if err != nil {
		return nil, RuleErrorf("HTML 解析失败: %v", err)
	}
	return &DOM{doc: doc}, nil
}

// SelectAll 返回文档序全部匹配项。
func (d *DOM) SelectAll(selector string) ([]*goquery.Selection, error) {
	return selectAllWithin(d.doc.Selection, selector)
}

// SelectOne 返回文档序第一个匹配项，没有则 nil。
func (d *DOM) SelectOne(selector string) (*goquery.Selection, error) {
	return selectOneWithin(d.doc.Selection, selector)
}

// SelectAll 在某个节点内部找（不含自身，与 Python 的 select_all(node) 一致）。
func SelectAll(node *goquery.Selection, selector string) ([]*goquery.Selection, error) {
	if node == nil {
		return nil, nil
	}
	return selectAllWithin(node, selector)
}

// SelectOne 在某个节点内部找第一个（不含自身）。
func SelectOne(node *goquery.Selection, selector string) (*goquery.Selection, error) {
	if node == nil {
		return nil, nil
	}
	return selectOneWithin(node, selector)
}

func selectAllWithin(root *goquery.Selection, selector string) ([]*goquery.Selection, error) {
	trimmed := strings.TrimSpace(selector)
	if trimmed == "" {
		return nil, RuleError("选择器不能为空", nil)
	}
	matched := root.Find(trimmed)
	if matched.Length() == 0 {
		// cascadia 只在调用 Find 时编译选择器，非法选择器会安静地返回空集；
		// 这里显式编译一次，把「写错了」和「没匹配」区分开。
		if _, err := cascadia.Compile(trimmed); err != nil {
			return nil, RuleErrorf("选择器无效 %s: %v", trimmed, err)
		}
		return nil, nil
	}
	nodes := make([]*goquery.Selection, 0, matched.Length())
	matched.Each(func(_ int, item *goquery.Selection) {
		nodes = append(nodes, item)
	})
	return nodes, nil
}

func selectOneWithin(root *goquery.Selection, selector string) (*goquery.Selection, error) {
	trimmed := strings.TrimSpace(selector)
	if trimmed == "" {
		return nil, RuleError("选择器不能为空", nil)
	}
	matched := root.Find(trimmed)
	if matched.Length() == 0 {
		if _, err := cascadia.Compile(trimmed); err != nil {
			return nil, RuleErrorf("选择器无效 %s: %v", trimmed, err)
		}
		return nil, nil
	}
	return matched.First(), nil
}

// ValidateSelector 只校验语法，不要求匹配任何节点（规则校验期用）。
func ValidateSelector(selector string) error {
	trimmed := strings.TrimSpace(selector)
	if trimmed == "" {
		return RuleError("选择器不能为空", nil)
	}
	if _, err := cascadia.Compile(trimmed); err != nil {
		return RuleErrorf("选择器无效 %s: %v", trimmed, err)
	}
	return nil
}

// NodeText 返回节点的文本，空白折叠成单空格并去掉首尾（对齐 Python 的 text()）。
func NodeText(node *goquery.Selection) string {
	if node == nil {
		return ""
	}
	return CollapseSpace(node.Text())
}

// NodeHTML 返回 outer HTML（对齐 Python 的 node.html()）。
func NodeHTML(node *goquery.Selection) string {
	if node == nil {
		return ""
	}
	out, err := goquery.OuterHtml(node)
	if err != nil {
		return ""
	}
	return out
}

// NodeInnerHTML 返回 inner HTML（对齐 Python 的「子节点 outerHTML 拼接」）。
func NodeInnerHTML(node *goquery.Selection) string {
	if node == nil {
		return ""
	}
	inner, err := node.Html()
	if err != nil {
		return ""
	}
	return inner
}

// NodeAttr 按字段规格取内容：text/innerText 取文本，html/outerHTML 取 outer，
// innerHTML 取 inner，其余按属性名取。
func NodeAttr(node *goquery.Selection, attr string) string {
	name := strings.TrimSpace(attr)
	if name == "" {
		name = "text"
	}
	switch name {
	case "text", "innerText":
		return NodeText(node)
	case "html", "outerHTML":
		return NodeHTML(node)
	case "innerHTML":
		return NodeInnerHTML(node)
	}
	if node == nil {
		return ""
	}
	if value, ok := node.Attr(name); ok {
		return value
	}
	return ""
}

// CollapseSpace 把连续空白折叠成一个空格并去首尾。
//
// 与 Python 的 re.sub(r"\s+", " ", s).strip() 等价：strings.Fields 按
// unicode.IsSpace 切分，覆盖 \t\n\v\f\r 与全角空格。
func CollapseSpace(text string) string {
	fields := strings.Fields(text)
	return strings.Join(fields, " ")
}
