package frontmatter

import (
	"strings"
	"testing"
	"time"
)

func TestTargetedUpdatePreservesOrderCommentsAndStyles(t *testing.T) {
	raw := []byte("---\r\n# owner comment\r\ncustom: 'keep quoted' # keep inline\r\ntitle: Old\r\ntags: [one, two]\r\npublish: true\r\n---\r\n\r\n# Old\r\n\r\nBody without final newline")
	doc, ok := Parse(raw)
	if !ok {
		t.Fatal("front matter was not recognised")
	}
	if err := doc.Set("title", "New"); err != nil {
		t.Fatal(err)
	}
	if err := doc.Set("updated", time.Date(2026, 8, 19, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	out, err := doc.Render(doc.Body())
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, want := range []string{
		"# owner comment",
		"custom: 'keep quoted' # keep inline",
		"custom: 'keep quoted' # keep inline\r\ntitle: New\r\ntags: [one, two]\r\npublish: true",
		"Body without final newline",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("rendered document lost %q:\n%s", want, text)
		}
	}
	if strings.HasSuffix(text, "\n") {
		t.Error("an unrelated final newline was added")
	}
}

func TestThematicBreakIsNotFrontMatter(t *testing.T) {
	raw := []byte("---\n\nThis is prose.\n\n---\n\nMore prose.\n")
	doc, ok := Parse(raw)
	if ok {
		t.Fatal("a thematic break was mistaken for YAML")
	}
	if string(doc.Body()) != string(raw) {
		t.Fatalf("body changed: %q", doc.Body())
	}
}

func TestUnchangedValueKeepsQuotedStyleAndComment(t *testing.T) {
	doc, ok := Parse([]byte("---\ntitle: 'Same' # comment\n---\n\nbody"))
	if !ok {
		t.Fatal("not recognised")
	}
	if err := doc.Set("title", "Same"); err != nil {
		t.Fatal(err)
	}
	out, _ := doc.Render(doc.Body())
	if !strings.Contains(string(out), "title: 'Same' # comment") {
		t.Fatalf("presentation changed:\n%s", out)
	}
}
