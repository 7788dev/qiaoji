package index

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"qiaoji/internal/store"
)

// PageRequest is the keyset-paginated form of Query. Cursor is opaque to the
// frontend; changing sort or scope simply starts a new request without any
// offset scan.
type PageRequest struct {
	Scope  string `json:"scope"`
	Value  string `json:"value"`
	SortBy string `json:"sortBy"`
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

// NotePage is the bounded list response used by the Wails API.
type NotePage struct {
	Items      []store.Meta `json:"items"`
	Total      int          `json:"total"`
	NextCursor string       `json:"nextCursor,omitempty"`
}

type pageCursor struct {
	SortBy string `json:"sortBy"`
	Text   string `json:"text,omitempty"`
	Millis int64  `json:"millis,omitempty"`
	ID     string `json:"id"`
	Path   string `json:"path"`
}

const defaultPageSize = 200

func encodeCursor(c pageCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(raw string) (pageCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return pageCursor{}, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return pageCursor{}, errors.New("invalid note page cursor")
	}
	var c pageCursor
	if err := json.Unmarshal(b, &c); err != nil || c.SortBy == "" || c.ID == "" {
		return pageCursor{}, errors.New("invalid note page cursor")
	}
	return c, nil
}

// ListPage executes a deterministic keyset query. It never materializes more
// than limit+1 rows, even when the vault contains tens of thousands of notes.
func (ix *Index) ListPage(q PageRequest) (NotePage, error) {
	where, _ := listWhere(q.Scope, q.Value)
	if q.Limit <= 0 || q.Limit > defaultPageSize {
		q.Limit = defaultPageSize
	}
	cur, err := decodeCursor(q.Cursor)
	if err != nil {
		return NotePage{}, err
	}
	if q.Cursor != "" && cur.SortBy != normalSort(q.SortBy) {
		return NotePage{}, errors.New("cursor sort does not match request")
	}
	if q.Cursor != "" {
		cursorSQL, _ := cursorPredicate(cur)
		where = append(where, cursorSQL)
	}
	order := pageOrder(q.SortBy)
	// Count is a cheap indexed aggregate and is returned with every page so
	// virtual lists can announce progress and choose their scroll height.
	countSQL := `SELECT COUNT(*) FROM notes WHERE ` + strings.Join(whereWithoutCursor(q.Scope, q.Value), " AND ")
	countArgs := listArgs(q.Scope, q.Value)
	rowSQL := `SELECT id, path, title, folder, tags, created, updated, favorite, excerpt, words, size
		FROM notes WHERE ` + strings.Join(where, " AND ") + ` ORDER BY ` + order + ` LIMIT ?`
	rowArgs := append([]any{}, listArgs(q.Scope, q.Value)...)
	if q.Cursor != "" {
		_, cursorArgs := cursorPredicate(cur)
		rowArgs = append(rowArgs, cursorArgs...)
	}
	rowArgs = append(rowArgs, q.Limit+1)

	ix.mu.Lock()
	defer ix.mu.Unlock()
	var total int
	if err := ix.db.QueryRow(countSQL, countArgs...).Scan(&total); err != nil {
		return NotePage{}, err
	}
	rows, err := ix.db.Query(rowSQL, rowArgs...)
	if err != nil {
		return NotePage{}, err
	}
	items, err := scanMetas(rows)
	rows.Close()
	if err != nil {
		return NotePage{}, err
	}
	page := NotePage{Items: items, Total: total}
	if len(items) > q.Limit {
		page.Items = items[:q.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeCursor(cursorFor(last, normalSort(q.SortBy)))
	}
	return page, nil
}

func normalSort(sortBy string) string {
	switch sortBy {
	case "created", "title":
		return sortBy
	default:
		return "updated"
	}
}

func cursorFor(m store.Meta, sortBy string) pageCursor {
	c := pageCursor{SortBy: sortBy, ID: m.ID, Path: m.Path}
	if sortBy == "title" {
		c.Text = m.Title
	} else if sortBy == "created" {
		c.Millis = m.Created.UnixMilli()
	} else {
		c.Millis = m.Updated.UnixMilli()
	}
	return c
}

func pageOrder(sortBy string) string {
	sortBy = normalSort(sortBy)
	switch sortBy {
	case "title":
		return "title COLLATE NOCASE ASC, id ASC, path ASC"
	case "created":
		return "created DESC, id ASC, path ASC"
	default:
		return "updated DESC, id ASC, path ASC"
	}
}

// listWhere/listArgs are shared by legacy List and keyset pages. Keeping the
// filter construction in one place prevents scope behavior drifting between
// APIs.
func listWhere(scope, value string) ([]string, []any) {
	where := []string{"1=1"}
	args := []any{}
	switch scope {
	case "favorites":
		where = append(where, "favorite = 1")
	case "folder":
		if value != "" {
			where = append(where, `(folder = ? OR folder LIKE ? ESCAPE '\')`)
			args = append(args, value, escapeLike(value)+"/%")
		}
	case "tag":
		if value == "" {
			where = append(where, "1=0")
		} else {
			where = append(where, `EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_rowid = notes.rowid AND nt.tag = ?)`)
			args = append(args, value)
		}
	case "untagged":
		where = append(where, "tags = ''")
	}
	return where, args
}

func whereWithoutCursor(scope, value string) []string {
	w, _ := listWhere(scope, value)
	return w
}

func listArgs(scope, value string) []any {
	_, a := listWhere(scope, value)
	return a
}

// cursorPredicate returns the strict keyset predicate for a decoded cursor.
func cursorPredicate(c pageCursor) (string, []any) {
	switch normalSort(c.SortBy) {
	case "title":
		return `(title COLLATE NOCASE > ? OR (title COLLATE NOCASE = ? AND (id > ? OR (id = ? AND path > ?))))`, []any{c.Text, c.Text, c.ID, c.ID, c.Path}
	case "created":
		return `(created < ? OR (created = ? AND (id > ? OR (id = ? AND path > ?))))`, []any{c.Millis, c.Millis, c.ID, c.ID, c.Path}
	default:
		return `(updated < ? OR (updated = ? AND (id > ? OR (id = ? AND path > ?))))`, []any{c.Millis, c.Millis, c.ID, c.ID, c.Path}
	}
}

// PageCursorPredicate is exported for tests and alternate query surfaces.
func PageCursorPredicate(raw string) (string, []any, error) {
	c, err := decodeCursor(raw)
	if err != nil {
		return "", nil, err
	}
	if raw == "" {
		return "", nil, nil
	}
	sqlText, args := cursorPredicate(c)
	return sqlText, args, nil
}
