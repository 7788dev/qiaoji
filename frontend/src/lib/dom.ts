/**
 * A ~100 line DOM layer instead of a framework.
 *
 * The UI is a fixed set of panels whose contents change, not an arbitrary
 * component tree, so direct element creation plus targeted updates keeps the
 * bundle tiny and the render path free of diffing overhead.
 */

type Falsy = null | undefined | false;
export type Child = Node | string | number | Falsy | Child[];

export type DisposableHTMLElement = HTMLElement & { destroy(): void };

export function disposableElement<T extends HTMLElement>(
  node: T,
  destroy: () => void,
): T & DisposableHTMLElement {
  return Object.assign(node, { destroy });
}

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  href?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  tabIndex?: number;
  html?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string | undefined>;
  /** Anything else lands on the element as an attribute. */
  [key: string]: unknown;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) applyAttrs(node, attrs);
  append(node, children);
  return node;
}

function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === "class") {
      node.className = String(value);
    } else if (key === "html") {
      node.innerHTML = String(value);
    } else if (key === "style") {
      if (typeof value === "string") node.setAttribute("style", value);
      else Object.assign(node.style, value);
    } else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(value as Record<string, string>)) {
        if (dv !== undefined) node.dataset[dk] = dv;
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in node && key !== "list" && key !== "form") {
      // Properties (checked, value, disabled…) must be set as properties or
      // they stop tracking user interaction.
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Replaces all children in one operation. */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

export function clear(parent: Element): void {
  parent.replaceChildren();
}

export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K | string,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}

/** Toggles a class and returns the element, for use inside el() trees. */
export function cls<T extends Element>(node: T, name: string, present: boolean): T {
  node.classList.toggle(name, present);
  return node;
}

export function qs<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`element not found: ${sel}`);
  return found;
}

/** Finds the closest ancestor carrying a data attribute, and returns its value. */
export function closestData(target: EventTarget | null, key: string): string | null {
  let node = target as HTMLElement | null;
  while (node && node !== document.body) {
    const value = node.dataset?.[key];
    if (value !== undefined) return value;
    node = node.parentElement;
  }
  return null;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let timer: number | undefined;
  let pending: A | undefined;

  const run = (...args: A) => {
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      const call = pending;
      pending = undefined;
      if (call) fn(...call);
    }, wait);
  };
  run.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  run.flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const call = pending;
    pending = undefined;
    if (call) fn(...call);
  };
  return run;
}

/** Coalesces calls into the next animation frame. */
export function raf(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Traps Tab focus inside a container. Modal dialogs are the only place this is
 * needed, and without it Tab silently walks into the note list behind them.
 */
export function trapFocus(container: HTMLElement): () => void {
  const selector =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  const handler = (ev: KeyboardEvent) => {
    if (ev.key !== "Tab") return;
    // checkVisibility rather than offsetParent: a fixed-position control has
    // no offsetParent even when it is plainly on screen, and filtering it out
    // would drop it from the tab cycle.
    const items = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
      (node) =>
        node === document.activeElement ||
        (node.checkVisibility?.({ checkVisibilityCSS: true }) ?? node.offsetParent !== null),
    );
    if (items.length === 0) {
      ev.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (ev.shiftKey && (active === first || !container.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  };

  container.addEventListener("keydown", handler);
  return () => container.removeEventListener("keydown", handler);
}

/* ------------------------------------------------------------------ icons */

/**
 * Inline 16px stroke icons. Bundling the handful the app uses avoids shipping
 * an icon font or an SVG sprite request.
 */
const PATHS: Record<string, string> = {
  note: "M4 2.5h6.5L14 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z M10 2.5V6h3.5",
  notes: "M3.5 3.5h9v9h-9z M6 6.2h4.5 M6 8.6h4.5 M6 11h3",
  clock: "M8 3.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Z M8 5.6V8l1.8 1.2",
  star: "M8 2.9l1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 11.1l-3.2 1.7.6-3.6L2.8 6.7l3.6-.5L8 2.9Z",
  trash: "M3.6 4.6h8.8 M6.2 4.6V3.4a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.2 M5 4.6l.5 8a.8.8 0 0 0 .8.8h3.4a.8.8 0 0 0 .8-.8l.5-8 M6.8 7v4 M9.2 7v4",
  folder: "M2.6 4.6a1 1 0 0 1 1-1h2.6l1.2 1.4h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-8.8a1 1 0 0 1-1-1v-7.4Z",
  tag: "M8.2 2.6H13v4.8l-5.6 5.6a1 1 0 0 1-1.4 0L2.6 9.6a1 1 0 0 1 0-1.4l5.6-5.6Z M10.6 5.4h.01",
  search: "M7.3 12.1a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6Z M13.4 13.4l-2.7-2.7",
  plus: "M8 3.6v8.8 M3.6 8h8.8",
  minus: "M3.4 8h9.2",
  close: "M4 4l8 8 M12 4l-8 8",
  chevronRight: "M6.4 3.8L10.6 8l-4.2 4.2",
  chevronDown: "M3.8 6.2L8 10.4l4.2-4.2",
  chevronUp: "M3.8 9.8L8 5.6l4.2 4.2",
  check: "M3.4 8.4l3 3 6.2-6.8",
  edit: "M11.2 2.9l1.9 1.9-7.4 7.4-2.5.6.6-2.5 7.4-7.4Z",
  copy: "M5.6 5.6h6.8v6.8H5.6z M10.4 5.6V3.6H3.6v6.8h2",
  eye: "M1.8 8S4.2 4 8 4s6.2 4 6.2 4-2.4 4-6.2 4-6.2-4-6.2-4Z M8 9.7a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z",
  pencil: "M2.9 13.1l.7-2.9 7.3-7.3 2.2 2.2-7.3 7.3-2.9.7Z",
  save: "M3.4 3.4h7.2l2 2v7.2h-9.2z M5.4 3.4v3.4h4.4V3.4 M5.4 12.6V9.4h5.2v3.2",
  download: "M8 2.8v7 M4.8 6.8L8 10l3.2-3.2 M3 12.4h10",
  settings:
    "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M12.9 9.6a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 1 1-1.7 1.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.2a1.2 1.2 0 1 1-2.4 0v-.1a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 1 1-1.7-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6h-.2a1.2 1.2 0 1 1 0-2.4h.1a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 1 1 1.7-1.7l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9v-.2a1.2 1.2 0 1 1 2.4 0v.1a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 1 1 1.7 1.7l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.2a1.2 1.2 0 1 1 0 2.4h-.1a1 1 0 0 0-.9.6Z",
  info: "M8 13.2A5.2 5.2 0 1 0 8 2.8a5.2 5.2 0 0 0 0 10.4Z M8 10.6V7.8 M8 5.6h.01",
  sun: "M8 10.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z M8 1.8v1.4 M8 12.8v1.4 M1.8 8h1.4 M12.8 8h1.4 M3.6 3.6l1 1 M11.4 11.4l1 1 M12.4 3.6l-1 1 M4.6 11.4l-1 1",
  moon: "M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8a5.6 5.6 0 1 0 6.6 6.6Z",
  layout: "M2.8 3.6h10.4v8.8H2.8z M6.4 3.6v8.8",
  grid: "M3.2 3.2h4.2v4.2H3.2z M8.6 3.2h4.2v4.2H8.6z M3.2 8.6h4.2v4.2H3.2z M8.6 8.6h4.2v4.2H8.6z",
  list: "M3 4.4h10 M3 8h10 M3 11.6h10",
  sort: "M4.4 3.6v8.8 M2.4 10.4l2 2 2-2 M11.6 12.4V3.6 M9.6 5.6l2-2 2 2",
  more: "M8 4.6h.01 M8 8h.01 M8 11.4h.01",
  keyboard: "M2.4 4.4h11.2v7.2H2.4z M4.6 6.8h.01 M7 6.8h.01 M9.4 6.8h.01 M11.6 6.8h.01 M4.6 9.4h6.8",
  restore: "M3.4 8a4.6 4.6 0 1 0 1.4-3.3 M4.6 2.6v2.4h2.4",
  external: "M9.4 3.2h3.4v3.4 M12.8 3.2L7.6 8.4 M11.4 9.2v3a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1h3",
  folderOpen: "M2.6 12.4V4.6a1 1 0 0 1 1-1h2.6l1.2 1.4h5a1 1 0 0 1 1 1v1.4 M2.6 12.4l1.8-5h10l-1.8 5H2.6Z",
  math: "M2.4 8.7h1.9l2.1 4.2 3.4-9.6h3.8",
  alert: "M8 2.9l5.4 9.5H2.6L8 2.9Z M8 6.6v2.6 M8 10.9h.01",
  file: "M4.4 2.6h5L12 5.2v8.2H4.4z M9.4 2.6v2.6H12",
  sidebar: "M2.8 3.6h10.4v8.8H2.8z M6.4 3.6v8.8 M4.1 6.2h.9 M4.1 8.2h.9",
  columns: "M2.8 3.6h10.4v8.8H2.8z M9.6 3.6v8.8",
  refresh: "M13 8a5 5 0 1 1-1.5-3.5 M13 2.6v3h-3",

  // Formatting glyphs are drawn as letterforms so the toolbar reads at a
  // glance instead of relying on abstract shapes.
  bold: "M5 3.2h3.6a2.4 2.4 0 0 1 0 4.8H5V3.2Z M5 8h4.1a2.4 2.4 0 0 1 0 4.8H5V8Z",
  italic: "M9.8 3.2H6.6 M9.4 12.8H6.2 M9.6 3.2L6.4 12.8",
  strikethrough:
    "M2.8 8h10.4 M11 5.2a2.6 2.6 0 0 0-2.6-2h-1a2.3 2.3 0 0 0-.8 4.5 M5 10.9a2.6 2.6 0 0 0 2.6 2h1a2.3 2.3 0 0 0 1.6-4",
  codeTag: "M6 4.6L2.8 8 6 11.4 M10 4.6L13.2 8 10 11.4",
  heading: "M4 3.4v9.2 M10.4 3.4v9.2 M4 8h6.4",
  quote:
    "M6.4 5.2c-1.6 0-2.8 1.2-2.8 2.8s1.2 2.6 2.6 2.6c.3 0 .6 0 .8-.1-.3 1-1.1 1.8-2.2 2.1 M13 5.2c-1.6 0-2.8 1.2-2.8 2.8s1.2 2.6 2.6 2.6c.3 0 .6 0 .8-.1-.3 1-1.1 1.8-2.2 2.1",
  bulletList: "M3.2 4.4h.01 M3.2 8h.01 M3.2 11.6h.01 M6 4.4h7 M6 8h7 M6 11.6h7",
  checkSquare: "M3.2 3.2h9.6v9.6H3.2z M5.6 8l1.8 1.8 3.2-3.4",
  table: "M2.8 3.6h10.4v8.8H2.8z M2.8 6.6h10.4 M6.6 6.6v5.8",
  image: "M2.8 3.6h10.4v8.8H2.8z M5.8 7a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z M2.8 10.6l3-2.6 3.2 2.8 2-1.6 2.2 1.8",
};

export function icon(name: keyof typeof PATHS | string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.35");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");

  const d = PATHS[name];
  if (d) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Renders a shortcut like "Ctrl+Shift+P" as styled key caps. */
export function kbd(combo: string): HTMLElement {
  const wrap = el("span", { class: "kbd" });
  const keys = combo.split("+").map((k) => k.trim()).filter(Boolean);
  keys.forEach((key, i) => {
    if (i > 0) wrap.appendChild(document.createTextNode("+"));
    wrap.appendChild(el("span", null, key));
  });
  return wrap;
}
