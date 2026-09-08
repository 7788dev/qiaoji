export type DocumentLink = { kind: "external"; href: string } | { kind: "document"; path: string; anchor: string } | { kind: "anchor"; anchor: string };

/** A Markdown document may link outside the navigation folder; executable URLs never navigate the WebView. */
export function resolveDocumentLink(path: string, href: string): DocumentLink | null {
  const raw = href.trim();
  if (!raw || /[\u0000-\u001f]/.test(raw)) return null;
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) return { kind: "external", href: raw };
  const unescape = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  if (raw.startsWith("#")) return { kind: "anchor", anchor: unescape(raw.slice(1)) };
  if (!path || raw.startsWith("//") || raw.startsWith("\\\\")) return null;
  const base = path.replaceAll("\\", "/");
  try {
    const url = new URL(raw.replaceAll("\\", "/"), base.startsWith("/") ? "file://" + base : "file:///" + base);
    if (url.protocol !== "file:" || url.host || url.search) return null;
    let resolved = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1);
    if (!/\.(?:md|markdown)$/i.test(resolved)) return null;
    return { kind: "document", path: resolved, anchor: unescape(url.hash.slice(1)) };
  } catch { return null; }
}
