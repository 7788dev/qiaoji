import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as actions from "./actions";
import * as api from "./api";
import { state, subscribe } from "./store";
import type { NoteMeta, Tab } from "./types";

vi.mock("./api", () => ({
  saveNote: vi.fn(),
  sidebar: vi.fn(),
  stats: vi.fn(),
  listNotes: vi.fn(),
  listFolders: vi.fn(),
  listTags: vi.fn(),
  listTrash: vi.fn(),
  getNote: vi.fn(),
  createNote: vi.fn(),
  renameNote: vi.fn(),
  moveNote: vi.fn(),
  duplicateNote: vi.fn(),
  setFavorite: vi.fn(),
  setNoteTags: vi.fn(),
  deleteNote: vi.fn(),
  restoreNote: vi.fn(),
  purgeTrashItem: vi.fn(),
  emptyTrash: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
  search: vi.fn(),
  suggest: vi.fn(),
  saveSettings: vi.fn(),
  confirmClose: vi.fn(),
  cancelClose: vi.fn(),
  showWindow: vi.fn(),
  onBackend: vi.fn(),
}));

const saveNote = vi.mocked(api.saveNote);

function makeTab(id: string, content: string): Tab {
  return {
    id,
    path: `C:/vault/${id}.md`,
    title: id,
    content,
    savedContent: content,
    favorite: false,
    tags: [],
    folder: "",
    scrollTop: 0,
    cursor: 0,
    mode: "edit",
    revision: `revision-${id}`,
    conflict: null,
  };
}

function metaFor(tab: Tab): NoteMeta {
  return {
    id: tab.id,
    title: tab.title,
    folder: "",
    path: tab.path,
    tags: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    favorite: false,
    excerpt: "",
    words: 1,
    size: 1,
    revision: tab.revision,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  saveNote.mockReset();
  vi.mocked(api.getNote).mockReset();
  saveNote.mockImplementation(async (path: string) => {
    const tab = state.tabs.find((t) => t.path === path);
    return metaFor(tab ?? makeTab("unknown", ""));
  });

  state.ready = false; // keeps refreshes from reaching the mocked backend
  state.tabs = [];
  state.activeTabId = null;
  state.notes = [];
  state.searchHits = null;
  state.docRevision = 0;
  state.saveState = "idle";
  state.settings = { ...state.settings, autoSave: true, autoSaveDelayMs: 800 };
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("autosave scheduling", () => {
  it("keeps a pending save for a tab the user switched away from", async () => {
    state.tabs = [makeTab("a", "A"), makeTab("b", "B")];
    state.activeTabId = "a";

    actions.markDirty("A edited");

    // Switch and type before the first tab's timer fires.
    state.activeTabId = "b";
    vi.advanceTimersByTime(200);
    actions.markDirty("B edited");

    await vi.advanceTimersByTimeAsync(1000);

    const saved = saveNote.mock.calls.map(([path]) => path);
    expect(saved).toContain("C:/vault/a.md");
    expect(saved).toContain("C:/vault/b.md");
  });

  it("cancels the pending save when the edit is undone back to the saved text", async () => {
    state.tabs = [makeTab("a", "A")];
    state.activeTabId = "a";

    actions.markDirty("A edited");
    actions.markDirty("A");

    await vi.advanceTimersByTimeAsync(2000);
    expect(saveNote).not.toHaveBeenCalled();
  });

  it("does not schedule anything when autosave is off", async () => {
    state.settings = { ...state.settings, autoSave: false };
    state.tabs = [makeTab("a", "A")];
    state.activeTabId = "a";

    actions.markDirty("A edited");
    await vi.advanceTimersByTimeAsync(5000);
    expect(saveNote).not.toHaveBeenCalled();
  });
});

describe("saveAll", () => {
  it("writes every dirty buffer and reports success", async () => {
    state.tabs = [makeTab("a", "A"), makeTab("b", "B"), makeTab("c", "C")];
    state.activeTabId = "a";
    state.tabs[0].content = "A edited";
    state.tabs[2].content = "C edited";

    const ok = await actions.saveAll();

    expect(ok).toBe(true);
    expect(saveNote.mock.calls.map(([path]) => path)).toEqual([
      "C:/vault/a.md",
      "C:/vault/c.md",
    ]);
  });

  it("reports failure so the close handshake can keep the window open", async () => {
    state.tabs = [makeTab("a", "A")];
    state.activeTabId = "a";
    state.tabs[0].content = "A edited";
    saveNote.mockRejectedValueOnce(new Error("磁盘已满"));

    expect(await actions.saveAll()).toBe(false);
  });
});

describe("closing tabs", () => {
  it("keeps a dirty tab open when its final save fails", async () => {
    const tab = makeTab("a", "A");
    tab.content = "A edited";
    state.tabs = [tab];
    state.activeTabId = tab.id;
    saveNote.mockRejectedValueOnce(new Error("磁盘已满"));

    expect(await actions.closeTab(tab.id)).toBe(false);
    expect(state.tabs).toEqual([tab]);
    expect(state.activeTabId).toBe(tab.id);
    expect(tab.content).toBe("A edited");
  });

  it("closes a dirty tab only after its final save succeeds", async () => {
    const tab = makeTab("a", "A");
    tab.content = "A edited";
    state.tabs = [tab];
    state.activeTabId = tab.id;

    expect(await actions.closeTab(tab.id)).toBe(true);
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
  });

  it("keeps every tab whose save failed while closing the others", async () => {
    const a = makeTab("a", "A");
    const b = makeTab("b", "B");
    a.content = "A edited";
    b.content = "B edited";
    state.tabs = [a, b];
    state.activeTabId = a.id;
    saveNote
      .mockRejectedValueOnce(new Error("A failed"))
      .mockResolvedValueOnce(metaFor(b));

    expect(await actions.closeAllTabs()).toBe(false);
    expect(state.tabs.map((tab) => tab.id)).toEqual(["a"]);
    expect(state.tabs[0].content).toBe("A edited");
  });
});

describe("external edit conflicts", () => {
  it("keeps the local buffer and suspends autosave when the backend rejects a stale revision", async () => {
    const tab = makeTab("a", "A");
    tab.content = "local edit";
    state.tabs = [tab];
    state.activeTabId = tab.id;
    saveNote.mockRejectedValueOnce(new Error("笔记已在磁盘上被修改"));
    vi.mocked(api.getNote).mockResolvedValueOnce({
      ...metaFor(tab),
      content: "remote edit",
      revision: "remote-revision",
    });

    expect(await actions.saveTab(tab.id, { silent: true })).toBe(false);
    expect(state.tabs[0].content).toBe("local edit");
    expect(state.tabs[0].savedContent).toBe("A");
    expect(state.tabs[0].conflict?.content).toBe("remote edit");

    await vi.advanceTimersByTimeAsync(5000);
    expect(saveNote).toHaveBeenCalledTimes(1);
  });

  it("detects a changed disk revision while reconciling a dirty tab", async () => {
    const tab = makeTab("a", "A");
    tab.content = "local edit";
    state.tabs = [tab];
    state.activeTabId = tab.id;
    vi.mocked(api.getNote).mockResolvedValueOnce({
      ...metaFor(tab),
      content: "remote edit",
      revision: "remote-revision",
    });

    await actions.reconcileTabs();

    expect(state.tabs[0].content).toBe("local edit");
    expect(state.tabs[0].conflict?.revision).toBe("remote-revision");
  });
});

describe("typing does not repaint the shell", () => {
  it("announces the buffer on its own topic, not through tabs", () => {
    state.tabs = [makeTab("a", "A")];
    state.activeTabId = "a";

    let tabsPublished = 0;
    let docPublished = 0;
    const offTabs = subscribe(["tabs"], () => tabsPublished++);
    const offDoc = subscribe(["docRevision"], () => docPublished++);

    actions.markDirty("A edited");
    actions.markDirty("A edited more");

    offTabs();
    offDoc();

    // The tab strip and the note list both listen on `tabs`; rebuilding them
    // per keystroke is the jank this split exists to prevent.
    expect(tabsPublished).toBe(0);
    expect(docPublished).toBe(2);
    expect(state.tabs[0].content).toBe("A edited more");
  });

  it("still marks the tab dirty so the indicator and the flush see it", () => {
    state.tabs = [makeTab("a", "A")];
    state.activeTabId = "a";

    actions.markDirty("A edited");
    expect(state.saveState).toBe("dirty");
    expect(state.tabs[0].content).not.toBe(state.tabs[0].savedContent);
  });
});

describe("post-save list merge", () => {
  it("updates the saved row in place instead of refetching the list", async () => {
    const tab = makeTab("a", "A");
    state.tabs = [tab];
    state.activeTabId = "a";
    state.notes = [metaFor(tab), metaFor(makeTab("z", "Z"))];
    tab.content = "A edited";

    saveNote.mockResolvedValueOnce({ ...metaFor(tab), title: "新标题", words: 42 });

    await actions.saveTab("a", { silent: true });

    expect(api.listNotes).not.toHaveBeenCalled();
    const row = state.notes.find((n) => n.path === tab.path);
    expect(row?.title).toBe("新标题");
    expect(row?.words).toBe(42);
  });

  it("leaves a title-ordered list alone when the title is unchanged", async () => {
    const a = makeTab("a", "A");
    const c = makeTab("c", "C");
    state.tabs = [a];
    state.activeTabId = "a";
    state.sortBy = "title";
    state.notes = [
      { ...metaFor(a), title: "阿" },
      { ...metaFor(c), title: "丙" },
    ];
    a.content = "A edited";

    saveNote.mockResolvedValueOnce({ ...metaFor(a), title: "阿", words: 9 });
    await actions.saveTab("a", { silent: true });

    // Re-sorting by time here would reshuffle the list under the user.
    expect(state.notes.map((n) => n.title)).toEqual(["阿", "丙"]);
    expect(state.notes[0].words).toBe(9);
    expect(api.listNotes).not.toHaveBeenCalled();
    state.sortBy = "updated";
  });
});
