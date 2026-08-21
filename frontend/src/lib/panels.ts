export const SIDEBAR_MIN = 152;
export const SIDEBAR_MAX = 360;
export const LIST_MIN = 200;
export const LIST_MAX = 520;
export const EDITOR_MIN = 320;

export interface PanelWidths {
  sidebar: number;
  list: number;
}

/**
 * Fits persisted panel sizes into the current zoom-adjusted layout without
 * overwriting the saved preference. The editor always keeps a usable minimum
 * and both navigation panels give ground proportionally on narrow windows.
 */
export function fitPanelWidths(
  available: number,
  requested: PanelWidths,
  sidebarVisible = true,
  listVisible = true,
): PanelWidths {
  let sidebar = clamp(requested.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  let list = clamp(requested.list, LIST_MIN, LIST_MAX);
  const budget = Math.max(0, available - EDITOR_MIN);

  if (!sidebarVisible) sidebar = 0;
  if (!listVisible) list = 0;
  if (sidebar + list <= budget) return { sidebar, list };

  if (sidebarVisible && listVisible) {
    const reducibleSidebar = Math.max(0, sidebar - SIDEBAR_MIN);
    const reducibleList = Math.max(0, list - LIST_MIN);
    let excess = sidebar + list - budget;
    const reducible = reducibleSidebar + reducibleList;
    if (reducible > 0) {
      const sidebarCut = Math.min(reducibleSidebar, excess * (reducibleSidebar / reducible));
      sidebar -= sidebarCut;
      excess -= sidebarCut;
      list -= Math.min(reducibleList, excess);
    }
    if (sidebar + list > budget) {
      // Below the declared minimum window there may simply not be enough
      // room. Preserve the sidebar first and let the list collapse; CSS hides
      // it entirely at the narrowest breakpoint.
      list = Math.max(0, budget - sidebar);
      if (list < LIST_MIN) {
        list = 0;
        sidebar = Math.min(sidebar, budget);
      }
    }
    return { sidebar: Math.round(sidebar), list: Math.round(list) };
  }

  if (sidebarVisible) return { sidebar: Math.min(sidebar, budget), list: 0 };
  if (listVisible) return { sidebar: 0, list: Math.min(list, budget) };
  return { sidebar: 0, list: 0 };
}

export function clampSidebarWidth(value: number, available: number, listWidth: number): number {
  return Math.round(clamp(value, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, available - listWidth - EDITOR_MIN)));
}

export function clampListWidth(value: number, available: number, sidebarWidth: number): number {
  return Math.round(clamp(value, LIST_MIN, Math.min(LIST_MAX, available - sidebarWidth - EDITOR_MIN)));
}

export function localPointerX(clientX: number, rectLeft: number, rectWidth: number, layoutWidth: number): number {
  if (rectWidth <= 0 || layoutWidth <= 0) return 0;
  return ((clientX - rectLeft) * layoutWidth) / rectWidth;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return Math.max(0, max);
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
