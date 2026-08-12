/**
 * Renders TeX inline in the editor, the way the prototype's main screen shows
 * it: `$E = mc^2$` appears as real notation while you write, and turns back
 * into editable source the moment the caret enters it.
 *
 * Implemented with replace decorations rather than a WYSIWYG layer, so the
 * document stays plain Markdown and undo history is unaffected.
 *
 * The decorations come from a StateField, not a ViewPlugin: display maths
 * spans line breaks, and CodeMirror only accepts line-crossing replacements
 * from state, never from a plugin.
 */

import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { katexInstance, loadKatex } from "./markdown";

/**
 * Documents beyond this size skip maths decoration entirely. Rebuilding over
 * the whole document on every keystroke is cheap for notes and pointless for
 * a pasted-in megabyte of log output.
 */
const MAX_DOC = 400_000;

/** Dispatched once KaTeX finishes loading, to repaint the pending widgets. */
const katexLoaded = StateEffect.define<null>();

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
    /**
     * Whether KaTeX was loaded when this widget was built. It participates in
     * equality because CodeMirror reuses the DOM of an equal widget, so
     * without it the placeholder would never be replaced once KaTeX arrives.
     */
    readonly rendered: boolean,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      other.source === this.source &&
      other.display === this.display &&
      other.rendered === this.rendered
    );
  }

  toDOM(): HTMLElement {
    const host = document.createElement(this.display ? "div" : "span");
    host.className = this.display ? "cm-math cm-math--block" : "cm-math";
    host.title = this.source;

    const katex = katexInstance();
    if (!katex) {
      host.classList.add("cm-math--pending");
      host.textContent = this.source;
      return host;
    }
    try {
      host.innerHTML = katex.renderToString(this.source, {
        displayMode: this.display,
        throwOnError: false,
        strict: false,
        output: "html",
        trust: false,
        maxSize: 64,
        maxExpand: 512,
      });
    } catch {
      host.classList.add("cm-math--error");
      host.textContent = this.source;
    }
    return host;
  }

  // Letting CodeMirror handle clicks means clicking a formula puts the caret
  // next to it, which is how the source gets revealed for editing.
  ignoreEvent(): boolean {
    return false;
  }
}

interface MathRange {
  from: number;
  to: number;
  source: string;
  display: boolean;
}

/** Syntax nodes where a `$` is literal text rather than the start of a formula. */
const CODE_NODES = /Code|Comment|URL|Link/;

function insideCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (;;) {
    if (CODE_NODES.test(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

/** Finds `$$ … $$` fences, which always occupy whole lines. */
function blockRanges(state: EditorState): MathRange[] {
  const out: MathRange[] = [];
  const doc = state.doc;
  let openLine = -1;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text.trim();

    if (openLine < 0) {
      // Single-line form: $$ x = 1 $$
      if (text.length > 4 && text.startsWith("$$") && text.endsWith("$$")) {
        out.push({
          from: line.from,
          to: line.to,
          source: text.slice(2, -2).trim(),
          display: true,
        });
        continue;
      }
      if (text === "$$") openLine = n;
      continue;
    }

    if (text === "$$") {
      const start = doc.line(openLine);
      const source = doc.sliceString(start.to + 1, line.from).trim();
      if (source) out.push({ from: start.from, to: line.to, source, display: true });
      openLine = -1;
    }
  }
  return out;
}

const INLINE = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

function inlineRanges(state: EditorState, skip: MathRange[]): MathRange[] {
  const out: MathRange[] = [];
  const text = state.doc.toString();
  INLINE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    const source = match[1].trim();
    if (!source) continue;
    // A digit right after the closing "$" usually means currency, not maths.
    if (/\d/.test(text[to] ?? "")) continue;
    if (skip.some((b) => from >= b.from && to <= b.to)) continue;
    if (insideCode(state, from + 1)) continue;
    out.push({ from, to, source, display: false });
  }
  return out;
}

/**
 * The last document scanned and what was found in it.
 *
 * Where the formulas are depends only on the text, while what gets replaced
 * also depends on the caret. Caching on the document means moving the caret
 * costs a walk over the handful of known ranges instead of a regex scan of the
 * whole note plus a syntax-tree lookup per match. CodeMirror documents are
 * immutable, so identity is a sound cache key.
 */
let scannedDoc: EditorState["doc"] | null = null;
let scannedRanges: MathRange[] = [];

function rangesFor(state: EditorState): MathRange[] {
  if (scannedDoc === state.doc) return scannedRanges;
  const blocks = blockRanges(state);
  scannedRanges = [...blocks, ...inlineRanges(state, blocks)].sort((a, b) => a.from - b.from);
  scannedDoc = state.doc;
  return scannedRanges;
}

function build(state: EditorState): DecorationSet {
  if (state.doc.length > MAX_DOC) return Decoration.none;

  const ranges = rangesFor(state);
  if (ranges.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const rendered = katexInstance() !== null;
  let previousEnd = -1;

  for (const range of ranges) {
    if (range.from < previousEnd) continue; // overlapping match; keep the first

    // Reveal the source whenever the caret or selection touches the formula,
    // otherwise there would be no way to edit it.
    const touched = state.selection.ranges.some(
      (sel) => sel.to >= range.from && sel.from <= range.to,
    );
    if (touched) continue;

    builder.add(
      range.from,
      range.to,
      Decoration.replace({
        widget: new MathWidget(range.source, range.display, rendered),
        block: range.display,
      }),
    );
    previousEnd = range.to;
  }
  return builder.finish();
}

const mathField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(current, tr) {
    const relevant =
      tr.docChanged ||
      tr.selection !== undefined ||
      tr.effects.some((effect) => effect.is(katexLoaded));
    if (!relevant) return current.map(tr.changes);
    return build(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Rebuilds the maths decorations. Widget identity includes whether KaTeX was
 * loaded, so this is what swaps placeholders for real notation once the module
 * arrives.
 */
export function refreshMath(view: EditorView): void {
  if (!view.dom.isConnected) return;
  view.dispatch({ effects: katexLoaded.of(null) });
}

/**
 * Loads KaTeX the first time a document contains maths.
 *
 * `update` checks on every cycle rather than only on `docChanged`: swapping
 * documents through `setState` does not always arrive as a document change,
 * and missing it would leave every formula stuck on its placeholder. The check
 * is a single boolean test once the request has been made.
 */
const katexLoader = ViewPlugin.fromClass(
  class {
    private requested = false;

    constructor(view: EditorView) {
      this.maybeLoad(view);
    }

    update(update: ViewUpdate): void {
      this.maybeLoad(update.view);
    }

    private maybeLoad(view: EditorView): void {
      if (this.requested || katexInstance()) return;
      if (view.state.field(mathField, false)?.size === 0) return;
      this.requested = true;
      void loadKatex()
        .then(() => refreshMath(view))
        .catch(() => {
          // Allow a later document to try again.
          this.requested = false;
        });
    }
  },
);

export const mathDecorations: Extension = [mathField, katexLoader];
