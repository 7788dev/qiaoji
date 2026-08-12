package store

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newVault(t *testing.T) *Vault {
	t.Helper()
	v, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return v
}

func TestCreateReadRoundTrip(t *testing.T) {
	v := newVault(t)

	n, err := v.Create("工作", "季度复盘", "# 季度复盘\n\n第一段内容。\n")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if n.Title != "季度复盘" {
		t.Errorf("title = %q, want 季度复盘", n.Title)
	}
	if n.Folder != "工作" {
		t.Errorf("folder = %q, want 工作", n.Folder)
	}
	if n.ID == "" {
		t.Error("id must be assigned on create")
	}
	if !strings.HasSuffix(n.Path, "季度复盘.md") {
		t.Errorf("path = %q, want it to end with the slugified title", n.Path)
	}

	// The body handed back must not contain the YAML block.
	if strings.Contains(n.Content, "---") && strings.HasPrefix(n.Content, "---") {
		t.Errorf("body leaked front matter: %q", n.Content)
	}
	if !strings.Contains(n.Content, "第一段内容。") {
		t.Errorf("body lost content: %q", n.Content)
	}

	// The file on disk must carry the front matter.
	raw, err := os.ReadFile(n.Path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.HasPrefix(string(raw), "---\n") {
		t.Errorf("file is missing front matter:\n%s", raw)
	}
	if !strings.Contains(string(raw), "id: "+n.ID) {
		t.Errorf("file is missing the id:\n%s", raw)
	}
}

func TestStatWalkReportsMissingRoot(t *testing.T) {
	v := newVault(t)
	if _, err := v.Create("", "会保留在索引里的笔记", "# 内容\n"); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(v.Root()); err != nil {
		t.Fatal(err)
	}

	stats, err := v.StatWalk()
	if err == nil {
		t.Fatalf("StatWalk() = %v, nil; want a missing-root error", stats)
	}
}

func TestSaveRenamesFileWhenHeadingChanges(t *testing.T) {
	v := newVault(t)
	n, err := v.Create("", "旧标题", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	oldPath := n.Path

	updated, err := v.Save(n.Path, "# 新标题\n\n正文。\n")
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if updated.Title != "新标题" {
		t.Errorf("title = %q, want 新标题", updated.Title)
	}
	if filepath.Base(updated.Path) != "新标题.md" {
		t.Errorf("file = %q, want 新标题.md", filepath.Base(updated.Path))
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Error("the old file should be gone after the rename")
	}
	if updated.ID != n.ID {
		t.Error("the id must survive a rename so open tabs keep working")
	}
}

func TestSaveKeepsIDAndCreatedTime(t *testing.T) {
	v := newVault(t)
	n, _ := v.Create("", "标题", "# 标题\n\n一。\n")
	created := n.Created

	updated, err := v.Save(n.Path, "# 标题\n\n二。\n")
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if updated.ID != n.ID {
		t.Errorf("id changed: %q -> %q", n.ID, updated.ID)
	}
	if !updated.Created.Equal(created) {
		t.Errorf("created changed: %v -> %v", created, updated.Created)
	}
	if !updated.Updated.After(created.Add(-1)) {
		t.Error("updated should move forward")
	}
}

func TestSaveIfRevisionRejectsExternalChange(t *testing.T) {
	v := newVault(t)
	n, err := v.Create("", "同步冲突", "# 同步冲突\n\n本机版本。\n")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(n.Path)
	if err != nil {
		t.Fatal(err)
	}
	fm, _, err := parseFrontMatter(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(n.Path, renderFile(fm, "# 同步冲突\n\n远端版本。\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := v.SaveIfRevision(
		n.Path,
		"# 同步冲突\n\n不应覆盖远端。\n",
		n.Revision,
		false,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("SaveIfRevision() error = %v, want ErrConflict", err)
	}
	disk, err := v.Read(n.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(disk.Content, "远端版本") {
		t.Fatalf("external content was overwritten: %q", disk.Content)
	}
}

func TestSaveDoesNotClobberSiblingTmpFile(t *testing.T) {
	v := newVault(t)
	n, err := v.Create("", "临时文件保护", "# 临时文件保护\n\n旧内容。\n")
	if err != nil {
		t.Fatal(err)
	}
	userTmp := n.Path + ".tmp"
	if err := os.WriteFile(userTmp, []byte("user-owned"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := v.Save(n.Path, "# 临时文件保护\n\n新内容。\n"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(userTmp)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "user-owned" {
		t.Fatalf("sibling .tmp file = %q, want user-owned", data)
	}
	matches, err := filepath.Glob(filepath.Join(v.Root(), ".qiaoji-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("atomic-write temporary files were not cleaned up: %v", matches)
	}
}

func TestSaveAssetCreatesSafeNoteRelativeImage(t *testing.T) {
	v := newVault(t)
	n, err := v.Create("项目", "含图片", "# 含图片\n")
	if err != nil {
		t.Fatal(err)
	}
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0}

	relative, err := v.SaveAsset(n.Path, `..\截图?.png`, png)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(relative, "assets/") || !strings.HasSuffix(relative, ".png") {
		t.Fatalf("relative asset path = %q", relative)
	}
	resolved, err := v.ResolveAsset(n.Path, relative)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(resolved, filepath.Join(v.Root(), "项目", "assets")+string(filepath.Separator)) {
		t.Fatalf("asset escaped its note folder: %q", resolved)
	}
	if data, err := os.ReadFile(resolved); err != nil || !bytes.Equal(data, png) {
		t.Fatalf("saved asset = %v, %v", data, err)
	}

	for _, bad := range []string{"../含图片.md", "../../outside.png", "/absolute.png"} {
		if _, err := v.ResolveAsset(n.Path, bad); !errors.Is(err, ErrNotFound) {
			t.Errorf("ResolveAsset(%q) error = %v, want ErrNotFound", bad, err)
		}
	}
}

func TestExternalFileWithoutFrontMatter(t *testing.T) {
	v := newVault(t)
	p := filepath.Join(v.Root(), "外部编辑器.md")
	if err := os.WriteFile(p, []byte("# 外部标题\n\n别的编辑器写的。\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	n, err := v.Read(p)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if n.Title != "外部标题" {
		t.Errorf("title = %q, want 外部标题", n.Title)
	}
	if n.ID == "" {
		t.Error("a synthetic id should be produced for un-owned files")
	}
	if strings.Contains(n.Content, "外部标题") == false {
		t.Errorf("content = %q", n.Content)
	}
}

func TestTagsAndFavorite(t *testing.T) {
	v := newVault(t)
	n, _ := v.Create("", "带标签", "")

	tagged, err := v.SetTags(n.Path, []string{" 工作 ", "#灵感", "工作", ""})
	if err != nil {
		t.Fatalf("SetTags: %v", err)
	}
	want := []string{"工作", "灵感"}
	if len(tagged.Tags) != len(want) {
		t.Fatalf("tags = %v, want %v (trimmed, de-duplicated, # stripped)", tagged.Tags, want)
	}
	for i := range want {
		if tagged.Tags[i] != want[i] {
			t.Errorf("tags[%d] = %q, want %q", i, tagged.Tags[i], want[i])
		}
	}

	fav, err := v.SetFavorite(n.Path, true)
	if err != nil {
		t.Fatalf("SetFavorite: %v", err)
	}
	if !fav.Favorite {
		t.Error("favorite should be set")
	}
	if len(fav.Tags) != 2 {
		t.Errorf("changing favorite must not drop tags: %v", fav.Tags)
	}
}

func TestTrashRestoreRoundTrip(t *testing.T) {
	v := newVault(t)
	n, _ := v.Create("学习", "会被删除", "# 会被删除\n\n内容。\n")

	item, err := v.Trash(n.Path)
	if err != nil {
		t.Fatalf("Trash: %v", err)
	}
	if _, err := os.Stat(n.Path); !os.IsNotExist(err) {
		t.Error("the note should be gone from the vault tree")
	}

	items, err := v.ListTrash()
	if err != nil || len(items) != 1 {
		t.Fatalf("ListTrash = %v, %v; want one entry", items, err)
	}
	if items[0].Title != "会被删除" || items[0].Folder != "学习" {
		t.Errorf("trash metadata lost: %+v", items[0])
	}

	restored, err := v.Restore(item.ID)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Kind != TrashNote {
		t.Errorf("restored kind = %q, want %q", restored.Kind, TrashNote)
	}
	if restored.Note.Folder != "学习" {
		t.Errorf("restored into %q, want 学习", restored.Note.Folder)
	}
	if !strings.Contains(restored.Note.Content, "内容。") {
		t.Errorf("restored content = %q", restored.Note.Content)
	}
	if left, _ := v.ListTrash(); len(left) != 0 {
		t.Errorf("trash should be empty after restore, got %d", len(left))
	}
}

func TestPurgeTrashRejectsRootAliases(t *testing.T) {
	v := newVault(t)
	n, err := v.Create("", "不能误删", "# 不能误删\n")
	if err != nil {
		t.Fatal(err)
	}
	item, err := v.Trash(n.Path)
	if err != nil {
		t.Fatal(err)
	}

	for _, entryID := range []string{"", ".", "..", "/", `\`, "nested/entry", `nested\entry`} {
		if err := v.PurgeTrash(entryID); err == nil {
			t.Errorf("PurgeTrash(%q) error = nil, want invalid-entry error", entryID)
		}
		items, listErr := v.ListTrash()
		if listErr != nil {
			t.Fatal(listErr)
		}
		if len(items) != 1 || items[0].ID != item.ID {
			t.Fatalf("PurgeTrash(%q) changed the trash: %+v", entryID, items)
		}
	}

	if err := v.PurgeTrash(item.ID); err != nil {
		t.Fatalf("PurgeTrash(valid id): %v", err)
	}
	if items, err := v.ListTrash(); err != nil || len(items) != 0 {
		t.Fatalf("trash after valid purge = %+v, %v; want empty", items, err)
	}
}

func TestRestoreWhenOriginalFolderIsGone(t *testing.T) {
	v := newVault(t)
	n, _ := v.Create("临时", "孤儿笔记", "")
	item, err := v.Trash(n.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(v.Root(), "临时")); err != nil {
		t.Fatal(err)
	}

	restored, err := v.Restore(item.ID)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Note.Folder != "临时" {
		t.Errorf("folder = %q, want the folder to be recreated", restored.Note.Folder)
	}
}

func TestSlugifyHandlesUnsafeNames(t *testing.T) {
	cases := map[string]string{
		`a/b\c:d*e?f"g<h>i|j`: "a-b-c-d-e-f-g-h-i-j",
		"  trailing dots... ": "trailing dots",
		"正常中文标题":              "正常中文标题",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
	// Reserved device names must not become filenames on Windows.
	if got := slugify("CON"); strings.EqualFold(got, "con") {
		t.Errorf("slugify(CON) = %q, want a non-reserved name", got)
	}
	if got := slugify(""); got == "" {
		t.Error("slugify must always produce a usable name")
	}
}

func TestUniquePathAvoidsCollisions(t *testing.T) {
	v := newVault(t)
	a, _ := v.Create("", "同名", "")
	b, _ := v.Create("", "同名", "")
	if a.Path == b.Path {
		t.Fatal("two notes with the same title must not share a file")
	}
	if filepath.Base(b.Path) != "同名-2.md" {
		t.Errorf("second file = %q, want 同名-2.md", filepath.Base(b.Path))
	}
}

func TestExcerptReadsAsProse(t *testing.T) {
	body := "# 标题不该重复\n\n" +
		"这是**加粗**和*斜体*，还有`代码`和[链接](https://example.com)，以及 ![配图](a.png)。\n\n" +
		"```go\nfmt.Println(\"不该出现\")\n```\n\n" +
		"| 表格 | 不该出现 |\n"

	got := excerptOf(body, 200)

	if strings.Contains(got, "标题不该重复") {
		t.Errorf("the title is already shown separately and must not repeat: %q", got)
	}
	for _, marker := range []string{"**", "*斜体*", "`", "https://", "](", "不该出现"} {
		if strings.Contains(got, marker) {
			t.Errorf("excerpt still contains %q: %q", marker, got)
		}
	}
	for _, want := range []string{"加粗", "斜体", "代码", "链接", "配图"} {
		if !strings.Contains(got, want) {
			t.Errorf("excerpt lost %q: %q", want, got)
		}
	}
}

func TestExcerptTruncatesOnRunes(t *testing.T) {
	body := "# 标题\n\n" + strings.Repeat("中", 200) + "\n"
	got := excerptOf(body, 30)
	runes := []rune(got)
	if len(runes) != 31 || runes[30] != '…' {
		t.Errorf("got %d runes (%q), want 30 plus an ellipsis", len(runes), got)
	}
}

func TestCountWordsMixedScripts(t *testing.T) {
	cases := map[string]int{
		"你好世界":         4,
		"hello world":  2,
		"你好 world 123": 2 + 1 + 1,
		"":             0,
		"标点，也不算。":      5,
	}
	for in, want := range cases {
		if got := countWords(in); got != want {
			t.Errorf("countWords(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestFrontMatterSurvivesRoundTrip(t *testing.T) {
	raw := "---\nid: abc123\ntitle: 测试\ntags:\n  - 工作\nfavorite: true\n---\n\n# 测试\n\n正文\n"
	fm, body, err := parseFrontMatter([]byte(raw))
	if err != nil {
		t.Fatalf("parseFrontMatter: %v", err)
	}
	if fm.ID != "abc123" || fm.Title != "测试" || !fm.Favorite {
		t.Fatalf("parsed front matter = %+v", fm)
	}
	if len(fm.Tags) != 1 || fm.Tags[0] != "工作" {
		t.Fatalf("tags = %v", fm.Tags)
	}
	if !strings.HasPrefix(body, "# 测试") {
		t.Fatalf("body = %q", body)
	}

	again, body2, _ := parseFrontMatter(renderFile(fm, body))
	if again.ID != fm.ID || again.Title != fm.Title || again.Favorite != fm.Favorite {
		t.Errorf("round trip lost data: %+v -> %+v", fm, again)
	}
	if strings.TrimSpace(body2) != strings.TrimSpace(body) {
		t.Errorf("round trip changed the body:\n%q\n%q", body, body2)
	}
}

func TestFrontMatterIgnoresLooseDashes(t *testing.T) {
	// A note that merely starts with a horizontal rule is not front matter.
	raw := "---\n\n这只是分割线开头的正文。\n"
	fm, body, _ := parseFrontMatter([]byte(raw))
	if fm.ID != "" {
		t.Errorf("unexpected front matter: %+v", fm)
	}
	if !strings.Contains(body, "分割线") {
		t.Errorf("body = %q", body)
	}
}

// The app is one editor among several. Keys it does not model belong to
// whoever wrote them, and a save must hand them back untouched.
func TestSavePreservesForeignFrontMatterKeys(t *testing.T) {
	v := newVault(t)
	n, err := v.Create("", "外部笔记", "# 外部笔记\n\n正文。\n")
	if err != nil {
		t.Fatal(err)
	}
	raw := "---\n" +
		"id: " + n.ID + "\n" +
		"title: 外部笔记\n" +
		"aliases:\n  - 别名一\n  - 别名二\n" +
		"cssclass: wide-table\n" +
		"publish: true\n" +
		"custom-field: 保留我\n" +
		"---\n\n# 外部笔记\n\n正文。\n"
	if err := os.WriteFile(n.Path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := v.Save(n.Path, "# 外部笔记\n\n改过的正文。\n"); err != nil {
		t.Fatalf("Save: %v", err)
	}

	after, err := os.ReadFile(n.Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"aliases", "别名一", "别名二", "cssclass", "wide-table", "publish", "custom-field", "保留我"} {
		if !strings.Contains(string(after), want) {
			t.Errorf("save dropped %q from the front matter:\n%s", want, after)
		}
	}
	if !strings.Contains(string(after), "改过的正文。") {
		t.Errorf("save lost the new body:\n%s", after)
	}
}

func TestUpdateMetaPreservesForeignFrontMatterKeys(t *testing.T) {
	v := newVault(t)
	n, _ := v.Create("", "收藏测试", "# 收藏测试\n\n正文。\n")
	raw := "---\nid: " + n.ID + "\ntitle: 收藏测试\naliases:\n  - 曾用名\n---\n\n# 收藏测试\n\n正文。\n"
	if err := os.WriteFile(n.Path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := v.SetTags(n.Path, []string{"工作"}); err != nil {
		t.Fatalf("SetTags: %v", err)
	}
	after, _ := os.ReadFile(n.Path)
	if !strings.Contains(string(after), "曾用名") {
		t.Errorf("tag edit dropped an unknown key:\n%s", after)
	}
	if !strings.Contains(string(after), "工作") {
		t.Errorf("tag edit did not apply:\n%s", after)
	}
}

// A body that opens with a thematic break is prose, not a header. Reading it
// as front matter used to delete everything above the next `---` on save.
func TestSaveKeepsBodyThatStartsWithThematicBreak(t *testing.T) {
	v := newVault(t)
	n, _ := v.Create("", "分割线", "")
	body := "---\n\n第一段不能消失。\n\n---\n\n第二段。\n"
	if err := os.WriteFile(n.Path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	read, err := v.Read(n.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read.Content, "第一段不能消失。") {
		t.Fatalf("reading already lost the first section: %q", read.Content)
	}

	saved, err := v.Save(n.Path, read.Content)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	after, _ := os.ReadFile(saved.Path)
	if !strings.Contains(string(after), "第一段不能消失。") {
		t.Errorf("save ate the first section:\n%s", after)
	}
	if !strings.Contains(string(after), "第二段。") {
		t.Errorf("save ate the second section:\n%s", after)
	}
}

// A header we cannot decode must stop the write. Rewriting it would silently
// replace values we failed to understand.
func TestSaveRefusesUndecodableFrontMatter(t *testing.T) {
	v := newVault(t)
	n, _ := v.Create("", "坏头部", "")
	raw := "---\nid: " + n.ID + "\ntags: 这是字符串不是列表\n---\n\n# 坏头部\n\n正文。\n"
	if err := os.WriteFile(n.Path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := v.Save(n.Path, "# 坏头部\n\n新正文。\n"); err == nil {
		t.Fatal("Save should refuse a front matter block it cannot decode")
	}
	after, _ := os.ReadFile(n.Path)
	if string(after) != raw {
		t.Errorf("the file was modified despite the error:\n%s", after)
	}

	// The note still has to be readable, or a single bad key would hide it.
	if _, err := v.Read(n.Path); err != nil {
		t.Errorf("Read: %v", err)
	}
}

// Deleting a folder has to be recoverable in full: the dialog promises it, and
// attachments are not disposable just because they are not Markdown.
func TestDeleteFolderKeepsAttachments(t *testing.T) {
	v := newVault(t)
	if _, err := v.Create("资料", "会议记录", "# 会议记录\n\n内容。\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("资料/存档", "旧笔记", "# 旧笔记\n"); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(v.Root(), "资料")
	if err := os.WriteFile(filepath.Join(dir, "示意图.png"), []byte("png-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "预算.xlsx"), []byte("xlsx-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	item, err := v.DeleteFolder("资料")
	if err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	if item.Kind != TrashFolder {
		t.Errorf("kind = %q, want %q", item.Kind, TrashFolder)
	}
	if item.Notes != 2 || item.Files != 2 {
		t.Errorf("counted %d notes and %d files, want 2 and 2", item.Notes, item.Files)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("the folder should be gone from the vault tree")
	}

	items, _ := v.ListTrash()
	if len(items) != 1 {
		t.Fatalf("trash holds %d entries, want one folder entry", len(items))
	}

	restored, err := v.Restore(item.ID)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Kind != TrashFolder || restored.Folder != "资料" {
		t.Errorf("restored = %+v, want the 资料 folder", restored)
	}
	for _, name := range []string{"示意图.png", "预算.xlsx"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s did not come back: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "存档", "旧笔记.md")); err != nil {
		t.Errorf("the nested note did not come back: %v", err)
	}
}

// The sidebar count and the list a folder opens have to agree.
func TestFolderCountsIncludeSubfolders(t *testing.T) {
	v := newVault(t)
	if _, err := v.Create("工作", "顶层", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("工作/2026", "子一", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("工作/2026", "子二", ""); err != nil {
		t.Fatal(err)
	}

	folders, err := v.Folders()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, f := range folders {
		got[f.Path] = f.Count
	}
	if got["工作"] != 3 {
		t.Errorf("工作 counts %d notes, want 3 including subfolders", got["工作"])
	}
	if got["工作/2026"] != 2 {
		t.Errorf("工作/2026 counts %d notes, want 2", got["工作/2026"])
	}
}

func TestScanSkipsInternalDir(t *testing.T) {
	v := newVault(t)
	if _, err := v.Create("", "可见笔记", ""); err != nil {
		t.Fatal(err)
	}
	hidden := filepath.Join(v.InternalPath("trash"), "x")
	_ = os.MkdirAll(hidden, 0o755)
	_ = os.WriteFile(filepath.Join(hidden, "note.md"), []byte("# 隐藏\n"), 0o644)

	notes, err := v.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 {
		t.Fatalf("scanned %d notes, want 1 (the trash must stay hidden)", len(notes))
	}
	if notes[0].Title != "可见笔记" {
		t.Errorf("title = %q", notes[0].Title)
	}
}

// The starter notes must be written once and never again. Someone who deletes
// every sample note expects an empty library on the next launch, not the
// samples back.
func TestInitialisationMarkerIsWrittenOnce(t *testing.T) {
	v := newVault(t)

	if v.IsInitialised() {
		t.Fatal("a fresh folder must not look initialised")
	}
	if err := v.Seed(); err != nil {
		t.Fatal(err)
	}
	if err := v.MarkInitialised(); err != nil {
		t.Fatal(err)
	}
	if !v.IsInitialised() {
		t.Fatal("the marker should persist after being written")
	}

	// Simulate the user deleting every note.
	notes, err := v.Scan()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range notes {
		if _, err := v.Trash(n.Path); err != nil {
			t.Fatal(err)
		}
	}
	if err := v.EmptyTrash(); err != nil {
		t.Fatal(err)
	}
	if !v.IsEmpty() {
		t.Fatal("the vault should be empty now")
	}

	// Reopening the same folder must still report it as initialised.
	again, err := Open(v.Root())
	if err != nil {
		t.Fatal(err)
	}
	if !again.IsInitialised() {
		t.Error("reopening a used folder must not trigger re-seeding")
	}

	// Removing the marker is the documented way to get the samples back.
	if err := os.Remove(again.InternalPath("vault.json")); err != nil {
		t.Fatal(err)
	}
	if again.IsInitialised() {
		t.Error("deleting the marker should allow re-initialisation")
	}
}

func TestSeedProducesUsableVault(t *testing.T) {
	v := newVault(t)
	if !v.IsEmpty() {
		t.Fatal("a fresh vault should be empty")
	}
	if err := v.Seed(); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if v.IsEmpty() {
		t.Fatal("the vault should not be empty after seeding")
	}
	notes, err := v.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != len(seeds) {
		t.Errorf("scanned %d notes, want %d", len(notes), len(seeds))
	}
	folders, _ := v.Folders()
	if len(folders) < 4 {
		t.Errorf("expected the four starter folders, got %v", folders)
	}
	var welcome *Note
	for i := range notes {
		if notes[i].Title == "欢迎使用巧记" {
			welcome = &notes[i]
		}
	}
	if welcome == nil {
		t.Fatal("the welcome note is missing")
	}
	if !welcome.Favorite {
		t.Error("the welcome note should start favourited")
	}
	if !strings.Contains(welcome.Content, `E = mc^2`) {
		t.Error("the welcome note should contain the sample formula")
	}
}
