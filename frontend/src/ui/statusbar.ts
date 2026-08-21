import * as actions from "../actions";
import { debounce, el, icon } from "../lib/dom";
import { countWords } from "../lib/format";
import { activeTab, isDirty, state, subscribe } from "../store";

export interface Statusbar {
  root: HTMLElement;
  setCursor: (line: number, column: number, selected: number) => void;
  destroy: () => void;
}

const SAVE_LABELS: Record<string, string> = {
  idle: "已保存",
  dirty: "未保存",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败 · 重试",
  conflict: "同步冲突 · 处理",
};

export function createStatusbar(): Statusbar {
  const words = el("span", { class: "statusbar__item" });
	const sync = el("span", { class: "statusbar__item", role: "status", "aria-live": "polite" });
  const save = el("button", {
    class: "statusbar__save statusbar__item",
    type: "button",
    role: "status",
    "aria-live": "polite",
    onclick: () => {
      const tab = activeTab();
      if (!tab) return;
      void actions.saveTab(tab.id);
    },
  });
  const root = el(
    "footer",
    { class: "statusbar" },
    words,
		sync,
    el("div", { class: "spacer" }),
    save,
  );

  let countedText: string | null = null;
  let countedWords = 0;

  function paintCounts(): void {
    const tab = activeTab();
    if (!tab) {
      countedText = null;
      words.textContent = "";
      return;
    }
    if (tab.content !== countedText) {
      countedText = tab.content;
      countedWords = countWords(tab.content);
    }
    words.textContent = `${countedWords} 字`;
  }

  const paintCountsSoon = debounce(paintCounts, 220);

  function paintSave(): void {
    const tab = activeTab();
    save.hidden = !tab;
    if (!tab) return;

    const status = tab.conflict
      ? "conflict"
      : state.saveState === "idle" && isDirty(tab)
        ? "dirty"
        : state.saveState;
    save.classList.toggle(
      "is-dirty",
      status === "dirty" || status === "error" || status === "conflict",
    );
    save.classList.toggle("is-saved", status === "saved" || status === "idle");
    save.disabled = status === "saving" || status === "saved" || status === "idle";
    save.title = status === "error" ? "重新保存" : status === "conflict" ? "处理冲突" : "";
    save.replaceChildren(
      status === "saving"
        ? el("span", { class: "spinner" })
        : icon(
            status === "error" || status === "conflict"
              ? "alert"
              : status === "dirty"
                ? "edit"
                : "check",
            12,
          ),
      el("span", null, SAVE_LABELS[status] ?? ""),
    );
  }

  function paintAll(): void {
    paintCounts();
    paintSave();
  }

	function paintSync(): void {
		const current = state.indexState;
		if (current.phase === "building") {
			sync.hidden = false;
			sync.textContent = current.total > 0
				? `建立索引 ${current.processed}/${current.total}`
				: "正在建立索引…";
			return;
		}
		if (current.phase === "calibrating") {
			sync.hidden = false;
			sync.textContent = "后台校准中…";
			return;
		}
		if (current.phase === "error") {
			sync.hidden = false;
			sync.textContent = "索引同步失败";
			return;
		}
		sync.hidden = true;
		sync.textContent = "";
	}

  const unsubscribeTabs = subscribe(["activeTabId", "tabs"], paintAll);
  const unsubscribeSave = subscribe(["saveState"], paintSave);
  const unsubscribeDoc = subscribe(["docRevision"], paintCountsSoon);
	const unsubscribeSync = subscribe(["indexState"], paintSync);
  paintAll();
	paintSync();

  return {
    root,
    destroy: () => {
      unsubscribeTabs();
      unsubscribeSave();
      unsubscribeDoc();
			unsubscribeSync();
      paintCountsSoon.cancel();
    },
    // Cursor details remain available through editor accessibility APIs and
    // the command palette; they no longer occupy the always-visible footer.
    setCursor: () => undefined,
  };
}
