package main

import (
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"qiaoji/internal/index"
	"qiaoji/internal/store"
	"qiaoji/internal/watch"
)

type IndexState struct {
	Phase       string `json:"phase"` // idle | building | calibrating | error
	Ready       bool   `json:"ready"`
	Cached      bool   `json:"cached"`
	Processed   int    `json:"processed"`
	Total       int    `json:"total"`
	Error       string `json:"error,omitempty"`
	LastSyncMs  int64  `json:"lastSyncMs"`
	LastChanged int    `json:"lastChanged"`
}

type NotePageRequest struct {
	Scope  string `json:"scope"`
	Value  string `json:"value"`
	SortBy string `json:"sortBy"`
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

type NotePage struct {
	Items      []store.Meta `json:"items"`
	Total      int          `json:"total"`
	NextCursor string       `json:"nextCursor,omitempty"`
}

type VaultDelta struct {
	Upserted    []store.Meta `json:"upserted,omitempty"`
	Previous    []store.Meta `json:"previous,omitempty"`
	Removed     []string     `json:"removed,omitempty"`
	RemovedMeta []store.Meta `json:"removedMeta,omitempty"`
	Full        bool         `json:"full,omitempty"`
	Structure   bool         `json:"structure,omitempty"`
	External    bool         `json:"external"`
	SyncMs      int64        `json:"syncMs"`
}

type syncRequest struct {
	changes  watch.ChangeSet
	full     bool
	reset    bool
	external bool
	done     chan syncResult
}

type syncResult struct {
	delta index.Delta
	err   error
}

type selfWriteMark struct {
	expires   time.Time
	directory bool
}

func (s *vaultSession) startSync(app *App) {
	if s.syncCh != nil {
		return
	}
	s.syncCh = make(chan syncRequest, 64)
	s.syncStop = make(chan struct{})
	s.syncDone = make(chan struct{})
	go s.syncLoop(app)
}

func (s *vaultSession) stopSync() {
	if s.syncStop == nil {
		return
	}
	select {
	case <-s.syncStop:
	default:
		close(s.syncStop)
	}
	<-s.syncDone
	s.syncStop = nil
	s.syncDone = nil
	s.syncCh = nil
}

func (s *vaultSession) enqueue(request syncRequest) bool {
	if s.syncCh == nil || s.syncStop == nil {
		return false
	}
	if request.done != nil {
		select {
		case s.syncCh <- request:
			return true
		case <-s.syncStop:
			return false
		}
	}
	select {
	case s.syncCh <- request:
		return true
	default:
		// Losing exact paths is never silently ignored. Escalate to the one
		// allowed fallback: a full reconciliation after the current job.
		fallback := syncRequest{full: true, external: request.external}
		select {
		case s.syncCh <- fallback:
		default:
		}
		return false
	}
}

func (s *vaultSession) syncLoop(app *App) {
	defer close(s.syncDone)
	for {
		select {
		case <-s.syncStop:
			return
		case request := <-s.syncCh:
			requests := []syncRequest{request}
			for {
				select {
				case next := <-s.syncCh:
					request.changes.Merge(next.changes)
					request.full = request.full || next.full
					request.reset = request.reset || next.reset
					request.external = request.external || next.external
					requests = append(requests, next)
				default:
					goto drained
				}
			}
		drained:
			result := s.runSync(app, request)
			for _, queued := range requests {
				if queued.done != nil {
					queued.done <- result
					close(queued.done)
				}
			}
		}
	}
}

func (s *vaultSession) runSync(app *App, request syncRequest) syncResult {
	started := time.Now()
	before := indexStructureSignature(s.index)
	current := s.indexState()
	phase := "calibrating"
	if !current.Ready || request.reset {
		phase = "building"
	}
	app.setIndexState(s, IndexState{
		Phase: phase, Ready: current.Ready && !request.reset, Cached: current.Cached && !request.reset,
	})

	var delta index.Delta
	var err error
	if request.reset {
		err = s.index.Reset()
	}
	if err == nil && (request.full || request.reset) {
		var changed int
		changed, err = s.index.SyncWithProgress(s.vault, func(done, total int) {
			state := s.indexState()
			state.Phase = phase
			state.Processed = done
			state.Total = total
			app.setIndexState(s, state)
		})
		delta = index.Delta{Full: true, Count: changed}
		if changed == 0 && !request.reset {
			delta.Full = false
		}
	} else if err == nil {
		delta, err = s.index.SyncChanges(s.vault, request.changes)
	}

	elapsed := time.Since(started).Milliseconds()
	app.lastSyncMs.Store(elapsed)
	app.lastSyncChange.Store(int64(delta.Changed()))
	if err != nil {
		state := s.indexState()
		state.Phase = "error"
		state.Error = err.Error()
		state.LastSyncMs = elapsed
		app.setIndexState(s, state)
		return syncResult{delta: delta, err: err}
	}
	after := indexStructureSignature(s.index)
	state := IndexState{
		Phase: "idle", Ready: true, Cached: true,
		LastSyncMs: elapsed, LastChanged: delta.Changed(),
	}
	app.setIndexState(s, state)
	if delta.Changed() > 0 || delta.Full {
		app.emitVaultDelta(s, VaultDelta{
			Upserted: delta.Upserted, Previous: delta.Previous, Removed: delta.Removed, RemovedMeta: delta.RemovedMeta, Full: delta.Full,
			Structure: before != after, External: request.external, SyncMs: elapsed,
		})
	}
	return syncResult{delta: delta}
}

func (s *vaultSession) indexState() IndexState {
	s.stateMu.RLock()
	defer s.stateMu.RUnlock()
	return s.state
}

func (s *vaultSession) setIndexState(state IndexState) {
	s.stateMu.Lock()
	s.state = state
	s.stateMu.Unlock()
}

func (a *App) setIndexState(s *vaultSession, state IndexState) {
	s.setIndexState(state)
	if a.session() == s {
		a.emit("vault:sync-state", state)
	}
}

func (a *App) emitVaultDelta(s *vaultSession, delta VaultDelta) {
	if a.session() == s {
		a.emit("vault:delta", delta)
	}
}

func indexStructureSignature(ix *index.Index) string {
	folders, _ := ix.Folders()
	tags, _ := ix.Tags()
	summary, _ := ix.Summary()
	var b strings.Builder
	b.WriteString(strings.Join([]string{
		"n", itoa(summary.Notes), "w", itoa(summary.Words), "b", itoa64(summary.Bytes),
	}, ":"))
	for _, folder := range folders {
		b.WriteString("|f:")
		b.WriteString(folder.Path)
		b.WriteString(":")
		b.WriteString(itoa(folder.Count))
	}
	for _, tag := range tags {
		b.WriteString("|t:")
		b.WriteString(tag.Name)
		b.WriteString(":")
		b.WriteString(itoa(tag.Count))
	}
	return b.String()
}

func itoa(value int) string     { return strconv.Itoa(value) }
func itoa64(value int64) string { return strconv.FormatInt(value, 10) }

func (a *App) markSelfPath(path string, directory bool) {
	if strings.TrimSpace(path) == "" {
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return
	}
	a.selfMu.Lock()
	a.selfWrites[filepath.Clean(abs)] = selfWriteMark{
		expires: time.Now().Add(2 * time.Second), directory: directory,
	}
	a.selfMu.Unlock()
}

func (a *App) isSelfPath(path string) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	abs = filepath.Clean(abs)
	now := time.Now()
	a.selfMu.Lock()
	defer a.selfMu.Unlock()
	owned := false
	for marked, entry := range a.selfWrites {
		if now.After(entry.expires) {
			delete(a.selfWrites, marked)
			continue
		}
		if strings.EqualFold(marked, abs) || (entry.directory && isWithin(marked, abs)) {
			owned = true
		}
	}
	return owned
}

func isWithin(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func filterPaths(paths []string, keep func(string) bool) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		if keep(path) {
			out = append(out, path)
		}
	}
	return out
}

func (a *App) onVaultChanges(s *vaultSession, changes watch.ChangeSet) {
	keep := func(path string) bool { return !a.isSelfPath(path) }
	changes.Created = filterPaths(changes.Created, keep)
	changes.Modified = filterPaths(changes.Modified, keep)
	changes.Removed = filterPaths(changes.Removed, keep)
	changes.Renamed = filterPaths(changes.Renamed, keep)
	changes.Dirs = filterPaths(changes.Dirs, keep)
	if changes.Empty() {
		return
	}
	s.enqueue(syncRequest{changes: changes, full: changes.Overflow || changes.Unknown, external: true})
}

func (a *App) IndexState() IndexState {
	s := a.session()
	if s == nil || !s.acquire() {
		return IndexState{Phase: "error", Error: "尚未打开笔记库"}
	}
	defer s.release()
	return s.indexState()
}

func (a *App) ListNotesPage(request NotePageRequest) (NotePage, error) {
	_, ix, done, err := a.need()
	if err != nil {
		return NotePage{}, err
	}
	defer done()
	page, err := ix.ListPage(index.PageRequest{
		Scope: request.Scope, Value: request.Value, SortBy: request.SortBy,
		Limit: request.Limit, Cursor: request.Cursor,
	})
	if err != nil {
		return NotePage{}, err
	}
	return NotePage{Items: page.Items, Total: page.Total, NextCursor: page.NextCursor}, nil
}

func waitSync(s *vaultSession, request syncRequest) (index.Delta, error) {
	request.done = make(chan syncResult, 1)
	if !s.enqueue(request) {
		return index.Delta{}, errors.New("同步队列已关闭")
	}
	select {
	case result := <-request.done:
		return result.delta, result.err
	case <-s.syncStop:
		return index.Delta{}, errors.New("同步队列已关闭")
	}
}
