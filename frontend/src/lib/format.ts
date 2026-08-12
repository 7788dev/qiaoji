/** Date, size and count formatting, tuned for a Chinese UI. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function parseDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Relative time for list rows: today shows a clock, this year shows a date
 * without the year, older shows the full date. Matches what the prototype's
 * note list conveys.
 */
export function relativeTime(value: string | number | Date): string {
  const date = parseDate(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return "";

  const now = Date.now();
  const diff = now - time;

  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;

  if (isSameDay(date, new Date(now))) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const yesterday = new Date(now - DAY);
  if (isSameDay(date, yesterday)) return "昨天";

  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;

  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${date.getMonth() + 1}-${pad(date.getDate())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Full timestamp for tooltips and detail views. */
export function fullTime(value: string | number | Date): string {
  const d = parseDate(value);
  if (!Number.isFinite(d.getTime())) return "";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCJK(code)) {
      count++;
      inWord = false;
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      if (!inWord) {
        count++;
        inWord = true;
      }
    } else {
      inWord = false;
    }
  }
  return count;
}

function isCJK(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/** Reading time at roughly 300 CJK characters per minute. */
export function readingTime(words: number): string {
  const minutes = Math.max(1, Math.round(words / 300));
  return `约 ${minutes} 分钟`;
}

/** Deterministic colour index so a tag keeps the same swatch across sessions. */
export function tagColor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return (hash % 6) + 1;
}

/** Shortens a long filesystem path for display in a fixed-width slot. */
export function shortPath(path: string, max = 46): string {
  if (path.length <= max) return path;
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length <= 2) return `…${path.slice(-max + 1)}`;
  const tail = parts.slice(-2).join("/");
  return `${parts[0]}/…/${tail}`;
}

export function pluralNotes(n: number): string {
  return `${n} 篇`;
}
