import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.dom import parse_html, select_all, select_one, SelectorError


HTML = """
<html><body>
<div class="list">
  <article class="item" data-kind="movie">
    <a href="/v/1" class="title">Movie One</a>
    <img src="/c/1.jpg" alt="cover">
    <p class="desc">Hello <b>World</b></p>
  </article>
  <article class="item">
    <a href="/v/2">Movie Two</a>
    <p class="desc">Second</p>
  </article>
</div>
<ul><li>a</li><li>b</li></ul>
</body></html>
"""


class DomTests(unittest.TestCase):
    def setUp(self):
        self.root = parse_html(HTML)

    def test_select_class(self):
        self.assertEqual(len(select_all(self.root, "article.item")), 2)

    def test_descendant(self):
        self.assertEqual([n.text() for n in select_all(self.root, "article .title")], ["Movie One"])

    def test_child_combinator(self):
        self.assertEqual(len(select_all(self.root, ".item > a")), 2)
        self.assertEqual(len(select_all(self.root, "div > a")), 0)

    def test_attribute_ops(self):
        nodes = select_all(self.root, 'a[href^="/v"]')
        self.assertEqual(len(nodes), 2)
        self.assertEqual(select_all(self.root, 'article[data-kind="movie"]')[0].get("data-kind"), "movie")

    def test_pseudo(self):
        self.assertEqual(select_one(self.root, "article:nth-child(2) a").text(), "Movie Two")
        self.assertEqual(len(select_all(self.root, "li:first-child")), 1)
        self.assertEqual(len(select_all(self.root, 'p:contains("world")')), 1)

    def test_text_normalization(self):
        self.assertEqual(select_one(self.root, "p.desc").text(), "Hello World")

    def test_empty_selector_raises(self):
        with self.assertRaises(SelectorError):
            select_all(self.root, "")

    def test_malformed_selector_raises(self):
        with self.assertRaises(SelectorError):
            select_all(self.root, "div[")


if __name__ == "__main__":
    unittest.main()
