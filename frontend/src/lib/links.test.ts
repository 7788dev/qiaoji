import { describe, expect, it } from "vitest";
import { resolveLocalNotePath } from "./links";

describe("resolveLocalNotePath", () => {
  const root = "C:\\vault";
  const note = "C:\\vault\\folder\\current.md";

  it("resolves Markdown links inside the vault", () => {
    expect(resolveLocalNotePath(root, note, "../other.md")).toBe("C:\\vault\\other.md");
    expect(resolveLocalNotePath(root, note, "sub/next.markdown#part")).toBe(
      "C:\\vault\\folder\\sub\\next.markdown",
    );
  });

  it("rejects traversal, external protocols, and non-note targets", () => {
    expect(resolveLocalNotePath(root, note, "../../outside.md")).toBeNull();
    expect(resolveLocalNotePath(root, note, "https://example.com/a.md")).toBeNull();
    expect(resolveLocalNotePath(root, note, "javascript:alert(1)")).toBeNull();
    expect(resolveLocalNotePath(root, note, "assets/image.png")).toBeNull();
    expect(resolveLocalNotePath(root, note, "%E0%A4%A.md")).toBeNull();
  });
});
