/**
 * Every user-visible operation lives here so the toolbar, context menus,
 * command palette and keyboard shortcuts all drive the same code path. A
 * command that behaves differently depending on how it was invoked is a bug
 * this layout makes hard to write.
 */

import * as api from "./api";
import { debounce, el } from "./lib/dom";
import { titleOf } from "./lib/markdown";
import {
  activeTab,
  isDirty,
  patchTab,
  setState,
  state,
  tabByPath,
} from "./store";
import type {
  ListQuery,
  Note,
  NoteMeta,
  Scope,
  Settings,
  SortBy,
  Stats as AppStats,
  Tab,
} from "./types";
import { openModal, type ModalHandle } from "./ui/modal";
import { notify, reportError } from "./ui/toast";

/* ---------------------------------------------------------------- editor hook */

interface EditorBridge {
  loadDoc(doc: string, cursor: number, scrollTop: number): void;
  syncDoc(doc: string): void;
  readonly doc: string;
  readonly cursor: number;
  readonly scrollTop: number;
  focus(): void;
}

let editor: EditorBridge | null = null;

export function registerEditor(bridge: EditorBridge): () => void {
  editor = bridge;
  return () => {
    if (editor === bridge) editor = null;
  };
}

/** The live buffer, which may be ahead of the last save. */
export function currentMarkdown(): string {
  return editor?.doc ?? activeTab()?.content ?? "";
}

/* ---------------------------------------------------------------- loading */

function query(): ListQuery {
  return {
    scope: state.scope === "trash" ? "all" : state.scope,
    value: state.scopeValue,
    sortBy: state.sortBy,
    limit: 0,
  };
}

export async function refreshList(): Promise<void> {
  if (!state.ready) return;
  setState({ loadingList: true });
  try {
    const notes = await api.listNotes(query());
    setState({ notes, loadingList: false });
  } catch (err) {
    setState({ loadingList: false });
    reportError("读取笔记列表", err);
  }
}

export async function refreshSidebar(): Promise<void> {
  if (!state.ready) return;
  try {
    const next = await api.sidebar();
    // Handing back the previous arrays when nothing moved keeps the store from
    // publishing, and the sidebar from rebuilding its nav tree and dropping
    // whatever row had keyboard focus.
    setState({
      folders: keepIfSame(
        state.folders,
        next.folders,
        (a, b) => a.path === b.path && a.name === b.name && a.count === b.count,
      ),
      tags: keepIfSame(state.tags, next.tags, (a, b) => a.name === b.name && a.count === b.count),
      stats: sameStats(state.stats, next.stats) ? state.stats : next.stats,
    });
  } catch (err) {
    reportError("读取侧边栏", err);
  }
}

function keepIfSame<T>(previous: T[], next: T[], equal: (a: T, b: T) => boolean): T[] {
  if (previous.length !== next.length) return next;
  return previous.every((item, i) => equal(item, next[i])) ? previous : next;
}

function sameStats(a: AppStats, b: AppStats): boolean {
  return (
    a.notes === b.notes &&
    a.words === b.words &&
    a.folders === b.folders &&
    a.tags === b.tags &&
    a.trash === b.trash &&
    a.bytes === b.bytes
  );
}

export async function refreshTrash(): Promise<void> {
  try {
    setState({ trash: await api.listTrash() });
  } catch (err) {
    reportError("读取回收站", err);
  }
}

export async function refreshAll(): Promise<void> {
  await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
}

/** Debounced so a burst of filesystem events costs one round of queries. */
export const refreshAllSoon = debounce(() => {
  void refreshAll();
}, 180);

export function selectScope(scope: Scope, value = ""): void {
  if (state.scope === scope && state.scopeValue === value) return;
  setState({ scope, scopeValue: value, searchQuery: "", searchHits: null });
  if (scope === "trash") {
    void refreshTrash();
  } else {
    void refreshList();
  }
}

export function setSortBy(sortBy: SortBy): void {
  if (state.sortBy === sortBy) return;
  setState({ sortBy });
  void patchSettings({ sortBy });
  void refreshList();
}

export function setListView(listView: "list" | "grid"): void {
  if (state.listView === listView) return;
  setState({ listView });
  void patchSettings({ listView });
}

/* ---------------------------------------------------------------- tabs */

function tabFromNote(note: Note): Tab {
  return {
    id: note.id || note.path,
    path: note.path,
    title: note.title,
    content: note.content,
    savedContent: note.content,
    favorite: note.favorite,
    tags: note.tags ?? [],
    folder: note.folder,
    scrollTop: 0,
    cursor: 0,
    mode: "edit",
    revision: note.revision,
    conflict: null,
  };
}

/**
 * Persists the live editor buffer back into the tab before switching away.
 *
 * The tab is mutated rather than replaced: this only ever catches the tab up
 * with text the editor already shows, and republishing `tabs` here would
 * repaint the strip and the note list on the save path.
 */
function captureEditorInto(tabId: string): void {
  if (!editor) return;
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.content = editor.doc;
  tab.cursor = editor.cursor;
  tab.scrollTop = editor.scrollTop;
}

export async function openNote(target: NoteMeta | string, options: { focus?: boolean } = {}): Promise<void> {
  const path = typeof target === "string" ? target : target.path;
  const id = typeof target === "string" ? "" : target.id;

  const existing = tabByPath(path);
  if (existing) {
    activateTab(existing.id, options.focus !== false);
    return;
  }

  try {
    const note = await api.getNote(path, id);
    if (state.activeTabId) captureEditorInto(state.activeTabId);
    const tab = tabFromNote(note);
    setState({ tabs: [...state.tabs, tab], activeTabId: tab.id, saveState: "idle" });
    if (options.focus !== false) editor?.focus();
  } catch (err) {
    reportError("打开笔记", err);
    // The list is stale if the file vanished; refreshing removes the ghost row.
    void refreshList();
  }
}

export function activateTab(id: string, focus = true): void {
  if (state.activeTabId === id) {
    if (focus) editor?.focus();
    return;
  }
  if (state.activeTabId) captureEditorInto(state.activeTabId);
  setState({ activeTabId: id, saveState: "idle" });
  if (focus) editor?.focus();
}

export async function closeTab(id: string, options: { skipPrompt?: boolean } = {}): Promise<boolean> {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return true;

  if (id === state.activeTabId) captureEditorInto(id);
  const current = state.tabs.find((t) => t.id === id);

  if (current && isDirty(current) && !options.skipPrompt) {
    // Auto-save means unsaved work is measured in milliseconds, so flushing is
    // friendlier than interrogating the user about it.
    if (!(await saveTab(current.id, { silent: true }))) return false;
  }

  cancelScheduledSave(id);
  const index = state.tabs.findIndex((t) => t.id === id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeTabId = state.activeTabId;
  if (activeTabId === id) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = next ? next.id : null;
  }
  setState({ tabs, activeTabId });
  return true;
}

export async function closeOtherTabs(keepId: string): Promise<boolean> {
  let closed = true;
  for (const tab of [...state.tabs]) {
    if (tab.id !== keepId && !(await closeTab(tab.id))) closed = false;
  }
  return closed;
}

export async function closeAllTabs(): Promise<boolean> {
  let closed = true;
  for (const tab of [...state.tabs]) {
    if (!(await closeTab(tab.id))) closed = false;
  }
  return closed;
}

export function cycleTab(direction: 1 | -1): void {
  if (state.tabs.length < 2) return;
  const index = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const next = (index + direction + state.tabs.length) % state.tabs.length;
  activateTab(state.tabs[next].id);
}

/* ---------------------------------------------------------------- saving */

/**
 * Pending autosaves, keyed by tab.
 *
 * One shared timer meant switching tabs mid-edit cancelled the previous tab's
 * write and never rescheduled it, leaving that buffer dirty until something
 * else happened to flush it.
 */
const saveTimers = new Map<string, number>();

function cancelScheduledSave(id: string): void {
  const timer = saveTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  saveTimers.delete(id);
}

function scheduleSave(id: string, delay: number): void {
  cancelScheduledSave(id);
  saveTimers.set(
    id,
    window.setTimeout(() => {
      saveTimers.delete(id);
      void saveTab(id, { silent: true });
    }, delay),
  );
}

const conflictDialogs = new Set<string>();

function isConflictError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes("笔记已在磁盘上被修改");
}

function applyDiskVersion(id: string, note: Note): void {
  patchTab(id, {
    path: note.path,
    title: note.title,
    folder: note.folder,
    tags: note.tags ?? [],
    favorite: note.favorite,
    content: note.content,
    savedContent: note.content,
    revision: note.revision,
    conflict: null,
  });
  if (id === state.activeTabId) {
    editor?.syncDoc(note.content);
    setState({ saveState: "idle" });
  }
}

function markConflict(id: string, disk: Note): void {
  cancelScheduledSave(id);
  const tab = patchTab(id, { conflict: disk });
  if (!tab) return;
  if (id === state.activeTabId) setState({ saveState: "error" });
  notify.error(`「${tabTitle(tab)}」在磁盘上有新的版本`, {
    action: {
      label: "处理冲突",
      run: () => openConflictDialog(id),
    },
  });
}

async function resolveConflict(
  id: string,
  choice: "mine" | "disk" | "copy",
): Promise<boolean> {
  const tab = state.tabs.find((entry) => entry.id === id);
  const disk = tab?.conflict;
  if (!tab || !disk) return true;

  if (choice === "mine") {
    return saveTab(id, { silent: true, force: true });
  }
  if (choice === "disk") {
    applyDiskVersion(id, disk);
    return true;
  }

  try {
    const duplicate = await api.duplicateNote(disk.path);
    const saved = await api.saveNote(duplicate.path, tab.content, duplicate.revision, false);
    const copy = await api.getNote(saved.path, saved.id);
    applyDiskVersion(id, disk);
    const copyTab = tabFromNote(copy);
    setState({
      tabs: [...state.tabs, copyTab],
      activeTabId: copyTab.id,
      saveState: "idle",
    });
    await Promise.all([refreshList(), refreshSidebar()]);
    notify.success("已把本机修改另存为副本");
    return true;
  } catch (err) {
    reportError("另存冲突副本", err);
    return false;
  }
}

function openConflictDialog(id: string): void {
  const tab = state.tabs.find((entry) => entry.id === id);
  if (!tab?.conflict || conflictDialogs.has(id)) return;
  conflictDialogs.add(id);

  let handle: ModalHandle;
  const buttons: HTMLButtonElement[] = [];
  const choose = async (choice: "mine" | "disk" | "copy") => {
    for (const button of buttons) button.disabled = true;
    const resolved = await resolveConflict(id, choice);
    if (resolved) handle.close();
    else for (const button of buttons) button.disabled = false;
  };
  const button = (label: string, choice: "mine" | "disk" | "copy", primary = false) => {
    const node = el(
      "button",
      {
        class: primary ? "btn btn--primary" : "btn",
        type: "button",
        onclick: () => void choose(choice),
      },
      label,
    );
    buttons.push(node);
    return node;
  };

  handle = openModal({
    title: "检测到同步冲突",
    width: 520,
    closeOnBackdrop: false,
    body: el(
      "div",
      { class: "confirm__message" },
      `「${tabTitle(tab)}」在你编辑期间被其他程序修改。请选择要保留的版本。`,
    ),
    footer: [
      button("使用磁盘版本", "disk"),
      button("另存我的修改", "copy"),
      button("保留我的版本", "mine", true),
    ],
    onClose: () => conflictDialogs.delete(id),
  });
}

/** Called on every keystroke; schedules the debounced write. */
export function markDirty(content: string): void {
  const tab = activeTab();
  if (!tab) return;

  // In place, on its own topic. Publishing a new `tabs` array per keystroke
  // rebuilt every tab node and every visible note row for a single character.
  tab.content = content;
  const dirty = content !== tab.savedContent;
  setState({
    docRevision: state.docRevision + 1,
    saveState: dirty ? "dirty" : "idle",
  });

  if (!dirty) {
    cancelScheduledSave(tab.id);
    return;
  }
  if (tab.conflict) {
    cancelScheduledSave(tab.id);
    return;
  }
  if (!state.settings.autoSave) return;
  scheduleSave(tab.id, state.settings.autoSaveDelayMs);
}

export async function saveTab(
  id: string,
  options: { silent?: boolean; force?: boolean } = {},
): Promise<boolean> {
  cancelScheduledSave(id);
  if (id === state.activeTabId) captureEditorInto(id);

  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (!isDirty(tab)) {
    if (!options.silent) notify.info("没有需要保存的修改");
    return true;
  }
  if (tab.conflict && !options.force) {
    openConflictDialog(id);
    return false;
  }

  setState({ saveState: "saving" });
  const content = tab.content;
  const previousPath = tab.path;
  try {
    const meta = await api.saveNote(tab.path, content, tab.revision, options.force ?? false);
    patchTab(id, {
      savedContent: content,
      path: meta.path,
      title: meta.title,
      folder: meta.folder,
      tags: meta.tags ?? [],
      favorite: meta.favorite,
      revision: meta.revision,
      conflict: null,
    });
    if (id === state.activeTabId) {
      setState({ saveState: "saved" });
      window.setTimeout(() => {
        if (state.saveState === "saved") setState({ saveState: "idle" });
      }, 1600);
    }
    if (!options.silent) notify.success("已保存");

    // A save changes one row, and a save cannot move a note out of the scope
    // being shown. Re-querying the whole list and re-walking the vault for the
    // sidebar after every autosave was the write path's dominant cost.
    mergeNoteMeta(meta, previousPath);
    refreshSidebarSoon();
    return true;
  } catch (err) {
    setState({ saveState: "error" });
    if (isConflictError(err)) {
      const disk = await api.getNote(tab.path, tab.id).catch(() => null);
      if (disk) {
        markConflict(id, disk);
        return false;
      }
    }
    reportError("保存失败", err);
    return false;
  }
}

/**
 * Folds a freshly saved note back into the visible list, keeping the sort
 * order the user chose.
 */
function mergeNoteMeta(meta: NoteMeta, previousPath: string): void {
  if (state.searchHits !== null) return; // search results are the backend's
  const index = state.notes.findIndex(
    (n) => n.path === previousPath || n.path === meta.path || n.id === meta.id,
  );
  if (index < 0) return;

  // Title order comes from SQLite's collation, which is not worth reproducing
  // here. Editing a heading while sorted by title is rare enough to just ask
  // the backend rather than risk the row settling in the wrong place.
  if (state.sortBy === "title" && state.notes[index].title !== meta.title) {
    void refreshList();
    return;
  }

  const notes = state.notes.slice();
  notes[index] = meta;
  // A title-ordered list only moves when the title does, which the branch
  // above already sent to the backend; re-sorting it by time here would
  // reshuffle the whole list on every autosave.
  if (state.sortBy !== "title") {
    const key = state.sortBy === "created" ? "created" : "updated";
    notes.sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]));
  }
  setState({ notes });
}

/**
 * The sidebar totals lag behind by design: they are library-wide numbers, and
 * recomputing them per autosave is work nobody is watching. Typing keeps
 * re-arming this, so it runs once after things settle.
 */
const refreshSidebarSoon = debounce(() => {
  void refreshSidebar();
}, 1500);

export async function saveActive(options: { silent?: boolean } = {}): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  return saveTab(tab.id, options);
}

/**
 * Flushes every dirty buffer and reports whether all of them landed.
 *
 * The close handshake depends on the answer: quitting while a write failed
 * would throw the edit away with no way to get it back.
 */
export async function saveAll(): Promise<boolean> {
  if (state.activeTabId) captureEditorInto(state.activeTabId);
  let ok = true;
  for (const tab of [...state.tabs]) {
    if (!isDirty(tab)) continue;
    if (!(await saveTab(tab.id, { silent: true }))) ok = false;
  }
  return ok;
}

/* ---------------------------------------------------------------- note ops */

export async function newNote(folder?: string): Promise<void> {
  if (!state.ready) return;
  const target = folder ?? (state.scope === "folder" ? state.scopeValue : "");
  try {
    const note = await api.createNote(target, "");
    if (state.activeTabId) captureEditorInto(state.activeTabId);
    const tab = tabFromNote(note);
    setState({ tabs: [...state.tabs, tab], activeTabId: tab.id, saveState: "idle" });
    await Promise.all([refreshList(), refreshSidebar()]);
    editor?.focus();
  } catch (err) {
    reportError("新建笔记", err);
  }
}

export async function renameNote(path: string, title: string): Promise<void> {
  try {
    const meta = await api.renameNote(path, title);
    const tab = tabByPath(path);
    if (tab) {
      // The heading changed on disk, so the buffer has to follow or the next
      // save would put the old title straight back.
      const note = await api.getNote(meta.path, meta.id);
      patchTab(tab.id, {
        path: meta.path,
        title: meta.title,
        content: note.content,
        savedContent: note.content,
        revision: note.revision,
        conflict: null,
      });
      if (tab.id === state.activeTabId) editor?.syncDoc(note.content);
    }
    await Promise.all([refreshList(), refreshSidebar()]);
    notify.success("已重命名");
  } catch (err) {
    reportError("重命名", err);
  }
}

export async function toggleFavorite(path: string): Promise<void> {
  const meta = state.notes.find((n) => n.path === path);
  const tab = tabByPath(path);
  const current = meta?.favorite ?? tab?.favorite ?? false;
  try {
    const updated = await api.setFavorite(path, !current);
    if (tab) {
      patchTab(tab.id, {
        favorite: updated.favorite,
        revision: updated.revision,
      });
    }
    await refreshList();
    void refreshSidebar();
    notify.success(updated.favorite ? "已加入收藏" : "已取消收藏");
  } catch (err) {
    reportError("更新收藏", err);
  }
}

export async function setTags(path: string, tags: string[]): Promise<void> {
  try {
    const updated = await api.setNoteTags(path, tags);
    const tab = tabByPath(path);
    if (tab) {
      patchTab(tab.id, {
        tags: updated.tags ?? [],
        revision: updated.revision,
      });
    }
    await Promise.all([refreshList(), refreshSidebar()]);
  } catch (err) {
    reportError("更新标签", err);
  }
}

export async function moveNote(path: string, folder: string): Promise<void> {
  try {
    const meta = await api.moveNote(path, folder);
    const tab = tabByPath(path);
    if (tab) {
      patchTab(tab.id, {
        path: meta.path,
        folder: meta.folder,
        revision: meta.revision,
      });
    }
    await Promise.all([refreshList(), refreshSidebar()]);
    notify.success(folder ? `已移动到「${folder}」` : "已移动到根目录");
  } catch (err) {
    reportError("移动笔记", err);
  }
}

export async function duplicateNote(path: string): Promise<void> {
  try {
    const meta = await api.duplicateNote(path);
    await Promise.all([refreshList(), refreshSidebar()]);
    await openNote(meta);
    notify.success("已创建副本");
  } catch (err) {
    reportError("复制笔记", err);
  }
}

export async function deleteNote(path: string): Promise<void> {
  const tab = tabByPath(path);
  try {
    // The backend hands back the trash entry it created, so "undo" restores
    // exactly that note instead of guessing from a path.
    const entry = await api.deleteNote(path);
    if (tab) await closeTab(tab.id, { skipPrompt: true });
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    notify.success("已移入回收站", {
      action: {
        label: "撤销",
        run: () => {
          void undoDelete(entry.id);
        },
      },
    });
  } catch (err) {
    reportError("删除笔记", err);
  }
}

async function undoDelete(entryID: string): Promise<void> {
  if (!entryID) return;
  try {
    const restored = await api.restoreNote(entryID);
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    if (restored.kind === "note") await openNote(restored.note);
    notify.success("已还原");
  } catch (err) {
    reportError("撤销删除", err);
  }
}

export async function restoreFromTrash(id: string): Promise<void> {
  try {
    const restored = await api.restoreNote(id);
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    if (restored.kind === "folder") {
      notify.success(`已还原文件夹「${restored.folder}」`);
      selectScope("folder", restored.folder);
      return;
    }
    notify.success(`已还原「${restored.note.title}」`);
  } catch (err) {
    reportError("还原", err);
  }
}

export async function purgeTrashItem(id: string): Promise<void> {
  try {
    await api.purgeTrashItem(id);
    await Promise.all([refreshTrash(), refreshSidebar()]);
  } catch (err) {
    reportError("彻底删除", err);
  }
}

export async function emptyTrash(): Promise<void> {
  try {
    await api.emptyTrash();
    await Promise.all([refreshTrash(), refreshSidebar()]);
    notify.success("回收站已清空");
  } catch (err) {
    reportError("清空回收站", err);
  }
}

/* ---------------------------------------------------------------- folders */

export async function createFolder(name: string): Promise<void> {
  try {
    const folder = await api.createFolder(name);
    await refreshSidebar();
    selectScope("folder", folder.path);
    notify.success(`已创建「${folder.name}」`);
  } catch (err) {
    reportError("新建文件夹", err);
  }
}

export async function renameFolder(path: string, name: string): Promise<void> {
  try {
    await api.renameFolder(path, name);
    if (state.scope === "folder" && state.scopeValue === path) {
      setState({ scopeValue: name });
    }
    await Promise.all([refreshList(), refreshSidebar()]);
    // Open tabs still point at the old directory, so reload their metadata.
    await reconcileTabs();
    notify.success("已重命名");
  } catch (err) {
    reportError("重命名文件夹", err);
  }
}

export async function deleteFolder(path: string): Promise<void> {
  try {
    const entry = await api.deleteFolder(path);
    if (state.scope === "folder" && state.scopeValue === path) {
      selectScope("all");
    }
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    await reconcileTabs();
    notify.success("文件夹已移入回收站", {
      action: {
        label: "撤销",
        run: () => {
          void undoDelete(entry.id);
        },
      },
    });
  } catch (err) {
    reportError("删除文件夹", err);
  }
}

/* ---------------------------------------------------------------- tags */

export async function renameTag(oldName: string, newName: string): Promise<void> {
  try {
    const count = await api.renameTag(oldName, newName);
    if (state.scope === "tag" && state.scopeValue === oldName) {
      setState({ scopeValue: newName });
    }
    await Promise.all([refreshList(), refreshSidebar()]);
    notify.success(`已更新 ${count} 篇笔记的标签`);
  } catch (err) {
    reportError("重命名标签", err);
  }
}

export async function deleteTag(name: string): Promise<void> {
  try {
    const count = await api.deleteTag(name);
    if (state.scope === "tag" && state.scopeValue === name) selectScope("all");
    await Promise.all([refreshList(), refreshSidebar()]);
    notify.success(`已从 ${count} 篇笔记中移除标签`);
  } catch (err) {
    reportError("删除标签", err);
  }
}

/* ---------------------------------------------------------------- search */

export const runSearch = debounce(async (raw: string) => {
  const value = raw.trim();
  if (!value) {
    setState({ searchHits: null, searching: false });
    return;
  }
  try {
    const hits = await api.search(value, 80);
    // A newer keystroke may have landed while this request was in flight.
    if (state.searchQuery.trim() !== value) return;
    setState({ searchHits: hits, searching: false });
  } catch (err) {
    setState({ searching: false });
    reportError("搜索", err);
  }
}, 140);

export function setSearchQuery(value: string): void {
  setState({ searchQuery: value, searching: value.trim().length > 0 });
  runSearch(value);
}

export function clearSearch(): void {
  runSearch.cancel();
  setState({ searchQuery: "", searchHits: null, searching: false });
}

/* ---------------------------------------------------------------- settings */

/** Applies a freshly opened library: close every tab and reload all lists. */
export async function adoptVault(payload: {
  settings: Settings;
  vaultPath: string;
  stats: AppStats;
}): Promise<void> {
  setState({
    settings: payload.settings,
    vaultPath: payload.vaultPath,
    stats: payload.stats,
    tabs: [],
    activeTabId: null,
    scope: "all",
    scopeValue: "",
    searchQuery: "",
    searchHits: null,
  });
  await refreshAll();
  const first = state.notes[0];
  if (first) await openNote(first, { focus: false });
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...state.settings, ...patch };
  setState({ settings: next });
  try {
    const applied = await api.saveSettings(next);
    setState({ settings: applied });
  } catch (err) {
    reportError("保存设置", err);
  }
}

/* ---------------------------------------------------------------- syncing */

/**
 * Reloads open tabs after the vault changed underneath us. Buffers with
 * unsaved edits are left alone: silently overwriting what someone is typing
 * is far worse than showing slightly stale metadata.
 */
export async function reconcileTabs(): Promise<void> {
  if (state.tabs.length === 0) return;
  if (state.activeTabId) captureEditorInto(state.activeTabId);

  // Fetched together: an external change with several tabs open used to wait
  // for one full round trip per tab, one after another.
  const loaded = await Promise.all(
    state.tabs.map((tab) =>
      api.getNote(tab.path, tab.id).then(
        (note) => ({ id: tab.id, note }),
        () => ({ id: tab.id, note: null }),
      ),
    ),
  );

  for (const { id, note } of loaded) {
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) continue;
    if (!note) {
      // A dirty buffer is still the only surviving copy and must stay open.
      if (!isDirty(tab)) await closeTab(id, { skipPrompt: true });
      continue;
    }
    // The user may have started typing while the read was in flight.
    if (isDirty(tab)) {
      if (note.revision !== tab.revision) {
        markConflict(id, note);
      } else if (note.path !== tab.path) {
        patchTab(id, {
          path: note.path,
          folder: note.folder,
          title: note.title,
        });
      }
      continue;
    }
    if (note.revision === tab.revision && note.path === tab.path) continue;
    applyDiskVersion(id, note);
  }
}

/** Title shown in a tab, derived live so it updates as you type the heading. */
export function tabTitle(tab: Tab): string {
  return titleOf(tab.content) || tab.title || "未命名笔记";
}
