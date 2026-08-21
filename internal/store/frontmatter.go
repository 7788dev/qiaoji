package store

import (
	"fmt"
	"strings"
	"time"

	"qiaoji/internal/frontmatter"
)

// frontMatter is the YAML block we own at the top of every note file. Unknown
// keys written by other editors are preserved in Extra so we never eat them.
type frontMatter struct {
	ID       string    `yaml:"id"`
	Title    string    `yaml:"title"`
	Tags     []string  `yaml:"tags"`
	Created  time.Time `yaml:"created"`
	Updated  time.Time `yaml:"updated"`
	Favorite bool      `yaml:"favorite"`

	document *frontmatter.Document
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
	doc, ok := frontmatter.Parse(raw)
	if !ok {
		return frontMatter{document: doc}, string(doc.Body()), nil
	}
	var fm frontMatter
	if err := doc.Decode(&fm); err != nil {
		fm.document = doc
		return fm, string(doc.Body()), fmt.Errorf("YAML 头部无法解析: %w", err)
	}
	fm.document = doc
	return fm, string(doc.Body()), nil
}

func renderFile(fm frontMatter, body string) []byte {
	doc := fm.document
	if doc == nil {
		doc = frontmatter.New()
	}
	_ = doc.Set("id", fm.ID)
	_ = doc.Set("title", fm.Title)
	_ = doc.Set("tags", normaliseTags(fm.Tags))
	_ = doc.Set("created", fm.Created)
	_ = doc.Set("updated", fm.Updated)
	_ = doc.Set("favorite", fm.Favorite)
	out, err := doc.Render([]byte(body))
	if err != nil {
		return nil
	}
	return out
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
