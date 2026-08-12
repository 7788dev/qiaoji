package index

import (
	"html"
	"strings"
	"time"
	"unicode"

	"qiaoji/internal/store"
)

// Hit is one search result with pre-highlighted HTML fragments, so the
// frontend can render matches without re-running the matching logic.
type Hit struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Title     string    `json:"title"`
	TitleHTML string    `json:"titleHtml"`
	Folder    string    `json:"folder"`
	Snippet   string    `json:"snippet"`
	Updated   time.Time `json:"updated"`
	Favorite  bool      `json:"favorite"`
}

// Search runs a full-text query.
//
// The trigram tokenizer cannot answer queries shorter than three characters,
// which in Chinese rules out most everyday words ("笔记", "工作"). Those fall
// back to a LIKE scan, which stays comfortably fast at personal-vault sizes.
func (ix *Index) Search(query string, limit int) ([]Hit, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return []Hit{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 60
	}

	if len([]rune(q)) >= minTrigram {
		hits, err := ix.searchFTS(q, limit)
		if err == nil && len(hits) > 0 {
			return hits, nil
		}
		if err == nil {
			return hits, nil
		}
		// A malformed MATCH expression should degrade, not fail the search box.
	}
	return ix.searchLike(q, limit)
}

func (ix *Index) searchFTS(q string, limit int) ([]Hit, error) {
	// Wrap in a quoted phrase so punctuation is never read as FTS syntax.
	phrase := `"` + strings.ReplaceAll(q, `"`, `""`) + `"`

	ix.mu.Lock()
	rows, err := ix.db.Query(`
		SELECT n.id, n.path, n.title, n.folder, n.content, n.updated, n.favorite
		FROM notes_fts
		JOIN notes n ON n.rowid = notes_fts.rowid
		WHERE notes_fts MATCH ?
		ORDER BY bm25(notes_fts, 10.0, 1.0)
		LIMIT ?`, phrase, limit)
	ix.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanHits(rows, q)
}

func (ix *Index) searchLike(q string, limit int) ([]Hit, error) {
	pattern := "%" + escapeLike(q) + "%"
	ix.mu.Lock()
	rows, err := ix.db.Query(`
		SELECT id, path, title, folder, content, updated, favorite
		FROM notes
		WHERE title LIKE ? ESCAPE '\' OR content LIKE ? ESCAPE '\'
		ORDER BY (CASE WHEN title LIKE ? ESCAPE '\' THEN 0 ELSE 1 END), updated DESC
		LIMIT ?`, pattern, pattern, pattern, limit)
	ix.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanHits(rows, q)
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

type rowScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanHits(rows rowScanner, q string) ([]Hit, error) {
	out := []Hit{}
	for rows.Next() {
		var (
			h       Hit
			content string
			updated int64
			fav     int
		)
		if err := rows.Scan(&h.ID, &h.Path, &h.Title, &h.Folder, &content, &updated, &fav); err != nil {
			return nil, err
		}
		h.Updated = time.UnixMilli(updated)
		h.Favorite = fav == 1
		h.TitleHTML = highlight(h.Title, q, len([]rune(h.Title)), 0)
		h.Snippet = highlight(stripMarkdown(content), q, 110, 28)
		out = append(out, h)
	}
	return out, rows.Err()
}

// highlight returns HTML-escaped text windowed around the first match, with
// every occurrence inside the window wrapped in <mark>.
func highlight(text, query string, width, lead int) string {
	runes := []rune(text)
	lowerText := strings.ToLower(text)
	lowerQ := strings.ToLower(query)

	start := 0
	if idx := strings.Index(lowerText, lowerQ); idx > 0 {
		runeIdx := len([]rune(text[:idx]))
		start = runeIdx - lead
		if start < 0 {
			start = 0
		}
	}
	end := start + width
	if end > len(runes) {
		end = len(runes)
	}
	window := string(runes[start:end])

	var sb strings.Builder
	if start > 0 {
		sb.WriteString("…")
	}
	sb.WriteString(markAll(window, query))
	if end < len(runes) {
		sb.WriteString("…")
	}
	return sb.String()
}

func markAll(text, query string) string {
	if query == "" {
		return html.EscapeString(text)
	}
	lowerText := strings.ToLower(text)
	lowerQ := strings.ToLower(query)

	var sb strings.Builder
	cursor := 0
	for {
		i := strings.Index(lowerText[cursor:], lowerQ)
		if i < 0 {
			sb.WriteString(html.EscapeString(text[cursor:]))
			break
		}
		abs := cursor + i
		sb.WriteString(html.EscapeString(text[cursor:abs]))
		sb.WriteString("<mark>")
		sb.WriteString(html.EscapeString(text[abs : abs+len(query)]))
		sb.WriteString("</mark>")
		cursor = abs + len(query)
	}
	return sb.String()
}

// stripMarkdown flattens a note into one line of readable prose for snippets.
func stripMarkdown(body string) string {
	var sb strings.Builder
	inFence := false
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence || t == "" || strings.HasPrefix(t, "---") {
			continue
		}
		t = strings.TrimLeft(t, "#> \t")
		t = strings.TrimLeft(t, "-*+ ")
		t = strings.NewReplacer("**", "", "__", "", "`", "", "~~", "").Replace(t)
		if t == "" {
			continue
		}
		if sb.Len() > 0 {
			sb.WriteByte(' ')
		}
		sb.WriteString(t)
		if sb.Len() > 4096 {
			break
		}
	}
	return strings.TrimSpace(sb.String())
}

// Suggest powers the quick-open list in the command palette: title matches
// only, ranked by how early the query appears.
func (ix *Index) Suggest(query string, limit int) ([]store.Meta, error) {
	q := strings.TrimSpace(query)
	if limit <= 0 {
		limit = 20
	}
	if q == "" {
		return ix.List(Query{Scope: "recent", SortBy: "updated", Limit: limit})
	}
	pattern := "%" + escapeLike(q) + "%"
	ix.mu.Lock()
	rows, err := ix.db.Query(`
		SELECT id, path, title, folder, tags, created, updated, favorite, excerpt, words, size
		FROM notes WHERE title LIKE ? ESCAPE '\'
		ORDER BY LENGTH(title) ASC, updated DESC LIMIT ?`, pattern, limit)
	ix.mu.Unlock()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMetas(rows)
}

// NormaliseQuery collapses whitespace so " 数学  公式 " and "数学 公式" behave
// the same.
func NormaliseQuery(s string) string {
	fields := strings.FieldsFunc(s, unicode.IsSpace)
	return strings.Join(fields, " ")
}
