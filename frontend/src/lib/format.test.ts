import { describe, expect, it } from "vitest";

import { countWords, fileSize, relativeTime, shortPath, tagColor } from "./format";

describe("countWords", () => {
  it("counts each CJK character and each Latin run as one word", () => {
    expect(countWords("你好世界")).toBe(4);
    expect(countWords("hello world")).toBe(2);
    expect(countWords("你好 world 123")).toBe(4);
    expect(countWords("")).toBe(0);
    expect(countWords("标点，也不算。")).toBe(5);
  });

  it("agrees with the Go counter on mixed punctuation and digits", () => {
    expect(countWords("v1.2.3 released")).toBe(4);
    expect(countWords("a-b_c")).toBe(3);
  });

  it("treats an astral code point as a single character", () => {
    // A surrogate pair must not be counted twice, and must not split a word.
    expect(countWords("𝄞")).toBe(0);
    expect(countWords("a𝄞b")).toBe(2);
  });

  it("stays linear on a large document", () => {
    const text = "混合 content ".repeat(20_000);
    const started = performance.now();
    countWords(text);
    // Generous, but a per-character regex over 260 KB blows straight past it.
    expect(performance.now() - started).toBeLessThan(400);
  });
});

describe("relativeTime", () => {
  const now = Date.now();

  it("describes recent times in words", () => {
    expect(relativeTime(now - 30_000)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000)).toBe("5 分钟前");
  });

  it("falls back to a date once a week has passed", () => {
    const old = new Date(now - 30 * 24 * 60 * 60_000);
    expect(relativeTime(old)).toMatch(/^\d+/);
  });

  it("returns nothing for an unparseable value", () => {
    expect(relativeTime("not a date")).toBe("");
  });
});

describe("misc formatting", () => {
  it("formats sizes at each boundary", () => {
    expect(fileSize(0)).toBe("0 B");
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2.0 KB");
    expect(fileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("keeps a tag's colour stable across calls", () => {
    expect(tagColor("工作")).toBe(tagColor("工作"));
    expect(tagColor("工作")).toBeGreaterThanOrEqual(1);
    expect(tagColor("工作")).toBeLessThanOrEqual(6);
  });

  it("shortens long paths from the middle", () => {
    const short = "C:/notes/a.md";
    expect(shortPath(short)).toBe(short);
    expect(shortPath("C:/very/deep/nested/tree/of/folders/note.md", 20)).toContain("…");
  });
});
