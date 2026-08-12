/**
 * Global keyboard layer.
 *
 * Registered on the capture phase so app-level shortcuts win over CodeMirror's
 * own bindings, and skipped whenever a dialog is open or the user is typing in
 * a plain text field.
 */

import { activeModal } from "./ui/modal";
import { closeMenu, menuIsOpen } from "./ui/menu";
import { reportError } from "./ui/toast";

export interface ShortcutSpec {
  /** Lowercase key name, matching KeyboardEvent.key. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Runs even when a dialog is open. */
  global?: boolean;
  run: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return node.isContentEditable;
}

function matches(spec: ShortcutSpec, ev: KeyboardEvent): boolean {
  if (ev.key.toLowerCase() !== spec.key.toLowerCase()) return false;
  if (Boolean(spec.ctrl) !== (ev.ctrlKey || ev.metaKey)) return false;
  if (Boolean(spec.shift) !== ev.shiftKey) return false;
  if (Boolean(spec.alt) !== ev.altKey) return false;
  return true;
}

export function installShortcuts(specs: ShortcutSpec[], onEscape: () => boolean): () => void {
  const handler = (ev: KeyboardEvent) => {
    // While an IME is composing, keys belong to the input method. Escape in
    // particular means "cancel this candidate", not "close the dialog", and
    // stealing it would make the app hostile to type Chinese in.
    if (ev.isComposing || ev.keyCode === 229) return;

    if (ev.key === "Escape") {
      if (menuIsOpen()) {
        ev.preventDefault();
        closeMenu();
        return;
      }
      const modal = activeModal();
      if (modal) {
        ev.preventDefault();
        modal.close();
        return;
      }
      if (onEscape()) ev.preventDefault();
      return;
    }

    const dialogOpen = activeModal() !== null;

    for (const spec of specs) {
      if (!matches(spec, ev)) continue;
      if (dialogOpen && !spec.global) continue;
      // Unmodified keys must never steal input from a text field.
      if (!spec.ctrl && !spec.alt && isTypingTarget(ev.target)) continue;

      ev.preventDefault();
      ev.stopPropagation();
      try {
        spec.run();
      } catch (err) {
        // A shortcut that throws must say so; silently doing nothing is the
        // hardest kind of bug to notice.
        reportError("快捷键执行失败", err);
      }
      return;
    }
  };

  document.addEventListener("keydown", handler, { capture: true });
  return () => document.removeEventListener("keydown", handler, { capture: true });
}
