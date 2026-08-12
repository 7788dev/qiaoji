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
    document.body.appendChild(host);
  }
  return host;
}

const ICONS: Record<ToastKind, string> = {
  info: "info",
  success: "check",
  error: "alert",
};

/** Shows a transient message in the bottom-right corner. */
export function toast(message: string, options: ToastOptions = {}): void {
  const kind = options.kind ?? "info";
  const duration = options.duration ?? (kind === "error" ? 5200 : 2600);

  const node = el(
    "div",
    { class: `toast toast--${kind}` },
    el("span", { class: "toast__icon" }, icon(ICONS[kind], 15)),
    el("span", { class: "toast__text" }, message),
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
