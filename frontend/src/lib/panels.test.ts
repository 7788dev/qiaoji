import { describe, expect, it } from "vitest";

import {
  clampListWidth,
  clampSidebarWidth,
  fitPanelWidths,
  localPointerX,
} from "./panels";

describe("panel layout", () => {
  it("keeps persisted widths when the editor has enough room", () => {
    expect(fitPanelWidths(1240, { sidebar: 240, list: 320 })).toEqual({
      sidebar: 240,
      list: 320,
    });
  });

  it("gives navigation space back while preserving the editor", () => {
    const fitted = fitPanelWidths(760, { sidebar: 300, list: 400 });
    expect(fitted.sidebar + fitted.list).toBeLessThanOrEqual(440);
    expect(fitted.sidebar).toBeGreaterThanOrEqual(152);
  });

  it("accounts for a hidden panel", () => {
    expect(fitPanelWidths(620, { sidebar: 208, list: 292 }, false, true)).toEqual({
      sidebar: 0,
      list: 292,
    });
  });

  it("clamps keyboard and pointer resizing to usable bounds", () => {
    expect(clampSidebarWidth(999, 1000, 300)).toBe(360);
    expect(clampListWidth(999, 900, 240)).toBe(340);
    expect(localPointerX(250, 100, 600, 400)).toBe(100);
  });
});
