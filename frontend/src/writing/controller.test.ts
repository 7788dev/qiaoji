import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testController, testSettings, deferred, cancelledDocument } from "./test-support";
import { isDirty, pathKey, type FileDocument } from "./types";
import type { CloseChoice, WritingController } from "./controller";

let controllers: WritingController[] = [];
beforeEach(() => { vi.useFakeTimers(); controllers = []; });
afterEach(() => { for (const controller of controllers) controller.dispose(); vi.useRealTimers(); });
async function fixture() {
  const test = testController();
  controllers.push(test.controller);
  await test.controller.start();
  return test;
}

describe("manual document lifecycle", () => {
  it("starts with an empty draft and creates no file", async () => {
    const { controller, disk, bridge } = await fixture();
    expect(controller.active?.content).toBe("");
    expect(controller.active?.path).toBe("");
    expect(disk.size).toBe(0);
    expect(bridge.saveDocument).not.toHaveBeenCalled();
  });

  it("keeps edits off disk through tab switches, source switches and idle time until Save", async () => {
    const { controller, bridge, seed, disk } = await fixture();
    const first = seed("C:/notes/中文.md", "---\nid: copy\n---\n原文");
    const doc = (await controller.open(first.path))!;
    controller.changed(doc.id, doc.content + "\n修改");
    const second = await controller.newDocument();
    controller.changed(second.id, "另一篇草稿");
    controller.activate(doc.id);
    controller.setMode(doc.id, "source");
    controller.setMode(doc.id, "rich");
    await vi.advanceTimersByTimeAsync(20000);
    expect(disk.get(pathKey(first.path))?.content).toBe(first.content);
    expect(bridge.saveDocument).not.toHaveBeenCalled();
    expect(await controller.save(doc.id)).toBe(true);
    expect(disk.get(pathKey(first.path))?.content).toBe(first.content + "\n修改");
    expect(isDirty(second)).toBe(true);
  });

  it("deduplicates paths, independently of front matter ids, and keeps tabs when folders change", async () => {
    const { controller, seed } = await fixture();
    const a = seed("C:/one/一.md", "---\nid: duplicate\n---\n一");
    const b = seed("C:/two/二.md", "---\nid: duplicate\n---\n二");
    const first = await controller.open(a.path);
    const duplicate = await controller.open("c:\\one\\一.md");
    const second = await controller.open(b.path);
    expect(first).toBe(duplicate);
    expect(first?.id).not.toBe(second?.id);
    const ids = controller.documents.map((doc) => doc.id);
    await controller.openFolder("C:/elsewhere");
    expect(controller.documents.map((doc) => doc.id)).toEqual(ids);
  });

  it.each(["cancel", "discard", "save"] as const)("handles the %s close choice without implicit writes", async (choice) => {
    const { controller, bridge, closeDocument, seed } = await fixture();
    const doc = (await controller.open(seed("C:/notes/a.md", "saved").path))!;
    controller.changed(doc.id, "changed");
    closeDocument.mockResolvedValue(choice);
    const closed = await controller.close(doc.id);
    expect(closed).toBe(choice !== "cancel");
    expect(bridge.saveDocument).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
    expect(controller.documents.includes(doc)).toBe(choice === "cancel");
  });

  it("aborts close when a draft's native Save dialog is cancelled", async () => {
    const { controller, bridge, closeDocument } = await fixture();
    const doc = controller.active!;
    controller.changed(doc.id, "不能丢失");
    closeDocument.mockResolvedValue("save");
    bridge.saveDocument.mockResolvedValue({ ...cancelledDocument });
    expect(await controller.close(doc.id)).toBe(false);
    expect(doc.content).toBe("不能丢失");
    expect(bridge.closeDocument).not.toHaveBeenCalled();
  });

  it("leaves all buffers open on write failure during quit", async () => {
    const { controller, bridge, closeDocument } = await fixture();
    controller.changed(controller.activeId!, "重要草稿");
    closeDocument.mockResolvedValue("save");
    bridge.saveDocument.mockRejectedValue(new Error("disk full"));
    expect(await controller.requestQuit()).toBe(false);
    expect(controller.documents).toHaveLength(1);
    expect(bridge.confirmClose).not.toHaveBeenCalled();
    expect(bridge.cancelClose).toHaveBeenCalledOnce();
  });

  it("waits past 8 seconds for the close choice and deduplicates repeated quit requests", async () => {
    const { controller, bridge, closeDocument } = await fixture();
    controller.changed(controller.activeId!, "尚未保存");
    const choice = deferred<CloseChoice>();
    closeDocument.mockReturnValue(choice.promise);
    const quit = controller.requestQuit();
    expect(controller.requestQuit()).toBe(quit);
    await vi.advanceTimersByTimeAsync(60000);
    expect(bridge.confirmClose).not.toHaveBeenCalled();
    expect(closeDocument).toHaveBeenCalledOnce();
    choice.resolve("cancel");
    expect(await quit).toBe(false);
    expect(controller.active?.content).toBe("尚未保存");
  });

  it("deduplicates repeated close clicks on one tab", async () => {
    const { controller, closeDocument } = await fixture();
    controller.changed(controller.activeId!, "内容");
    const choice = deferred<CloseChoice>();
    closeDocument.mockReturnValue(choice.promise);
    const close = controller.close(controller.activeId!);
    expect(controller.close(controller.activeId!)).toBe(close);
    choice.resolve("cancel");
    expect(await close).toBe(false);
    expect(closeDocument).toHaveBeenCalledOnce();
  });

  it("does not replace newer edits with a delayed save response", async () => {
    const { controller, bridge, seed } = await fixture();
    const doc = (await controller.open(seed("C:/notes/a.md", "original").path))!;
    controller.changed(doc.id, "first edit");
    const save = deferred<FileDocument>();
    bridge.saveDocument.mockReturnValueOnce(save.promise);
    const saved = controller.save(doc.id);
    await vi.advanceTimersByTimeAsync(1);
    controller.changed(doc.id, "second edit");
    save.resolve({ ...doc, content: "first edit", revision: "saved" });
    expect(await saved).toBe(true);
    expect(doc.content).toBe("second edit");
    expect(doc.savedContent).toBe("first edit");
    expect(isDirty(doc)).toBe(true);
  });

  it("asks again if typing continued while saving for a close", async () => {
    const { controller, bridge, seed, closeDocument } = await fixture();
    const doc = (await controller.open(seed("C:/notes/a.md", "original").path))!;
    controller.changed(doc.id, "first edit");
    const save = deferred<FileDocument>();
    bridge.saveDocument.mockReturnValueOnce(save.promise);
    closeDocument.mockResolvedValueOnce("save").mockResolvedValueOnce("cancel");
    const close = controller.close(doc.id);
    await vi.advanceTimersByTimeAsync(1);
    controller.changed(doc.id, "second edit");
    save.resolve({ ...doc, content: "first edit", revision: "saved" });
    expect(await close).toBe(false);
    expect(doc.content).toBe("second edit");
    expect(bridge.closeDocument).not.toHaveBeenCalled();
  });

  it("retains the editing buffer after an external change and saves only after an explicit overwrite", async () => {
    const { controller, bridge, seed, disk } = await fixture();
    const doc = (await controller.open(seed("C:/notes/a.md", "original").path))!;
    controller.changed(doc.id, "local");
    const external = { ...doc, content: "external", revision: "external" };
    disk.set(pathKey(doc.path), external);
    bridge.checkDocuments.mockResolvedValue([{ id: doc.id, document: external, missing: false, error: "" }]);
    await controller.checkDisk();
    expect(doc.conflict?.content).toBe("external");
    expect(doc.content).toBe("local");
    expect(await controller.save(doc.id)).toBe(false);
    expect(disk.get(pathKey(doc.path))?.content).toBe("external");
    expect(await controller.save(doc.id, false, true)).toBe(true);
    expect(disk.get(pathKey(doc.path))?.content).toBe("local");
  });

  it("does not discard an edit made while an external reload was waiting", async () => {
    const { controller, bridge, seed } = await fixture();
    const doc = (await controller.open(seed("C:/notes/a.md", "original").path))!;
    const pending = deferred<FileDocument>();
    bridge.reloadDocument.mockReturnValueOnce(pending.promise);
    const reload = controller.reload(doc.id, "external");
    controller.changed(doc.id, "typed during reload");
    pending.resolve({ ...doc, content: "external", revision: "external" });
    await reload;
    expect(doc.content).toBe("typed during reload");
    expect(doc.conflict?.content).toBe("external");
  });

  it("requires a fresh confirmation when disk changes after the reviewed conflict", async () => {
    const { controller, seed, disk } = await fixture();
    const doc = (await controller.open(seed("C:/notes/a.md", "original").path))!;
    controller.changed(doc.id, "local");
    doc.conflict = { ...doc, content: "reviewed", revision: "reviewed" };
    disk.set(pathKey(doc.path), { ...doc, content: "changed again", revision: "changed again" });
    expect(await controller.save(doc.id, false, true, "reviewed")).toBe(false);
    expect(doc.content).toBe("local");
    expect(doc.conflict?.content).toBe("changed again");
    expect(disk.get(pathKey(doc.path))?.content).toBe("changed again");
  });

  it("clears the missing-file state when an identical file is restored", async () => {
    const { controller, seed, bridge } = await fixture();
    const doc = (await controller.open(seed("C:/notes/a.md", "original").path))!;
    doc.missing = true;
    bridge.checkDocuments.mockResolvedValue([{ id: doc.id, missing: false, error: "", document: { ...doc } }]);
    await controller.checkDisk();
    expect(doc.missing).toBe(false);
    expect(doc.content).toBe("original");
    expect(bridge.saveDocument).not.toHaveBeenCalled();
  });

  it("restores only saved paths with their active document and reading position", async () => {
    const settings = testSettings();
    const test = testController(settings);
    controllers.push(test.controller);
    const a = test.seed("C:/笔记/甲.md", "甲");
    const b = test.seed("C:/笔记/乙.md", "乙");
    settings.openDocuments = [
      { path: a.path, mode: "source", cursor: 2, scrollTop: 140 },
      { path: b.path, mode: "rich", cursor: 8, scrollTop: 320 },
    ];
    settings.activeDocument = a.path;
    await test.controller.start();
    expect(test.controller.active?.path).toBe(a.path);
    expect(test.controller.active?.mode).toBe("source");
    expect(test.controller.active?.scrollTop).toBe(140);
    await test.controller.newDocument();
    await test.controller.persistSession();
    expect(test.bridge.rememberDocuments).toHaveBeenLastCalledWith(settings.openDocuments, "");
    expect(settings.openDocuments).toHaveLength(2);
  });
});
