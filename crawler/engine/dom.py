"""Zero-dependency HTML tree and CSS selector engine.

Only the subset needed by crawler rules is supported:
tag, *, #id, .class, [attr], [attr=v], [attr*=v], [attr^=v], [attr$=v],
descendant and child combinators, selector lists, :first-child,
:last-child, :nth-child(n) and :contains("text").
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from html import escape
from html.parser import HTMLParser
from typing import Iterator, Optional


VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

AUTO_CLOSE = {
    "li": {"li"},
    "p": {"p"},
    "option": {"option"},
    "tr": {"tr"},
    "td": {"td", "th"},
    "th": {"td", "th"},
    "thead": {"thead", "tbody", "tfoot"},
    "tbody": {"thead", "tbody", "tfoot"},
    "tfoot": {"thead", "tbody", "tfoot"},
}


class SelectorError(ValueError):
    pass


@dataclass
class Node:
    tag: Optional[str]
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: Optional["Node"] = None
    data: str = ""

    def __post_init__(self) -> None:
        for child in self.children:
            child.parent = self

    @property
    def classes(self) -> set:
        return set((self.attrs.get("class") or "").split())

    def get(self, name: str, default: Optional[str] = None) -> Optional[str]:
        return self.attrs.get(name, default)

    def text(self, deep: bool = True) -> str:
        return re.sub(r"\s+", " ", self.raw_text(deep)).strip()

    def raw_text(self, deep: bool = True) -> str:
        if self.tag is None:
            return self.data
        if not deep:
            return ""
        return "".join(child.raw_text(deep=True) for child in self.children)

    def html(self) -> str:
        if self.tag is None:
            return escape(self.data)
        attrs = "".join(
            " %s=\"%s\"" % (key, escape(value or "", quote=True))
            for key, value in self.attrs.items()
        )
        inner = "".join(child.html() for child in self.children)
        if self.tag in VOID_TAGS:
            return "<%s%s/>" % (self.tag, attrs)
        return "<%s%s>%s</%s>" % (self.tag, attrs, inner, self.tag)


class _Builder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node(None)
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        close_until = AUTO_CLOSE.get(tag)
        if close_until:
            while len(self.stack) > 1 and self.stack[-1].tag in close_until:
                self.stack.pop()
        node = Node(tag, {key: value or "" for key, value in attrs})
        parent = self.stack[-1]
        parent.children.append(node)
        node.parent = parent
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        node = Node(tag, {key: value or "" for key, value in attrs})
        parent = self.stack[-1]
        parent.children.append(node)
        node.parent = parent

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        if not data:
            return
        parent = self.stack[-1]
        if parent.children and parent.children[-1].tag is None:
            parent.children[-1].data += data
        else:
            node = Node(None, data=data)
            parent.children.append(node)
            node.parent = parent


def parse_html(html_text: str) -> Node:
    builder = _Builder()
    builder.feed(html_text or "")
    builder.close()
    return builder.root


def iter_elements(root: Node) -> Iterator[Node]:
    stack = list(reversed(root.children))
    while stack:
        node = stack.pop()
        if node.tag is not None:
            yield node
            stack.extend(reversed(node.children))
        else:
            stack.extend(reversed(node.children))


@dataclass
class AttrSelector:
    name: str
    op: Optional[str] = None
    value: Optional[str] = None


@dataclass
class Compound:
    tag: Optional[str] = None
    id: Optional[str] = None
    classes: list = field(default_factory=list)
    attrs: list = field(default_factory=list)
    pseudos: list = field(default_factory=list)


@dataclass
class Step:
    combinator: Optional[str]
    compound: Compound


def _scan_balanced(text: str, start: int) -> int:
    depth = 0
    quote = ""
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return index
    raise SelectorError("unbalanced attribute selector")


def _split_groups(selector: str) -> list:
    groups: list[str] = []
    buffer: list[str] = []
    depth = 0
    quote = ""
    for char in selector:
        if quote:
            buffer.append(char)
            if char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
            buffer.append(char)
        elif char in "[(":
            depth += 1
            buffer.append(char)
        elif char in ")]":
            depth -= 1
            buffer.append(char)
        elif char == "," and depth == 0:
            groups.append("".join(buffer).strip())
            buffer = []
        else:
            buffer.append(char)
    tail = "".join(buffer).strip()
    if tail:
        groups.append(tail)
    return [group for group in groups if group]


def _split_steps(group: str) -> list:
    raw: list[tuple] = []
    buffer: list[str] = []
    combinator: Optional[str] = None
    depth = 0
    quote = ""
    index = 0
    while index < len(group):
        char = group[index]
        if quote:
            buffer.append(char)
            if char == quote:
                quote = ""
            index += 1
            continue
        if char in "\"'":
            quote = char
            buffer.append(char)
            index += 1
            continue
        if char in "[(":
            depth += 1
            buffer.append(char)
            index += 1
            continue
        if char in ")]":
            depth -= 1
            buffer.append(char)
            index += 1
            continue
        if depth == 0 and char == ">":
            if buffer:
                raw.append((combinator, "".join(buffer).strip()))
                buffer = []
            combinator = ">"
            index += 1
            continue
        if depth == 0 and char.isspace():
            if buffer:
                raw.append((combinator, "".join(buffer).strip()))
                buffer = []
                combinator = " "
            index += 1
            continue
        buffer.append(char)
        index += 1
    if buffer:
        raw.append((combinator, "".join(buffer).strip()))
    steps = []
    for position, (comb, text) in enumerate(raw):
        if not text:
            raise SelectorError("empty selector step")
        steps.append(Step(">" if position and comb == ">" else (" " if position else None), _parse_compound(text)))
    return steps


_ATTR_RE = re.compile(
    r"^\s*([\w:-]+)\s*(?:([*^$~]?=)\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s]+)))?\s*$"
)


def _parse_compound(text: str) -> Compound:
    compound = Compound()
    index = 0
    length = len(text)
    if text and text[0] not in ".#[:":
        match = re.match(r"[a-zA-Z][\w-]*|\*", text)
        if not match:
            raise SelectorError("bad tag in selector: %r" % text)
        tag = match.group(0)
        compound.tag = None if tag == "*" else tag.lower()
        index = len(tag)
    while index < length:
        char = text[index]
        if char == "#":
            match = re.match(r"#([\w-]+)", text[index:])
            if not match:
                raise SelectorError("bad id in selector: %r" % text)
            compound.id = match.group(1)
            index += len(match.group(0))
        elif char == ".":
            match = re.match(r"\.([\w-]+)", text[index:])
            if not match:
                raise SelectorError("bad class in selector: %r" % text)
            compound.classes.append(match.group(1))
            index += len(match.group(0))
        elif char == "[":
            end = _scan_balanced(text, index)
            body = text[index + 1:end]
            match = _ATTR_RE.match(body)
            if not match:
                raise SelectorError("bad attribute selector: %r" % body)
            name, op, double, single, bare = match.groups()
            value = double if double is not None else (single if single is not None else bare)
            compound.attrs.append(AttrSelector(name.lower(), op, value))
            index = end + 1
        elif char == ":":
            match = re.match(r":([a-zA-Z-]+)(?:\(([^)]*)\))?", text[index:])
            if not match:
                raise SelectorError("bad pseudo selector: %r" % text)
            name = match.group(1).lower()
            argument = match.group(2)
            if name not in ("first-child", "last-child", "nth-child", "contains", "not"):
                raise SelectorError("unsupported pseudo: %s" % name)
            compound.pseudos.append((name, argument))
            index += len(match.group(0))
        else:
            raise SelectorError("unexpected character %r in selector %r" % (char, text))
    return compound


def parse_selector(selector: str) -> list:
    groups = _split_groups(selector or "")
    if not groups:
        raise SelectorError("empty selector")
    return [_split_steps(group) for group in groups]


def _element_siblings(node: Node) -> list:
    parent = node.parent
    if not parent:
        return [node]
    return [child for child in parent.children if child.tag is not None]


def _match_pseudo(node: Node, name: str, argument: Optional[str]) -> bool:
    if name == "first-child":
        siblings = _element_siblings(node)
        return bool(siblings) and siblings[0] is node
    if name == "last-child":
        siblings = _element_siblings(node)
        return bool(siblings) and siblings[-1] is node
    if name == "nth-child":
        siblings = _element_siblings(node)
        if node not in siblings:
            return False
        position = siblings.index(node) + 1
        arg = (argument or "").strip().lower()
        if arg == "odd":
            return position % 2 == 1
        if arg == "even":
            return position % 2 == 0
        try:
            return position == int(arg)
        except ValueError:
            raise SelectorError("bad nth-child argument: %r" % argument)
    if name == "contains":
        needle = (argument or "").strip().strip("\"'")
        return needle.lower() in node.text().lower()
    if name == "not":
        inner = _parse_compound((argument or "").strip())
        return not _match_compound(node, inner)
    return False


def _match_compound(node: Node, compound: Compound) -> bool:
    if node.tag is None:
        return False
    if compound.tag and node.tag != compound.tag:
        return False
    if compound.id and node.get("id") != compound.id:
        return False
    node_classes = node.classes
    for class_name in compound.classes:
        if class_name not in node_classes:
            return False
    for attr in compound.attrs:
        actual = node.get(attr.name)
        if actual is None:
            return False
        if attr.op is None:
            continue
        expected = attr.value or ""
        if attr.op == "=" and actual != expected:
            return False
        if attr.op == "*=" and expected not in actual:
            return False
        if attr.op == "^=" and not actual.startswith(expected):
            return False
        if attr.op == "$=" and not actual.endswith(expected):
            return False
        if attr.op == "~=" and expected not in actual.split():
            return False
    for name, argument in compound.pseudos:
        if not _match_pseudo(node, name, argument):
            return False
    return True


def _matches_chain(node: Node, steps: list, index: int) -> bool:
    if not _match_compound(node, steps[index].compound):
        return False
    if index == 0:
        return True
    combinator = steps[index].combinator
    parent = node.parent
    if combinator == ">":
        return parent is not None and _matches_chain(parent, steps, index - 1)
    while parent is not None:
        if _matches_chain(parent, steps, index - 1):
            return True
        parent = parent.parent
    return False


def select_all(root: Node, selector: str) -> list:
    groups = parse_selector(selector)
    matched: list[Node] = []
    for node in iter_elements(root):
        for steps in groups:
            if _matches_chain(node, steps, len(steps) - 1):
                matched.append(node)
                break
    return matched


def select_one(root: Node, selector: str) -> Optional[Node]:
    groups = parse_selector(selector)
    for node in iter_elements(root):
        for steps in groups:
            if _matches_chain(node, steps, len(steps) - 1):
                return node
    return None


def node_attr(node: Node, attr: str) -> str:
    if attr in ("text", "innerText"):
        return node.text()
    if attr in ("html", "outerHTML"):
        return node.html()
    return node.get(attr) or ""
