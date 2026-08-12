/**
 * Application state with topic-based subscriptions.
 *
 * Panels subscribe to the specific keys they render, so typing never triggers
 * a sidebar or note-list repaint. That is the difference between a smooth
 * editor and a janky one at this scale.
 *
 * The split that makes it work is `tabs` versus `docRevision`. `tabs` is
 * republished only when a tab is opened, closed, activated or has its metadata
 * changed; the live buffer is mutated in place and announced on `docRevision`,
 * which only the few pieces that track the text as it is typed subscribe to.
 */

import type {
  Folder,
  ListView,
  NoteMeta,
  SearchHit,
  Scope,
  Settings,
  SortBy,
  Stats,
  Tab,
  Tag,
  TrashItem,
} from "./types";

export interface AppState {
  ready: boolean;
  version: string;
  vaultPath: string;
  settings: Settings;
  stats: Stats;

  scope: Scope;
  scopeValue: string;
  sortBy: SortBy;
  listView: ListView;

  notes: NoteMeta[];
  folders: Folder[];
  tags: Tag[];
  trash: TrashItem[];
  loadingList: boolean;

  tabs: Tab[];
  activeTabId: string | null;

  /**
   * Bumped on every editor change. Only the parts that must follow the text as
   * it is typed — the dirty marker, the word count, the window title, the live
   * preview — listen here, so a keystroke costs a few text nodes rather than a
   * rebuild of the tab strip and the note list.
   */
  docRevision: number;

  /** Non-null while the search panel is filtering the note list. */
  searchQuery: string;
  searchHits: SearchHit[] | null;
  searching: boolean;

  sidebarVisible: boolean;
  listVisible: boolean;
  saveState: "idle" | "dirty" | "saving" | "saved" | "error";
}

export type StateKey = keyof AppState;

const defaultSettings: Settings = {
  vaultPath: "",
  theme: "light",
  language: "zh-CN",
  zoom: 100,
  autostart: false,
  minimiseToTray: true,
  closeToTray: false,
  autoUpdate: true,
  hardwareAcceleration: true,
  fontFamily: "system",
  fontSize: 15,
  lineHeight: 1.8,
  tabSize: 4,
  showLineNumbers: false,
  autoSave: true,
  autoSaveDelayMs: 800,
  autoPairing: true,
  editorWidth: "medium",
  listView: "list",
  sortBy: "updated",
  showLivePreview: true,
  exportDir: "",
  lastExportFormat: "md",
  window: { width: 1240, height: 820, x: -1, y: -1, maximised: false },
};

export const state: AppState = {
  ready: false,
  version: "1.0.0",
  vaultPath: "",
  settings: defaultSettings,
  stats: { notes: 0, words: 0, folders: 0, tags: 0, trash: 0, bytes: 0 },

  scope: "all",
  scopeValue: "",
  sortBy: "updated",
  listView: "list",

  notes: [],
  folders: [],
  tags: [],
  trash: [],
  loadingList: false,

  tabs: [],
  activeTabId: null,
  docRevision: 0,

  searchQuery: "",
  searchHits: null,
  searching: false,

  sidebarVisible: true,
  listVisible: true,
  saveState: "idle",
};

type Listener = () => void;
const listeners = new Map<StateKey, Set<Listener>>();

/** Subscribes to one or more state keys. Returns an unsubscribe function. */
export function subscribe(keys: StateKey[], fn: Listener): () => void {
  for (const key of keys) {
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(fn);
  }
  return () => {
    for (const key of keys) listeners.get(key)?.delete(fn);
  };
}

/**
 * Merges a patch into the state and notifies subscribers of the keys that
 * actually changed. Listeners are collected into a set first so a component
 * watching three changed keys still renders once.
 */
export function setState(patch: Partial<AppState>): void {
  const touched: StateKey[] = [];
  for (const key of Object.keys(patch) as StateKey[]) {
    const next = patch[key];
    if (next === undefined) continue;
    if (Object.is(state[key], next)) continue;
    (state as unknown as Record<string, unknown>)[key] = next;
    touched.push(key);
  }
  if (touched.length === 0) return;
  notify(touched);
}

/** Announces a change to keys that were mutated in place. */
export function notify(keys: StateKey[]): void {
  const pending = new Set<Listener>();
  for (const key of keys) {
    const set = listeners.get(key);
    if (set) for (const fn of set) pending.add(fn);
  }
  for (const fn of pending) fn();
}

/* ---------------------------------------------------------------- tabs */

export function activeTab(): Tab | null {
  if (!state.activeTabId) return null;
  return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
}

export function tabByPath(path: string): Tab | undefined {
  return state.tabs.find((t) => t.path === path);
}

export function isDirty(tab: Tab): boolean {
  return tab.content !== tab.savedContent;
}

export function hasUnsaved(): boolean {
  return state.tabs.some(isDirty);
}

/** Replaces one tab and republishes the list so subscribers rerender. */
export function patchTab(id: string, patch: Partial<Tab>): Tab | null {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return null;
  const next = { ...state.tabs[index], ...patch };
  const tabs = state.tabs.slice();
  tabs[index] = next;
  setState({ tabs });
  return next;
}

/* ---------------------------------------------------------------- labels */

export const SCOPE_LABELS: Record<Scope, string> = {
  all: "全部笔记",
  recent: "最近使用",
  favorites: "收藏",
  folder: "文件夹",
  tag: "标签",
  untagged: "未加标签",
  trash: "回收站",
};

export function currentScopeLabel(): string {
  if (state.scope === "folder") return state.scopeValue || "全部笔记";
  if (state.scope === "tag") return `#${state.scopeValue}`;
  return SCOPE_LABELS[state.scope];
}
