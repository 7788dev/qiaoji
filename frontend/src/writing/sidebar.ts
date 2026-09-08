import { debounce, el, icon, setSafeHighlight } from "../lib/dom";
import { outlineOf } from "../lib/markdown";
import { showMenu } from "../ui/menu";
import { confirm, prompt } from "../ui/modal";
import * as api from "../api";
import type { WritingController } from "./controller";
import { fileName, pathKey, type DirectoryEntry } from "./types";
import { splitSource } from "./source";

interface Branch { container: HTMLElement; cursor: string; loading: boolean }
export class WritingSidebar {
  readonly root = el("aside", { class: "writing-sidebar", "aria-label": "文件与大纲" });
  private readonly files = el("div", { class: "writing-files" });
  private readonly tree = el("div", { class: "file-tree", role: "tree", "aria-label": "文件夹中的 Markdown 文件" });
  private readonly results = el("div", { class: "file-results", hidden: true });
  private readonly outline = el("div", { class: "writing-outline", hidden: true });
  private readonly folderName = el("button", { class: "folder-name", type: "button", title: "打开文件夹" });
  private readonly search = el("input", { class: "file-search", type: "search", placeholder: "搜索文件与内容", "aria-label": "搜索文件夹" });
  private readonly filesTab = el("button", { type: "button", role: "tab" }, "文件");
  private readonly outlineTab = el("button", { type: "button", role: "tab" }, "大纲");
  private readonly expanded = new Set<string>();
  private branches = new Map<string, Branch>();
  private generation = 0;
  private searchGeneration = 0;
  private folder = "";
  private unsubscribe: () => void;
  private searchSoon = debounce(() => void this.runSearch(), 160);
  private outlineSoon = debounce(() => this.paintOutline(), 100);
  private refreshSoon = debounce(() => void this.refresh(), 150);

  constructor(
    readonly controller: WritingController,
    readonly goToHeading: (index: number) => void,
    readonly onDocumentOpened: () => void = () => {},
  ) {
    this.root.append(
      el("div", { class: "sidebar-actions" },
        el("button", { class: "sidebar-new", type: "button", title: "新建文档  Ctrl+N", onclick: () => this.run(async () => {
          await controller.newDocument();
          this.onDocumentOpened();
        }) }, icon("plus", 14), "新建"),
        el("button", { class: "ibtn", type: "button", title: "打开文件  Ctrl+O", "aria-label": "打开文件", onclick: () => this.run(() => this.openFile()) }, icon("folderOpen", 15))),
      el("div", { class: "sidebar-tabs", role: "tablist", "aria-label": "侧栏内容" }, this.filesTab, this.outlineTab),
      this.files, this.outline,
    );
    this.files.append(
      el("div", { class: "file-search-wrap" }, icon("search", 14), this.search),
      el("div", { class: "folder-heading" }, this.folderName,
        el("button", { class: "ibtn", type: "button", title: "新建文件夹", "aria-label": "新建文件夹", onclick: () => this.run(async () => {
          if (!controller.folder) return controller.openFolder();
          const name = await prompt({ title: "新建文件夹", label: "名称" });
          if (name) { await controller.bridge.createFolder(name); controller.emit("folder"); }
        }) }, icon("plus", 13))),
      el("div", { class: "file-scroll scroll" }, this.tree, this.results),
    );
    this.folderName.onclick = () => this.run(() => controller.openFolder());
    this.filesTab.onclick = () => void controller.patchSettings({ sidebarMode: "files" });
    this.outlineTab.onclick = () => void controller.patchSettings({ sidebarMode: "outline" });
    this.search.oninput = () => this.searchSoon();
    this.search.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.stopPropagation(); this.search.value = ""; void this.runSearch(); }
    };
    this.tree.addEventListener("keydown", (event) => this.treeKeyboard(event));
    this.unsubscribe = controller.subscribe((kind) => {
      if (kind === "folder") this.refreshSoon();
      if (kind === "active" || kind === "documents") { this.paintSelection(); this.outlineSoon(); }
      if (kind === "content") this.outlineSoon();
      if (kind === "settings") this.paintMode();
    });
    this.paintMode();
    void this.refresh();
  }
  private run(job: () => Promise<unknown>): void {
    void job().catch((error) => this.controller.dialogs.error(String(error)));
  }
  private async openFile(path = ""): Promise<void> {
    if (await this.controller.open(path)) this.onDocumentOpened();
  }
  private paintMode(): void {
    const outline = this.controller.settings.sidebarMode === "outline";
    this.files.hidden = outline;
    this.outline.hidden = !outline;
    this.filesTab.classList.toggle("is-active", !outline);
    this.outlineTab.classList.toggle("is-active", outline);
    this.filesTab.setAttribute("aria-selected", String(!outline));
    this.outlineTab.setAttribute("aria-selected", String(outline));
    if (outline) this.paintOutline();
  }
  private paintOutline(): void {
    if (this.outline.hidden) return;
    const source = splitSource(this.controller.active?.content ?? "").body;
    const entries = outlineOf(source);
    this.outline.replaceChildren(...entries.map((entry, index) => el("button", {
      class: "outline-row", type: "button", title: entry.text,
      style: { paddingLeft: 16 + (entry.level - 1) * 12 + "px" },
      onclick: () => this.goToHeading(index),
    }, entry.text)));
    if (!entries.length) this.outline.append(el("p", { class: "sidebar-hint" }, "文章中的标题会显示在这里。"));
  }
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    if (this.folder !== this.controller.folder) {
      this.expanded.clear();
      this.search.value = "";
      this.folder = this.controller.folder;
      this.searchGeneration++;
    }
    this.branches.clear();
    this.folderName.textContent = this.folder ? fileName(this.folder) : "打开文件夹";
    this.folderName.title = this.folder || "打开文件夹";
    this.folderName.parentElement!.hidden = !this.folder;
    this.search.disabled = !this.folder;
    this.tree.replaceChildren();
    if (!this.search.value.trim()) { this.tree.hidden = false; this.results.hidden = true; }
    if (!this.folder) {
      this.tree.append(el("div", { class: "sidebar-hint" },
        el("p", null, "打开文件夹，浏览其中的 Markdown 文件。"),
        el("button", { class: "btn", type: "button", onclick: () => this.run(() => this.controller.openFolder()) }, "打开文件夹")));
      return;
    }
    await this.load(this.folder, this.tree, 0, generation);
    if (this.search.value.trim()) await this.runSearch();
  }
  private async load(path: string, container: HTMLElement, depth: number, generation: number): Promise<void> {
    const branch = this.branches.get(path) ?? { container, cursor: "", loading: false };
    if (branch.loading) return;
    this.branches.set(path, branch);
    branch.loading = true;
    container.querySelector(":scope > .tree-more")?.remove();
    try {
      const page = await this.controller.bridge.listDirectory(path, branch.cursor);
      if (generation !== this.generation) return;
      for (const entry of page.entries) container.append(this.entry(entry, depth, generation));
      branch.cursor = page.nextCursor;
      if (page.nextCursor) container.append(el("button", {
        class: "tree-more", type: "button", onclick: () => this.run(() => this.load(path, container, depth, generation)),
      }, "加载更多"));
      if (!page.entries.length && !container.children.length) container.append(el("div", { class: "tree-empty" }, "没有 Markdown 文件"));
      this.paintSelection();
    } catch (error) {
      if (generation === this.generation) {
        container.append(el("button", { class: "tree-more", type: "button", onclick: () => {
          container.replaceChildren();
          this.run(() => this.load(path, container, depth, generation));
        } }, "读取失败，点击重试"));
        this.controller.dialogs.error(String(error));
      }
    } finally { branch.loading = false; }
  }
  private entry(entry: DirectoryEntry, depth: number, generation: number): HTMLElement {
    const group = el("div", { class: "tree-node" });
    const children = el("div", { class: "tree-children", role: "group", hidden: true });
    const arrow = el("span", { class: "tree-arrow" }, entry.directory ? icon("chevronRight", 11) : null);
    const button = el("button", {
      class: "tree-row", type: "button", role: "treeitem", title: entry.path,
      "aria-level": depth + 1, dataset: { path: entry.path },
      style: { paddingLeft: 8 + depth * 16 + "px" },
    }, arrow, icon(entry.directory ? "folder" : "note", 14), el("span", { class: "truncate" }, entry.name));
    const toggle = async () => {
      children.hidden = !children.hidden;
      button.setAttribute("aria-expanded", String(!children.hidden));
      arrow.classList.toggle("is-expanded", !children.hidden);
      if (children.hidden) this.expanded.delete(entry.path);
      else {
        this.expanded.add(entry.path);
        if (!this.branches.has(entry.path)) await this.load(entry.path, children, depth + 1, generation);
      }
    };
    button.onclick = () => this.run(() => entry.directory ? toggle() : this.openFile(entry.path));
    button.oncontextmenu = (event) => {
      event.preventDefault();
      showMenu(entry.directory ? [
        { label: "在资源管理器中显示", run: () => this.run(() => api.revealInExplorer(entry.path)) },
      ] : [
        { label: "打开", run: () => this.run(() => this.openFile(entry.path)) },
        { label: "重命名", run: () => this.run(async () => {
          const name = await prompt({ title: "重命名文件", label: "文件名", value: entry.name });
          if (!name || name === entry.name) return;
          const doc = await this.controller.open(entry.path);
          if (doc) await this.controller.rename(doc.id, /\.(md|markdown)$/i.test(name) ? name : name + ".md");
        }) },
        { label: "在资源管理器中显示", run: () => this.run(() => api.revealInExplorer(entry.path)) },
        "separator",
        { label: "移入回收站", danger: true, run: () => this.run(async () => {
          if (!(await confirm({ title: "移入回收站", message: `删除“${entry.name}”？可以从回收站还原。`, confirmLabel: "移入回收站", danger: true }))) return;
          const doc = await this.controller.open(entry.path);
          if (doc) await this.controller.trash(doc.id);
        }) },
      ], { x: event.clientX, y: event.clientY });
    };
    group.append(button);
    if (entry.directory) {
      button.setAttribute("aria-expanded", "false");
      group.append(children);
      if (this.expanded.has(entry.path)) void toggle();
    }
    return group;
  }
  private paintSelection(): void {
    const path = pathKey(this.controller.active?.path ?? "");
    for (const item of Array.from(this.tree.querySelectorAll<HTMLElement>(".tree-row"))) {
      const selected = pathKey(item.dataset.path ?? "") === path;
      item.classList.toggle("is-active", selected);
      item.setAttribute("aria-selected", String(selected));
    }
  }
  private async runSearch(): Promise<void> {
    const generation = ++this.searchGeneration;
    const query = this.search.value.trim();
    this.tree.hidden = Boolean(query);
    this.results.hidden = !query;
    if (!query) return;
    this.results.replaceChildren(el("p", { class: "sidebar-hint" }, "搜索中…"));
    try {
      const hits = this.folder ? await this.controller.bridge.search(query) : [];
      if (generation !== this.searchGeneration) return;
      this.results.replaceChildren(...hits.map((hit) => {
        const snippet = el("span", { class: "search-snippet" });
        setSafeHighlight(snippet, hit.snippet, "");
        return el("button", { class: "search-result", type: "button", title: hit.path, onclick: () => this.run(() => this.openFile(hit.path)) },
          el("span", { class: "search-result__name" }, fileName(hit.path)), snippet);
      }));
      if (!hits.length) this.results.append(el("p", { class: "sidebar-hint" }, this.folder ? "没有匹配的内容。" : "先打开一个文件夹，再搜索其中的文档。"));
    } catch (error) {
      if (generation === this.searchGeneration) this.results.replaceChildren(el("p", { class: "sidebar-hint" }, "搜索失败，可以重新输入后重试。"));
      this.controller.dialogs.error(String(error));
    }
  }
  focusSearch(): void {
    void this.controller.patchSettings({ sidebarMode: "files", sidebarHidden: false });
    this.search.focus();
    this.search.select();
  }
  private treeKeyboard(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(".tree-row");
    if (!target) return;
    const rows = Array.from(this.tree.querySelectorAll<HTMLButtonElement>(".tree-row")).filter((row) => !row.closest("[hidden]"));
    const at = rows.indexOf(target);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (event.key === "ArrowRight" && target.getAttribute("aria-expanded") === "false") {
      event.preventDefault(); target.click();
    } else if (event.key === "ArrowLeft" && target.getAttribute("aria-expanded") === "true") {
      event.preventDefault(); target.click();
    }
  }
  destroy(): void {
    this.generation++;
    this.searchGeneration++;
    this.unsubscribe();
    this.searchSoon.cancel();
    this.outlineSoon.cancel();
    this.refreshSoon.cancel();
  }
}
