/**
 * Typed facade over the generated Wails bindings.
 *
 * The generator types Go's time.Time as `any` and wraps structs in classes, so
 * everything is re-declared here against the interfaces in types.ts. It is
 * also the single place where backend errors become plain Error objects.
 */

import * as Go from "../wailsjs/go/main/App";
import { EventsOn, LogError } from "../wailsjs/runtime/runtime";
import type {
  BootstrapPayload,
  Diagnostics,
  ExportRequest,
  Folder,
  IndexState,
  NotePage,
  NotePageRequest,
  Note,
  NoteMeta,
  Restored,
  SearchHit,
  Settings,
  SidebarData,
  Stats,
  Tag,
  TrashItem,
  UpdateInfo,
} from "./types";

/**
 * Wails rejects with a string, not an Error, which loses the stack and breaks
 * `instanceof` checks at call sites.
 */
async function call<T>(fn: () => Promise<T>, context: string): Promise<T> {
  try {
    return await fn();
  } catch (raw) {
    const message =
      typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
    LogError(`${context}: ${message}`);
    throw new Error(message || context);
  }
}

/* ---------------------------------------------------------------- vault */

export const bootstrap = () => call(() => Go.Bootstrap(), "启动") as Promise<BootstrapPayload>;

export const openVault = (path: string) =>
  call(() => Go.OpenVault(path), "打开笔记库") as Promise<BootstrapPayload>;

export const selectVaultDir = () => call(() => Go.SelectVaultDir(), "选择文件夹");

export const stats = () => call(() => Go.Stats(), "统计") as Promise<Stats>;

export const diagnostics = () =>
  call(() => Go.Diagnostics(), "性能诊断") as Promise<Diagnostics>;

/** Folders, tags and totals in one call, so a refresh walks the vault once. */
export const sidebar = () => call(() => Go.Sidebar(), "读取侧边栏") as Promise<SidebarData>;

export const rebuildIndex = () => call(() => Go.RebuildIndex(), "重建索引") as Promise<Stats>;

/* ---------------------------------------------------------------- notes */

export const listNotesPage = (query: NotePageRequest) =>
  call(() => Go.ListNotesPage(query as never), "读取笔记列表") as Promise<NotePage>;

/** Compatibility shim for focused tests and older optional callers. */
export const listNotes = async (query: NotePageRequest) => (await listNotesPage(query)).items;

export const indexState = () => call(() => Go.IndexState(), "读取索引状态") as Promise<IndexState>;

export const listFolders = () => call(() => Go.ListFolders(), "读取文件夹") as Promise<Folder[]>;

export const listTags = () => call(() => Go.ListTags(), "读取标签") as Promise<Tag[]>;

export const getNote = (path: string, id = "") =>
  call(() => Go.GetNote(path, id), "打开笔记") as Promise<Note>;

export const createNote = (folder: string, title = "") =>
  call(() => Go.CreateNote(folder, title), "新建笔记") as Promise<Note>;

export const saveNote = (
  path: string,
  content: string,
  expectedRevision: string,
  force = false,
) =>
  call(
    () => Go.SaveNote(path, content, expectedRevision, force),
    "保存笔记",
  ) as Promise<NoteMeta>;

export const saveAsset = (notePath: string, filename: string, data: number[]) =>
  call(() => Go.SaveAsset(notePath, filename, data), "保存图片");

/** Streams the browser File directly to the AssetServer without expanding it into number[]. */
export const uploadAsset = (notePath: string, file: File) =>
  call(async () => {
    const params = new URLSearchParams({
      note: notePath,
      filename: file.name || "image",
    });
    const response = await fetch(`/__qiaoji_asset?${params}`, {
      method: "POST",
      headers: file.type ? { "Content-Type": file.type } : undefined,
      body: file,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      path?: string;
      error?: string;
    };
    if (!response.ok || !payload.path) {
      throw new Error(payload.error || `图片上传失败（${response.status}）`);
    }
    return payload.path;
  }, "保存图片");

export const renameNote = (path: string, title: string) =>
  call(() => Go.RenameNote(path, title), "重命名笔记") as Promise<NoteMeta>;

export const moveNote = (path: string, folder: string) =>
  call(() => Go.MoveNote(path, folder), "移动笔记") as Promise<NoteMeta>;

export const duplicateNote = (path: string) =>
  call(() => Go.DuplicateNote(path), "复制笔记") as Promise<NoteMeta>;

export const setFavorite = (path: string, favorite: boolean) =>
  call(() => Go.SetFavorite(path, favorite), "更新收藏") as Promise<NoteMeta>;

export const setNoteTags = (path: string, tags: string[]) =>
  call(() => Go.SetNoteTags(path, tags), "更新标签") as Promise<NoteMeta>;

export const deleteNote = (path: string) =>
  call(() => Go.DeleteNote(path), "删除笔记") as Promise<TrashItem>;

/* ---------------------------------------------------------------- trash */

export const listTrash = () => call(() => Go.ListTrash(), "读取回收站") as Promise<TrashItem[]>;

export const restoreNote = (id: string) =>
  call(() => Go.RestoreNote(id), "还原") as Promise<Restored>;

export const purgeTrashItem = (id: string) => call(() => Go.PurgeTrashItem(id), "彻底删除");

export const emptyTrash = () => call(() => Go.EmptyTrash(), "清空回收站");

/* ---------------------------------------------------------------- folders & tags */

export const createFolder = (name: string) =>
  call(() => Go.CreateFolder(name), "新建文件夹") as Promise<Folder>;

export const renameFolder = (path: string, name: string) =>
  call(() => Go.RenameFolder(path, name), "重命名文件夹") as Promise<string>;

export const deleteFolder = (path: string) =>
  call(() => Go.DeleteFolder(path), "删除文件夹") as Promise<TrashItem>;

export const renameTag = (oldName: string, newName: string) =>
  call(() => Go.RenameTag(oldName, newName), "重命名标签");

export const deleteTag = (name: string) => call(() => Go.DeleteTag(name), "删除标签");

export const sortedFolderNames = () =>
  call(() => Go.SortedFolderNames(), "读取文件夹") as Promise<string[]>;

/* ---------------------------------------------------------------- search */

export const search = (query: string, limit = 60) =>
  call(() => Go.Search(query, limit), "搜索") as Promise<SearchHit[]>;

export const suggest = (query: string, limit = 20) =>
  call(() => Go.Suggest(query, limit), "搜索") as Promise<NoteMeta[]>;

/* ---------------------------------------------------------------- settings */

export const getSettings = () => call(() => Go.GetSettings(), "读取设置") as Promise<Settings>;

export const saveSettings = (next: Settings) =>
  call(() => Go.SaveSettings(next as never), "保存设置") as Promise<Settings>;

export const applyTheme = (theme: string) => Go.ApplyTheme(theme);

export const checkForUpdates = () =>
  call(() => Go.CheckForUpdates(), "检查更新") as Promise<UpdateInfo>;

export const applyUpdate = () => call(() => Go.ApplyUpdate(), "安装更新");

/* ---------------------------------------------------------------- export */

export const selectExportDir = () => call(() => Go.SelectExportDir(), "选择保存位置");

export const runExport = (request: ExportRequest) =>
  call(() => Go.Export(request as never), "导出");

/* ---------------------------------------------------------------- shell */

export const revealInExplorer = (path: string) =>
  call(() => Go.RevealInExplorer(path), "在资源管理器中显示");

export const openPath = (path: string) => call(() => Go.OpenPath(path), "打开文件");

export const openExternal = (url: string) => call(() => Go.OpenExternal(url), "打开链接");

/* ---------------------------------------------------------------- window */

export const windowMinimise = () => Go.WindowMinimise();
export const windowToggleMaximise = () => Go.WindowToggleMaximise();
export const windowIsMaximised = () => Go.WindowIsMaximised();
export const windowClose = () => Go.WindowClose();

/* ------------------------------------------------------------ close handshake */

/** Releases the close the backend is holding open while buffers flush. */
export const confirmClose = () => Go.ConfirmClose();

/** Keeps the window open because something could not be written. */
export const cancelClose = () => Go.CancelClose();

/** Brings the window back, for when a problem needs attention from the tray. */
export const showWindow = () => Go.ShowWindow();

/* ---------------------------------------------------------------- events */

export type BackendEvent =
  | "vault:delta"
  | "vault:sync-state"
  | "window:focus"
  | "tray:new-note"
  | "app:before-close"
  | "update:progress";

export function onBackend(event: BackendEvent, handler: (data?: unknown) => void): () => void {
  return EventsOn(event, (payload: unknown) => handler(payload));
}
