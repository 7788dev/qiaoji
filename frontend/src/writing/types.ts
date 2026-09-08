import type { Settings, SearchHit, TrashItem, Restored, ExportRequest } from "../types";

export type EditorMode = "rich" | "source";
export interface FileDocument {
  id: string;
  path: string;
  name: string;
  content: string;
  revision: string;
  readOnly: boolean;
}
export interface DocumentState {
  path: string;
  mode: EditorMode;
  cursor: number;
  scrollTop: number;
}
export interface WritingSettings extends Settings {
  experienceVersion: number;
  workspacePath: string;
  openDocuments: DocumentState[];
  activeDocument: string;
  sidebarHidden: boolean;
  sidebarMode: "files" | "outline";
}
export interface OpenDocument extends FileDocument {
  savedContent: string;
  mode: EditorMode;
  cursor: number;
  scrollTop: number;
  saving: boolean;
  conflict: FileDocument | null;
  missing: boolean;
  error: string;
}
export interface DirectoryEntry { name: string; path: string; directory: boolean }
export interface DirectoryPage { entries: DirectoryEntry[]; nextCursor: string }
export interface DiskChange { id: string; document?: FileDocument | null; missing: boolean; error: string }
export interface WritingBootstrap {
  settings: WritingSettings;
  vaultReady: boolean;
  vaultPath: string;
  version: string;
  error: string;
}
export interface WritingBridge {
  bootstrap(): Promise<WritingBootstrap>;
  newDocument(): Promise<FileDocument>;
  openDocument(path: string): Promise<FileDocument>;
  saveDocument(id: string, content: string, revision: string, force: boolean): Promise<FileDocument>;
  saveDocumentAs(id: string, content: string): Promise<FileDocument>;
  closeDocument(id: string): Promise<void>;
  openFolder(path: string): Promise<WritingBootstrap>;
  listDirectory(path: string, cursor: string): Promise<DirectoryPage>;
  checkDocuments(): Promise<DiskChange[]>;
  readDisk(id: string): Promise<FileDocument>;
  reloadDocument(id: string, revision: string): Promise<FileDocument>;
  rememberDocuments(documents: DocumentState[], active: string): Promise<void>;
  saveSettings(settings: WritingSettings): Promise<WritingSettings>;
  uploadImage(id: string, file: File): Promise<string>;
  assetURL(id: string, href: string, content?: string): string | Promise<string>;
  renameDocument(id: string, name: string): Promise<FileDocument>;
  trashDocument(id: string): Promise<TrashItem>;
  listTrash(id: string): Promise<(TrashItem & { root: string })[]>;
  restoreTrash(id: string, entry: string): Promise<Restored>;
  search(query: string): Promise<SearchHit[]>;
  exportDocument(request: ExportRequest): Promise<string>;
  selectExportDir(): Promise<string>;
  createFolder(name: string): Promise<unknown>;
  confirmClose(): Promise<void>;
  cancelClose(): Promise<void>;
}

export type ChangeKind = "documents" | "content" | "active" | "settings" | "folder" | "status";
export const isDirty = (doc: OpenDocument) => doc.content !== doc.savedContent;

export function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() || path;
}
export function parentPath(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}
export function pathKey(path: string): string {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}
