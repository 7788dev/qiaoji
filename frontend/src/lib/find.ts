/**
 * Thin wrappers over CodeMirror's search panel.
 *
 * The prototype lists Ctrl+F for find and Ctrl+H for replace as separate
 * shortcuts, but CodeMirror 6 has a single panel whose replace row is always
 * present. These helpers open and focus that panel without mutating any of its
 * option checkboxes.
 */

import { closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

function focusPanelField(view: EditorView, selector: string): void {
  // The panel mounts on the next frame, so the field cannot be focused inline.
  requestAnimationFrame(() => {
    const field = view.dom.querySelector<HTMLInputElement>(selector);
    if (!field) return;
    field.focus();
    field.select();
  });
}

/** Opens find, seeded with the current selection when there is one. */
export function openFindPanel(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const selected = from !== to ? view.state.sliceDoc(from, to) : "";

  if (!searchPanelOpen(view.state)) openSearchPanel(view);

  requestAnimationFrame(() => {
    const field = view.dom.querySelector<HTMLInputElement>('.cm-panel.cm-search input[name="search"]');
    if (!field) return;
    if (selected && !selected.includes("\n")) {
      field.value = selected;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    field.focus();
    field.select();
  });
}

export function openReplacePanel(view: EditorView): void {
  if (!searchPanelOpen(view.state)) openSearchPanel(view);
  focusPanelField(view, '.cm-panel.cm-search input[name="search"]');
}

export function closeFindPanel(view: EditorView): void {
  if (searchPanelOpen(view.state)) closeSearchPanel(view);
}

export { openFindPanel as openSearchPanel };
