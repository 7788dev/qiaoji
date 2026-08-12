import { describe, expect, it } from "vitest";

import { detectMath, outlineOf, render, titleOf } from "./markdown";

/** The ids the renderer actually put on the headings, in document order. */
function renderedAnchors(source: string): string[] {
  const html = render(source).html;
  return Array.from(html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g), (m) => m[1]);
}

describe("titleOf", () => {
  it("prefers the first heading", () => {
    expect(titleOf("# 标题\n\n正文")).toBe("标题");
    expect(titleOf("\n\n### 三级标题")).toBe("三级标题");
  });

  it("falls back to the first line of prose", () => {
    expect(titleOf("没有标题的一段话\n第二行")).toBe("没有标题的一段话");
    expect(titleOf("")).toBe("");
  });

  it("reads only as far as it must", () => {
    const source = "# 开头\n" + "x".repeat(500_000);
    const started = performance.now();
    expect(titleOf(source)).toBe("开头");
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("heading anchors", () => {
  it("gives the outline the same slugs the renderer emits", () => {
    const source = [
      "# snake_case 说明",
      "## **加粗** 小节",
      "### 普通标题",
      "## `代码` 标题",
    ].join("\n\n");

    const outline = outlineOf(source).map((entry) => entry.slug);
    expect(outline).toEqual(renderedAnchors(source));
  });

  it("keeps duplicate headings unique, including against explicit suffixes", () => {
    const source = "# a\n\n# a\n\n# a-1\n\n# a";
    const anchors = renderedAnchors(source);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(outlineOf(source).map((e) => e.slug)).toEqual(anchors);
  });

  it("ignores headings inside fenced code", () => {
    const source = "# 真标题\n\n```\n# 假标题\n```\n";
    expect(outlineOf(source).map((e) => e.text)).toEqual(["真标题"]);
  });
});

describe("detectMath", () => {
  it("does not treat prices as formulas", () => {
    expect(detectMath("这件事花了 $5 和 $6")).toBe(false);
    expect(detectMath("单独一个 $ 符号")).toBe(false);
  });

  it("recognises real inline and block maths", () => {
    expect(detectMath("公式 $E = mc^2$ 在此")).toBe(true);
    expect(detectMath("$$\nx = 1\n$$")).toBe(true);
  });
});

describe("render", () => {
  it("escapes raw HTML in note content", () => {
    const html = render('<img src=x onerror="alert(1)">').html;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("routes relative note images through the validated vault asset endpoint", () => {
    const html = render("![截图](assets/screenshot.png)", "C:\\vault\\note.md").html;
    expect(html).toContain("/__qiaoji_asset?");
    expect(html).toContain("note=C%3A%5Cvault%5Cnote.md");
    expect(html).toContain("path=assets%2Fscreenshot.png");

    const external = render("![](https://example.com/image.png)", "C:\\vault\\note.md").html;
    expect(external).toContain('src="https://example.com/image.png"');
  });

  it("handles a document full of dollar signs without going quadratic", () => {
    const source = "价格 $1 $2 $3 $4 $5 ".repeat(4000);
    const started = performance.now();
    render(source);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
