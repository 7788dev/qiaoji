import { el, icon, on } from "../lib/dom";

export interface MenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Nested entries. An item with children opens a flyout instead of running. */
  children?: MenuEntry[];
  run?: () => void;
}

export type MenuEntry = MenuItem | "separator";

interface MenuAnchor {
  x: number;
  y: number;
}

let openMenu: { root: HTMLElement; dispose: () => void } | null = null;

export function closeMenu(): void {
  openMenu?.dispose();
}

export function menuIsOpen(): boolean {
  return openMenu !== null;
}

/**
 * Places a floating panel at a point, flipping it when it would run past the
 * window edge. Measuring off-screen first is what makes the flip exact rather
 * than a guess based on assumed dimensions.
 */
/** The interface scale, which the shell and every overlay carry. */
function uiScale(): number {
  const raw = Number(
    getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"),
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Where an element actually sits on screen, in viewport pixels.
 *
 * Anything inside the scaled shell reports its geometry in that shell's own
 * coordinate space, while mouse events report true viewport pixels. Menus are
 * anchored in viewport pixels, so element anchors have to come through here or
 * they land at the wrong place whenever the interface scale is not 100%.
 */
export function anchorRect(element: Element): DOMRect {
  const rect = element.getBoundingClientRect();
  const scale = uiScale();
  if (scale === 1) return rect;
  return new DOMRect(
    rect.x * scale,
    rect.y * scale,
    rect.width * scale,
    rect.height * scale,
  );
}

function place(node: HTMLElement, x: number, y: number, flipAround?: DOMRect): void {
  node.style.visibility = "hidden";
  node.style.left = "0px";
  node.style.top = "0px";
  node.style.maxHeight = "";
  document.body.appendChild(node);

  // A zoomed element reports and accepts geometry in its own scaled space, so
  // measurements coming out of it are multiplied up to viewport pixels and
  // positions going into it are divided back down.
  const scale = uiScale();
  const rect = node.getBoundingClientRect();
  const width = rect.width * scale;
  const height = rect.height * scale;
  const margin = 8;

  let left = x;
  if (left + width + margin > window.innerWidth) {
    // A submenu flips to the other side of its parent; a root menu flips about
    // the cursor.
    left = flipAround
      ? Math.max(margin, flipAround.left - width + 2)
      : Math.max(margin, x - width);
  }

  // A menu taller than the window is capped and scrolls. The outline of a long
  // note and the "move to" list of a deep vault both reach that size, and
  // clamping to the top edge alone left their last entries off screen with no
  // way to reach them.
  const available = window.innerHeight - margin * 2;
  let top = y;
  if (height > available) {
    node.style.maxHeight = `${available / scale}px`;
    top = margin;
  } else if (top + height + margin > window.innerHeight) {
    top = Math.max(margin, window.innerHeight - height - margin);
  }

  node.style.left = `${left / scale}px`;
  node.style.top = `${top / scale}px`;
  node.style.visibility = "";
}

/**
 * Opens a context menu at a point, flipping it when it would run past the
 * window edge. Right-clicking near the bottom of the note list is common
 * enough that clipping there would be a daily annoyance.
 */
export function showMenu(entries: MenuEntry[], anchor: MenuAnchor): void {
  closeMenu();

  /** Every panel currently on screen: index 0 is the root, then each flyout. */
  const panels: { node: HTMLElement; buttons: HTMLButtonElement[]; active: number }[] = [];

  function closeFrom(depth: number): void {
    while (panels.length > depth) {
      panels.pop()?.node.remove();
    }
  }

  function buildPanel(list: MenuEntry[], depth: number): HTMLElement {
    const node = el("div", { class: "menu scroll", role: "menu" });
    const buttons: HTMLButtonElement[] = [];
    const level = { node, buttons, active: -1 };

    let hoverTimer = 0;

    for (const entry of list) {
      if (entry === "separator") {
        node.appendChild(el("div", { class: "menu__sep" }));
        continue;
      }

      const hasChildren = Boolean(entry.children?.length);
      const button = el(
        "button",
        {
          class: `menu__item${entry.danger ? " menu__item--danger" : ""}`,
          type: "button",
          role: hasChildren ? "menuitem" : "menuitem",
          "aria-haspopup": hasChildren ? "true" : undefined,
          disabled: entry.disabled,
          onclick: () => {
            if (hasChildren) {
              openChild(entry, button, depth);
              return;
            }
            // Through dispose(), never by clearing openMenu by hand: that
            // skipped the listener teardown and, because dispose() checks the
            // menu it belongs to, made it unreachable afterwards. Every menu
            // click leaked a document pointerdown, a document keydown and a
            // window resize handler for the rest of the session.
            dispose();
            entry.run?.();
          },
          onmouseenter: () => {
            level.active = buttons.indexOf(button);
            paint(level);
            // Leaving a parent item must close its flyout, but only after a
            // beat so diagonal travel toward the submenu does not dismiss it.
            window.clearTimeout(hoverTimer);
            hoverTimer = window.setTimeout(() => {
              closeFrom(depth + 1);
              if (hasChildren) openChild(entry, button, depth);
            }, hasChildren ? 90 : 160);
          },
          onmouseleave: () => window.clearTimeout(hoverTimer),
        },
        el("span", { class: "icon" }, entry.icon ? icon(entry.icon, 15) : undefined),
        el("span", { class: "menu__label" }, entry.label),
        hasChildren
          ? el("span", { class: "menu__chevron" }, icon("chevronRight", 13))
          : entry.shortcut && el("span", { class: "kbd" }, entry.shortcut),
      );

      if (!entry.disabled) buttons.push(button);
      node.appendChild(button);
    }

    panels.push(level);
    return node;
  }

  function openChild(entry: MenuItem, button: HTMLElement, depth: number): void {
    closeFrom(depth + 1);
    if (!entry.children?.length) return;
    const rect = anchorRect(button);
    const child = buildPanel(entry.children, depth + 1);
    // Overlap the parent slightly so the pointer never crosses a gap.
    place(child, rect.right - 4, rect.top - 4, rect);
  }

  function paint(level: (typeof panels)[number]): void {
    level.buttons.forEach((b, i) => b.classList.toggle("is-active", i === level.active));
  }

  const root = buildPanel(entries, 0);
  place(root, anchor.x, anchor.y);

  const offPointer = on(
    document,
    "pointerdown",
    (ev) => {
      const target = ev.target as Node;
      if (!panels.some((p) => p.node.contains(target))) dispose();
    },
    { capture: true },
  );

  const offKey = on(
    document,
    "keydown",
    (ev) => {
      const key = (ev as KeyboardEvent).key;
      const level = panels[panels.length - 1];
      if (!level) return;

      if (key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        if (panels.length > 1) closeFrom(panels.length - 1);
        else dispose();
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        ev.preventDefault();
        if (level.buttons.length === 0) return;
        const step = key === "ArrowDown" ? 1 : -1;
        level.active = (level.active + step + level.buttons.length) % level.buttons.length;
        paint(level);
        level.buttons[level.active]?.focus();
      } else if (key === "ArrowRight") {
        ev.preventDefault();
        level.buttons[level.active]?.click();
      } else if (key === "ArrowLeft") {
        ev.preventDefault();
        if (panels.length > 1) closeFrom(panels.length - 1);
      } else if (key === "Enter" && level.active >= 0) {
        ev.preventDefault();
        level.buttons[level.active]?.click();
      }
    },
    { capture: true },
  );

  const offResize = on(window, "resize", () => dispose());

  // Menus are positioned in viewport coordinates, so scrolling the panel
  // underneath one leaves it floating next to whatever moved into that spot.
  const offScroll = on(
    document,
    "scroll",
    (ev) => {
      if (panels.some((p) => p.node.contains(ev.target as Node))) return;
      dispose();
    },
    { capture: true, passive: true },
  );

  function dispose(): void {
    if (openMenu?.root !== root) return;
    offPointer();
    offKey();
    offResize();
    offScroll();
    closeFrom(0);
    openMenu = null;
  }

  openMenu = { root, dispose };
}

/** Convenience wrapper for `contextmenu` handlers. */
export function attachContextMenu(
  target: HTMLElement,
  build: (ev: MouseEvent) => MenuEntry[] | null,
): () => void {
  return on(target, "contextmenu", (ev) => {
    const event = ev as MouseEvent;
    const entries = build(event);
    if (!entries || entries.length === 0) return;
    event.preventDefault();
    showMenu(entries, { x: event.clientX, y: event.clientY });
  });
}
