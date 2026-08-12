import { el, icon, on, trapFocus, type Child } from "../lib/dom";

export interface ModalOptions {
  title?: string;
  /** Extra class on the .modal element, used for per-dialog sizing. */
  variant?: string;
  width?: number;
  align?: "center" | "top";
  body: Child;
  footer?: Child;
  /** Focused once the dialog is on screen. */
  initialFocus?: () => HTMLElement | null;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
}

export interface ModalHandle {
  root: HTMLElement;
  content: HTMLElement;
  close: () => void;
}

/**
 * Open dialogs, innermost last, so Escape and the shortcut layer can defer.
 *
 * A stack rather than a single "previous" pointer: dialogs do not always close
 * in the order they opened, and restoring the predecessor blindly left this
 * pointing at a dialog that was already gone.
 */
const stack: ModalHandle[] = [];

export function activeModal(): ModalHandle | null {
  return stack[stack.length - 1] ?? null;
}

/**
 * Takes the shell out of the tab order while a dialog is up.
 *
 * aria-modal alone is only a hint: without this, Tab could still reach the
 * note list and the sidebar behind the scrim.
 */
function syncShellInert(): void {
  const shell = document.getElementById("app");
  if (shell) shell.inert = stack.length > 0;
}

export function openModal(options: ModalOptions): ModalHandle {
  const previousFocus = document.activeElement as HTMLElement | null;

  const content = el("div", {
    class: `modal${options.variant ? ` ${options.variant}` : ""}`,
    role: "dialog",
    "aria-modal": "true",
    "aria-label": options.title ?? "对话框",
    // The dialog carries the interface scale, so viewport units inside it are
    // read in its own scaled space and the scale has to be divided back out.
    style: options.width
      ? { width: `min(${options.width}px, calc((100vw - 64px) / var(--ui-scale, 1)))` }
      : undefined,
  });

  if (options.title || options.showCloseButton !== false) {
    content.appendChild(
      el(
        "div",
        { class: "modal__head" },
        options.title && el("h2", { class: "modal__title" }, options.title),
        options.showCloseButton !== false &&
          el(
            "button",
            { class: "ibtn", type: "button", title: "关闭", onclick: () => close() },
            icon("close", 15),
          ),
      ),
    );
  }

  content.appendChild(el("div", { class: "modal__body scroll" }, options.body));
  if (options.footer) {
    content.appendChild(el("div", { class: "modal__foot" }, options.footer));
  }

  const root = el(
    "div",
    { class: `scrim scrim--${options.align ?? "center"}` },
    content,
  );

  const releaseTrap = trapFocus(content);
  const offBackdrop = on(root, "mousedown", (ev) => {
    if (ev.target !== root) return;
    if (options.closeOnBackdrop === false) {
      // Nudge rather than close, so a stray click never discards input.
      content.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.012)" }, { transform: "scale(1)" }],
        { duration: 180, easing: "ease-out" },
      );
      return;
    }
    close();
  });

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    releaseTrap();
    offBackdrop();

    const at = stack.indexOf(handle);
    if (at >= 0) stack.splice(at, 1);
    syncShellInert();

    root.classList.add("is-closing");

    // The exit animation and the timeout are both fallbacks for each other, so
    // teardown has to be idempotent or onClose fires twice.
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;

      // Restore focus only if nothing else has claimed it. A palette command
      // that opens another dialog focuses its own input immediately, and this
      // cleanup runs a few hundred milliseconds later: without the check it
      // would yank focus back and send the user's typing into the editor.
      const active = document.activeElement as HTMLElement | null;
      const focusIsOurs = !active || active === document.body || root.contains(active);

      root.remove();
      options.onClose?.();

      if (focusIsOurs && previousFocus?.isConnected) previousFocus.focus?.();
    };
    root.addEventListener("animationend", remove, { once: true });
    window.setTimeout(remove, 400);
  }

  document.body.appendChild(root);
  const handle: ModalHandle = { root, content, close };
  stack.push(handle);
  syncShellInert();

  requestAnimationFrame(() => {
    const target = options.initialFocus?.() ?? content.querySelector<HTMLElement>(
      'input,textarea,button:not(.ibtn),[tabindex]:not([tabindex="-1"])',
    );
    target?.focus();
  });

  return handle;
}

/* ---------------------------------------------------------------- confirm */

export interface ConfirmOptions {
  title: string;
  message: Child;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Promise-based confirmation, so callers read as a linear flow. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
      handle.close();
    };

    const confirmButton = el(
      "button",
      {
        class: `btn ${options.danger ? "btn--danger" : "btn--primary"}`,
        type: "button",
        onclick: () => finish(true),
      },
      options.confirmLabel ?? "确定",
    );

    const handle = openModal({
      title: options.title,
      width: 400,
      showCloseButton: false,
      body: el("div", { class: "confirm__message" }, options.message),
      footer: [
        el(
          "button",
          { class: "btn", type: "button", onclick: () => finish(false) },
          options.cancelLabel ?? "取消",
        ),
        confirmButton,
      ],
      initialFocus: () => confirmButton,
      onClose: () => finish(false),
    });
  });
}

/* ---------------------------------------------------------------- prompt */

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return a message to block submission, or null when the value is fine. */
  validate?: (value: string) => string | null;
}

export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const input = el("input", {
      class: "input",
      type: "text",
      value: options.value ?? "",
      placeholder: options.placeholder ?? "",
      spellcheck: false,
    });
    const error = el("div", { class: "field__hint", style: { color: "var(--danger)" } });
    error.hidden = true;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
      handle.close();
    };

    const submit = () => {
      const value = input.value.trim();
      const problem = options.validate?.(value) ?? (value ? null : "内容不能为空");
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        input.focus();
        input.select();
        return;
      }
      finish(value);
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      }
    });
    input.addEventListener("input", () => {
      error.hidden = true;
    });

    const handle = openModal({
      title: options.title,
      width: 420,
      body: el(
        "div",
        { class: "field" },
        options.label && el("label", { class: "field__label" }, options.label),
        input,
        error,
      ),
      footer: [
        el("button", { class: "btn", type: "button", onclick: () => finish(null) }, "取消"),
        el(
          "button",
          { class: "btn btn--primary", type: "button", onclick: submit },
          options.confirmLabel ?? "确定",
        ),
      ],
      initialFocus: () => {
        input.select();
        return input;
      },
      onClose: () => finish(null),
    });
  });
}
