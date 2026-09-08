import * as api from "../api";
import markUrl from "../assets/mark.png";
import { disposableElement, el, on, type DisposableHTMLElement } from "../lib/dom";

const SVG_NS = "http://www.w3.org/2000/svg";

export function brandMark(className: string): HTMLElement {
  return el("img", {
    class: className,
    src: markUrl,
    alt: "巧记",
    draggable: false,
  });
}

function windowGlyph(kind: "min" | "max" | "restore" | "close"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("aria-hidden", "true");

  const paths: Record<typeof kind, string[]> = {
    min: ["M0 5.5h10"],
    max: ["M0.5 0.5h9v9h-9z"],
    restore: ["M2.5 0.5h7v7h-7z", "M0.5 2.5h7v7h-7z"],
    close: ["M0.5 0.5l9 9", "M9.5 0.5l-9 9"],
  };
  for (const d of paths[kind]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export function createWindowControls(): DisposableHTMLElement {
  let destroyed = false;
  const maxButton = el("button", {
    class: "wbtn",
    type: "button",
    title: "最大化",
    "aria-label": "最大化",
    onclick: () => void api.windowToggleMaximise().then(paintMaxButton),
  });

  async function paintMaxButton(): Promise<void> {
    const maximised = await api.windowIsMaximised();
    if (destroyed) return;
    maxButton.replaceChildren(windowGlyph(maximised ? "restore" : "max"));
    maxButton.title = maximised ? "向下还原" : "最大化";
  }
  void paintMaxButton();
  const removeResize = on(window, "resize", () => void paintMaxButton());

  const root = el(
    "div",
    { class: "workspacebar__controls" },
    el(
      "button",
      {
        class: "wbtn",
        type: "button",
        title: "最小化",
        "aria-label": "最小化",
        onclick: () => void api.windowMinimise(),
      },
      windowGlyph("min"),
    ),
    maxButton,
    el(
      "button",
      {
        class: "wbtn wbtn--close",
        type: "button",
        title: "关闭",
        "aria-label": "关闭",
        onclick: () => void api.windowClose(),
      },
      windowGlyph("close"),
    ),
  );
  return disposableElement(root, () => {
    destroyed = true;
    removeResize();
  });
}
