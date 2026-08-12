package index

import (
	"fmt"
	"math/rand"
	"path/filepath"
	"testing"
	"time"

	"qiaoji/internal/store"
)

// buildLibrary writes a realistically sized vault: mixed Chinese and English
// prose, headings, code blocks and formulas, spread across folders and tags.
func buildLibrary(tb testing.TB, count int) (*store.Vault, *Index) {
	tb.Helper()

	dir := tb.TempDir()
	v, err := store.Open(dir)
	if err != nil {
		tb.Fatal(err)
	}
	ix, err := Open(filepath.Join(dir, "index.db"))
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { ix.Close() })

	folders := []string{"工作", "学习", "项目", "日常", ""}
	tags := []string{"工作", "学习", "灵感", "待办", "项目", "归档"}
	topics := []string{
		"性能优化", "接口联调", "读书笔记", "会议纪要", "灰度发布",
		"数据建模", "用户反馈", "架构评审", "周报计划", "技术调研",
	}
	rng := rand.New(rand.NewSource(7))

	for i := 0; i < count; i++ {
		topic := topics[i%len(topics)]
		title := fmt.Sprintf("%s %d", topic, i)
		body := fmt.Sprintf(
			"# %s\n\n这是第 %d 篇笔记，主题是%s。本季度的重点在于稳定性与响应速度。\n\n"+
				"## 背景\n\n- 需求来源：产品评审\n- 影响范围：核心链路\n- 风险：第三方接口抖动\n\n"+
				"## 细节\n\n关键公式 $E_%d = mc^2$，以及一段代码：\n\n"+
				"```go\nfunc handle(id int) error {\n\treturn process(id)\n}\n```\n\n"+
				"## 结论\n\n先做减法，再让核心动作变快。measurement %d done.\n",
			title, i, topic, i%9, i)

		n, err := v.Create(folders[i%len(folders)], title, body)
		if err != nil {
			tb.Fatal(err)
		}
		if i%3 == 0 {
			picked := []string{tags[rng.Intn(len(tags))], tags[rng.Intn(len(tags))]}
			if _, err := v.SetTags(n.Path, picked); err != nil {
				tb.Fatal(err)
			}
		}
	}
	return v, ix
}

// TestLibraryPerformance is the numbers behind the "stays fast with thousands
// of notes" claim. It reports timings rather than asserting hard limits, which
// would be flaky on shared CI hardware, but it does fail on the order of
// magnitude that would make the UI feel broken.
func TestLibraryPerformance(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping library performance run in short mode")
	}
	const count = 1200

	v, ix := buildLibrary(t, count)

	start := time.Now()
	changed, err := ix.Sync(v)
	if err != nil {
		t.Fatal(err)
	}
	coldSync := time.Since(start)
	if changed != count {
		t.Fatalf("indexed %d notes, want %d", changed, count)
	}

	start = time.Now()
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	warmSync := time.Since(start)

	start = time.Now()
	metas, err := ix.List(Query{Scope: "all", SortBy: "updated"})
	if err != nil {
		t.Fatal(err)
	}
	listTime := time.Since(start)
	if len(metas) != count {
		t.Fatalf("listed %d notes, want %d", len(metas), count)
	}

	// Three or more characters: answered by the FTS5 trigram index.
	start = time.Now()
	ftsHits, err := ix.Search("性能优化", 60)
	if err != nil {
		t.Fatal(err)
	}
	ftsTime := time.Since(start)

	// Two characters: falls back to a LIKE scan, the slowest supported path.
	start = time.Now()
	likeHits, err := ix.Search("笔记", 60)
	if err != nil {
		t.Fatal(err)
	}
	likeTime := time.Since(start)

	t.Logf("notes=%d  cold index=%v  warm index=%v  list=%v  fts=%v (%d hits)  like=%v (%d hits)",
		count, coldSync.Round(time.Millisecond), warmSync.Round(time.Millisecond),
		listTime.Round(time.Millisecond), ftsTime.Round(time.Millisecond), len(ftsHits),
		likeTime.Round(time.Millisecond), len(likeHits))

	if len(ftsHits) == 0 {
		t.Error("the full-text path returned nothing")
	}
	if len(likeHits) == 0 {
		t.Error("the short-query fallback returned nothing")
	}

	// A warm start must not re-read the library; that is what keeps launch fast.
	if warmSync > coldSync/4 {
		t.Errorf("warm index took %v against a cold %v; the mtime check is not working",
			warmSync, coldSync)
	}
	// Generous ceilings: anything slower than this is felt as lag in the UI.
	if listTime > 400*time.Millisecond {
		t.Errorf("listing %d notes took %v", count, listTime)
	}
	if ftsTime > 300*time.Millisecond {
		t.Errorf("full-text search took %v", ftsTime)
	}
	if likeTime > 900*time.Millisecond {
		t.Errorf("short-query search took %v", likeTime)
	}
}

func BenchmarkSearchFTS(b *testing.B) {
	v, ix := buildLibrary(b, 800)
	if _, err := ix.Sync(v); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ix.Search("性能优化", 60); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkSearchShortQuery(b *testing.B) {
	v, ix := buildLibrary(b, 800)
	if _, err := ix.Sync(v); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ix.Search("笔记", 60); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkListAll(b *testing.B) {
	v, ix := buildLibrary(b, 800)
	if _, err := ix.Sync(v); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ix.List(Query{Scope: "all", SortBy: "updated"}); err != nil {
			b.Fatal(err)
		}
	}
}
