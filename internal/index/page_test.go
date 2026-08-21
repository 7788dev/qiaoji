package index

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"qiaoji/internal/watch"
)

func TestListPageUsesStableCursor(t *testing.T) {
	v, ix := newFixture(t)
	for i := 0; i < 435; i++ {
		if _, err := v.Create("分页", fmt.Sprintf("笔记 %03d", i), fmt.Sprintf("# 笔记 %03d\n\n内容。\n", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}

	request := PageRequest{Scope: "all", SortBy: "title", Limit: 200}
	seen := map[string]bool{}
	for pageNo := 0; ; pageNo++ {
		page, err := ix.ListPage(request)
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 435 {
			t.Fatalf("page %d total = %d, want 435", pageNo, page.Total)
		}
		if len(page.Items) > 200 {
			t.Fatalf("page %d returned %d items", pageNo, len(page.Items))
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatalf("duplicate item %q across pages", item.ID)
			}
			seen[item.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		request.Cursor = page.NextCursor
	}
	if len(seen) != 435 {
		t.Fatalf("visited %d notes, want 435", len(seen))
	}
}

func TestListPageRejectsCursorFromAnotherSort(t *testing.T) {
	v, ix := newFixture(t)
	for i := 0; i < 3; i++ {
		if _, err := v.Create("", fmt.Sprintf("N%d", i), ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	page, err := ix.ListPage(PageRequest{SortBy: "updated", Limit: 1})
	if err != nil || page.NextCursor == "" {
		t.Fatalf("first page = %+v, %v", page, err)
	}
	if _, err := ix.ListPage(PageRequest{SortBy: "title", Limit: 1, Cursor: page.NextCursor}); err == nil {
		t.Fatal("cursor from another sort was accepted")
	}
}

func TestSyncChangesTouchesOnlyNamedFile(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)
	all, err := ix.List(Query{Scope: "all", SortBy: "title"})
	if err != nil || len(all) != 3 {
		t.Fatalf("seed list = %v, %v", all, err)
	}
	target := all[0]
	if _, err := v.Save(target.Path, "# "+target.Title+"\n\n只修改这一篇。\n"); err != nil {
		t.Fatal(err)
	}
	delta, err := ix.SyncChanges(v, watch.ChangeSet{Modified: []string{target.Path}})
	if err != nil {
		t.Fatal(err)
	}
	if delta.Full || len(delta.Upserted) != 1 || len(delta.Removed) != 0 {
		t.Fatalf("delta = %+v, want one precise upsert", delta)
	}
	if delta.Upserted[0].Path != target.Path {
		t.Fatalf("updated %q, want %q", delta.Upserted[0].Path, target.Path)
	}
}

func TestSyncChangesHandlesDirectoryRenameWithoutFullWalk(t *testing.T) {
	v, ix := newFixture(t)
	if _, err := v.Create("旧目录", "一", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("旧目录/子目录", "二", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	oldDir := filepath.Join(v.Root(), "旧目录")
	newDir := filepath.Join(v.Root(), "新目录")
	if err := os.Rename(oldDir, newDir); err != nil {
		t.Fatal(err)
	}
	delta, err := ix.SyncChanges(v, watch.ChangeSet{
		Renamed: []string{oldDir},
		Created: []string{newDir},
		Dirs:    []string{oldDir, newDir},
	})
	if err != nil {
		t.Fatal(err)
	}
	if delta.Full || len(delta.Upserted) != 2 || len(delta.Removed) != 2 {
		t.Fatalf("delta = %+v", delta)
	}
	folders, err := ix.Folders()
	if err != nil {
		t.Fatal(err)
	}
	for _, folder := range folders {
		if folder.Path == "旧目录" || folder.Path == "旧目录/子目录" {
			t.Fatalf("stale folder remained: %+v", folders)
		}
	}
}

func TestTagAndFolderAggregatesUpdateWithOneNote(t *testing.T) {
	v, ix := newFixture(t)
	note, err := v.Create("工作/2026", "聚合", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err = v.SetTags(note.Path, []string{"工作", "计划"})
	if err != nil {
		t.Fatal(err)
	}
	if err := ix.Upsert(note); err != nil {
		t.Fatal(err)
	}
	tags, err := ix.Tags()
	if err != nil || len(tags) != 2 {
		t.Fatalf("tags = %+v, %v", tags, err)
	}
	folders, err := ix.Folders()
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, folder := range folders {
		counts[folder.Path] = folder.Count
	}
	if counts["工作"] != 1 || counts["工作/2026"] != 1 {
		t.Fatalf("folder counts = %v", counts)
	}
}
