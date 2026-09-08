import * as Go from "../../wailsjs/go/main/App";
import * as api from "../api";
import type { WritingBridge, WritingBootstrap, WritingSettings } from "./types";

async function call<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}

const imageSources = new Map<string, { content: string; ready: Promise<void> }>();

export const nativeBridge: WritingBridge = {
  bootstrap: () => call(() => Go.Bootstrap()) as Promise<WritingBootstrap>,
  newDocument: () => call(() => Go.NewDocument()),
  openDocument: (path) => call(() => Go.OpenDocument(path)),
  saveDocument: (id, content, revision, force) => call(() => Go.SaveDocument(id, content, revision, force)),
  saveDocumentAs: (id, content) => call(() => Go.SaveDocumentAs(id, content)),
  closeDocument: (id) => { imageSources.delete(id); return call(() => Go.CloseDocument(id)); },
  openFolder: (path) => call(() => Go.OpenFolder(path)) as Promise<WritingBootstrap>,
  listDirectory: (path, cursor) => call(() => Go.ListDirectory(path, cursor)),
  checkDocuments: () => call(() => Go.CheckDocuments()),
  readDisk: (id) => call(() => Go.ReadDocumentDisk(id)),
  reloadDocument: (id, revision) => call(() => Go.ReloadDocument(id, revision)),
  rememberDocuments: (documents, active) => call(() => Go.RememberDocuments(documents, active)),
  saveSettings: (settings) => api.saveSettings(settings) as Promise<WritingSettings>,
  uploadImage: async (id, file) => {
    const response = await fetch(`/__qiaoji_document_asset?${new URLSearchParams({ id })}`, {
      method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    const payload = await response.json() as { path?: string; error?: string };
    if (!response.ok || !payload.path) throw new Error(payload.error || "图片暂存失败");
    return payload.path;
  },
  assetURL: async (id, href, content = "") => {
    if (/^https?:\/\//i.test(href)) return href;
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^(?:qiaoji-asset|file):/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return "";
    if (!href.startsWith("qiaoji-asset:")) {
      let source = imageSources.get(id);
      if (!source || source.content !== content) {
        const previous = source?.ready ?? Promise.resolve();
        source = { content, ready: previous.catch(() => {}).then(() => call(() => Go.AuthorizeDocumentImages(id, content))) };
        imageSources.set(id, source);
      }
      await source.ready;
    }
    return `/__qiaoji_document_asset?${new URLSearchParams({ id, path: href })}`;
  },
  renameDocument: (id, name) => call(() => Go.RenameDocument(id, name)),
  trashDocument: (id) => call(() => Go.TrashDocument(id)) as ReturnType<WritingBridge["trashDocument"]>,
  listTrash: (id) => call(() => Go.ListDocumentTrash(id)) as ReturnType<WritingBridge["listTrash"]>,
  restoreTrash: (id, entry) => call(() => Go.RestoreDocumentTrash(id, entry)) as ReturnType<WritingBridge["restoreTrash"]>,
  search: (query) => api.search(query, 80),
  exportDocument: api.runExport,
  selectExportDir: api.selectExportDir,
  createFolder: api.createFolder,
  confirmClose: api.confirmClose,
  cancelClose: api.cancelClose,
};
