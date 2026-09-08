import { describe, expect, it } from "vitest";
import { resolveDocumentLink } from "./links";

describe("document-relative links", () => {
  it("resolves Chinese and escaped paths outside the navigation folder", () => {
    expect(resolveDocumentLink("C:/写作/项目/当前.md", "../资料/阅读%20记录.md#标题")).toEqual({
      kind: "document", path: "C:/写作/资料/阅读 记录.md", anchor: "标题",
    });
  });
  it("distinguishes anchors and external links", () => {
    expect(resolveDocumentLink("", "#%E6%A0%87%E9%A2%98")).toEqual({ kind: "anchor", anchor: "标题" });
    expect(resolveDocumentLink("", "https://example.com")).toEqual({ kind: "external", href: "https://example.com" });
  });
  it.each(["javascript:alert(1)", "data:text/html,test", "vbscript:x", "file:///C:/run.exe", "//server/share/a.md", "a.md?query=x"])("rejects unsafe or non-document navigation: %s", (href) => {
    expect(resolveDocumentLink("C:/notes/a.md", href)).toBeNull();
  });
});
