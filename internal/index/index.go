// Package index keeps a disposable SQLite mirror of the vault so listing,
// filtering and full-text search never have to touch the filesystem.
package index

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
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
CREATE INDEX IF NOT EXISTS notes_created_idx  ON notes(created DESC);
CREATE INDEX IF NOT EXISTS notes_title_idx    ON notes(title COLLATE NOCASE ASC);
CREATE INDEX IF NOT EXISTS notes_folder_idx   ON notes(folder);
CREATE INDEX IF NOT EXISTS notes_favorite_updated_idx ON notes(favorite, updated DESC);
	CREATE UNIQUE INDEX IF NOT EXISTS notes_id_idx ON notes(id);
CREATE TABLE IF NOT EXISTS note_tags(
	  note_rowid INTEGER NOT NULL REFERENCES notes(rowid) ON DELETE CASCADE,
	  tag TEXT NOT NULL,
	  PRIMARY KEY(note_rowid, tag)
	);
CREATE INDEX IF NOT EXISTS note_tags_tag_idx ON note_tags(tag, note_rowid);
CREATE TABLE IF NOT EXISTS folder_cache(
	  path TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS folder_counts(
	  path TEXT PRIMARY KEY,
	  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS index_stats(
	  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
	  notes INTEGER NOT NULL DEFAULT 0,
	  words INTEGER NOT NULL DEFAULT 0,
	  bytes INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO index_stats(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS index_meta(
	  key TEXT PRIMARY KEY,
	  value TEXT NOT NULL
);
INSERT OR IGNORE INTO index_meta(key, value) VALUES('calibrated', '0');

CREATE TRIGGER IF NOT EXISTS notes_stats_ai AFTER INSERT ON notes BEGIN
	UPDATE index_stats SET notes = notes + 1, words = words + new.words, bytes = bytes + new.size WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS notes_stats_ad AFTER DELETE ON notes BEGIN
	UPDATE index_stats SET notes = MAX(0, notes - 1), words = MAX(0, words - old.words), bytes = MAX(0, bytes - old.size) WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS notes_stats_au AFTER UPDATE ON notes BEGIN
	UPDATE index_stats SET words = MAX(0, words + new.words - old.words), bytes = MAX(0, bytes + new.size - old.size) WHERE singleton = 1;
END;

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
	mu   sync.Mutex
	db   *sql.DB
	path string
}

func Open(path string) (*Index, error) {
	_, statErr := os.Stat(path)
	existed := statErr == nil
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer keeps WAL contention and memory down
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	ix := &Index{db: db, path: path}
	if err := ix.migrateRelations(existed); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate schema: %w", err)
	}
	return ix, nil
}

func (ix *Index) Path() string {
	if ix == nil {
		return ""
	}
	return ix.path
}

const schemaVersion = 5

func (ix *Index) migrateRelations(existed bool) error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	var version int
	if err := ix.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version >= schemaVersion {
		return nil
	}
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM note_tags`); err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT rowid, tags FROM notes WHERE tags <> ''`)
	if err != nil {
		return err
	}
	type relation struct {
		rowID int64
		tags  []string
	}
	var relations []relation
	for rows.Next() {
		var rowID int64
		var tags string
		if err := rows.Scan(&rowID, &tags); err != nil {
			rows.Close()
			return err
		}
		relations = append(relations, relation{rowID: rowID, tags: splitTags(tags)})
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, relation := range relations {
		if err := replaceTagRows(tx, relation.rowID, relation.tags); err != nil {
			return err
		}
	}
	if err := refreshSummaryTx(tx); err != nil {
		return err
	}
	if err := rebuildFolderCountsTx(tx); err != nil {
		return err
	}
	if version < 5 {
		// Older indexes stored the logical front matter `updated` value in
		// mtime. Reset it so the first background calibration after upgrading
		// replaces every row with the actual filesystem clock exactly once.
		if _, err := tx.Exec(`UPDATE notes SET mtime = 0`); err != nil {
			return err
		}
	}
	if existed {
		if _, err := tx.Exec(`UPDATE index_meta SET value = '1' WHERE key = 'calibrated'`); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

func (ix *Index) Calibrated() bool {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	var value string
	return ix.db.QueryRow(`SELECT value FROM index_meta WHERE key = 'calibrated'`).Scan(&value) == nil && value == "1"
}

func (ix *Index) setCalibrated(ready bool) error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	value := "0"
	if ready {
		value = "1"
	}
	_, err := ix.db.Exec(`INSERT INTO index_meta(key, value) VALUES('calibrated', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, value)
	return err
}

func (ix *Index) Close() error {
	if ix == nil || ix.db == nil {
		return nil
	}
	return ix.db.Close()
}

// IntegrityCheck verifies the disposable index. A failed check is a signal to
// discard and rebuild the cache; Markdown files remain the source of truth.
func (ix *Index) IntegrityCheck() error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	var result string
	if err := ix.db.QueryRow(`PRAGMA quick_check`).Scan(&result); err != nil {
		return err
	}
	if strings.ToLower(strings.TrimSpace(result)) != "ok" {
		return fmt.Errorf("index integrity check: %s", result)
	}
	return nil
}

// Reset drops everything. Used when the vault changes or the index is corrupt.
func (ix *Index) Reset() error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	_, err := ix.db.Exec(`
		DROP TRIGGER IF EXISTS notes_ai;
		DROP TRIGGER IF EXISTS notes_ad;
		DROP TRIGGER IF EXISTS notes_au;
		DROP TRIGGER IF EXISTS notes_stats_ai;
		DROP TRIGGER IF EXISTS notes_stats_ad;
		DROP TRIGGER IF EXISTS notes_stats_au;
		DROP TABLE IF EXISTS notes_fts;
		DROP TABLE IF EXISTS note_tags;
		DROP TABLE IF EXISTS folder_cache;
		DROP TABLE IF EXISTS folder_counts;
		DROP TABLE IF EXISTS index_stats;
		DROP TABLE IF EXISTS index_meta;
		DROP TABLE IF EXISTS notes;
	` + schema)
	if err == nil {
		_, err = ix.db.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion))
	}
	if err == nil {
		_, err = ix.db.Exec(`UPDATE index_meta SET value = '0' WHERE key = 'calibrated'`)
	}
	return err
}

// ---------------------------------------------------------------- syncing

// Sync brings the index in line with what is on disk. It stats every note
// first and only re-reads the ones whose size or mtime moved.
func (ix *Index) Sync(v *store.Vault) (changed int, err error) {
	return ix.SyncWithProgress(v, nil)
}

// SyncWithProgress is the explicit full-disk reconciliation path. Watcher
// events normally use SyncChanges; this method is reserved for first build,
// background calibration, overflow recovery and manual rebuild.
func (ix *Index) SyncWithProgress(v *store.Vault, progress func(done, total int)) (changed int, err error) {
	stats, err := v.StatWalk()
	if err != nil {
		return 0, err
	}

	ix.mu.Lock()
	known := map[string]struct {
		size  int64
		mtime int64
	}{}
	idOwners := make(map[string]string)
	rows, err := ix.db.Query(`SELECT id, path, size, mtime FROM notes`)
	if err != nil {
		ix.mu.Unlock()
		return 0, err
	}
	for rows.Next() {
		var id, p string
		var size, mtime int64
		if err := rows.Scan(&id, &p, &size, &mtime); err != nil {
			continue
		}
		known[p] = struct {
			size  int64
			mtime int64
		}{size, mtime}
		idOwners[id] = p
	}
	rows.Close()
	ix.mu.Unlock()

	// An empty walk is valid when the user deleted every note, but not when the
	// vault disappeared or became unreadable between WalkDir and this point.
	// Never turn a transient drive/network failure into a wholesale index wipe.
	if len(stats) == 0 && len(known) > 0 {
		if _, err := os.ReadDir(v.Root()); err != nil {
			return 0, fmt.Errorf("verify empty vault: %w", err)
		}
	}

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
		if progress != nil {
			progress(0, 0)
		}
		folders, folderErr := v.Folders()
		if folderErr != nil {
			return 0, folderErr
		}
		if err := ix.ReplaceFolders(folders); err != nil {
			return 0, err
		}
		return 0, ix.setCalibrated(true)
	}
	total := len(stale) + len(gone)
	if progress != nil {
		progress(0, total)
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
			if owner, exists := idOwners[n.ID]; exists && owner != n.Path {
				n, err = v.ReassignID(n.Path)
				if err != nil {
					return changed, fmt.Errorf("repair duplicate note id for %s: %w", p, err)
				}
			}
			idOwners[n.ID] = n.Path
			notes = append(notes, n)
		}
		if err := ix.upsert(notes, true); err != nil {
			return changed, err
		}
		changed += len(notes)
		if progress != nil {
			progress(changed, total)
		}
	}
	if err := ix.removePaths(gone); err != nil {
		return changed, err
	}
	if progress != nil {
		progress(changed+len(gone), total)
	}
	folders, folderErr := v.Folders()
	if folderErr != nil {
		return changed + len(gone), folderErr
	}
	if err := ix.ReplaceFolders(folders); err != nil {
		return changed + len(gone), err
	}
	if err := ix.setCalibrated(true); err != nil {
		return changed + len(gone), err
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

	const upsertSQL = `
		INSERT INTO notes(id, path, title, folder, tags, created, updated, favorite, excerpt, words, size, mtime, content)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET
		  id=excluded.id, title=excluded.title, folder=excluded.folder, tags=excluded.tags,
		  created=excluded.created, updated=excluded.updated, favorite=excluded.favorite,
		  excerpt=excluded.excerpt, words=excluded.words, size=excluded.size,
		  mtime=excluded.mtime, content=excluded.content`
	sqlText := upsertSQL
	if onlyIfNewer {
		sqlText += ` WHERE excluded.mtime >= notes.mtime`
	}

	stmt, err := tx.Prepare(sqlText)
	if err != nil {
		return err
	}
	defer stmt.Close()
	var unconditionalStmt *sql.Stmt
	if onlyIfNewer {
		unconditionalStmt, err = tx.Prepare(upsertSQL)
		if err != nil {
			return err
		}
		defer unconditionalStmt.Close()
	}

	for _, n := range notes {
		var previousFolder string
		previousExists := tx.QueryRow(`SELECT folder FROM notes WHERE path = ?`, n.Path).Scan(&previousFolder) == nil
		fav := 0
		if n.Favorite {
			fav = 1
		}
		args := []any{
			n.ID, n.Path, n.Title, n.Folder, strings.Join(n.Tags, "\x1f"),
			n.Created.UnixMilli(), n.Updated.UnixMilli(), fav,
			n.Excerpt, n.Words, n.Size, noteFileMtime(n), n.Content,
		}
		result, err := stmt.Exec(args...)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected == 0 && onlyIfNewer {
			// A restored or copied file may legitimately carry an older mtime
			// than the row it replaces. Before overriding that row, verify that
			// the file still matches the exact note this sync pass read. If an
			// in-app save landed in between, its file state differs and its
			// authoritative Upsert will run after this mutex is released.
			info, statErr := os.Stat(n.Path)
			if statErr != nil || info.IsDir() || info.Size() != n.Size || info.ModTime().UnixMilli() != noteFileMtime(n) {
				continue
			}
			result, err = unconditionalStmt.Exec(args...)
			if err != nil {
				return err
			}
			affected, err = result.RowsAffected()
			if err != nil {
				return err
			}
		}
		if affected == 0 {
			continue
		}
		var rowID int64
		if err := tx.QueryRow(`SELECT rowid FROM notes WHERE path = ?`, n.Path).Scan(&rowID); err != nil {
			return err
		}
		if err := replaceTagRows(tx, rowID, n.Tags); err != nil {
			return err
		}
		if err := ensureFolderRowsTx(tx, n.Folder); err != nil {
			return err
		}
		if !previousExists {
			if err := adjustFolderCountsTx(tx, n.Folder, 1); err != nil {
				return err
			}
		} else if previousFolder != n.Folder {
			if err := adjustFolderCountsTx(tx, previousFolder, -1); err != nil {
				return err
			}
			if err := adjustFolderCountsTx(tx, n.Folder, 1); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func noteFileMtime(n store.Note) int64 {
	if !n.FileModTime.IsZero() {
		return n.FileModTime.UnixMilli()
	}
	// Tests and narrow internal callers may construct a Note directly. The
	// logical timestamp is a compatibility fallback, never the normal vault path.
	return n.Updated.UnixMilli()
}

func replaceTagRows(tx *sql.Tx, rowID int64, tags []string) error {
	if _, err := tx.Exec(`DELETE FROM note_tags WHERE note_rowid = ?`, rowID); err != nil {
		return err
	}
	for _, tag := range tags {
		if strings.TrimSpace(tag) == "" {
			continue
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO note_tags(note_rowid, tag) VALUES(?, ?)`, rowID, tag); err != nil {
			return err
		}
	}
	return nil
}

func refreshSummaryTx(tx *sql.Tx) error {
	_, err := tx.Exec(`UPDATE index_stats SET
		notes = (SELECT COUNT(*) FROM notes),
		words = (SELECT COALESCE(SUM(words), 0) FROM notes),
		bytes = (SELECT COALESCE(SUM(size), 0) FROM notes)
		WHERE singleton = 1`)
	return err
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
		var folder string
		hadRow := tx.QueryRow(`SELECT folder FROM notes WHERE path = ?`, p).Scan(&folder) == nil
		if _, err := tx.Exec(`DELETE FROM notes WHERE path = ?`, p); err != nil {
			return err
		}
		if hadRow {
			if err := adjustFolderCountsTx(tx, folder, -1); err != nil {
				return err
			}
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
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT folder, COUNT(*) FROM notes WHERE folder = ? OR folder LIKE ? ESCAPE '\' GROUP BY folder`, folder, escapeLike(folder)+`/%`)
	if err != nil {
		return err
	}
	counts := map[string]int{}
	for rows.Next() {
		var path string
		var count int
		if err := rows.Scan(&path, &count); err != nil {
			rows.Close()
			return err
		}
		counts[path] = count
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`DELETE FROM notes WHERE folder = ? OR folder LIKE ? ESCAPE '\'`,
		folder, escapeLike(folder)+`/%`); err != nil {
		return err
	}
	for path, count := range counts {
		if err := adjustFolderCountsTx(tx, path, -count); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM folder_cache WHERE path = ? OR path LIKE ? ESCAPE '\'`, folder, escapeLike(folder)+`/%`); err != nil {
		return err
	}
	return tx.Commit()
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
	where, args := listWhere(q.Scope, q.Value)

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
	err := ix.db.QueryRow(`SELECT notes, words, bytes FROM index_stats WHERE singleton = 1`).Scan(&s.Notes, &s.Words, &s.Bytes)
	return s, err
}

func (ix *Index) Tags() ([]store.Tag, error) {
	ix.mu.Lock()
	rows, err := ix.db.Query(`SELECT tag, COUNT(*) FROM note_tags GROUP BY tag ORDER BY COUNT(*) DESC, tag ASC`)
	ix.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []store.Tag{}
	for rows.Next() {
		var tag store.Tag
		if err := rows.Scan(&tag.Name, &tag.Count); err != nil {
			return nil, err
		}
		out = append(out, tag)
	}
	return out, rows.Err()
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
