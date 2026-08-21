package index

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"qiaoji/internal/store"
)

// buildScaleIndex writes files directly because the benchmark is measuring
// the index, not 20,000 fsync-heavy user creates. All data remains in TempDir.
func buildScaleIndex(t *testing.T, count int) (*store.Vault, *Index) {
	t.Helper()
	root := t.TempDir()
	for i := 0; i < count; i++ {
		folder := filepath.Join(root, fmt.Sprintf("分组-%02d", i%40))
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		text := fmt.Sprintf("# 性能优化笔记 %05d\n\n这是第 %d 篇中英文 mixed note，包含短词笔记与 full text search。\n", i, i)
		if err := os.WriteFile(filepath.Join(folder, fmt.Sprintf("note-%05d.md", i)), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	v, err := store.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	ix, err := Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ix.Close() })
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	return v, ix
}

func TestTwentyThousandQueryPerformance(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping 20k scale acceptance in short mode")
	}
	const count = 20_000
	_, ix := buildScaleIndex(t, count)

	measure := func(name string, limit time.Duration, run func() error) {
		t.Helper()
		start := time.Now()
		if err := run(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		elapsed := time.Since(start)
		t.Logf("%s=%v", name, elapsed.Round(time.Millisecond))
		if elapsed > limit {
			t.Errorf("%s took %v, target <= %v", name, elapsed, limit)
		}
	}

	measure("first-page", 100*time.Millisecond, func() error {
		page, err := ix.ListPage(PageRequest{Scope: "all", SortBy: "updated", Limit: 200})
		if err == nil && (len(page.Items) != 200 || page.Total != count || page.NextCursor == "") {
			return fmt.Errorf("page = %d/%d cursor=%t", len(page.Items), page.Total, page.NextCursor != "")
		}
		return err
	})
	measure("fts", 100*time.Millisecond, func() error {
		_, err := ix.Search("性能优化", 60)
		return err
	})
	measure("short-like", 200*time.Millisecond, func() error {
		_, err := ix.Search("笔记", 60)
		return err
	})
}
