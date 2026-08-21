package index

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"qiaoji/internal/store"
)

func newFixture(t *testing.T) (*store.Vault, *Index) {
	t.Helper()
	dir := t.TempDir()
	v, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	ix, err := Open(filepath.Join(dir, "index.db"))
	if err != nil {
		t.Fatalf("index.Open: %v", err)
	}
	t.Cleanup(func() { ix.Close() })
	return v, ix
}

func seedFixture(t *testing.T, v *store.Vault, ix *Index) {
	t.Helper()
	notes := []struct {
		folder, title, body string
		tags                []string
		fav                 bool
	}{
		{"工作", "季度复盘", "# 季度复盘\n\n本季度的工作重点是性能优化与稳定性。\n", []string{"工作"}, false},
		{"学习", "读书笔记", "# 读书笔记\n\n简单是可靠的先决条件，笔记要写得克制。\n", []string{"学习", "灵感"}, true},
		{"", "公式示例", "# 公式示例\n\n质能方程 $E = mc^2$ 与 Markdown 渲染。\n", nil, false},
	}
	for _, n := range notes {
		note, err := v.Create(n.folder, n.title, n.body)
		if err != nil {
			t.Fatalf("create %s: %v", n.title, err)
		}
		if n.tags != nil {
			note, _ = v.SetTags(note.Path, n.tags)
		}
		if n.fav {
			note, _ = v.SetFavorite(note.Path, true)
		}
		_ = note
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatalf("Sync: %v", err)
	}
}

func TestSyncIsIncremental(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	n, err := ix.Count()
	if err != nil || n != 3 {
		t.Fatalf("Count = %d, %v; want 3", n, err)
	}

	// Nothing changed on disk, so a second pass must be a no-op.
	changed, err := ix.Sync(v)
	if err != nil {
		t.Fatal(err)
	}
	if changed != 0 {
		t.Errorf("second Sync touched %d notes, want 0", changed)
	}

	// Keep the heading identical so the file is not renamed; this isolates the
	// "content changed" path from the "file moved" path.
	target := findByTitle(t, ix, "季度复盘")
	if _, err := v.Save(target.Path, "# 季度复盘\n\n改过的内容。\n"); err != nil {
		t.Fatal(err)
	}
	changed, err = ix.Sync(v)
	if err != nil {
		t.Fatal(err)
	}
	if changed != 1 {
		t.Errorf("Sync after one edit touched %d notes, want 1", changed)
	}
}

func TestSyncUsesFilesystemMtimeInsteadOfFutureFrontMatterUpdated(t *testing.T) {
	v, ix := newFixture(t)
	path := filepath.Join(v.Root(), "future.md")
	future := time.Now().Add(10 * 365 * 24 * time.Hour).UTC().Format(time.RFC3339)
	raw := "---\nid: future-note\ntitle: Future\ncreated: 2026-01-01T00:00:00Z\nupdated: " + future + "\n---\n# Future\n\nbody\n"
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	if changed, err := ix.Sync(v); err != nil || changed != 1 {
		t.Fatalf("first Sync = %d, %v; want 1", changed, err)
	}
	if changed, err := ix.Sync(v); err != nil || changed != 0 {
		t.Fatalf("second Sync = %d, %v; future front matter must not force a reread", changed, err)
	}
}

func TestSyncAcceptsExternallyRestoredOlderMtimeOnce(t *testing.T) {
	v, ix := newFixture(t)
	note, err := v.Create("", "Restored", "# Restored\n\nnewer body\n")
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := ix.Sync(v); err != nil || changed != 1 {
		t.Fatalf("seed Sync = %d, %v; want 1", changed, err)
	}

	raw, err := os.ReadFile(note.Path)
	if err != nil {
		t.Fatal(err)
	}
	restored := strings.Replace(string(raw), "newer body", "older body", 1)
	if restored == string(raw) {
		t.Fatal("test fixture did not contain the expected body")
	}
	if err := os.WriteFile(note.Path, []byte(restored), 0o644); err != nil {
		t.Fatal(err)
	}
	older := note.FileModTime.Add(-24 * time.Hour)
	if err := os.Chtimes(note.Path, older, older); err != nil {
		t.Fatal(err)
	}
	restoredInfo, err := os.Stat(note.Path)
	if err != nil {
		t.Fatal(err)
	}

	if changed, err := ix.Sync(v); err != nil || changed != 1 {
		t.Fatalf("restored Sync = %d, %v; want one update", changed, err)
	}
	var content string
	var indexedMtime int64
	if err := ix.db.QueryRow(`SELECT content, mtime FROM notes WHERE path = ?`, note.Path).Scan(&content, &indexedMtime); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "older body") {
		t.Fatalf("index kept stale content: %q", content)
	}
	if want := restoredInfo.ModTime().UnixMilli(); indexedMtime != want {
		t.Fatalf("indexed mtime = %d, want restored filesystem mtime %d", indexedMtime, want)
	}
	if changed, err := ix.Sync(v); err != nil || changed != 0 {
		t.Fatalf("second restored Sync = %d, %v; want no-op", changed, err)
	}
}

func TestSchemaUpgradeRecalibratesLegacyLogicalMtimeOnce(t *testing.T) {
	v, ix := newFixture(t)
	path := filepath.Join(v.Root(), "legacy-future.md")
	future := time.Now().Add(10 * 365 * 24 * time.Hour).UTC().Format(time.RFC3339)
	raw := "---\nid: legacy-future\ntitle: Legacy Future\ncreated: 2026-01-01T00:00:00Z\nupdated: " + future + "\n---\n# Legacy Future\n\nbody\n"
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	if changed, err := ix.Sync(v); err != nil || changed != 1 {
		t.Fatalf("seed Sync = %d, %v", changed, err)
	}
	if _, err := ix.db.Exec(`UPDATE notes SET mtime = ?, updated = ?`, time.Now().Add(365*24*time.Hour).UnixMilli(), time.Now().Add(365*24*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.db.Exec(`PRAGMA user_version = 4`); err != nil {
		t.Fatal(err)
	}
	if err := ix.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(ix.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	if changed, err := upgraded.Sync(v); err != nil || changed != 1 {
		t.Fatalf("upgrade calibration = %d, %v; want one real reread", changed, err)
	}
	if changed, err := upgraded.Sync(v); err != nil || changed != 0 {
		t.Fatalf("second calibration = %d, %v; want no-op", changed, err)
	}
}

func findByTitle(t *testing.T, ix *Index, title string) store.Meta {
	t.Helper()
	metas, err := ix.List(Query{Scope: "all"})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range metas {
		if m.Title == title {
			return m
		}
	}
	t.Fatalf("no note titled %q", title)
	return store.Meta{}
}

func TestSyncRemovesDeletedFiles(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	target := findByTitle(t, ix, "读书笔记")
	if _, err := v.Trash(target.Path); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	if n, _ := ix.Count(); n != 2 {
		t.Errorf("Count = %d, want 2 after trashing one note", n)
	}
}

func TestSyncRepairsDuplicatedFrontMatterIDs(t *testing.T) {
	v, ix := newFixture(t)
	original, err := v.Create("", "原始笔记", "# 原始笔记\n\n内容。\n")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(original.Path)
	if err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(v.Root(), "原始笔记 - 冲突副本.md")
	if err := os.WriteFile(copyPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	for pass := 1; pass <= 3; pass++ {
		if _, err := ix.Sync(v); err != nil {
			t.Fatalf("Sync pass %d: %v", pass, err)
		}
		notes, err := ix.List(Query{Scope: "all"})
		if err != nil {
			t.Fatal(err)
		}
		if len(notes) != 2 {
			t.Fatalf("Sync pass %d indexed %d notes, want 2", pass, len(notes))
		}
		if notes[0].ID == notes[1].ID {
			t.Fatalf("Sync pass %d kept duplicate id %q", pass, notes[0].ID)
		}
	}

	first, err := v.Read(original.Path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := v.Read(copyPath)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatalf("repaired ids were not persisted: %q", first.ID)
	}
}

func TestListFilters(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	cases := []struct {
		name string
		q    Query
		want int
	}{
		{"all", Query{Scope: "all"}, 3},
		{"favorites", Query{Scope: "favorites"}, 1},
		{"folder 工作", Query{Scope: "folder", Value: "工作"}, 1},
		{"folder 学习", Query{Scope: "folder", Value: "学习"}, 1},
		{"tag 灵感", Query{Scope: "tag", Value: "灵感"}, 1},
		{"tag 学习", Query{Scope: "tag", Value: "学习"}, 1},
		{"untagged", Query{Scope: "untagged"}, 1},
		{"missing tag", Query{Scope: "tag", Value: "不存在"}, 0},
	}
	for _, tc := range cases {
		got, err := ix.List(tc.q)
		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if len(got) != tc.want {
			t.Errorf("%s: got %d notes, want %d", tc.name, len(got), tc.want)
		}
	}
}

// A tag named "学" must not match a note tagged "学习"; the delimiter-based
// LIKE patterns are easy to get wrong.
func TestTagFilterMatchesWholeTagsOnly(t *testing.T) {
	v, ix := newFixture(t)
	n, _ := v.Create("", "标签测试", "# 标签测试\n")
	if _, err := v.SetTags(n.Path, []string{"学习", "工作计划"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}

	for _, partial := range []string{"学", "习", "工作", "计划"} {
		got, _ := ix.List(Query{Scope: "tag", Value: partial})
		if len(got) != 0 {
			t.Errorf("tag %q matched %d notes, want 0 (partial tags must not match)", partial, len(got))
		}
	}
	for _, exact := range []string{"学习", "工作计划"} {
		got, _ := ix.List(Query{Scope: "tag", Value: exact})
		if len(got) != 1 {
			t.Errorf("tag %q matched %d notes, want 1", exact, len(got))
		}
	}
}

func TestListSorting(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	byTitle, err := ix.List(Query{Scope: "all", SortBy: "title"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(byTitle); i++ {
		if strings.Compare(byTitle[i-1].Title, byTitle[i].Title) > 0 {
			t.Errorf("titles are out of order: %q before %q", byTitle[i-1].Title, byTitle[i].Title)
		}
	}

	byUpdated, err := ix.List(Query{Scope: "all", SortBy: "updated"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(byUpdated); i++ {
		if byUpdated[i-1].Updated.Before(byUpdated[i].Updated) {
			t.Error("updated sort should be newest first")
		}
	}
}

// The trigram tokenizer cannot answer queries shorter than three characters,
// which covers most everyday Chinese words. Those have to reach the LIKE path.
func TestSearchShortChineseQueries(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	for _, q := range []string{"笔记", "工作", "复盘", "公式"} {
		hits, err := ix.Search(q, 20)
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if len(hits) == 0 {
			t.Errorf("Search(%q) found nothing; the short-query fallback is broken", q)
		}
	}
}

func TestSearchLongerQueriesAndHighlighting(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	hits, err := ix.Search("性能优化", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("got %d hits, want 1", len(hits))
	}
	if hits[0].Title != "季度复盘" {
		t.Errorf("title = %q, want 季度复盘", hits[0].Title)
	}
	if !strings.Contains(hits[0].Snippet, "<mark>性能优化</mark>") {
		t.Errorf("snippet is missing the highlight: %q", hits[0].Snippet)
	}
}

func TestSearchIsCaseInsensitive(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	for _, q := range []string{"markdown", "MARKDOWN", "MarkDown"} {
		hits, err := ix.Search(q, 20)
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if len(hits) == 0 {
			t.Errorf("Search(%q) found nothing", q)
		}
	}
}

func TestSearchTitleIsHighlighted(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	hits, _ := ix.Search("公式", 20)
	if len(hits) == 0 {
		t.Fatal("expected a hit")
	}
	found := false
	for _, h := range hits {
		if strings.Contains(h.TitleHTML, "<mark>公式</mark>") {
			found = true
		}
	}
	if !found {
		t.Errorf("no title highlight among %d hits", len(hits))
	}
}

// A query containing FTS5 operators must not blow up the search box.
func TestSearchHandlesQuerySyntaxSafely(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	for _, q := range []string{`"`, `AND OR NOT`, `foo*`, `a"b"c`, `(unbalanced`, `^caret`, `50%`, `under_score`} {
		if _, err := ix.Search(q, 10); err != nil {
			t.Errorf("Search(%q) returned an error: %v", q, err)
		}
	}
}

func TestSearchEscapesHTMLInResults(t *testing.T) {
	v, ix := newFixture(t)
	n, _ := v.Create("", "脚本测试", "# 脚本测试\n\n危险内容 <script>alert(1)</script> 结束。\n")
	_ = n
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}

	hits, err := ix.Search("危险内容", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("expected a hit")
	}
	if strings.Contains(hits[0].Snippet, "<script>") {
		t.Errorf("snippet must escape HTML: %q", hits[0].Snippet)
	}
}

func TestSuggestPrefersShorterTitles(t *testing.T) {
	v, ix := newFixture(t)
	for _, title := range []string{"笔记", "我的笔记归档整理", "笔记本"} {
		if _, err := v.Create("", title, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}

	got, err := ix.Suggest("笔记", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d suggestions, want 3", len(got))
	}
	if got[0].Title != "笔记" {
		t.Errorf("first suggestion = %q, want the shortest match 笔记", got[0].Title)
	}
}

func TestSuggestEmptyQueryReturnsRecent(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	got, err := ix.Suggest("", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Errorf("got %d, want all 3 recent notes", len(got))
	}
}

func TestResetRebuildsCleanly(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	if err := ix.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	if n, _ := ix.Count(); n != 0 {
		t.Errorf("Count = %d after reset, want 0", n)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	if n, _ := ix.Count(); n != 3 {
		t.Errorf("Count = %d after re-sync, want 3", n)
	}
	// Search must still work against the rebuilt FTS table.
	if hits, _ := ix.Search("性能优化", 10); len(hits) != 1 {
		t.Errorf("search after rebuild returned %d hits, want 1", len(hits))
	}
}

func TestTagsAggregation(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	tags, err := ix.Tags()
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, tg := range tags {
		counts[tg.Name] = tg.Count
	}
	if counts["工作"] != 1 || counts["学习"] != 1 || counts["灵感"] != 1 {
		t.Errorf("tag counts = %v", counts)
	}
	for i := 1; i < len(tags); i++ {
		if tags[i-1].Count < tags[i].Count {
			t.Error("tags should be ordered by descending count")
		}
	}
}

func TestPathByID(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	metas, _ := ix.List(Query{Scope: "all"})
	got, err := ix.PathByID(metas[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if got != metas[0].Path {
		t.Errorf("PathByID = %q, want %q", got, metas[0].Path)
	}
}

func TestRenamedFileDoesNotDuplicateIndexRow(t *testing.T) {
	v, ix := newFixture(t)
	n, _ := v.Create("", "原标题", "# 原标题\n\n内容\n")
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}

	renamed, err := v.Rename(n.Path, "改过的标题")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Path == n.Path {
		t.Fatal("expected the file to be renamed")
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	if count, _ := ix.Count(); count != 1 {
		t.Errorf("Count = %d after rename, want 1 (the stale row must go)", count)
	}
}

// Case folding is not length-preserving, so offsets taken from a lowercased
// copy cannot index the original. Getting this wrong emitted broken UTF-8 into
// the result list, and for some code points panicked outright.
func TestHighlightIsSafeAcrossCaseFolding(t *testing.T) {
	cases := []struct{ text, query string }{
		{"note aaaaKbbbb\u212Acccc", "\u212A"},  // Kelvin sign folds shorter
		{"note \u023Abbbb\u023Acccc", "\u023A"}, // folds longer
		{"Straße und STRASSE", "ß"},             // sharp s
		{"İstanbul ve istanbul", "i"},           // dotted capital I
		{"中文标题 中文正文", "中文"},                     // the ordinary path
		{"MiXeD Case Text", "case"},             // ASCII, case-insensitive
	}
	for _, c := range cases {
		got := highlight(c.text, c.query, 200, 20)
		if !utf8.ValidString(got) {
			t.Errorf("highlight(%q, %q) produced invalid UTF-8: %q", c.text, c.query, got)
		}
		if strings.Contains(got, "<mark></mark>") {
			t.Errorf("highlight(%q, %q) marked nothing: %q", c.text, c.query, got)
		}
	}

	// The marked run has to be the text that matched, not a byte window of it.
	got := markAll("找到 ABC 了", "abc")
	if !strings.Contains(got, "<mark>ABC</mark>") {
		t.Errorf("markAll = %q, want the original casing inside the mark", got)
	}
}

func TestSearchSnippetsStayIntact(t *testing.T) {
	v, ix := newFixture(t)
	if _, err := v.Create("", "长笔记", "# 长笔记\n\n"+strings.Repeat("很长的正文内容。", 2000)+"\n关键词在这里\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	hits, err := ix.Search("长笔记", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("got %d hits, want 1", len(hits))
	}
	if !utf8.ValidString(hits[0].Snippet) || !utf8.ValidString(hits[0].TitleHTML) {
		t.Error("snippet or title is not valid UTF-8")
	}
	if len([]rune(hits[0].Snippet)) > 200 {
		t.Errorf("snippet is %d runes, want a short window", len([]rune(hits[0].Snippet)))
	}
}

// A tag holding a LIKE wildcard must match only itself.
func TestTagScopeEscapesWildcards(t *testing.T) {
	v, ix := newFixture(t)
	a, _ := v.Create("", "下划线标签", "# 下划线标签\n")
	b, _ := v.Create("", "相似标签", "# 相似标签\n")
	if _, err := v.SetTags(a.Path, []string{"a_b"}); err != nil {
		t.Fatal(err)
	}
	if _, err := v.SetTags(b.Path, []string{"axb"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}

	got, err := ix.List(Query{Scope: "tag", Value: "a_b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Title != "下划线标签" {
		t.Errorf("tag a_b matched %d notes, want only its own", len(got))
	}

	// An empty tag is not a filter for untagged notes.
	if empty, _ := ix.List(Query{Scope: "tag", Value: ""}); len(empty) != 0 {
		t.Errorf("an empty tag scope returned %d notes, want none", len(empty))
	}
}

func TestSummaryMatchesRows(t *testing.T) {
	v, ix := newFixture(t)
	seedFixture(t, v, ix)

	sum, err := ix.Summary()
	if err != nil {
		t.Fatal(err)
	}
	metas, _ := ix.List(Query{Scope: "all"})
	words, bytes := 0, int64(0)
	for _, m := range metas {
		words += m.Words
		bytes += m.Size
	}
	if sum.Notes != len(metas) || sum.Words != words || sum.Bytes != bytes {
		t.Errorf("Summary = %+v, want notes=%d words=%d bytes=%d", sum, len(metas), words, bytes)
	}
}

func TestRemoveUnderDropsOnlyThatSubtree(t *testing.T) {
	v, ix := newFixture(t)
	if _, err := v.Create("工作", "顶层", "# 顶层\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("工作/2026", "子级", "# 子级\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("学习", "别动我", "# 别动我\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}

	if err := ix.RemoveUnder("工作"); err != nil {
		t.Fatal(err)
	}
	left, _ := ix.List(Query{Scope: "all"})
	if len(left) != 1 || left[0].Title != "别动我" {
		t.Errorf("RemoveUnder left %v, want only the note outside the folder", left)
	}
}

func TestNormaliseQuery(t *testing.T) {
	cases := map[string]string{
		"  数学  公式  ": "数学 公式",
		"single":     "single",
		"   ":        "",
	}
	for in, want := range cases {
		if got := NormaliseQuery(in); got != want {
			t.Errorf("NormaliseQuery(%q) = %q, want %q", in, got, want)
		}
	}
}
