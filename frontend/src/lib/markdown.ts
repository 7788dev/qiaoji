/**
 * Markdown rendering for the preview and for HTML/PDF export.
 *
 * Two deliberate choices:
 *  - `html: false`. The WebView has the Go API bound to `window.go`, so
 *    rendering raw HTML from note content would turn a pasted snippet into
 *    arbitrary filesystem access. Raw tags are shown as literal text, with a
 *    single carve-out for bare `<br>`.
 *  - KaTeX and highlight.js are dynamically imported the first time a note
 *    actually needs them, so plain notes never pay their parse cost.
 */

import MarkdownIt from "markdown-it";
import { escapeHtml } from "./dom";

// markdown-it exports a callable-class hybrid, so the instance type has to be
// derived rather than referenced by name.
type MdInstance = InstanceType<typeof MarkdownIt>;
type Plugin = (md: MdInstance) => void;
type Token = ReturnType<MdInstance["parse"]>[number];

/**
 * Structural types for the two lazily loaded modules. Declaring only the
 * surface actually used keeps the code independent of their major versions.
 */
interface KatexApi {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}

interface HljsApi {
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): {
    value: string;
  };
}

let katex: KatexApi | null = null;
let hljs: HljsApi | null = null;
let katexLoading: Promise<void> | null = null;
let hljsLoading: Promise<void> | null = null;

// Sticky, so the inline rule can match at a position without slicing the rest
// of the document first. A note that merely mentions prices reaches this rule
// at every "$", and copying the remainder each time made rendering quadratic.
const INLINE_MATH = /\$((?:[^$\\\n]|\\.)+?)\$/y;
const BLOCK_MATH_OPEN = /^\$\$\s*$/;

export interface RenderResult {
  html: string;
  hasMath: boolean;
  hasCode: boolean;
}

/* ---------------------------------------------------------------- lazy deps */

export async function loadKatex(): Promise<void> {
  if (katex) return;
  if (!katexLoading) {
    katexLoading = (async () => {
      const mod = await import("katex");
      katex = (mod.default ?? mod) as unknown as KatexApi;
    })().catch((err) => {
      // Clearing the latch lets a later render retry instead of leaving every
      // formula stuck on its placeholder forever.
      katexLoading = null;
      throw err;
    });
  }
  await katexLoading;
}

/** The loaded KaTeX module, or null while it is still being fetched. */
export function katexInstance(): KatexApi | null {
  return katex;
}

export async function loadHljs(): Promise<void> {
  if (hljs) return;
  if (!hljsLoading) {
    hljsLoading = (async () => {
      const mod = await import("highlight.js/lib/common");
      hljs = (mod.default ?? mod) as unknown as HljsApi;
    })().catch((err) => {
      hljsLoading = null;
      throw err;
    });
  }
  await hljsLoading;
}

/**
 * Preloads whatever the given source needs, so the first paint is complete.
 * A failure leaves the placeholder text in place rather than breaking the
 * render, and is surfaced once instead of on every keystroke.
 */
export async function preloadFor(source: string): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (detectMath(source)) jobs.push(loadKatex().catch(reportOnce("公式渲染组件")));
  if (detectCode(source)) jobs.push(loadHljs().catch(reportOnce("代码高亮组件")));
  await Promise.all(jobs);
}

const reported = new Set<string>();

function reportOnce(what: string): (err: unknown) => void {
  return (err) => {
    if (reported.has(what)) return;
    reported.add(what);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${what}加载失败`, err);
    void import("../ui/toast").then(({ notify }) =>
      notify.error(`${what}加载失败：${message}`),
    );
  };
}

/**
 * A bare "$" is a price far more often than it is a formula. Treating one as
 * maths pulled the KaTeX bundle in while editing and inlined 360 KB of base64
 * fonts into the exported HTML, so this looks for the shapes the renderer
 * actually accepts instead.
 */
const MATH_HINT = /\$\$|\$(?:[^$\\\n]|\\.)+?\$(?!\d)/;

export function detectMath(source: string): boolean {
  return MATH_HINT.test(source);
}

/** Whether the optional renderers a source needs are already in memory. */
export function modulesReadyFor(source: string): boolean {
  if (detectMath(source) && !katex) return false;
  if (detectCode(source) && !hljs) return false;
  return true;
}

export function detectCode(source: string): boolean {
  return source.includes("```") || source.includes("~~~");
}

/* ---------------------------------------------------------------- plugins */

/**
 * Inline and block maths. markdown-it has no maths support, so `$…$` and
 * `$$…$$` are added as first-class tokens rather than post-processing the
 * rendered HTML (which would corrupt maths inside code spans).
 */
const mathPlugin: Plugin = (md) => {
  md.inline.ruler.before("escape", "math_inline", (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== "$") return false;
    // `$$` at an inline position is an escaped literal, not maths.
    if (state.src[start + 1] === "$") return false;

    INLINE_MATH.lastIndex = start;
    const match = INLINE_MATH.exec(state.src);
    if (!match) return false;

    const body = match[1].trim();
    if (!body) return false;
    // A digit right after the closing "$" usually means currency ("$5 $6").
    const after = state.src[start + match[0].length];
    if (after && /\d/.test(after)) return false;

    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = body;
      token.markup = "$";
    }
    state.pos += match[0].length;
    return true;
  });

  md.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      const begin = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const first = state.src.slice(begin, max).trim();
      if (!first.startsWith("$$")) return false;

      // Single-line form: $$ x = 1 $$
      if (first.length > 2 && first.endsWith("$$")) {
        if (silent) return true;
        const token = state.push("math_block", "math", 0);
        token.content = first.slice(2, -2).trim();
        token.map = [startLine, startLine + 1];
        token.markup = "$$";
        state.line = startLine + 1;
        return true;
      }
      if (!BLOCK_MATH_OPEN.test(first)) return false;
      if (silent) return true;

      let line = startLine + 1;
      let closed = false;
      for (; line < endLine; line++) {
        const from = state.bMarks[line] + state.tShift[line];
        const to = state.eMarks[line];
        if (state.src.slice(from, to).trim() === "$$") {
          closed = true;
          break;
        }
      }

      const body = state.getLines(startLine + 1, closed ? line : endLine, 0, false);
      const token = state.push("math_block", "math", 0);
      token.content = body.trim();
      token.map = [startLine, line + 1];
      token.markup = "$$";
      state.line = closed ? line + 1 : endLine;
      return true;
    },
    { alt: ["paragraph", "blockquote"] },
  );

  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) =>
    `<div class="md-math-block">${renderMath(tokens[idx].content, true)}</div>\n`;
};

function renderMath(source: string, display: boolean): string {
  if (!katex) {
    // Still loading: show the source so the layout does not jump when the
    // rendered version replaces it a moment later.
    const tag = display ? "div" : "span";
    return `<${tag} class="md-math-pending">${escapeHtml(source)}</${tag}>`;
  }
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      output: "html",
      trust: false,
      maxSize: 64,
      maxExpand: 512,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `<span class="md-math-error" title="${escapeHtml(message)}">${escapeHtml(source)}</span>`;
  }
}

/**
 * Renders `- [ ]` items as real checkboxes. They are disabled in the preview
 * because the editor buffer, not the DOM, owns the document.
 */
const taskListPlugin: Plugin = (md) => {
  md.core.ruler.after("inline", "task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
      const inline = tokens[i];
      const parent = tokens[i - 1];
      if (!parent || parent.type !== "paragraph_open") continue;
      const item = tokens[i - 2];
      if (!item || item.type !== "list_item_open") continue;

      const match = /^\[([ xX])\]\s+/.exec(inline.content);
      if (!match) continue;

      const checked = match[1] !== " ";
      inline.content = inline.content.slice(match[0].length);
      const firstChild = inline.children?.[0];
      if (firstChild && firstChild.type === "text") {
        firstChild.content = firstChild.content.replace(/^\[([ xX])\]\s+/, "");
      }

      const box = new state.Token("html_inline", "", 0);
      box.content =
        `<input class="md-task" type="checkbox" disabled${checked ? " checked" : ""}>`;
      inline.children?.unshift(box);

      item.attrJoin("class", checked ? "md-task-item is-done" : "md-task-item");
      const list = findListOpen(tokens, i);
      if (list) list.attrJoin("class", "md-task-list");
    }
    return true;
  });
};

function findListOpen(tokens: Token[], from: number): Token | null {
  for (let i = from; i >= 0; i--) {
    if (tokens[i].type === "bullet_list_open" || tokens[i].type === "ordered_list_open") {
      return tokens[i];
    }
  }
  return null;
}

/**
 * Links open in the system browser, never inside the app window: navigating
 * the WebView away from the bundled assets would leave the user stranded with
 * no back button.
 */
const externalLinkPlugin: Plugin = (md) => {
  const base =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    // attrGet is typed as string | number because attributes are permissive.
    const href = String(tokens[idx].attrGet("href") ?? "");
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet("data-external", href);
      tokens[idx].attrSet("rel", "noopener noreferrer");
    } else if (href.startsWith("#")) {
      tokens[idx].attrSet("data-anchor", href.slice(1));
    } else {
      tokens[idx].attrSet("data-local", href);
    }
    return base(tokens, idx, options, env, self);
  };
};

/** Adds stable ids to headings so the outline and `#anchor` links work. */
const headingAnchorPlugin: Plugin = (md) => {
  md.core.ruler.push("heading_anchor", (state) => {
    const slug = createSlugger();
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== "heading_open") continue;
      token.attrSet("id", slug(state.tokens[i + 1]?.content ?? ""));
    }
    return true;
  });
};

export function slugifyHeading(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, "-")
      .replace(/[^\p{L}\p{N}\-_]/gu, "") || "section"
  );
}

/**
 * Assigns unique heading slugs in document order.
 *
 * The rendered headings and the outline have to agree exactly, or clicking an
 * entry in preview mode scrolls nowhere, so both go through this. Suffixed
 * candidates are checked too: headings named "a", "a" and "a-1" used to
 * produce the id "a-1" twice.
 */
export function createSlugger(): (text: string) => string {
  const used = new Set<string>();
  return (text) => {
    const base = slugifyHeading(text);
    let slug = base;
    for (let n = 2; used.has(slug); n++) {
      slug = `${base}-${n}`;
    }
    used.add(slug);
    return slug;
  };
}

/* ---------------------------------------------------------------- renderer */

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, lang) {
    if (hljs && lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(code, { language: lang, ignoreIllegals: true });
        return `<pre class="md-code"><code class="hljs language-${escapeHtml(lang)}">${out.value}</code></pre>`;
      } catch {
        /* fall through to the plain rendering below */
      }
    }
    const label = lang ? ` language-${escapeHtml(lang)}` : "";
    return `<pre class="md-code"><code class="hljs${label}">${escapeHtml(code)}</code></pre>`;
  },
});

md.use(mathPlugin).use(taskListPlugin).use(externalLinkPlugin).use(headingAnchorPlugin);

// A bare <br> is the one raw tag worth honouring; everything else stays literal.
md.renderer.rules.html_inline = (tokens, idx) => {
  const raw = tokens[idx].content;
  if (/^<br\s*\/?>$/i.test(raw.trim())) return "<br>";
  // Our own task-list plugin injects trusted markup through this same rule.
  if (raw.startsWith('<input class="md-task"')) return raw;
  return escapeHtml(raw);
};
md.renderer.rules.html_block = (tokens, idx) =>
  `<pre class="md-code md-raw-html"><code>${escapeHtml(tokens[idx].content.trimEnd())}</code></pre>\n`;

md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";

/** Renders Markdown to HTML using whichever optional modules are loaded. */
export function render(source: string): RenderResult {
  return {
    html: md.render(source),
    hasMath: detectMath(source),
    hasCode: detectCode(source),
  };
}

/**
 * Renders after making sure maths and syntax highlighting are available.
 * Used for export, where a half-loaded render would ship broken output.
 */
export async function renderComplete(source: string): Promise<RenderResult> {
  await preloadFor(source);
  return render(source);
}

/**
 * First heading in the document, used to name new notes and tabs.
 *
 * The document is scanned line by line rather than split: this runs as the
 * user types, and the answer always comes from the top of the note, so
 * allocating an array of every line would be work thrown away immediately.
 */
export function titleOf(source: string): string {
  let start = 0;
  while (start < source.length) {
    let end = source.indexOf("\n", start);
    if (end < 0) end = source.length;
    const trimmed = source.slice(start, end).trim();
    if (trimmed) {
      if (trimmed.startsWith("#")) return trimmed.replace(/^#+\s*/, "").trim();
      return trimmed.slice(0, 60);
    }
    start = end + 1;
  }
  return "";
}

/** Table of contents entries for the outline popover. */
export interface OutlineEntry {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export function outlineOf(source: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const slugFor = createSlugger();
  let inFence = false;

  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (!match) return;

    // Slugged from the raw heading, exactly as the renderer sees it, and only
    // then stripped for display. Slugging the stripped text made the outline
    // disagree with the anchor for anything containing an underscore.
    const raw = match[2].trim();
    const text = raw.replace(/[*_`~]/g, "").trim();
    if (!text) return;
    out.push({ level: match[1].length, text, slug: slugFor(raw), line: index });
  });
  return out;
}
