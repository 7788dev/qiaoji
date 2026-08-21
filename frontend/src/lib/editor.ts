/**
 * CodeMirror 6 configuration.
 *
 * The prototype's editor is a "live" Markdown surface: headings render at
 * their real size and emphasis is styled, but the syntax markers stay visible
 * and editable. That is a highlight-style problem rather than a WYSIWYG one,
 * which keeps the document a plain string and the undo history honest.
 */

import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import {
  HighlightStyle,
  LanguageDescription,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeLanguages } from "./codelangs";
import { mathDecorations, refreshMath } from "./mathdeco";
import { searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  onChange: (doc: string) => void;
  onCursor: (line: number, column: number, selected: number) => void;
  onSave: () => void;
  onScroll?: (top: number) => void;
  onImages?: (files: File[], from: number, to: number) => void;
}

export interface EditorSettings {
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  showLineNumbers: boolean;
  autoPairing: boolean;
  width: string;
}

const themeCompartment = new Compartment();
const settingsCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const languageCompartment = new Compartment();

function markdownSupport(): Extension[] {
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages,
      addKeymap: false,
    }),
    syntaxHighlighting(markdownHighlight),
    mathDecorations,
  ];
}

/* ---------------------------------------------------------------- theme */

// Colours come from the design tokens, so the editor follows the app theme
// without a second palette to keep in sync.
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--fg)",
    backgroundColor: "var(--bg-editor)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font, var(--font-reading))",
    lineHeight: "var(--editor-leading, 1.8)",
    overflowY: "auto",
    scrollbarWidth: "thin",
    padding: "var(--sp-8) 0 30vh",
  },
  ".cm-content": {
    maxWidth: "var(--measure, 720px)",
    width: "100%",
    margin: "0 auto",
    padding: "0 var(--sp-7)",
    caretColor: "var(--fg)",
    fontSize: "var(--editor-size, 15px)",
  },
  ".cm-line": { padding: "0 2px" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftWidth: "2px",
    borderLeftColor: "var(--fg)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--hover) 55%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--fg-faint)",
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    paddingRight: "var(--sp-3)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--fg-secondary)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--mark)",
    color: "var(--mark-fg)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--warn)",
    color: "var(--bg-editor)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--active)",
    outline: "none",
  },
  ".cm-placeholder": { color: "var(--fg-faint)" },
  ".cm-panels": {
    backgroundColor: "var(--bg-elevated)",
    color: "var(--fg)",
    borderColor: "var(--border)",
  },
  ".cm-panel.cm-search": {
    padding: "var(--sp-3) var(--sp-4)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-base)",
  },
  ".cm-panel.cm-search input": {
    padding: "3px 8px",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    background: "var(--bg-elevated)",
    color: "var(--fg)",
  },
  ".cm-panel.cm-search button": {
    padding: "3px 8px",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    background: "var(--bg-sunken)",
    color: "var(--fg)",
    backgroundImage: "none",
  },
  ".cm-panel.cm-search label": { color: "var(--fg-secondary)" },
});

const markdownHighlight = HighlightStyle.define([
  {
    tag: t.heading1,
    fontSize: "1.85em",
    fontWeight: "700",
    lineHeight: "1.35",
    letterSpacing: "-0.02em",
  },
  { tag: t.heading2, fontSize: "1.42em", fontWeight: "650", lineHeight: "1.4" },
  { tag: t.heading3, fontSize: "1.2em", fontWeight: "650", lineHeight: "1.45" },
  { tag: t.heading4, fontSize: "1.07em", fontWeight: "650" },
  { tag: [t.heading5, t.heading6], fontWeight: "650", color: "var(--fg-secondary)" },

  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--fg-muted)" },

  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--link)", textDecoration: "underline" },

  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    color: "var(--fg-secondary)",
  },
  { tag: t.quote, color: "var(--fg-secondary)", fontStyle: "italic" },
  { tag: t.list, color: "var(--fg-secondary)" },
  { tag: t.contentSeparator, color: "var(--fg-faint)" },

  // Syntax markers stay visible but recede, which is what makes the surface
  // read as rendered text while remaining plain Markdown.
  { tag: t.processingInstruction, color: "var(--fg-faint)", fontWeight: "400" },
  { tag: t.labelName, color: "var(--fg-muted)" },
  { tag: t.comment, color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/* ---------------------------------------------------------------- commands */

type Command = (view: EditorView) => boolean;

/**
 * Wraps or unwraps the selection with a marker. With no selection it inserts
 * the pair and places the caret between them, which is what every editor does
 * and what people press Ctrl+B expecting.
 */
function toggleWrap(marker: string): Command {
  return (view) => {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      const before = state.sliceDoc(
        Math.max(0, range.from - marker.length),
        range.from,
      );
      const after = state.sliceDoc(
        range.to,
        Math.min(state.doc.length, range.to + marker.length),
      );

      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - marker.length, to: range.from },
            { from: range.to, to: range.to + marker.length },
          ],
          range: EditorSelection.range(
            range.from - marker.length,
            range.to - marker.length,
          ),
        };
      }

      const text = state.sliceDoc(range.from, range.to);
      if (text.startsWith(marker) && text.endsWith(marker) && text.length > marker.length * 2) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(marker.length, -marker.length) },
          range: EditorSelection.range(range.from, range.to - marker.length * 2),
        };
      }

      return {
        changes: { from: range.from, to: range.to, insert: marker + text + marker },
        range: range.empty
          ? EditorSelection.cursor(range.from + marker.length)
          : EditorSelection.range(range.from + marker.length, range.to + marker.length),
      };
    });

    view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

/**
 * Cycles the heading level of every line the selection touches.
 *
 * Lines are visited once: two cursors on one line produced two overlapping
 * changes for the same range, which ChangeSet.of throws on.
 */
function setHeading(level: number): Command {
  return (view) => {
    const { state } = view;
    const changes: { from: number; to: number; insert: string }[] = [];
    const seen = new Set<number>();

    for (const range of state.selection.ranges) {
      const start = state.doc.lineAt(range.from).number;
      const end = state.doc.lineAt(range.to).number;
      for (let n = start; n <= end; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        const match = /^(#{1,6})\s+/.exec(line.text);
        const currentLevel = match ? match[1].length : 0;
        const prefixLength = match ? match[0].length : 0;
        const nextLevel = currentLevel === level ? 0 : level;
        const insert = nextLevel === 0 ? "" : `${"#".repeat(nextLevel)} `;
        changes.push({ from: line.from, to: line.from + prefixLength, insert });
      }
    }
    if (changes.length === 0) return false;
    view.dispatch(state.update({ changes, userEvent: "input.format" }));
    return true;
  };
}

const insertLink: Command = (view) => {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}](url)`;
    // Land the caret on "url" so the next keystroke replaces the placeholder.
    const urlStart = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + 3),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.format" }));
  return true;
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;

/**
 * Enter inside a list continues it; Enter on an empty item ends the list.
 * Without this, writing a bulleted list means retyping the marker every line.
 */
const continueList: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;

  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const match = LIST_ITEM.exec(line.text);
  if (!match) return false;

  const [, indent, marker, gap, task, content] = match;

  // An empty item means "I'm done with this list": clear the marker instead of
  // adding another one.
  if (!content.trim() && (!task || !content)) {
    if (line.text.trim() === (task ? `${marker}${gap}${task}`.trim() : marker)) {
      view.dispatch(
        state.update({
          changes: { from: line.from, to: line.to, insert: "" },
          selection: EditorSelection.cursor(line.from),
          userEvent: "input",
        }),
      );
      return true;
    }
  }

  const nextMarker = /^\d+[.)]$/.test(marker)
    ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}`
    : marker;
  const nextTask = task ? "[ ] " : "";
  const insert = `\n${indent}${nextMarker}${gap}${nextTask}`;

  view.dispatch(
    state.update({
      changes: { from: pos, to: pos, insert },
      selection: EditorSelection.cursor(pos + insert.length),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/** Toggles `- [ ]` / `- [x]` on the current line. */
const toggleTask: Command = (view) => {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();

  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let n = start; n <= end; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const match = LIST_ITEM.exec(line.text);
      if (!match) {
        const indent = /^\s*/.exec(line.text)?.[0] ?? "";
        changes.push({
          from: line.from,
          to: line.from + indent.length,
          insert: `${indent}- [ ] `,
        });
        continue;
      }
      const [, indent, marker, gap, task] = match;
      const head = `${indent}${marker}${gap}`;
      if (!task) {
        changes.push({ from: line.from + head.length, to: line.from + head.length, insert: "[ ] " });
      } else {
        const done = /[xX]/.test(task);
        changes.push({
          from: line.from + head.length,
          to: line.from + head.length + task.length,
          insert: done ? "[ ] " : "[x] ",
        });
      }
    }
  }
  if (changes.length === 0) return false;
  view.dispatch(state.update({ changes, userEvent: "input.format" }));
  return true;
};

/**
 * Indents or outdents whole lines, so Tab works on a selected block.
 *
 * With no selection and a caret past the leading whitespace, Tab inserts at
 * the caret instead: pressing it mid-sentence used to jump the indent to the
 * start of the line, which is never what was meant.
 *
 * Lines are deduplicated because two cursors on the same line would otherwise
 * produce overlapping changes, which ChangeSet.of rejects outright.
 */
function shiftLines(direction: 1 | -1): Command {
  return (view) => {
    const { state } = view;
    const unit = " ".repeat(state.facet(EditorState.tabSize));

    const main = state.selection.main;
    if (direction === 1 && state.selection.ranges.length === 1 && main.empty) {
      const line = state.doc.lineAt(main.head);
      const lead = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
      if (main.head > line.from + lead) {
        view.dispatch(
          state.update({
            changes: { from: main.head, to: main.head, insert: unit },
            selection: EditorSelection.cursor(main.head + unit.length),
            userEvent: "input.indent",
          }),
        );
        return true;
      }
    }

    const changes: { from: number; to: number; insert: string }[] = [];
    const seen = new Set<number>();

    for (const range of state.selection.ranges) {
      const start = state.doc.lineAt(range.from).number;
      const end = state.doc.lineAt(range.to).number;
      for (let n = start; n <= end; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        if (direction === 1) {
          changes.push({ from: line.from, to: line.from, insert: unit });
        } else {
          const lead = /^[ \t]*/.exec(line.text)?.[0] ?? "";
          const drop = Math.min(lead.length, unit.length);
          if (drop > 0) changes.push({ from: line.from, to: line.from + drop, insert: "" });
        }
      }
    }
    if (changes.length === 0) return false;
    view.dispatch(state.update({ changes, userEvent: "input.indent" }));
    return true;
  };
}

/** Adds or removes a line prefix such as `- ` or `> ` across the selection. */
function toggleLinePrefix(prefix: string, pattern: RegExp): Command {
  return (view) => {
    const { state } = view;
    const changes: { from: number; to: number; insert: string }[] = [];

    for (const range of state.selection.ranges) {
      const start = state.doc.lineAt(range.from).number;
      const end = state.doc.lineAt(range.to).number;

      // If every touched line already has the prefix, the action removes it.
      let allPrefixed = true;
      for (let n = start; n <= end; n++) {
        if (!pattern.test(state.doc.line(n).text)) {
          allPrefixed = false;
          break;
        }
      }

      for (let n = start; n <= end; n++) {
        const line = state.doc.line(n);
        if (allPrefixed) {
          const match = pattern.exec(line.text);
          if (match) changes.push({ from: line.from, to: line.from + match[0].length, insert: "" });
        } else if (!pattern.test(line.text)) {
          const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
          changes.push({
            from: line.from + indent.length,
            to: line.from + indent.length,
            insert: prefix,
          });
        }
      }
    }
    if (changes.length === 0) return false;
    view.dispatch(state.update({ changes, userEvent: "input.format" }));
    return true;
  };
}

const insertTable: Command = (view) => {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  // Tables need to start on their own line, so pad when the caret sits in text.
  const lead = line.text.trim() === "" ? "" : "\n\n";
  const table =
    `${lead}| 列 1 | 列 2 | 列 3 |\n` +
    `| --- | --- | --- |\n` +
    `|  |  |  |\n`;

  const at = line.to;
  view.dispatch(
    state.update({
      changes: { from: at, to: at, insert: table },
      selection: EditorSelection.cursor(at + lead.length + 2),
      scrollIntoView: true,
      userEvent: "input.format",
    }),
  );
  return true;
};

/**
 * Inserts a snippet at the cursor.
 *
 * `$SEL` is replaced by the current selection so wrapping snippets keep the
 * text, and `$0` marks where the caret ends up. Block snippets are pushed onto
 * their own line: dropping a table into the middle of a sentence would
 * otherwise produce Markdown that does not parse.
 */
/** The body a freshly created note starts with, before anything is typed. */
const UNTITLED_HEADING = /^#\s*未命名笔记\s*$/;

/** True when the document still holds nothing but a new note's placeholder. */
function isPristine(doc: string): boolean {
  const lines = doc.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return true;
  return lines.length === 1 && UNTITLED_HEADING.test(lines[0].trim());
}

export function insertSnippet(text: string, block = false): Command {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const selected = state.sliceDoc(range.from, range.to);

    let body = text.replaceAll("$SEL", selected);

    let from = range.from;
    let to = range.to;
    let prefix = "";
    let suffix = "";

    // A template dropped into a pristine new note should become the note, not
    // sit under a leftover "未命名笔记" heading. The check is deliberately
    // narrow so a template can never eat real content.
    if (block && isPristine(state.doc.toString())) {
      const caret = body.indexOf("$0");
      const clean = body.replace("$0", "");
      view.dispatch(
        state.update({
          changes: { from: 0, to: state.doc.length, insert: clean },
          selection: EditorSelection.cursor(caret >= 0 ? caret : clean.length),
          scrollIntoView: true,
          userEvent: "input.template",
        }),
      );
      view.focus();
      return true;
    }

    if (block) {
      const line = state.doc.lineAt(range.from);
      const beforeCaret = state.sliceDoc(line.from, range.from);
      const afterCaret = state.sliceDoc(range.to, state.doc.lineAt(range.to).to);

      if (beforeCaret.trim() !== "") {
        // Mid-line: start a fresh paragraph below.
        from = to = line.to;
        prefix = "\n\n";
      } else {
        from = line.from;
        to = state.doc.lineAt(range.to).to;
        suffix = afterCaret.trim() === "" ? "" : "\n";
      }
      // Keep one blank line after a block so following text is not absorbed.
      const rest = state.sliceDoc(to, Math.min(state.doc.length, to + 2));
      if (rest !== "" && !rest.startsWith("\n\n")) suffix += "\n";
    }

    const caret = body.indexOf("$0");
    body = body.replace("$0", "");
    const insert = prefix + body + suffix;
    const cursor =
      caret >= 0 ? from + prefix.length + caret : from + prefix.length + body.length;

    view.dispatch(
      state.update({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(cursor),
        scrollIntoView: true,
        userEvent: "input.template",
      }),
    );
    view.focus();
    return true;
  };
}

export const commands = {
  bold: toggleWrap("**"),
  italic: toggleWrap("*"),
  strike: toggleWrap("~~"),
  code: toggleWrap("`"),
  link: insertLink,
  task: toggleTask,
  heading: setHeading,
  bullet: toggleLinePrefix("- ", /^[ \t]*[-*+]\s+/),
  quote: toggleLinePrefix("> ", /^[ \t]*>\s?/),
  table: insertTable,
  undo,
  redo,
};

/* ---------------------------------------------------------------- factory */

export function settingsExtension(s: EditorSettings): Extension {
  const list: Extension[] = [
    EditorState.tabSize.of(s.tabSize),
    indentUnit.of(" ".repeat(s.tabSize)),
    EditorView.contentAttributes.of({
      style: `--editor-size:${s.fontSize}px;--editor-leading:${s.lineHeight}`,
    }),
  ];
  if (s.showLineNumbers) list.push(lineNumbers(), highlightActiveLineGutter());
  if (s.autoPairing) list.push(bracketMatching());
  return list;
}

/**
 * Owns the view and its extension list so documents can be swapped by
 * rebuilding the state. Reusing the state would carry the undo history across
 * notes, letting Ctrl+Z paste the previous note's text into the current file.
 */
export class MarkdownEditor {
  readonly view: EditorView;
  private readonly options: EditorOptions;
  private settings: EditorSettings;
  private languageExtension: Extension = markdownSupport();
  private languageGeneration = 0;

  constructor(options: EditorOptions, settings: EditorSettings) {
    this.options = options;
    this.settings = settings;
    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({ doc: options.doc, extensions: this.extensions() }),
    });
  }

  private extensions(): Extension[] {
    const options = this.options;
    return [
      // Markdown shortcuts must beat the defaults, otherwise Ctrl+B and the
      // list-aware Enter never fire.
      Prec.high(
        keymap.of([
          { key: "Mod-b", run: commands.bold, preventDefault: true },
          { key: "Mod-i", run: commands.italic, preventDefault: true },
          { key: "Mod-Shift-x", run: commands.strike, preventDefault: true },
          { key: "Mod-e", run: commands.code, preventDefault: true },
          { key: "Mod-k", run: commands.link, preventDefault: true },
          { key: "Mod-Shift-l", run: commands.task, preventDefault: true },
          { key: "Mod-1", run: setHeading(1), preventDefault: true },
          { key: "Mod-2", run: setHeading(2), preventDefault: true },
          { key: "Mod-3", run: setHeading(3), preventDefault: true },
          { key: "Mod-4", run: setHeading(4), preventDefault: true },
          { key: "Mod-0", run: setHeading(0), preventDefault: true },
          { key: "Enter", run: continueList },
          { key: "Tab", run: shiftLines(1), shift: shiftLines(-1) },
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              options.onSave();
              return true;
            },
          },
        ]),
      ),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      highlightSpecialChars(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      cmPlaceholder("从这里开始写…"),
      languageCompartment.of(this.languageExtension),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      themeCompartment.of(baseTheme),
      settingsCompartment.of(settingsExtension(this.settings)),
      readOnlyCompartment.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          options.onChange(update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main;
          const line = update.state.doc.lineAt(head.head);
          options.onCursor(line.number, head.head - line.from + 1, Math.abs(head.to - head.from));
        }
      }),
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (files.length === 0 || !options.onImages) return false;
          event.preventDefault();
          const range = view.state.selection.main;
          options.onImages(files, range.from, range.to);
          return true;
        },
        drop: (event, view) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (files.length === 0 || !options.onImages) return false;
          event.preventDefault();
          const position =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.head;
          options.onImages(files, position, position);
          return true;
        },
        scroll: (_event, view) => {
          options.onScroll?.(view.scrollDOM.scrollTop);
        },
      }),
    ];
  }

  /** Loads a different note, resetting selection, scroll and undo history. */
  loadDoc(doc: string, cursor = 0, scrollTop = 0): void {
    const safeCursor = Math.min(Math.max(0, cursor), doc.length);
    this.view.setState(EditorState.create({ doc, extensions: this.extensions() }));
    this.view.dispatch({ selection: EditorSelection.cursor(safeCursor) });

    // CodeMirror estimates line heights before it has measured them, and
    // rendered maths widgets change them again a moment later. Both nudge the
    // scroll position, so the target is re-applied over the next two frames.
    //
    // Pending frames from an earlier load are cancelled first: switching notes
    // quickly otherwise let the previous note's offset land on the new one.
    this.cancelScrollRestore();
    const apply = () => {
      this.view.scrollDOM.scrollTop = scrollTop;
    };
    apply();
    this.scrollFrame = requestAnimationFrame(() => {
      apply();
      this.scrollFrame = requestAnimationFrame(() => {
        apply();
        this.scrollFrame = 0;
      });
    });
  }

  private scrollFrame = 0;

  private cancelScrollRestore(): void {
    if (!this.scrollFrame) return;
    cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
  }

  /**
   * Applies text that changed underneath us (an external edit) while keeping
   * the caret where the user left it.
   */
  syncDoc(doc: string): void {
    if (doc === this.view.state.doc.toString()) return;
    const cursor = Math.min(this.view.state.selection.main.head, doc.length);
    const scrollTop = this.view.scrollDOM.scrollTop;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: doc },
      selection: EditorSelection.cursor(cursor),
    });
    this.view.scrollDOM.scrollTop = scrollTop;
  }

  /**
   * Re-renders inline formulas. Called once KaTeX has finished loading, which
   * the caller knows about deterministically; relying only on the editor's own
   * plugin lifecycle proved racy across document swaps.
   */
  refreshMath(): void {
    refreshMath(this.view);
  }

  applySettings(settings: EditorSettings): void {
    this.settings = settings;
    this.view.dispatch({
      effects: settingsCompartment.reconfigure(settingsExtension(settings)),
    });
  }

  setReadOnly(readOnly: boolean): void {
    this.view.dispatch({
      effects: readOnlyCompartment.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    });
  }

  async setLanguage(language: string): Promise<void> {
    const generation = ++this.languageGeneration;
    const name = language.trim().toLowerCase();
    let extension: Extension = [];
    if (name === "" || name === "text" || name === "plain") {
      extension = [];
    } else if (name === "markdown" || name === "md") {
      extension = markdownSupport();
    } else {
      const description =
        LanguageDescription.matchLanguageName(codeLanguages, name, false) ??
        LanguageDescription.matchFilename(codeLanguages, `file.${name}`);
      extension = description ? await description.load() : [];
    }
    if (generation !== this.languageGeneration) return;
    this.languageExtension = extension;
    this.view.dispatch({ effects: languageCompartment.reconfigure(extension) });
  }

  get doc(): string {
    return this.view.state.doc.toString();
  }

  get cursor(): number {
    return this.view.state.selection.main.head;
  }

  get scrollTop(): number {
    return this.view.scrollDOM.scrollTop;
  }

  focus(): void {
    this.view.focus();
  }

  run(command: Command): void {
    command(this.view);
    this.view.focus();
  }

  get selectedText(): string {
    const { from, to } = this.view.state.selection.main;
    return this.view.state.sliceDoc(from, to);
  }

  get hasSelection(): boolean {
    return !this.view.state.selection.main.empty;
  }

  /** Moves the caret to the document offset under a screen coordinate. */
  placeCaretAt(x: number, y: number): void {
    const pos = this.view.posAtCoords({ x, y });
    if (pos === null) return;
    this.view.dispatch({ selection: EditorSelection.cursor(pos) });
  }

  replaceSelection(text: string): void {
    const range = this.view.state.selection.main;
    this.view.dispatch(
      this.view.state.update({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        userEvent: "input.paste",
      }),
    );
    this.view.focus();
  }

  replaceRange(from: number, to: number, text: string): void {
    const start = Math.min(Math.max(0, from), this.view.state.doc.length);
    const end = Math.min(Math.max(start, to), this.view.state.doc.length);
    this.view.dispatch(
      this.view.state.update({
        changes: { from: start, to: end, insert: text },
        selection: EditorSelection.cursor(start + text.length),
        userEvent: "input.paste",
      }),
    );
    this.view.focus();
  }

  /** Jumps to a zero-based source line, used by the outline. */
  goToLine(line: number): void {
    const target = Math.min(Math.max(1, line + 1), this.view.state.doc.lines);
    const pos = this.view.state.doc.line(target).from;
    this.view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }),
    });
    this.view.focus();
  }

  destroy(): void {
    this.cancelScrollRestore();
    this.view.destroy();
  }
}
