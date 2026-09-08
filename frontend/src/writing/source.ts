export interface SourceEnvelope { prefix: string; body: string; newline: "\n" | "\r\n" }

/** Keep YAML and its surrounding bytes outside the rich-text serializer. */
export function splitSource(source: string): SourceEnvelope {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const bom = source.startsWith("\ufeff") ? "\ufeff" : "";
  const raw = source.slice(bom.length);
  const header = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(raw);
  if (header) {
    const separator = /^(?:[ \t]*\r?\n)*/.exec(raw.slice(header[0].length))?.[0] ?? "";
    const prefix = bom + header[0] + separator;
    return { prefix, body: source.slice(prefix.length), newline };
  }
  return { prefix: bom, body: raw, newline };
}

export function joinSource(envelope: SourceEnvelope, body: string): string {
  return envelope.prefix + body.replace(/\r?\n/g, envelope.newline);
}

/** Syntax the rich schema cannot round-trip safely stays available as source. */
export function sourceOnlyReason(source: string): string {
  if (source.length > 1024 * 1024) return "文档较长，使用源码模式以保持编辑流畅。";
  const body = splitSource(source).body;
  let fence = "";
  const prose: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = "";
      continue;
    }
    if (!fence && !/^(?: {4}|\t)/.test(line)) prose.push(line.replace(/(`+)[\s\S]*?\1/g, ""));
  }
  const text = prose.join("\n");
  if (/<(?:!--|!DOCTYPE|\/?[a-z][\w:-]*(?:\s[^<>]*|\/?)>)/i.test(text)) {
    return "含有原始 HTML，使用源码模式保留这些内容。";
  }
  if (/^ {0,3}:{3,}|\[\[[^\]\n]+\]\]/m.test(text)) return "含有扩展 Markdown 语法，使用源码模式保留原文。";
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return "含有引用定义，使用源码模式保留原有引用格式。";
  return "";
}

export function countDocumentWords(source: string): number {
  const body = splitSource(source).body;
  return (body.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu) ?? []).length;
}
