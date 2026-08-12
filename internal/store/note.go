package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"strings"
	"time"
	"unicode"
)

// Meta is everything the UI needs to render a note in a list without loading
// its body.
type Meta struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Folder   string    `json:"folder"` // vault-relative directory, "" means root
	Path     string    `json:"path"`   // absolute path on disk
	Tags     []string  `json:"tags"`
	Created  time.Time `json:"created"`
	Updated  time.Time `json:"updated"`
	Favorite bool      `json:"favorite"`
	Excerpt  string    `json:"excerpt"`
	Words    int       `json:"words"`
	Size     int64     `json:"size"`
	Revision string    `json:"revision"`
}

type Note struct {
	Meta
	Content string `json:"content"`
}

type Folder struct {
	Name  string `json:"name"`
	Path  string `json:"path"` // vault-relative
	Count int    `json:"count"`
}

type Tag struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// SearchScope values accepted by index.Query.Scope, kept here so both layers
// agree on the vocabulary.
const (
	ScopeAll       = "all"
	ScopeRecent    = "recent"
	ScopeFavorites = "favorites"
	ScopeFolder    = "folder"
	ScopeTag       = "tag"
	ScopeUntagged  = "untagged"
)

var idEncoding = base32.NewEncoding("0123456789abcdefghjkmnpqrstvwxyz").WithPadding(base32.NoPadding)

// newID returns a lexicographically sortable, collision-resistant id: 48 bits
// of millisecond timestamp followed by 40 bits of randomness.
func newID() string {
	var b [11]byte
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	_, _ = rand.Read(b[6:])
	return idEncoding.EncodeToString(b[:])
}

func revisionOf(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// countWords treats every CJK ideograph as one word and every run of Latin
// letters or digits as one word, which matches what Chinese users expect from
// a word counter.
func countWords(s string) int {
	n := 0
	inWord := false
	for _, r := range s {
		switch {
		case isCJK(r):
			n++
			inWord = false
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if !inWord {
				n++
				inWord = true
			}
		default:
			inWord = false
		}
	}
	return n
}

func isCJK(r rune) bool {
	return (r >= 0x4E00 && r <= 0x9FFF) || // CJK Unified Ideographs
		(r >= 0x3400 && r <= 0x4DBF) || // Extension A
		(r >= 0x3040 && r <= 0x30FF) || // Kana
		(r >= 0xAC00 && r <= 0xD7AF) // Hangul
}

// excerptOf strips the most common Markdown noise so list rows read like prose
// instead of showing "## " and "![](...)".
//
// The leading heading is skipped because the list row already shows it as the
// title, and repeating it wastes both lines of the preview.
func excerptOf(body string, limit int) string {
	var sb strings.Builder
	inFence := false
	skippedTitle := false

	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if !skippedTitle && t != "" {
			skippedTitle = true
			if strings.HasPrefix(t, "#") {
				continue
			}
		}
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence || t == "" {
			continue
		}
		t = strings.TrimLeft(t, "#> \t")
		t = strings.TrimPrefix(t, "- ")
		t = strings.TrimPrefix(t, "* ")
		t = strings.TrimPrefix(t, "+ ")
		t = stripInline(t)
		if t == "" || strings.HasPrefix(t, "---") || strings.HasPrefix(t, "|") {
			continue
		}
		if sb.Len() > 0 {
			sb.WriteString(" ")
		}
		sb.WriteString(t)
		if len([]rune(sb.String())) >= limit {
			break
		}
	}
	r := []rune(sb.String())
	if len(r) > limit {
		return string(r[:limit]) + "…"
	}
	return string(r)
}

// stripInline removes inline Markdown syntax so list previews read as prose.
// Link and image targets are dropped entirely; a preview full of URLs tells
// the reader nothing about the note.
func stripInline(s string) string {
	var sb strings.Builder
	sb.Grow(len(s))

	i := 0
	for i < len(s) {
		switch {
		case s[i] == '!' && i+1 < len(s) && s[i+1] == '[':
			text, next, ok := readLink(s, i+1)
			if !ok {
				sb.WriteByte(s[i])
				i++
				continue
			}
			if text == "" {
				text = "图片"
			}
			sb.WriteString("[" + text + "]")
			i = next

		case s[i] == '[':
			text, next, ok := readLink(s, i)
			if !ok {
				sb.WriteByte(s[i])
				i++
				continue
			}
			sb.WriteString(text)
			i = next

		case s[i] == '*' || s[i] == '_' || s[i] == '`' || s[i] == '~' || s[i] == '$':
			// Emphasis, code, strikethrough and maths delimiters carry no
			// meaning in a one-line preview; the text between them still does.
			i++

		default:
			sb.WriteByte(s[i])
			i++
		}
	}
	return strings.TrimSpace(sb.String())
}

// readLink parses `[text](target)` starting at the opening bracket and returns
// the visible text plus the index just past the closing parenthesis.
func readLink(s string, start int) (text string, next int, ok bool) {
	close := strings.IndexByte(s[start:], ']')
	if close < 0 {
		return "", 0, false
	}
	open := start + close + 1
	if open >= len(s) || s[open] != '(' {
		return "", 0, false
	}
	end := strings.IndexByte(s[open:], ')')
	if end < 0 {
		return "", 0, false
	}
	return s[start+1 : start+close], open + end + 1, true
}

// titleFromBody uses the first ATX heading, falling back to the first line of
// prose, so a note always shows something meaningful in the list.
func titleFromBody(body string) string {
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || isThematicBreak(t) {
			continue
		}
		if strings.HasPrefix(t, "#") {
			return strings.TrimSpace(strings.TrimLeft(t, "# "))
		}
		return firstRunes(t, 60)
	}
	return ""
}

// isThematicBreak reports whether a line is a horizontal rule. A rule is not a
// title, and naming a file after one produces "-.md".
func isThematicBreak(line string) bool {
	trimmed := strings.NewReplacer(" ", "", "\t", "").Replace(line)
	if len(trimmed) < 3 {
		return false
	}
	c := trimmed[0]
	if c != '-' && c != '*' && c != '_' {
		return false
	}
	return strings.Count(trimmed, string(c)) == len(trimmed)
}

func firstRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
