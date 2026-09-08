import { describe, expect, it } from "vitest";
import { splitSource, joinSource, sourceOnlyReason, countDocumentWords } from "./source";
import { outlineOf } from "../lib/markdown";

describe("source preservation", () => {
  it.each(["---\n---\n", "---\n# comment-only YAML\n...\n", "---\n[one, two]\n---\n", "---\n'quoted key': value\n---\n"])("preserves the full front matter envelope: %s", (prefix) => {
    const envelope = splitSource(prefix + "# 正文\n");
    expect(envelope.prefix).toBe(prefix);
    expect(joinSource(envelope, "# 新正文\n")).toBe(prefix + "# 新正文\n");
  });
  it("preserves BOM, YAML comments, custom fields and CRLF outside rich editing", () => {
    const prefix = "\ufeff---\r\n# comment\r\nid: 'shared'\r\ncustom: {a: 1}\r\n---\r\n\r\n";
    const source = prefix + "# 原文\r\n";
    const envelope = splitSource(source);
    expect(envelope.prefix).toBe(prefix);
    expect(joinSource(envelope, "# 新内容\n\n正文\n")).toBe(prefix + "# 新内容\r\n\r\n正文\r\n");
    expect(joinSource(envelope, envelope.body)).toBe(source);
  });
  it.each([
    "<div onclick='alert(1)'>原文</div>",
    "<!-- keep this comment -->",
    "::: custom\nunknown\n:::",
    "[[双向链接]]",
    "文字[^a]\n\n[^a]: footnote",
    "![图片][ref]\n\n[ref]: assets/test.png",
  ])("keeps unsupported source instead of rendering or discarding it: %s", (source) => {
    expect(sourceOnlyReason(source)).not.toBe("");
  });
  it("allows HTML examples inside code and links with angle destinations", () => {
    expect(sourceOnlyReason("`<div>`\n\n```html\n<script>foo</script>\n```\n\n[链接](<https://example.com>)")).toBe("");
  });
  it("counts mixed Latin and Chinese text as separate words", () => {
    expect(countDocumentWords("Hello中文 world你好 2026 年")).toBe(8);
  });
  it("keeps outline jumps aligned with setext headings and nested code fences", () => {
    const source = "章节\n====\n\n````md\n```\n# 代码中的标题\n````\n\n## 第二节 ##\n\n    # 缩进代码\n";
    expect(outlineOf(source).map(({ text, level, line }) => ({ text, level, line }))).toEqual([
      { text: "章节", level: 1, line: 0 },
      { text: "第二节", level: 2, line: 8 },
    ]);
  });
});
