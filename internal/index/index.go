// Package index keeps a disposable SQLite mirror of the vault so listing,
// filtering and full-text search never have to touch the filesystem.
package index

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"qiaoji/internal/store"
)

const schema = `
CREATE TABLE IF NOT EXISTS notes(
  rowid    INTEGER PRIMARY KEY,
  id       TEXT NOT NULL,
  path     TEXT NOT NULL UNIQUE,
  title    TEXT NOT NULL DEFAULT '',
  folder   TEXT NOT NULL DEFAULT '',
  tags     TEXT NOT NULL DEFAULT '',
  created  INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  excerpt  TEXT NOT NULL DEFAULT '',
  words    INTEGER NOT NULL DEFAULT 0,
  size     INTEGER NOT NULL DEFAULT 0,
  mtime    INTEGER NOT NULL DEFAULT 0,
  content  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notes_updated_idx  ON notes(updated DESC);
CREATE INDEX IF NOT EXISTS notes_folder_idx   ON notes(folder);
CREATE UNIQUE INDEX IF NOT EXISTS notes_id_idx ON notes(id);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, content,
  content='notes', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`

// minTrigram is the shortest query the trigram tokenizer can answer. Anything
// shorter (which in Chinese means most two-character words) falls back to a
// LIKE scan.
const minTrigram = 3

type Index struct {
	mu sync.Mutex
	db *sql.DB
}

func Open(path string) (*Index, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer keeps WAL contention and memory down
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Index{db: db}, nil
}

func (ix *Index) Close() error {
	if ix == nil || ix.db == nil {
		return nil
	}
	return ix.db.Close()
}

// Reset drops everything. Used when the vault changes or the index is corrupt.
func (ix *Index) Reset() error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	_, err := ix.db.Exec(`
		DROP TRIGGER IF EXISTS notes_ai;
		DROP TRIGGER IF EXISTS notes_ad;
		DROP TRIGGER IF EXISTS notes_au;
		DROP TABLE IF EXISTS notes_fts;
		DROP TABLE IF EXISTS notes;
	` + schema)
	return err
}

// ---------------------------------------------------------------- syncing

// Sync brings the index in line with what is on disk. It stats every note
// first and only re-reads the ones whose size or mtime moved.
func (ix *Index) Sync(v *store.Vault) (changed int, err error) {
	stats, err := v.StatWalk()
	if err != nil {
		return 0, err
	}

	ix.mu.Lock()
	known := map[string]struct {
		size  int64
		mtime int64
	}{}
	rows, err := ix.db.Query(`SELECT path, size, mtime FROM notes`)
	if err != nil {
		ix.mu.Unlock()
		return 0, err
	}
	for rows.Next() {
		var p string
		var size, mtime int64
		if err := rows.Scan(&p, &size, &mtime); err != nil {
			continue
		}
		known[p] = struct {
			size  int64
			mtime int64
		}{size, mtime}
	}
	rows.Close()
	ix.mu.Unlock()

	seen := make(map[string]bool, len(stats))
	var stale []string
	for _, s := range stats {
		seen[s.Path] = true
		k, ok := known[s.Path]
		if ok && k.size == s.Size && k.mtime == s.ModTime.UnixMilli() {
			continue
		}
		stale = append(stale, s.Path)
	}

	var gone []string
	for p := range known {
		if !seen[p] {
			gone = append(gone, p)
		}
	}

	if len(stale) == 0 && len(gone) == 0 {
		return 0, nil
	}

	// Notes are read and committed in batches. Loading a whole vault into one
	// slice made peak memory equal to the total size of every changed note,
	// which is exactly the first-run and bulk-import case.
	for start := 0; start < len(stale); start += syncBatch {
		end := start + syncBatch
		if end > len(stale) {
			end = len(stale)
		}
		notes := make([]store.Note, 0, end-start)
		for _, p := range stale[start:end] {
			n, err := v.Read(p)
			if err != nil {
				continue
			}
			notes = append(notes, n)
		}
		if err := ix.upsert(notes, true); err != nil {
			return changed, err
		}
		changed += len(notes)
	}
	if err := ix.removePaths(gone); err != nil {
		return changed, err
	}
	return changed + len(gone), nil
}

// syncBatch bounds how many note bodies are held in memory at once.
const syncBatch = 200

// upsert writes notes into the index.
//
// onlyIfNewer guards the sync path. Syncing reads a file from disk and writes
// it back a moment later; a save that lands in that window would otherwise be
// overwritten by the copy the walk had already read, leaving the index showing
// text the note no longer has.
func (ix *Index) upsert(notes []store.Note, onlyIfNewer bool) error {
	if len(notes) == 0 {
		return nil
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()

	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	sqlText := `
		INSERT INTO notes(id, path, title, folder, tags, created, updated, favorite, excerpt, words, size, mtime, content)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET
		  id=excluded.id, title=excluded.title, folder=excluded.folder, tags=excluded.tags,
		  created=excluded.created, updated=excluded.updated, favorite=excluded.favorite,
		  excerpt=excluded.excerpt, words=excluded.words, size=excluded.size,
		  mtime=excluded.mtime, content=excluded.content`
	if onlyIfNewer {
		sqlText += ` WHERE excluded.mtime >= notes.mtime`
	}

	stmt, err := tx.Prepare(sqlText)
	if err != nil {
		return err
	}
	defer stmt.Close()

	// A duplicated id (copied file) would break the unique index, so the path
	// always wins and the clash gets a fresh surrogate.
	dedupe, err := tx.Prepare(`DELETE FROM notes WHERE id = ? AND path <> ?`)
	if err != nil {
		return err
	}
	defer dedupe.Close()

	for _, n := range notes {
		if _, err := dedupe.Exec(n.ID, n.Path); err != nil {
			return err
		}
		fav := 0
		if n.Favorite {
			fav = 1
		}
		if _, err := stmt.Exec(
			n.ID, n.Path, n.Title, n.Folder, strings.Join(n.Tags, "\x1f"),
			n.Created.UnixMilli(), n.Updated.UnixMilli(), fav,
			n.Excerpt, n.Words, n.Size, n.Updated.UnixMilli(), n.Content,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Upsert indexes a single note right after it was saved. The caller has the
// authoritative copy, so this always wins.
func (ix *Index) Upsert(n store.Note) error { return ix.upsert([]store.Note{n}, false) }

func (ix *Index) removePaths(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range paths {
		if _, err := tx.Exec(`DELETE FROM notes WHERE path = ?`, p); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (ix *Index) Remove(path string) error { return ix.removePaths([]string{path}) }

// RemoveUnder drops every note in a folder and its subfolders.
//
// Folder deletes and renames used to throw the whole index away and re-read
// the vault from disk; scoping the change to the affected subtree keeps the
// cost proportional to what actually moved.
func (ix *Index) RemoveUnder(folder string) error {
	folder = strings.Trim(strings.TrimSpace(folder), "/")
	if folder == "" {
		return nil
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	_, err := ix.db.Exec(
		`DELETE FROM notes WHERE folder = ? OR folder LIKE ? ESCAPE '\'`,
		folder, escapeLike(folder)+`/%`)
	return err
}

// ---------------------------------------------------------------- queries

// Query describes one list request from the sidebar.
type Query struct {
	Scope  string `json:"scope"`  // all | recent | favorites | folder | tag | untagged
	Value  string `json:"value"`  // folder path or tag name
	SortBy string `json:"sortBy"` // updated | created | title
	Limit  int    `json:"limit"`
}

func (ix *Index) List(q Query) ([]store.Meta, error) {
	where := []string{"1=1"}
	args := []any{}

	switch q.Scope {
	case "favorites":
		where = append(where, "favorite = 1")
	case "folder":
		if q.Value != "" {
			where = append(where, `(folder = ? OR folder LIKE ? ESCAPE '\')`)
			args = append(args, q.Value, escapeLike(q.Value)+"/%")
		}
	case "tag":
		// An empty tag is not a filter for untagged notes; without this guard
		// the equality below quietly matches every note that has no tags.
		if q.Value == "" {
			return []store.Meta{}, nil
		}
		// Tags are stored as a unit-separated list, so membership is three
		// LIKE patterns. Wildcards inside the tag itself have to be escaped or
		// a tag named "a_b" also matches "axb".
		esc := escapeLike(q.Value)
		where = append(where, `(tags = ? OR tags LIKE ? ESCAPE '\' OR tags LIKE ? ESCAPE '\' OR tags LIKE ? ESCAPE '\')`)
		args = append(args, q.Value, esc+"\x1f%", "%\x1f"+esc, "%\x1f"+esc+"\x1f%")
	case "untagged":
		where = append(where, "tags = ''")
	}

	order := "updated DESC"
	switch q.SortBy {
	case "created":
		order = "created DESC"
	case "title":
		order = "title COLLATE NOCASE ASC"
	}
	if q.Scope == "recent" {
		order = "updated DESC"
	}

	limit := q.Limit
	if limit <= 0 {
		limit = 5000
	}
	if q.Scope == "recent" && (q.Limit <= 0 || q.Limit > 50) {
		limit = 50
	}

	sqlText := `SELECT id, path, title, folder, tags, created, updated, favorite, excerpt, words, size
		FROM notes WHERE ` + strings.Join(where, " AND ") +
		` ORDER BY ` + order + ` LIMIT ?`
	args = append(args, limit)

	ix.mu.Lock()
	rows, err := ix.db.Query(sqlText, args...)
	ix.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMetas(rows)
}

func scanMetas(rows *sql.Rows) ([]store.Meta, error) {
	out := []store.Meta{}
	for rows.Next() {
		var (
			m                store.Meta
			tags             string
			created, updated int64
			fav              int
		)
		if err := rows.Scan(&m.ID, &m.Path, &m.Title, &m.Folder, &tags,
			&created, &updated, &fav, &m.Excerpt, &m.Words, &m.Size); err != nil {
			return nil, err
		}
		m.Tags = splitTags(tags)
		m.Created = time.UnixMilli(created)
		m.Updated = time.UnixMilli(updated)
		m.Favorite = fav == 1
		out = append(out, m)
	}
	return out, rows.Err()
}

func splitTags(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, "\x1f")
}

func (ix *Index) Count() (int, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	var n int
	err := ix.db.QueryRow(`SELECT COUNT(*) FROM notes`).Scan(&n)
	return n, err
}

// Summary totals the library.
//
// The sidebar asks for this after every save, so the numbers are aggregated in
// SQL. Listing a hundred thousand rows into Go structs just to add up two
// columns was the single most expensive thing on the write path.
type Summary struct {
	Notes int   `json:"notes"`
	Words int   `json:"words"`
	Bytes int64 `json:"bytes"`
}

func (ix *Index) Summary() (Summary, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	var s Summary
	err := ix.db.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(words), 0), COALESCE(SUM(size), 0) FROM notes`,
	).Scan(&s.Notes, &s.Words, &s.Bytes)
	return s, err
}

func (ix *Index) Tags() ([]store.Tag, error) {
	ix.mu.Lock()
	rows, err := ix.db.Query(`SELECT tags FROM notes WHERE tags <> ''`)
	ix.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			continue
		}
		for _, name := range splitTags(t) {
			counts[name]++
		}
	}
	out := make([]store.Tag, 0, len(counts))
	for name, c := range counts {
		out = append(out, store.Tag{Name: name, Count: c})
	}
	sortTags(out)
	return out, nil
}

// sortTags orders by popularity, then by name so the sidebar stays stable.
func sortTags(t []store.Tag) {
	sort.Slice(t, func(i, j int) bool {
		if t[i].Count != t[j].Count {
			return t[i].Count > t[j].Count
		}
		return t[i].Name < t[j].Name
	})
}

// PathByID resolves a stable note id to its current file path.
func (ix *Index) PathByID(id string) (string, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	var p string
	err := ix.db.QueryRow(`SELECT path FROM notes WHERE id = ?`, id).Scan(&p)
	return p, err
}
