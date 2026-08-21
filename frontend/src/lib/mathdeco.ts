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

/** Dispatched once KaTeX finishes loading, to repaint the pending widgets. */
const katexLoaded = StateEffect.define<null>();
const viewportChanged = StateEffect.define<readonly ScanRange[]>();

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

interface ScanRange {
  from: number;
  to: number;
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

/** Finds `$$ … $$` fences near the visible document ranges. */
function blockRanges(state: EditorState, scans: readonly ScanRange[]): MathRange[] {
  const out: MathRange[] = [];
  const doc = state.doc;
  for (const scan of scans) {
    let openLine = -1;
    const firstLine = doc.lineAt(scan.from).number;
    const lastLine = doc.lineAt(Math.max(scan.from, scan.to - 1)).number;
    for (let n = firstLine; n <= lastLine; n++) {
      const line = doc.line(n);
      const text = line.text.trim();

      if (openLine < 0) {
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
  }
  return out;
}

const INLINE = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

function inlineRanges(
  state: EditorState,
  skip: MathRange[],
  scans: readonly ScanRange[],
): MathRange[] {
  const out: MathRange[] = [];
  for (const scan of scans) {
    const text = state.doc.sliceString(scan.from, scan.to);
    INLINE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE.exec(text)) !== null) {
      const from = scan.from + match.index;
      const to = from + match[0].length;
      const source = match[1].trim();
      if (!source) continue;
      if (/\d/.test(state.doc.sliceString(to, to + 1))) continue;
      if (skip.some((block) => from >= block.from && to <= block.to)) continue;
      if (insideCode(state, from + 1)) continue;
      out.push({ from, to, source, display: false });
    }
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
let scannedKey = "";
let scannedRanges: MathRange[] = [];

function rangesFor(state: EditorState, scans: readonly ScanRange[]): MathRange[] {
  const key = scans.map((range) => `${range.from}:${range.to}`).join("|");
  if (scannedDoc === state.doc && scannedKey === key) return scannedRanges;
  const blocks = blockRanges(state, scans);
  scannedRanges = [...blocks, ...inlineRanges(state, blocks, scans)].sort(
    (a, b) => a.from - b.from,
  );
  scannedDoc = state.doc;
  scannedKey = key;
  return scannedRanges;
}

function build(state: EditorState, scans: readonly ScanRange[]): DecorationSet {
  if (scans.length === 0) return Decoration.none;
  const ranges = rangesFor(state, scans);
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

interface MathFieldValue {
  decorations: DecorationSet;
  scans: readonly ScanRange[];
}

const mathField = StateField.define<MathFieldValue>({
  create: () => ({ decorations: Decoration.none, scans: [] }),
  update(current, tr) {
    let scans = current.scans;
    let rebuild = tr.effects.some((effect) => effect.is(katexLoaded));
    for (const effect of tr.effects) {
      if (!effect.is(viewportChanged)) continue;
      scans = effect.value;
      rebuild = true;
    }
    if (rebuild) return { scans, decorations: build(tr.state, scans) };
    return { scans, decorations: current.decorations.map(tr.changes) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
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

function visibleScanRanges(view: EditorView): ScanRange[] {
  const doc = view.state.doc;
  const expanded = view.visibleRanges.map((range) => {
    const first = Math.max(1, doc.lineAt(range.from).number - 40);
    const last = Math.min(doc.lines, doc.lineAt(Math.max(range.from, range.to - 1)).number + 40);
    return { from: doc.line(first).from, to: doc.line(last).to };
  });
  expanded.sort((a, b) => a.from - b.from);
  const merged: ScanRange[] = [];
  for (const range of expanded) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Pushes viewport changes into the state field outside the editor update. */
const viewportMath = ViewPlugin.fromClass(
  class {
    private scheduled = false;
    private force = false;
    private signature = "";

    constructor(view: EditorView) {
      this.schedule(view, true);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.schedule(update.view, update.docChanged || update.selectionSet);
      }
    }

    private schedule(view: EditorView, force: boolean): void {
      this.force ||= force;
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (!view.dom.isConnected) return;
        const scans = visibleScanRanges(view);
        const signature = scans.map((range) => `${range.from}:${range.to}`).join("|");
        const shouldDispatch = this.force || signature !== this.signature;
        this.force = false;
        if (!shouldDispatch) return;
        this.signature = signature;
        view.dispatch({ effects: viewportChanged.of(scans) });
      });
    }
  },
);

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
      if (view.state.field(mathField, false)?.decorations.size === 0) return;
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

export const mathDecorations: Extension = [mathField, viewportMath, katexLoader];
