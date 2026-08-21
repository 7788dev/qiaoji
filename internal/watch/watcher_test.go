package watch

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDebounceCoalescesABurst(t *testing.T) {
	dir := t.TempDir()
	var calls atomic.Int32

	w, err := New(dir, 40*time.Millisecond, func() { calls.Add(1) })
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer w.Close()

	// An editor saving one file emits several events; they must add up to one
	// callback, which is the whole point of the debounce.
	for i := 0; i < 8; i++ {
		if err := os.WriteFile(filepath.Join(dir, "note.md"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	if n := calls.Load(); n != 1 {
		t.Errorf("onChange fired %d times, want 1", n)
	}
}

// Close must not return while a callback is still running: the callback
// reindexes the vault, and the caller closes that index the moment this
// returns.
func TestCloseWaitsForRunningCallback(t *testing.T) {
	dir := t.TempDir()

	var (
		mu       sync.Mutex
		running  bool
		finished bool
	)
	started := make(chan struct{})
	release := make(chan struct{})

	w, err := New(dir, 20*time.Millisecond, func() {
		mu.Lock()
		running = true
		mu.Unlock()
		close(started)

		<-release

		mu.Lock()
		running, finished = false, true
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dir, "note.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	select {
	case <-started:
	case <-time.After(3 * time.Second):
		_ = w.Close()
		t.Fatal("the callback never ran")
	}

	closed := make(chan struct{})
	go func() {
		_ = w.Close()
		close(closed)
	}()

	select {
	case <-closed:
		t.Fatal("Close returned while the callback was still running")
	case <-time.After(120 * time.Millisecond):
	}

	close(release)

	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close never returned")
	}

	mu.Lock()
	defer mu.Unlock()
	if running || !finished {
		t.Errorf("callback state after Close: running=%v finished=%v", running, finished)
	}
}

func TestNoCallbacksAfterClose(t *testing.T) {
	dir := t.TempDir()
	var calls atomic.Int32

	w, err := New(dir, 30*time.Millisecond, func() { calls.Add(1) })
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dir, "note.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Closed inside the debounce window, so the pending callback is dropped.
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	if n := calls.Load(); n != 0 {
		t.Errorf("onChange fired %d times after Close, want 0", n)
	}
}

func TestIgnoresInternalAndTempFiles(t *testing.T) {
	dir := t.TempDir()
	w, err := New(dir, time.Second, func() {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer w.Close()

	cases := map[string]bool{
		filepath.Join(dir, "note.md"):                  false,
		filepath.Join(dir, "note.md.tmp"):              true,
		filepath.Join(dir, "~$note.md"):                true,
		filepath.Join(dir, ".qiaoji", "index.db"):      true,
		filepath.Join(dir, ".qiaoji", "trash", "a.md"): true,
	}
	for path, want := range cases {
		if got := w.ignore(path); got != want {
			t.Errorf("ignore(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestChangeSetMergesAndDeduplicatesPaths(t *testing.T) {
	var got ChangeSet
	got.Merge(ChangeSet{Created: []string{"b", "a"}, Modified: []string{"a"}})
	got.Merge(ChangeSet{Created: []string{"a"}, Removed: []string{"c"}, Overflow: true})
	if len(got.Created) != 2 || got.Created[0] != "a" || got.Created[1] != "b" {
		t.Fatalf("created = %v", got.Created)
	}
	if len(got.Paths()) != 3 || !got.Overflow {
		t.Fatalf("merged set = %+v, paths=%v", got, got.Paths())
	}
}
