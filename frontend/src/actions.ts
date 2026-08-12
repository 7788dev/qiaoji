/**
 * Every user-visible operation lives here so the toolbar, context menus,
 * command palette and keyboard shortcuts all drive the same code path. A
 * command that behaves differently depending on how it was invoked is a bug
 * this layout makes hard to write.
 */

import * as api from "./api";
import { debounce } from "./lib/dom";
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

export function registerEditor(bridge: EditorBridge): void {
  editor = bridge;
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
    const [folders, tags, stats] = await Promise.all([
      api.listFolders(),
      api.listTags(),
      api.stats(),
    ]);
    setState({ folders, tags, stats });
  } catch (err) {
    reportError("读取侧边栏", err);
  }
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
  };
}

/** Persists the live editor buffer back into the tab before switching away. */
function captureEditorInto(tabId: string): void {
  if (!editor) return;
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  patchTab(tabId, {
    content: editor.doc,
    cursor: editor.cursor,
    scrollTop: editor.scrollTop,
  });
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

export async function closeTab(id: string, options: { skipPrompt?: boolean } = {}): Promise<void> {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;

  if (id === state.activeTabId) captureEditorInto(id);
  const current = state.tabs.find((t) => t.id === id);

  if (current && isDirty(current) && !options.skipPrompt) {
    // Auto-save means unsaved work is measured in milliseconds, so flushing is
    // friendlier than interrogating the user about it.
    await saveTab(current.id, { silent: true });
  }

  const index = state.tabs.findIndex((t) => t.id === id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeTabId = state.activeTabId;
  if (activeTabId === id) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = next ? next.id : null;
  }
  setState({ tabs, activeTabId });
}

export async function closeOtherTabs(keepId: string): Promise<void> {
  for (const tab of [...state.tabs]) {
    if (tab.id !== keepId) await closeTab(tab.id);
  }
}

export async function closeAllTabs(): Promise<void> {
  for (const tab of [...state.tabs]) await closeTab(tab.id);
}

export function cycleTab(direction: 1 | -1): void {
  if (state.tabs.length < 2) return;
  const index = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const next = (index + direction + state.tabs.length) % state.tabs.length;
  activateTab(state.tabs[next].id);
}

/* ---------------------------------------------------------------- saving */

let saveTimer: number | undefined;

/** Called on every keystroke; schedules the debounced write. */
export function markDirty(content: string): void {
  const tab = activeTab();
  if (!tab) return;
  patchTab(tab.id, { content });

  const dirty = content !== tab.savedContent;
  setState({ saveState: dirty ? "dirty" : "idle" });
  if (!dirty) {
    if (saveTimer) clearTimeout(saveTimer);
    return;
  }
  if (!state.settings.autoSave) return;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveTab(tab.id, { silent: true });
  }, state.settings.autoSaveDelayMs);
}

export async function saveTab(
  id: string,
  options: { silent?: boolean } = {},
): Promise<boolean> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (id === state.activeTabId) captureEditorInto(id);

  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (!isDirty(tab)) {
    if (!options.silent) notify.info("没有需要保存的修改");
    return true;
  }

  setState({ saveState: "saving" });
  const content = tab.content;
  try {
    const meta = await api.saveNote(tab.path, content);
    patchTab(id, {
      savedContent: content,
      path: meta.path,
      title: meta.title,
      folder: meta.folder,
      tags: meta.tags ?? [],
      favorite: meta.favorite,
    });
    if (id === state.activeTabId) {
      setState({ saveState: "saved" });
      window.setTimeout(() => {
        if (state.saveState === "saved") setState({ saveState: "idle" });
      }, 1600);
    }
    if (!options.silent) notify.success("已保存");
    void refreshList();
    void refreshSidebar();
    return true;
  } catch (err) {
    setState({ saveState: "error" });
    reportError("保存失败", err);
    return false;
  }
}

export async function saveActive(options: { silent?: boolean } = {}): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  return saveTab(tab.id, options);
}

/** Flushes every dirty buffer, used before closing the window. */
export async function saveAll(): Promise<void> {
  if (state.activeTabId) captureEditorInto(state.activeTabId);
  for (const tab of state.tabs) {
    if (isDirty(tab)) await saveTab(tab.id, { silent: true });
  }
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
    if (tab) patchTab(tab.id, { favorite: updated.favorite });
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
    if (tab) patchTab(tab.id, { tags: updated.tags ?? [] });
    await Promise.all([refreshList(), refreshSidebar()]);
  } catch (err) {
    reportError("更新标签", err);
  }
}

export async function moveNote(path: string, folder: string): Promise<void> {
  try {
    const meta = await api.moveNote(path, folder);
    const tab = tabByPath(path);
    if (tab) patchTab(tab.id, { path: meta.path, folder: meta.folder });
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
    await api.deleteNote(path);
    if (tab) await closeTab(tab.id, { skipPrompt: true });
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    notify.success("已移入回收站", {
      action: {
        label: "撤销",
        run: () => {
          void undoDelete(path);
        },
      },
    });
  } catch (err) {
    reportError("删除笔记", err);
  }
}

/** Restores the most recent trash entry that came from the given path. */
async function undoDelete(originalPath: string): Promise<void> {
  try {
    const items = await api.listTrash();
    const match =
      items.find((item) => originalPath.replace(/\\/g, "/").endsWith(item.originalRel)) ??
      items[0];
    if (!match) return;
    const meta = await api.restoreNote(match.id);
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    await openNote(meta);
    notify.success("已还原");
  } catch (err) {
    reportError("撤销删除", err);
  }
}

export async function restoreFromTrash(id: string): Promise<void> {
  try {
    const meta = await api.restoreNote(id);
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    notify.success(`已还原「${meta.title}」`);
  } catch (err) {
    reportError("还原笔记", err);
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
    await api.deleteFolder(path);
    if (state.scope === "folder" && state.scopeValue === path) {
      selectScope("all");
    }
    await Promise.all([refreshList(), refreshSidebar(), refreshTrash()]);
    await reconcileTabs();
    notify.success("文件夹已删除，笔记已移入回收站");
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

  for (const tab of [...state.tabs]) {
    if (isDirty(tab)) continue;
    try {
      const note = await api.getNote(tab.path, tab.id);
      if (note.content === tab.savedContent && note.path === tab.path) continue;
      patchTab(tab.id, {
        path: note.path,
        title: note.title,
        folder: note.folder,
        tags: note.tags ?? [],
        favorite: note.favorite,
        content: note.content,
        savedContent: note.content,
      });
      if (tab.id === state.activeTabId) editor?.syncDoc(note.content);
    } catch {
      // The note is gone; drop the tab rather than leave a dead one behind.
      await closeTab(tab.id, { skipPrompt: true });
    }
  }
}

/** Title shown in a tab, derived live so it updates as you type the heading. */
export function tabTitle(tab: Tab): string {
  return titleOf(tab.content) || tab.title || "未命名笔记";
}
