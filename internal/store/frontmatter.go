package store

import (
	"bytes"
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
}

var fmDelim = []byte("---")

// splitFrontMatter returns the raw YAML block (without delimiters) and the
// Markdown body. A file with no front matter is all body.
func splitFrontMatter(raw []byte) (yamlPart, body []byte) {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // strip UTF-8 BOM
	if !bytes.HasPrefix(raw, fmDelim) {
		return nil, raw
	}
	rest := raw[len(fmDelim):]
	if len(rest) == 0 || (rest[0] != '\n' && rest[0] != '\r') {
		return nil, raw
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
				return rest[:idx], nil
			}
			return rest[:idx], trimLeadingNewline(rest[idx+lineEnd+1:])
		}
		if lineEnd < 0 {
			break
		}
		idx += lineEnd + 1
	}
	return nil, raw
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

func parseFrontMatter(raw []byte) (frontMatter, string) {
	yamlPart, body := splitFrontMatter(raw)
	var fm frontMatter
	if len(yamlPart) > 0 {
		_ = yaml.Unmarshal(yamlPart, &fm)
	}
	return fm, string(body)
}

func renderFile(fm frontMatter, body string) []byte {
	var buf bytes.Buffer
	buf.WriteString("---\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	_ = enc.Encode(fm)
	_ = enc.Close()
	buf.WriteString("---\n\n")
	buf.WriteString(strings.TrimLeft(body, "\n"))
	if !strings.HasSuffix(body, "\n") {
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
