package crawler

import (
	"strconv"
	"strings"
	"sync"

	"github.com/antchfx/htmlquery"
	"github.com/antchfx/xpath"
	"golang.org/x/net/html"
)

// XPath 抽取。
//
// 为什么要支持第二种选择器：Kazumi 与部分老站点规则只有 XPath 表达式
// （`//div[@class="module-item"]`），CSS 选择器无法表达「取父节点」「取兄弟」。
// 这里把 XPath 作为可选能力挂进来——规则不写 container_xpath 时仍然只走
// goquery，行为一字不变。
//
// 只取节点的文本与属性：XPath 返回标量（count()、字符串函数）时按文本处理。

// xpathCache 复用编译结果。规则对每条结果重复求值同一表达式，重编译是纯浪费。
var xpathCache sync.Map // map[string]*xpath.Expr

func compileXPath(expression string) *xpath.Expr {
	trimmed := strings.TrimSpace(expression)
	if trimmed == "" {
		return nil
	}
	if cached, ok := xpathCache.Load(trimmed); ok {
		compiled, _ := cached.(*xpath.Expr)
		return compiled
	}
	compiled, err := xpath.Compile(trimmed)
	if err != nil {
		// 表达式来自外站规则，非法只影响这一条，不抛给整次搜索。
		xpathCache.Store(trimmed, (*xpath.Expr)(nil))
		return nil
	}
	xpathCache.Store(trimmed, compiled)
	return compiled
}

// xpathValue 是一次求值结果（节点或标量）。
type xpathValue struct {
	node   *html.Node
	scalar string
}

func (v xpathValue) text() string {
	if v.node != nil {
		return strings.TrimSpace(collapseXPathText(v.node))
	}
	return strings.TrimSpace(v.scalar)
}

func (v xpathValue) attrValue(name string) string {
	if v.node == nil || v.node.Type != html.ElementNode {
		return ""
	}
	for _, attribute := range v.node.Attr {
		if attribute.Key == name {
			return attribute.Val
		}
	}
	return ""
}

// xpathSelect 在 scope 子树里求值；scope 为 nil 时从文档根算起。
//
// 绝对路径（单个 `/` 开头）一律回到文档根：XPath 的 `/` 本来就是从根算的，
// 在上下文节点上求值会得到「意外能跑但语义不同」的结果。
func xpathSelect(root, scope *html.Node, expression string) []xpathValue {
	compiled := compileXPath(expression)
	if compiled == nil {
		return nil
	}
	target := scope
	if target == nil {
		target = root
	}
	trimmed := strings.TrimSpace(expression)
	if strings.HasPrefix(trimmed, "/") && !strings.HasPrefix(trimmed, "//") {
		target = root
	}
	return flattenXPath(compiled.Evaluate(htmlquery.CreateXPathNavigator(target)))
}

func flattenXPath(value any) []xpathValue {
	switch typed := value.(type) {
	case *xpath.NodeIterator:
		out := make([]xpathValue, 0, 8)
		for typed.MoveNext() {
			navigator := typed.Current()
			// 属性轴拿不到 html.Node，按标量处理（与 textContent 等价）。
			if navigator.NodeType() == xpath.AttributeNode {
				out = append(out, xpathValue{scalar: navigator.Value()})
				continue
			}
			if node, ok := navigator.(*htmlquery.NodeNavigator); ok {
				out = append(out, xpathValue{node: node.Current()})
			}
		}
		return out
	case string:
		return []xpathValue{{scalar: typed}}
	case float64:
		return []xpathValue{{scalar: strconv.FormatFloat(typed, 'f', -1, 64)}}
	case bool:
		if typed {
			return []xpathValue{{scalar: "true"}}
		}
		return []xpathValue{{scalar: "false"}}
	default:
		return nil
	}
}

// collapseXPathText 复刻 DOM 的 textContent（注释不算）。
func collapseXPathText(node *html.Node) string {
	if node.Type == html.TextNode {
		return node.Data
	}
	var builder strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		switch child.Type {
		case html.TextNode:
			builder.WriteString(child.Data)
		case html.ElementNode:
			builder.WriteString(collapseXPathText(child))
		}
	}
	return builder.String()
}
