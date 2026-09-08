package store

import (
	"errors"
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

// renderNoteFile is the last size and render-error check before a note is
// replaced on disk. The body limit alone is insufficient because front matter
// and preserved unknown YAML keys also contribute to the file size.
func renderNoteFile(fm frontMatter, body string) ([]byte, error) {
	data := renderFile(fm, body)
	if data == nil {
		return nil, errors.New("无法生成笔记内容")
	}
	if len(data) > maxNoteBytes {
		return nil, fmt.Errorf("笔记超过 %d MB 限制", maxNoteBytes>>20)
	}
	return data, nil
}

func normaliseTags(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, t := range in {
		t = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "#"))
		if t == "" || seen[t] || len([]rune(t)) > maxTagRunes {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

func validateTags(in []string) error {
	if len(in) > 100 {
		return errors.New("标签数量过多")
	}
	total := 0
	for _, raw := range in {
		t := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "#"))
		if t == "" {
			continue
		}
		if err := ValidateTagName(t); err != nil {
			return err
		}
		total += len([]byte(t))
		if total > 16<<10 {
			return errors.New("标签内容过大")
		}
	}
	return nil
}

// ValidateTagName checks one normalized tag name for API callers that mutate
// a whole set of notes, such as RenameTag.
func ValidateTagName(tag string) error {
	if strings.TrimSpace(tag) == "" {
		return errors.New("标签名不能为空")
	}
	if len([]rune(tag)) > maxTagRunes {
		return errors.New("标签名称过长")
	}
	for _, r := range tag {
		if r < 0x20 || r == 0x7f {
			return errors.New("标签包含非法控制字符")
		}
	}
	return nil
}
