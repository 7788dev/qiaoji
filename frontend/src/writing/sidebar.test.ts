// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { WritingSidebar } from "./sidebar";
import type { WritingController } from "./controller";

const sidebars: WritingSidebar[] = [];
afterEach(() => {
  sidebars.splice(0).forEach((sidebar) => sidebar.destroy());
  document.body.replaceChildren();
});

async function fixture() {
  const opened = { path: "C:/文档/文章.md", content: "正文" };
  const controller = {
    folder: "C:/文档",
    active: opened,
    settings: { sidebarMode: "files" },
    bridge: { listDirectory: vi.fn(async (path: string) => ({
      entries: path === "C:/文档" ? [
        { name: "资料", path: "C:/文档/资料", directory: true },
        { name: "文章.md", path: opened.path, directory: false },
      ] : [],
      nextCursor: "",
    })) },
    open: vi.fn(async () => opened as typeof opened | null),
    dialogs: { error: vi.fn() },
    subscribe: () => () => {},
  };
  const onDocumentOpened = vi.fn();
  const sidebar = new WritingSidebar(controller as unknown as WritingController, () => {}, onDocumentOpened);
  sidebars.push(sidebar);
  document.body.append(sidebar.root);
  await vi.waitFor(() => expect(sidebar.root.querySelectorAll(".tree-row")).toHaveLength(2));
  return { sidebar, controller, onDocumentOpened };
}

describe("sidebar document navigation", () => {
  it("returns to writing after selecting a file, including the already active document", async () => {
    const { sidebar, controller, onDocumentOpened } = await fixture();
    const rows = sidebar.root.querySelectorAll<HTMLButtonElement>(".tree-row");
    rows[0].click();
    await vi.waitFor(() => expect(controller.bridge.listDirectory).toHaveBeenCalledWith("C:/文档/资料", ""));
    expect(onDocumentOpened).not.toHaveBeenCalled();

    rows[1].click();
    await vi.waitFor(() => expect(onDocumentOpened).toHaveBeenCalledOnce());
    expect(controller.open).toHaveBeenCalledWith("C:/文档/文章.md");
  });

  it("keeps navigation available when opening is canceled or fails", async () => {
    const { sidebar, controller, onDocumentOpened } = await fixture();
    controller.open.mockResolvedValueOnce(null);
    sidebar.root.querySelector<HTMLButtonElement>('[aria-label="打开文件"]')!.click();
    await vi.waitFor(() => expect(controller.open).toHaveBeenCalledWith(""));
    expect(onDocumentOpened).not.toHaveBeenCalled();

    controller.open.mockRejectedValueOnce(new Error("文件不可读"));
    sidebar.root.querySelectorAll<HTMLButtonElement>(".tree-row")[1].click();
    await vi.waitFor(() => expect(controller.dialogs.error).toHaveBeenCalledWith("Error: 文件不可读"));
    expect(onDocumentOpened).not.toHaveBeenCalled();
  });
});
