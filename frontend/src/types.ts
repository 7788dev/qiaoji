/** Shapes mirrored from the Go API, with Go's time.Time narrowed to a string. */

export interface NoteMeta {
  id: string;
  title: string;
  folder: string;
  path: string;
  tags: string[];
  created: string;
  updated: string;
  favorite: boolean;
  excerpt: string;
  words: number;
  size: number;
  /** SHA-256 of the exact file loaded from disk, used for conflict checks. */
  revision: string;
}

export interface Note extends NoteMeta {
  content: string;
}

export interface Folder {
  name: string;
  path: string;
  count: number;
}

export interface Tag {
  name: string;
  count: number;
}

export type TrashKind = "note" | "folder";

export interface TrashItem {
  id: string;
  kind: TrashKind;
  title: string;
  folder: string;
  excerpt: string;
  deletedAt: string;
  originalRel: string;
  size: number;
  /** Folder entries: how many notes and other files went in with it. */
  notes: number;
  files: number;
}

/** What came back out of the trash: one note, or a whole folder. */
export interface Restored {
  kind: TrashKind;
  note: Note;
  folder: string;
  notes: number;
}

export interface SearchHit {
  id: string;
  path: string;
  title: string;
  titleHtml: string;
  folder: string;
  snippet: string;
  updated: string;
  favorite: boolean;
}

export type Scope = "all" | "recent" | "favorites" | "folder" | "tag" | "untagged" | "trash";
export type SortBy = "updated" | "created" | "title";
export type ListView = "list" | "grid";
export type ThemeName = "light" | "dark" | "system";
export type EditorWidth = "narrow" | "medium" | "wide" | "full";
export type ExportFormat = "md" | "html" | "pdf" | "docx" | "txt";

export interface ListQuery {
  scope: string;
  value: string;
  sortBy: string;
  limit: number;
}

export interface Settings {
  vaultPath: string;

  theme: ThemeName;
  language: string;
  zoom: number;
  autostart: boolean;
  minimiseToTray: boolean;
  closeToTray: boolean;
  autoUpdate: boolean;
  hardwareAcceleration: boolean;

  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  showLineNumbers: boolean;
  autoSave: boolean;
  autoSaveDelayMs: number;
  autoPairing: boolean;

  editorWidth: EditorWidth;
  listView: ListView;
  sortBy: SortBy;
  showLivePreview: boolean;

  exportDir: string;
  lastExportFormat: string;

  window: { width: number; height: number; x: number; y: number; maximised: boolean };
}

export interface Stats {
  notes: number;
  words: number;
  folders: number;
  tags: number;
  trash: number;
  bytes: number;
}

/** Folders, tags and totals in one round trip, refreshed as a unit. */
export interface SidebarData {
  folders: Folder[];
  tags: Tag[];
  stats: Stats;
}

export interface BootstrapPayload {
  settings: Settings;
  vaultReady: boolean;
  vaultPath: string;
  version: string;
  error: string;
  stats: Stats;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  releaseUrl: string;
}

export interface ExportRequest {
  format: ExportFormat;
  title: string;
  fileName: string;
  dir: string;
  markdown: string;
  bodyHtml: string;
  hasMath: boolean;
}

/** One open editor tab. */
export interface Tab {
  id: string;
  path: string;
  title: string;
  content: string;
  savedContent: string;
  favorite: boolean;
  tags: string[];
  folder: string;
  /** Preserved so switching tabs returns you to where you were reading. */
  scrollTop: number;
  cursor: number;
  mode: "edit" | "preview";
  revision: string;
  /** Disk version that arrived while this tab had unsaved edits. */
  conflict: Note | null;
}
