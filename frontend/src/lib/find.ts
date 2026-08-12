/**
 * Thin wrappers over CodeMirror's search panel.
 *
 * The prototype lists Ctrl+F for find and Ctrl+H for replace as separate
 * shortcuts, but CodeMirror has a single panel with a collapsible replace row.
 * These helpers open that panel in the right state so both shortcuts behave
 * the way the shortcut sheet promises.
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
  setReplaceVisible(view, false);

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
  setReplaceVisible(view, true);
  focusPanelField(view, '.cm-panel.cm-search input[name="search"]');
}

export function closeFindPanel(view: EditorView): void {
  if (searchPanelOpen(view.state)) closeSearchPanel(view);
}

/**
 * CodeMirror hides the replace row behind a checkbox rather than an API, so
 * the checkbox is toggled directly.
 */
function setReplaceVisible(view: EditorView, visible: boolean): void {
  requestAnimationFrame(() => {
    const toggle = view.dom.querySelector<HTMLInputElement>(
      '.cm-panel.cm-search input[name="replace"], .cm-panel.cm-search input[type="checkbox"]',
    );
    const panel = view.dom.querySelector<HTMLElement>(".cm-panel.cm-search");
    if (panel) panel.classList.toggle("cm-search--replace", visible);
    if (toggle && toggle.type === "checkbox" && toggle.checked !== visible) {
      toggle.checked = visible;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

export { openFindPanel as openSearchPanel };
