import { vi } from "vitest";
import { WritingController, type CloseChoice } from "./controller";
import { pathKey, type FileDocument, type WritingBridge, type WritingSettings } from "./types";

export function testSettings(): WritingSettings {
  return {
    experienceVersion: 2, workspacePath: "", openDocuments: [], activeDocument: "", sidebarHidden: false, sidebarMode: "files",
    vaultPath: "", theme: "light", language: "zh-CN", zoom: 100, autostart: false, minimiseToTray: true,
    closeToTray: false, autoUpdate: false, hardwareAcceleration: true, fontFamily: "system", fontSize: 16,
    lineHeight: 1.75, tabSize: 4, showLineNumbers: false, autoSave: false, autoSaveDelayMs: 800,
    autoPairing: true, editorWidth: "medium", listView: "list", sortBy: "title", showLivePreview: false,
    sidebarWidth: 240, listWidth: 292, exportDir: "", lastExportFormat: "pdf",
    window: { width: 1280, height: 800, x: -1, y: -1, maximised: false },
  };
}

export const cancelledDocument: FileDocument = { id: "", path: "", name: "", content: "", revision: "", readOnly: false };

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function testController(settings = testSettings()) {
  let serial = 0;
  const disk = new Map<string, FileDocument>();
  const sessions = new Map<string, FileDocument>();
  const seed = (path: string, content: string) => {
    const doc = { id: "file-" + ++serial, path, name: path.split(/[\\/]/).pop()!, content, revision: content, readOnly: false };
    disk.set(pathKey(path), doc);
    return doc;
  };
  const closeDocument = vi.fn(async (): Promise<CloseChoice> => "cancel");
  const error = vi.fn();
  const bridge = {
    bootstrap: vi.fn(async () => ({ settings, vaultReady: Boolean(settings.workspacePath), vaultPath: settings.workspacePath, version: "test", error: "" })),
    newDocument: vi.fn(async () => {
      const doc = { ...cancelledDocument, id: "draft-" + ++serial, name: "未命名" };
      sessions.set(doc.id, doc);
      return { ...doc };
    }),
    openDocument: vi.fn(async (path: string) => {
      const doc = disk.get(pathKey(path));
      if (!doc) throw new Error("文件不存在");
      sessions.set(doc.id, doc);
      return { ...doc };
    }),
    saveDocument: vi.fn(async (id: string, content: string, revision: string, _force: boolean) => {
      const session = sessions.get(id)!;
      if (!session.path) return { ...cancelledDocument };
      const current = disk.get(pathKey(session.path));
      if (current?.revision !== revision) throw new Error("文件已在磁盘上被修改");
      const saved = { ...session, content, revision: content };
      disk.set(pathKey(session.path), saved);
      sessions.set(id, saved);
      return { ...saved };
    }),
    saveDocumentAs: vi.fn(async () => ({ ...cancelledDocument })),
    closeDocument: vi.fn(async (id: string) => { sessions.delete(id); }),
    openFolder: vi.fn(async (path: string) => ({ settings, vaultReady: Boolean(path), vaultPath: path, version: "test", error: "" })),
    listDirectory: vi.fn(async () => ({ entries: [], nextCursor: "" })),
    checkDocuments: vi.fn<WritingBridge["checkDocuments"]>(async () => []),
    readDisk: vi.fn(async (id: string) => ({ ...disk.get(pathKey(sessions.get(id)!.path))! })),
    reloadDocument: vi.fn(async (id: string) => {
      const doc = disk.get(pathKey(sessions.get(id)!.path))!;
      sessions.set(id, doc);
      return { ...doc };
    }),
    rememberDocuments: vi.fn(async () => {}),
    saveSettings: vi.fn(async (next: WritingSettings) => ({ ...next })),
    uploadImage: vi.fn(async () => "qiaoji-asset:test"),
    assetURL: vi.fn((id: string, href: string) => "/__qiaoji_document_asset?id=" + id + "&path=" + encodeURIComponent(href)),
    renameDocument: vi.fn<WritingBridge["renameDocument"]>(),
    trashDocument: vi.fn<WritingBridge["trashDocument"]>(),
    listTrash: vi.fn(async () => []),
    restoreTrash: vi.fn<WritingBridge["restoreTrash"]>(),
    search: vi.fn(async () => []),
    exportDocument: vi.fn(async () => ""),
    selectExportDir: vi.fn(async () => ""),
    createFolder: vi.fn(async () => {}),
    confirmClose: vi.fn(async () => {}),
    cancelClose: vi.fn(async () => {}),
  } satisfies WritingBridge;
  const controller = new WritingController(bridge, { closeDocument, error });
  return { controller, bridge, closeDocument, error, disk, seed };
}
