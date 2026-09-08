/** Resolve a Markdown link to another note without leaving the vault. */
export function resolveLocalNotePath(
  vaultRoot: string,
  notePath: string,
  href: string,
): string | null {
  const raw = href.trim();
  if (!vaultRoot || !notePath || !raw || raw.startsWith("#") || raw.startsWith("//")) {
    return null;
  }

  let resolved: URL;
  try {
    const basePath = notePath.replace(/\\/g, "/");
    const base = basePath.startsWith("/") ? `file://${basePath}` : `file:///${basePath}`;
    resolved = new URL(raw, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "file:" || resolved.host || resolved.search) return null;

  let path: string;
  try {
    path = decodeURIComponent(resolved.pathname);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  path = path.replace(/\//g, "\\");
  const root = normaliseAbsolute(vaultRoot);
  const candidate = normaliseAbsolute(path);
  if (!root || !candidate || !isWithin(root, candidate)) return null;

  const lower = candidate.toLowerCase();
  if (!(lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdown"))) {
    return null;
  }
  return candidate;
}

function normaliseAbsolute(path: string): string {
  const value = path.replace(/[\\/]+/g, "\\").replace(/\\\.\\/g, "\\");
  const drive = /^[A-Za-z]:/.test(value);
  const absolute = drive || value.startsWith("\\");
  if (!absolute) return "";
  const prefix = drive ? value.slice(0, 2) : "";
  const rest = drive ? value.slice(2) : value;
  const parts: string[] = [];
  for (const part of rest.split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return "";
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${drive ? "\\" : ""}${parts.join("\\")}`;
}

function isWithin(root: string, target: string): boolean {
  const a = root.toLowerCase().replace(/[\\]+$/, "");
  const b = target.toLowerCase();
  return b === a || b.startsWith(`${a}\\`);
}
