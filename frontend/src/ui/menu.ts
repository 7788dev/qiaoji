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
function place(node: HTMLElement, x: number, y: number, flipAround?: DOMRect): void {
  node.style.visibility = "hidden";
  node.style.left = "0px";
  node.style.top = "0px";
  document.body.appendChild(node);

  const rect = node.getBoundingClientRect();
  const margin = 8;

  let left = x;
  if (left + rect.width + margin > window.innerWidth) {
    // A submenu flips to the other side of its parent; a root menu flips about
    // the cursor.
    left = flipAround
      ? Math.max(margin, flipAround.left - rect.width + 2)
      : Math.max(margin, x - rect.width);
  }

  let top = y;
  if (top + rect.height + margin > window.innerHeight) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }

  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
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
    const node = el("div", { class: "menu", role: "menu" });
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
            closeFrom(0);
            openMenu = null;
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
    const rect = button.getBoundingClientRect();
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

  function dispose(): void {
    if (openMenu?.root !== root) return;
    offPointer();
    offKey();
    offResize();
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
