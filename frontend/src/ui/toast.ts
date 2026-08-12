import { el, icon } from "../lib/dom";

export type ToastKind = "info" | "success" | "error";

interface ToastOptions {
  kind?: ToastKind;
  /** Milliseconds on screen. Errors default to longer because they matter more. */
  duration?: number;
  action?: { label: string; run: () => void };
}

let host: HTMLElement | null = null;

function container(): HTMLElement {
  if (!host) {
    host = el("div", { class: "toasts", role: "status", "aria-live": "polite" });
  }
  // Re-attached rather than assumed: a detached host would swallow every
  // message that followed, with nothing on screen to say so.
  if (host.parentNode !== document.body) {
    document.body.appendChild(host);
  }
  return host;
}

const ICONS: Record<ToastKind, string> = {
  info: "info",
  success: "check",
  error: "alert",
};

/**
 * Most toasts the user can see at once.
 *
 * A disconnected vault drive makes the watcher fire repeatedly, and each round
 * reports the same failure. Unbounded, the stack grew off the top of the
 * window and buried the app.
 */
const MAX_TOASTS = 4;

/** Shows a transient message in the bottom-right corner. */
export function toast(message: string, options: ToastOptions = {}): void {
  const kind = options.kind ?? "info";
  const duration = options.duration ?? (kind === "error" ? 5200 : 2600);

  const existing = Array.from(
    container().querySelectorAll<HTMLElement>(".toast:not(.is-leaving)"),
  );

  // A repeated message counts up on the toast already on screen instead of
  // stacking a duplicate behind it.
  //
  // Only when neither toast carries an action: "已移入回收站" is the same string
  // every time, but its Undo is bound to one particular trash entry, and
  // folding the second delete into the first would restore the wrong note.
  if (!options.action) {
    for (const node of existing) {
      if (node.dataset.message !== message || node.dataset.hasAction === "1") continue;
      const repeats = Number(node.dataset.repeats ?? "1") + 1;
      node.dataset.repeats = String(repeats);
      const counter = node.querySelector<HTMLElement>(".toast__count");
      if (counter) {
        counter.textContent = `×${repeats}`;
        counter.hidden = false;
      }
      return;
    }
  }

  // Oldest first, so the newest message is always the one that stays.
  for (let i = 0; i <= existing.length - MAX_TOASTS; i++) {
    dismiss(existing[i]);
  }

  const node = el(
    "div",
    { class: `toast toast--${kind}` },
    el("span", { class: "toast__icon" }, icon(ICONS[kind], 15)),
    el("span", { class: "toast__text" }, message),
    el("span", { class: "toast__count", hidden: true }),
    options.action &&
      el(
        "button",
        {
          class: "toast__action",
          type: "button",
          onclick: () => {
            options.action?.run();
            dismiss(node);
          },
        },
        options.action.label,
      ),
  );

  node.dataset.message = message;
  node.dataset.repeats = "1";
  if (options.action) node.dataset.hasAction = "1";
  container().appendChild(node);

  let timer = window.setTimeout(() => dismiss(node), duration);
  // Hovering a toast means the user is reading it, so stop the clock.
  node.addEventListener("mouseenter", () => clearTimeout(timer));
  node.addEventListener("mouseleave", () => {
    timer = window.setTimeout(() => dismiss(node), 1200);
  });
}

function dismiss(node: HTMLElement): void {
  if (!node.isConnected || node.classList.contains("is-leaving")) return;
  node.classList.add("is-leaving");
  node.addEventListener("animationend", () => node.remove(), { once: true });
  // Guard against the animation never firing (reduced motion, hidden tab).
  window.setTimeout(() => node.remove(), 500);
}

export const notify = {
  info: (message: string, options?: ToastOptions) => toast(message, { ...options, kind: "info" }),
  success: (message: string, options?: ToastOptions) =>
    toast(message, { ...options, kind: "success" }),
  error: (message: string, options?: ToastOptions) =>
    toast(message, { ...options, kind: "error" }),
};

/** Reports a rejected promise without repeating try/catch at every call site. */
export function reportError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  notify.error(message.includes(context) ? message : `${context}：${message}`);
}
