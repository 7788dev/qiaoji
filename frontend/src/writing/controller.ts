import { debounce } from "../lib/dom";
import {
  isDirty, pathKey, type ChangeKind, type DocumentState, type FileDocument,
  type OpenDocument, type WritingBridge, type WritingSettings,
} from "./types";

export type CloseChoice = "save" | "discard" | "cancel";
export interface ControllerDialogs {
  closeDocument(document: OpenDocument): Promise<CloseChoice>;
  error(message: string): void;
}

/** Owns buffers and save/close decisions. Rendering never writes a document. */
export class WritingController {
  documents: OpenDocument[] = [];
  activeId: string | null = null;
  folder = "";
  version = "";
  settings!: WritingSettings;
  private listeners = new Set<(kind: ChangeKind, id?: string) => void>();
  private flushers = new Map<string, () => void>();
  private queues = new Map<string, Promise<boolean>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing: Promise<boolean> | null = null;
  private checks: Promise<void> | null = null;
  private settingsQueue: Promise<void> = Promise.resolve();
  private opening = new Map<string, Promise<OpenDocument | null>>();
  private closeJobs = new Map<string, Promise<boolean>>();
  private restoring = true;
  private remember = debounce(() => void this.persistSession(), 300);

  constructor(readonly bridge: WritingBridge, readonly dialogs: ControllerDialogs) {}
  get active(): OpenDocument | null { return this.documents.find((doc) => doc.id === this.activeId) ?? null; }
  subscribe(fn: (kind: ChangeKind, id?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(kind: ChangeKind, id?: string): void {
    for (const listener of this.listeners) listener(kind, id);
  }
  registerFlusher(id: string, flush: () => void): () => void {
    this.flushers.set(id, flush);
    return () => this.flushers.delete(id);
  }
  flush(id = this.activeId): void { if (id) this.flushers.get(id)?.(); }

  async start(): Promise<void> {
    const boot = await this.bridge.bootstrap();
    this.settings = boot.settings;
    this.folder = boot.vaultReady ? boot.vaultPath : "";
    this.version = boot.version;
    const restored = this.settings.openDocuments ?? [];
    let missing = 0;
    for (const entry of restored) {
      try {
        const doc = await this.open(entry.path);
        if (doc) Object.assign(doc, { mode: entry.mode, cursor: entry.cursor, scrollTop: entry.scrollTop });
      } catch { missing++; }
    }
    const active = this.documents.find((doc) => pathKey(doc.path) === pathKey(this.settings.activeDocument || ""));
    if (active) this.activeId = active.id;
    if (this.documents.length === 0) await this.newDocument();
    this.restoring = false;
    this.emit("settings");
    this.emit("documents");
    this.emit("active");
    if (boot.error) this.dialogs.error(boot.error);
    if (missing) this.dialogs.error(`有 ${missing} 个文件无法恢复，可以通过“打开文件”重新选择。`);
  }

  private add(raw: FileDocument): OpenDocument {
    const doc: OpenDocument = {
      ...raw, savedContent: raw.content, mode: "rich", cursor: 0, scrollTop: 0,
      saving: false, conflict: null, missing: false, error: "",
    };
    this.documents.push(doc);
    this.activeId = doc.id;
    this.emit("documents");
    this.emit("active", doc.id);
    this.remember();
    return doc;
  }
  async newDocument(): Promise<OpenDocument> {
    this.flush();
    return this.add(await this.bridge.newDocument());
  }
  async open(path = ""): Promise<OpenDocument | null> {
    const key = pathKey(path);
    const existing = path && this.documents.find((doc) => pathKey(doc.path) === key);
    if (existing) { this.activate(existing.id); return existing; }
    const pending = this.opening.get(key);
    if (pending) return pending;
    const job = (async () => {
      const raw = await this.bridge.openDocument(path);
      if (!raw.id) return null;
      const existing = this.documents.find((doc) => doc.id === raw.id);
      if (existing) { this.activate(existing.id); return existing; }
      this.flush();
      return this.add(raw);
    })();
    this.opening.set(key, job);
    try { return await job; }
    finally { this.opening.delete(key); }
  }
  activate(id: string): void {
    if (!this.documents.some((doc) => doc.id === id) || id === this.activeId) return;
    this.flush();
    this.activeId = id;
    this.emit("active", id);
    this.remember();
  }
  changed(id: string, content: string): void {
    const doc = this.documents.find((entry) => entry.id === id);
    if (!doc || doc.content === content) return;
    doc.content = content;
    doc.error = "";
    this.emit("content", id);
    clearTimeout(this.timers.get(id));
    if (this.settings.autoSave && doc.path && !doc.conflict && !doc.missing && !doc.readOnly) {
      this.timers.set(id, setTimeout(() => void this.save(id), this.settings.autoSaveDelayMs));
    }
  }
  setMode(id: string, mode: OpenDocument["mode"]): void {
    this.flush(id);
    const doc = this.documents.find((entry) => entry.id === id);
    if (!doc) return;
    doc.mode = mode;
    this.emit("active", id);
    this.remember();
  }
  position(id: string, cursor: number, scrollTop: number): void {
    const doc = this.documents.find((entry) => entry.id === id);
    if (!doc) return;
    doc.cursor = cursor;
    doc.scrollTop = scrollTop;
    this.remember();
  }

  save(id = this.activeId, saveAs = false, force = false, reviewedRevision?: string): Promise<boolean> {
    if (!id) return Promise.resolve(true);
    clearTimeout(this.timers.get(id));
    this.flush(id);
    const overwriteRevision = reviewedRevision ?? (force ? this.documents.find((doc) => doc.id === id)?.conflict?.revision : undefined);
    const previous = this.queues.get(id) ?? Promise.resolve(true);
    const job = previous.catch(() => false).then(async () => {
      const doc = this.documents.find((entry) => entry.id === id);
      if (!doc) return false;
      this.flush(id);
      const content = doc.content;
      const previousPath = doc.path;
      doc.saving = true;
      doc.error = "";
      this.emit("status", id);
      try {
        const saved = saveAs
          ? await this.bridge.saveDocumentAs(id, content)
          : await this.bridge.saveDocument(id, content, overwriteRevision ?? doc.revision, force);
        if (!saved.id) return false;
        const stillSame = doc.content === content;
        Object.assign(doc, {
          path: saved.path, name: saved.name, revision: saved.revision,
          readOnly: saved.readOnly, savedContent: saved.content,
          conflict: null, missing: false,
        });
        if (stillSame) doc.content = saved.content;
        this.emit("documents", id);
        this.emit("content", id);
        if (previousPath !== saved.path) this.emit("folder");
        await this.persistSession();
        return true;
      } catch (error) {
        doc.error = error instanceof Error ? error.message : String(error);
        if (doc.error.includes("磁盘上被修改")) {
          doc.conflict = await this.bridge.readDisk(id).catch(() => null);
          doc.missing = !doc.conflict;
        }
        this.dialogs.error(doc.error);
        return false;
      } finally {
        doc.saving = false;
        this.emit("status", id);
      }
    });
    this.queues.set(id, job);
    void job.finally(() => { if (this.queues.get(id) === job) this.queues.delete(id); });
    return job;
  }

  private async mayClose(documents: OpenDocument[]): Promise<boolean> {
    for (const doc of documents) {
      clearTimeout(this.timers.get(doc.id));
      this.flush(doc.id);
      const pending = this.queues.get(doc.id);
      if (pending && !(await pending)) return false;
      this.flush(doc.id);
      while (isDirty(doc)) {
        const choice = await this.dialogs.closeDocument(doc);
        if (choice === "cancel") return false;
        if (choice === "discard") break;
        if (!(await this.save(doc.id))) return false;
        // The user may continue typing while an asynchronous write is in flight.
        this.flush(doc.id);
      }
    }
    return true;
  }
  close(id: string): Promise<boolean> {
    const pending = this.closeJobs.get(id);
    if (pending) return pending;
    const job = (async () => {
      const doc = this.documents.find((entry) => entry.id === id);
      if (!doc) return true;
      if (!(await this.mayClose([doc]))) return false;
      await this.bridge.closeDocument(id);
      this.remove(id);
      return true;
    })().finally(() => this.closeJobs.delete(id));
    this.closeJobs.set(id, job);
    return job;
  }
  private remove(id: string): void {
    clearTimeout(this.timers.get(id));
    const index = this.documents.findIndex((doc) => doc.id === id);
    this.documents = this.documents.filter((doc) => doc.id !== id);
    if (this.activeId === id) this.activeId = this.documents[Math.min(index, this.documents.length - 1)]?.id ?? null;
    this.emit("documents", id);
    this.emit("active", this.activeId ?? undefined);
    this.remember();
  }
  requestQuit(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await Promise.all([...this.closeJobs.values()]);
      const allowed = await this.mayClose([...this.documents]);
      if (allowed) {
        await this.persistSession();
        await this.bridge.confirmClose();
      } else await this.bridge.cancelClose();
      return allowed;
    })().catch(async (error) => {
      this.dialogs.error(String(error));
      await this.bridge.cancelClose();
      return false;
    }).finally(() => { this.closing = null; });
    return this.closing;
  }
  async openFolder(path = ""): Promise<void> {
    const boot = await this.bridge.openFolder(path);
    if (!boot.vaultReady) return;
    this.folder = boot.vaultPath;
    this.settings.workspacePath = this.folder;
    this.settings.vaultPath = this.folder;
    this.emit("folder");
  }
  async patchSettings(patch: Partial<WritingSettings>): Promise<void> {
    Object.assign(this.settings, patch);
    if (patch.autoSave === false) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    }
    this.emit("settings");
    this.settingsQueue = this.settingsQueue.catch(() => {}).then(async () => {
      const saved = await this.bridge.saveSettings({ ...this.settings });
      Object.assign(this.settings, saved, { openDocuments: this.sessionEntries(), activeDocument: this.active?.path ?? "" });
    });
    try { await this.settingsQueue; } catch (error) { this.dialogs.error(String(error)); }
  }
  checkDisk(): Promise<void> {
    if (this.checks) return this.checks;
    this.checks = (async () => {
      this.flush();
      for (const change of await this.bridge.checkDocuments()) {
        const doc = this.documents.find((entry) => entry.id === change.id);
        if (!doc) continue;
        const pending = this.queues.get(doc.id);
        if (pending) {
          await pending;
          if (!this.documents.includes(doc)) continue;
          try {
            change.document = await this.bridge.readDisk(doc.id);
            change.missing = false;
          } catch {
            change.document = null;
            change.missing = true;
          }
        }
        if (change.missing) { doc.missing = true; this.emit("status", doc.id); continue; }
        if (change.error) { doc.error = change.error; this.emit("status", doc.id); continue; }
        if (!change.document) continue;
        doc.missing = false;
        doc.readOnly = change.document.readOnly;
        if (change.document.revision === doc.revision) {
          doc.conflict = null;
          this.emit("status", doc.id);
          continue;
        }
        if (isDirty(doc)) {
          doc.conflict = change.document;
          this.emit("status", doc.id);
        } else await this.reload(doc.id, change.document.revision);
      }
    })().catch((error) => this.dialogs.error(String(error))).finally(() => { this.checks = null; });
    return this.checks;
  }
  async reload(id: string, revision: string): Promise<void> {
    const doc = this.documents.find((entry) => entry.id === id);
    if (!doc) return;
    this.flush(id);
    const buffer = doc.content;
    const disk = await this.bridge.reloadDocument(id, revision);
    this.flush(id);
    if (doc.content !== buffer) {
      doc.conflict = disk;
      this.emit("status", id);
      return;
    }
    Object.assign(doc, disk, { savedContent: disk.content, conflict: null, missing: false, error: "" });
    this.emit("content", id);
    this.emit("status", id);
  }
  async rename(id: string, name: string): Promise<void> {
    const doc = this.documents.find((entry) => entry.id === id);
    if (!doc) return;
    const renamed = await this.bridge.renameDocument(id, name);
    doc.path = renamed.path;
    doc.name = renamed.name;
    this.emit("documents", id);
    this.emit("folder");
    this.remember();
  }
  async trash(id: string): Promise<boolean> {
    const doc = this.documents.find((entry) => entry.id === id);
    if (!doc || !(await this.mayClose([doc]))) return false;
    await this.bridge.trashDocument(id);
    this.remove(id);
    this.emit("folder");
    return true;
  }
  sessionEntries(): DocumentState[] {
    return this.documents.filter((doc) => doc.path).map(({ path, mode, cursor, scrollTop }) => ({ path, mode, cursor, scrollTop }));
  }
  async persistSession(): Promise<void> {
    if (this.restoring) return;
    this.remember.cancel();
    this.settings.openDocuments = this.sessionEntries();
    this.settings.activeDocument = this.active?.path ?? "";
    await this.bridge.rememberDocuments(this.settings.openDocuments, this.settings.activeDocument).catch((error) => {
      this.dialogs.error(`无法记住阅读位置：${String(error)}`);
    });
  }
  dispose(): void {
    this.remember.cancel();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.listeners.clear();
    this.flushers.clear();
  }
}
