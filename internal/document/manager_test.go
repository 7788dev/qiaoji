package document

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOpenAndNoopSavePreserveExactFile(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	body := "\ufeff---\r\n# custom comment\r\ntitle: '与文件名不同'\r\nextra: {keep: true}\r\n---\r\n\r\n# 标题\r\n\r\n__文字__  \r\n"
	path := fixture(t, dir, "文件.md", body)
	stamp := time.Unix(1600000000, 0)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	doc, err := m.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Content != body {
		t.Fatal("open changed the raw source")
	}
	if _, err = m.Save(SaveRequest{ID: doc.ID, Content: doc.Content, ExpectedRevision: doc.Revision}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	info, _ := os.Stat(path)
	if !bytes.Equal(data, []byte(body)) || !info.ModTime().Equal(stamp) {
		t.Fatal("no-op save rewrote the file")
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatal("opening a document created application files")
	}
	next := strings.Replace(body, "# 标题", "# 改标题", 1)
	if _, err = m.Save(SaveRequest{ID: doc.ID, Content: next, ExpectedRevision: doc.Revision}); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if string(data) != next {
		t.Fatal("save did not preserve front matter, BOM and CRLF")
	}
	if _, err = os.Stat(filepath.Join(dir, "改标题.md")); !os.IsNotExist(err) {
		t.Fatal("heading renamed file")
	}
}

func TestDraftAndRevisionConflicts(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := NewManager()
	draft := m.New()
	files, _ := os.ReadDir(dir)
	if len(files) != 0 || draft.Path != "" || draft.Content != "" {
		t.Fatal("draft must be empty and not on disk")
	}
	path := filepath.Join(dir, "随手记.md")
	saved, err := m.Save(SaveRequest{ID: draft.ID, Path: path, Content: "一段正文\n"})
	if err != nil {
		t.Fatal(err)
	}
	fixture(t, dir, "随手记.md", "外部修改\n")
	_, err = m.Save(SaveRequest{ID: saved.ID, Content: "本地编辑\n", ExpectedRevision: saved.Revision})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "外部修改\n" {
		t.Fatal("conflict overwrote disk")
	}
	reviewed := Revision([]byte("外部修改\n"))
	if _, err = m.Save(SaveRequest{ID: saved.ID, Content: "明确覆盖\n", ExpectedRevision: reviewed, Force: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Save(SaveRequest{ID: saved.ID, Content: "过期覆盖\n", ExpectedRevision: reviewed, Force: true}); !errors.Is(err, ErrConflict) {
		t.Fatalf("a second disk revision must require a new confirmation: %v", err)
	}
}

func TestIdentityUsesPathAndSaveAsDoesNotOverwriteAnOpenFile(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := NewManager()
	first, _ := m.Open(fixture(t, dir, "一.md", "---\nid: same\n---\n\n一"))
	second, _ := m.Open(fixture(t, dir, "二.md", "---\nid: same\n---\n\n二"))
	again, _ := m.Open(first.Path)
	if first.ID == second.ID || first.ID != again.ID {
		t.Fatal("identity must follow paths, not YAML ids")
	}
	if _, err := m.Save(SaveRequest{ID: first.ID, Path: second.Path, Content: "覆盖", TargetRevision: second.Revision}); err == nil {
		t.Fatal("save as replaced another open document")
	}
	third := fixture(t, dir, "三.md", "保留")
	if _, err := m.Save(SaveRequest{ID: first.ID, Path: third, Content: "覆盖"}); !errors.Is(err, ErrExists) {
		t.Fatalf("save as must require destination revision: %v", err)
	}
}

func TestStagedImagesAndSaveAsKeepImagesAndCodeExamples(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dest := t.TempDir()
	m := NewManager()
	draft := m.New()
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ar8AAAAASUVORK5CYII=")
	href, err := m.StageAsset(draft.ID, bytes.NewReader(png))
	if err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatal("staging an image wrote to the document folder")
	}
	content := "![测试](" + href + ")\n\n```md\n![示例](missing.png)\n```\n"
	saved, err := m.Save(SaveRequest{ID: draft.ID, Path: filepath.Join(dir, "原稿.md"), Content: content})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(saved.Content, "qiaoji-asset:") {
		t.Fatal("temporary asset URL leaked to disk")
	}
	if !strings.Contains(saved.Content, "![示例](missing.png)") {
		t.Fatal("code example changed")
	}
	refs := imageReferences(saved.Content)
	if len(refs) != 1 {
		t.Fatalf("expected one real image, got %#v", refs)
	}
	copy, err := m.Save(SaveRequest{ID: saved.ID, Path: filepath.Join(dest, "副本.md"), Content: saved.Content})
	if err != nil {
		t.Fatal(err)
	}
	copied, _ := os.ReadFile(filepath.Join(dest, filepath.FromSlash(imageReferences(copy.Content)[0].href)))
	if !bytes.Equal(copied, png) {
		t.Fatal("save as did not copy the local image")
	}
	if _, err := os.Stat(saved.Path); err != nil {
		t.Fatal("save as removed original")
	}
}

func TestImageReferencesSupportAnglesReferencesAndExcludeInlineCode(t *testing.T) {
	t.Parallel()
	source := "![图片](<assets/a b.png> \"标题\")\n![第二张][pic]\n[pic]: assets/second.png\n\n`![示例](ignore.png)`\n"
	refs := imageReferences(source)
	if len(refs) != 2 || refs[0].href != "assets/a b.png" || refs[1].href != "assets/second.png" {
		t.Fatalf("references = %#v", refs)
	}
}

func TestImageExamplesAndFrontMatterRemainUntouched(t *testing.T) {
	t.Parallel()
	source := "---\n# ![comment](missing.png)\nvalue: '![yaml](absent.png)'\n---\n\n\\![escaped](no.png)\n\n![real](assets/图.png)\n"
	refs := imageReferences(source)
	if len(refs) != 1 || refs[0].href != "assets/图.png" {
		t.Fatalf("unexpected image references: %#v", refs)
	}
}

func TestLiveImageReferencesDoNotSaveTheBuffer(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	notes := filepath.Join(dir, "笔记")
	if err := os.Mkdir(notes, 0o755); err != nil {
		t.Fatal(err)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ar8AAAAASUVORK5CYII=")
	if err := os.WriteFile(filepath.Join(dir, "图.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	doc, err := m.Open(fixture(t, notes, "中文.md", "原文"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.Asset(doc.ID, "../图.png"); err == nil {
		t.Fatal("an unrelated sibling image was readable")
	}
	if err := m.AuthorizeImages(doc.ID, "原文\n\n![新引用](../图.png)"); err != nil {
		t.Fatal(err)
	}
	data, _, err := m.Asset(doc.ID, "../图.png")
	if err != nil || !bytes.Equal(data, png) {
		t.Fatalf("unsaved relative image cannot be displayed: %v", err)
	}
	saved, _ := m.Get(doc.ID)
	disk, _ := os.ReadFile(doc.Path)
	if saved.Content != "原文" || string(disk) != "原文" {
		t.Fatal("authorizing images saved the editing buffer")
	}
}

func TestImageAliasesSurviveSaveAsAndOldUndoSnapshots(t *testing.T) {
	t.Parallel()
	original, destination := t.TempDir(), t.TempDir()
	m := NewManager()
	doc := m.New()
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ar8AAAAASUVORK5CYII=")
	staged, err := m.StageAsset(doc.ID, bytes.NewReader(png))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := "![图片](" + staged + ")\n"
	first, err := m.Save(SaveRequest{ID: doc.ID, Path: filepath.Join(original, "原稿.md"), Content: snapshot})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.docs[doc.ID].assets) != 0 {
		t.Fatal("saved image bytes were retained in the staging buffer")
	}
	second, err := m.Save(SaveRequest{ID: doc.ID, Path: filepath.Join(destination, "副本.md"), Content: first.Content})
	if err != nil {
		t.Fatal(err)
	}
	// An undo or an edit made while Save As was pending still contains the old URL.
	third, err := m.Save(SaveRequest{ID: doc.ID, Content: snapshot + "\n新编辑", ExpectedRevision: second.Revision})
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{staged, imageReferences(first.Content)[0].href, imageReferences(third.Content)[0].href} {
		raw, _, err := m.Asset(doc.ID, ref)
		if err != nil || !bytes.Equal(raw, png) {
			t.Fatalf("historical image reference %q lost: %v", ref, err)
		}
	}
	raw, err := os.ReadFile(first.Path)
	if err != nil || string(raw) != first.Content {
		t.Fatal("save as changed the original document")
	}
}

func TestUnchangedSaveDoesNotRequireWritableFileOrExistingImages(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := NewManager()
	doc, err := m.Open(fixture(t, dir, "只读.md", "![失效图片](assets/missing.png)\n"))
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Unix(1600000000, 0)
	if err := os.Chtimes(doc.Path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(doc.Path, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(doc.Path, 0o644) })
	if _, err := m.Save(SaveRequest{ID: doc.ID, Content: doc.Content, ExpectedRevision: doc.Revision}); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(doc.Path)
	if !info.ModTime().Equal(stamp) {
		t.Fatal("unchanged save touched the file")
	}
}

func TestMissingDocumentCanReappearWithTheSameContent(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := NewManager()
	doc, err := m.Open(fixture(t, dir, "恢复.md", "保留原文"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(doc.Path); err != nil {
		t.Fatal(err)
	}
	if changes := m.Check(); len(changes) != 1 || !changes[0].Missing {
		t.Fatal("removed file was not reported")
	}
	fixture(t, dir, "恢复.md", doc.Content)
	changes := m.Check()
	if len(changes) != 1 || changes[0].Missing || changes[0].Document == nil || changes[0].Document.Revision != doc.Revision {
		t.Fatal("identical restored file was not reported")
	}
}

func TestExternalChangesAreReportedWithoutOverwritingSession(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := NewManager()
	doc, _ := m.Open(fixture(t, dir, "文件.md", "原文"))
	fixture(t, dir, "文件.md", "磁盘变更更长的内容")
	changes := m.Check()
	if len(changes) != 1 || changes[0].Document == nil {
		t.Fatalf("changes=%#v", changes)
	}
	current, _ := m.Get(doc.ID)
	if current.Content != "原文" {
		t.Fatal("external change implicitly accepted")
	}
	if len(m.Check()) != 0 {
		t.Fatal("unchanged disk emitted twice")
	}
	reloaded, err := m.AcceptDisk(doc.ID, changes[0].Document.Revision)
	if err != nil || reloaded.Content != "磁盘变更更长的内容" {
		t.Fatalf("reload: %v", err)
	}
}

func TestDirectoryIsPagedAndDoesNotInitialiseVault(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	for i := 0; i < 405; i++ {
		fixture(t, dir, time.Unix(int64(i), 0).Format("150405")+".md", "")
	}
	first, err := ListDirectory(dir, "", "")
	if err != nil || len(first.Entries) != 200 || first.NextCursor == "" {
		t.Fatalf("first page: %v %#v", err, first)
	}
	second, _ := ListDirectory(dir, "", first.NextCursor)
	third, _ := ListDirectory(dir, "", second.NextCursor)
	if len(third.Entries) != 5 || third.NextCursor != "" {
		t.Fatal("pagination lost files")
	}
	if _, err := os.Stat(filepath.Join(dir, ".qiaoji")); !os.IsNotExist(err) {
		t.Fatal("directory read created metadata")
	}
	if _, err := ListDirectory(dir, filepath.Dir(dir), ""); err == nil {
		t.Fatal("directory traversal allowed")
	}
}
