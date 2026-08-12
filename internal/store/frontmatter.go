package store

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// frontMatter is the YAML block we own at the top of every note file. Unknown
// keys written by other editors are preserved in Extra so we never eat them.
type frontMatter struct {
	ID       string    `yaml:"id,omitempty"`
	Title    string    `yaml:"title,omitempty"`
	Tags     []string  `yaml:"tags,omitempty"`
	Created  time.Time `yaml:"created,omitempty"`
	Updated  time.Time `yaml:"updated,omitempty"`
	Favorite bool      `yaml:"favorite,omitempty"`

	// Extra carries every key we do not model. Obsidian's `aliases` and
	// `cssclass`, publishing flags and per-vault custom fields all land here
	// and are written back verbatim, so a note stays whatever its author made
	// it even after we rewrite the header.
	Extra map[string]yaml.Node `yaml:",inline"`
}

var (
	fmDelim = []byte("---")
	utf8BOM = []byte("\xef\xbb\xbf")
)

// splitFrontMatter returns the raw YAML block (without delimiters) and the
// Markdown body. A file with no delimited block is all body.
func splitFrontMatter(raw []byte) (yamlPart, body []byte, ok bool) {
	raw = bytes.TrimPrefix(raw, utf8BOM)
	if !bytes.HasPrefix(raw, fmDelim) {
		return nil, raw, false
	}
	rest := raw[len(fmDelim):]
	if len(rest) == 0 || (rest[0] != '\n' && rest[0] != '\r') {
		return nil, raw, false
	}
	rest = trimLeadingNewline(rest)

	// Find a line that is exactly "---" (or "..." per the YAML spec).
	idx := 0
	for idx < len(rest) {
		lineEnd := bytes.IndexByte(rest[idx:], '\n')
		var line []byte
		if lineEnd < 0 {
			line = rest[idx:]
		} else {
			line = rest[idx : idx+lineEnd]
		}
		trimmed := bytes.TrimRight(line, "\r \t")
		if string(trimmed) == "---" || string(trimmed) == "..." {
			if lineEnd < 0 {
				return rest[:idx], nil, true
			}
			return rest[:idx], trimLeadingNewline(rest[idx+lineEnd+1:]), true
		}
		if lineEnd < 0 {
			break
		}
		idx += lineEnd + 1
	}
	return nil, raw, false
}

func trimLeadingNewline(b []byte) []byte {
	if len(b) > 0 && b[0] == '\r' {
		b = b[1:]
	}
	if len(b) > 0 && b[0] == '\n' {
		b = b[1:]
	}
	return b
}

// parseFrontMatter splits a note file into its header and body.
//
// A delimited block only counts as front matter when it is a YAML mapping. A
// note whose body opens with a `---` thematic break would otherwise lose
// everything above the next `---` the first time we rewrote the file.
//
// A block that is a mapping but holds a value we cannot decode (say
// `tags: 工作` where a list belongs) returns an error alongside whatever did
// decode. Reads tolerate that so the note still lists; writes must not, or the
// unreadable keys would be dropped on the way back to disk.
func parseFrontMatter(raw []byte) (frontMatter, string, error) {
	yamlPart, body, ok := splitFrontMatter(raw)
	var fm frontMatter
	if !ok {
		return fm, string(body), nil
	}
	if len(bytes.TrimSpace(yamlPart)) == 0 {
		return fm, string(body), nil
	}

	whole := string(bytes.TrimPrefix(raw, utf8BOM))

	var doc yaml.Node
	if err := yaml.Unmarshal(yamlPart, &doc); err != nil {
		return frontMatter{}, whole, nil
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return frontMatter{}, whole, nil
	}
	if err := doc.Content[0].Decode(&fm); err != nil {
		return fm, string(body), fmt.Errorf("YAML 头部无法解析: %w", err)
	}
	return fm, string(body), nil
}

func renderFile(fm frontMatter, body string) []byte {
	var buf bytes.Buffer
	buf.WriteString("---\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	_ = enc.Encode(fm)
	_ = enc.Close()
	buf.WriteString("---\n\n")

	text := strings.TrimLeft(body, "\n")
	buf.WriteString(text)
	if text != "" && !strings.HasSuffix(text, "\n") {
		buf.WriteString("\n")
	}
	return buf.Bytes()
}

func normaliseTags(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, t := range in {
		t = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "#"))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}
