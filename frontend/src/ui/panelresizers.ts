import * as actions from "../actions";
import { disposableElement, el, on, type DisposableHTMLElement } from "../lib/dom";
import {
  clampListWidth,
  clampSidebarWidth,
  fitPanelWidths,
  LIST_MAX,
  LIST_MIN,
  localPointerX,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  type PanelWidths,
} from "../lib/panels";
import { state, subscribe } from "../store";

export interface PanelResizers extends DisposableHTMLElement {
  refresh: () => void;
}

type Panel = "sidebar" | "list";

/** Two overlay separators keep the body grid at three semantic children. */
export function createPanelResizers(body: HTMLElement): PanelResizers {
  let current: PanelWidths = {
    sidebar: state.settings.sidebarWidth,
    list: state.settings.listWidth,
  };
  let dragging: { panel: Panel; pointerId: number } | null = null;

  const sidebar = separator("sidebar", "调整侧栏宽度", "qiaoji-sidebar");
  const list = separator("list", "调整笔记列表宽度", "qiaoji-notelist");
  const root = el("div", { class: "panel-resizers", "aria-hidden": "false" }, sidebar, list);

  function separator(panel: Panel, label: string, controls: string): HTMLElement {
    const node = el("div", {
      class: `panel-resizer panel-resizer--${panel}`,
      role: "separator",
      tabIndex: 0,
      title: `${label}（双击恢复默认）`,
      "aria-label": label,
      "aria-orientation": "vertical",
      "aria-controls": controls,
      onpointerdown: (ev: PointerEvent) => beginDrag(panel, node, ev),
      onkeydown: (ev: KeyboardEvent) => resizeFromKeyboard(panel, ev),
      ondblclick: () => commit(panel, panel === "sidebar" ? 208 : 292),
    });
    return node;
  }

  function availableWidth(): number {
    return Math.max(0, body.clientWidth);
  }

  function requested(): PanelWidths {
    return {
      sidebar: state.settings.sidebarWidth,
      list: state.settings.listWidth,
    };
  }

  function refresh(): void {
    const grid = state.listView === "grid";
    current = fitPanelWidths(
      availableWidth(),
      requested(),
      state.sidebarVisible,
      state.listVisible && !grid,
    );
    // Grid view still uses the sidebar width even though its middle pane is a
    // card wall rather than the fixed-width list.
    if (grid && state.sidebarVisible) {
      current.sidebar = clampSidebarWidth(
        state.settings.sidebarWidth,
        availableWidth(),
        0,
      );
    }
    paint();
  }

  function paint(): void {
    body.style.setProperty("--sidebar-w", `${Math.max(0, current.sidebar)}px`);
    body.style.setProperty("--list-w", `${Math.max(0, current.list)}px`);
    updateSeparator(sidebar, current.sidebar, SIDEBAR_MIN, dynamicMax("sidebar"));
    updateSeparator(list, current.list, LIST_MIN, dynamicMax("list"));
  }

  function dynamicMax(panel: Panel): number {
    if (panel === "sidebar") {
      return Math.max(
        SIDEBAR_MIN,
        Math.min(SIDEBAR_MAX, availableWidth() - current.list - 320),
      );
    }
    return Math.max(
      LIST_MIN,
      Math.min(LIST_MAX, availableWidth() - current.sidebar - 320),
    );
  }

  function updateSeparator(node: HTMLElement, value: number, min: number, max: number): void {
    node.setAttribute("aria-valuemin", String(min));
    node.setAttribute("aria-valuemax", String(Math.max(min, Math.round(max))));
    node.setAttribute("aria-valuenow", String(Math.round(value)));
    node.setAttribute("aria-valuetext", `${Math.round(value)} 像素`);
  }

  function beginDrag(panel: Panel, node: HTMLElement, ev: PointerEvent): void {
    if (ev.button !== 0 || node.hasAttribute("hidden")) return;
    ev.preventDefault();
    dragging = { panel, pointerId: ev.pointerId };
    node.setPointerCapture?.(ev.pointerId);
    body.classList.add("is-resizing-panels");

    const move = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      const rect = body.getBoundingClientRect();
      const x = localPointerX(event.clientX, rect.left, rect.width, body.clientWidth);
      if (panel === "sidebar") {
        current.sidebar = clampSidebarWidth(x, availableWidth(), current.list);
      } else {
        const start = state.sidebarVisible ? current.sidebar : 0;
        current.list = clampListWidth(x - start, availableWidth(), start);
      }
      paint();
    };
    const end = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      dragging = null;
      body.classList.remove("is-resizing-panels");
      node.releasePointerCapture?.(event.pointerId);
      removeMove();
      removeUp();
      removeCancel();
      void persist(panel);
    };
    const removeMove = on(node, "pointermove", move);
    const removeUp = on(node, "pointerup", end);
    const removeCancel = on(node, "pointercancel", end);
  }

  function resizeFromKeyboard(panel: Panel, ev: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) return;
    ev.preventDefault();
    const min = panel === "sidebar" ? SIDEBAR_MIN : LIST_MIN;
    const max = dynamicMax(panel);
    const currentValue = panel === "sidebar" ? current.sidebar : current.list;
    const step = ev.shiftKey ? 24 : 8;
    const next =
      ev.key === "Home"
        ? min
        : ev.key === "End"
          ? max
          : currentValue + (ev.key === "ArrowLeft" ? -step : step);
    commit(panel, next);
  }

  function commit(panel: Panel, value: number): void {
    if (panel === "sidebar") {
      current.sidebar = clampSidebarWidth(value, availableWidth(), current.list);
    } else {
      current.list = clampListWidth(value, availableWidth(), current.sidebar);
    }
    paint();
    void persist(panel);
  }

  function persist(panel: Panel): Promise<void> {
    return actions.patchSettings(
      panel === "sidebar"
        ? { sidebarWidth: Math.round(current.sidebar) }
        : { listWidth: Math.round(current.list) },
    );
  }

  const unsubscribe = subscribe(
    ["settings", "sidebarVisible", "listVisible", "listView"],
    refresh,
  );
  const observer = new ResizeObserver(refresh);
  observer.observe(body);
  refresh();

  return Object.assign(
    disposableElement(root, () => {
      unsubscribe();
      observer.disconnect();
      body.classList.remove("is-resizing-panels");
      body.style.removeProperty("--sidebar-w");
      body.style.removeProperty("--list-w");
    }),
    { refresh },
  );
}
