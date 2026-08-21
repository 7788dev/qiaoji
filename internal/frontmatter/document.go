// Package frontmatter edits YAML front matter without round-tripping it
// through a Go map. yaml.Node keeps mapping order, comments, scalar styles and
// aliases, which lets callers change only the keys they own.
package frontmatter

import (
	"bytes"
	"errors"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

var (
	delimiter = []byte("---")
	utf8BOM   = []byte("\xef\xbb\xbf")
)

// Document is a parsed Markdown file. Body excludes the one blank separator
// line normally placed between the closing delimiter and Markdown content.
// The separator, BOM, newline convention and closing delimiter are retained
// and written back unchanged.
type Document struct {
	root       yaml.Node
	body       []byte
	bom        bool
	newline    string
	closing    string
	separator  []byte
	recognised bool
}

// New returns an empty front-matter document using the conventional layout.
func New() *Document {
	root := yaml.Node{Kind: yaml.DocumentNode}
	root.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	return &Document{
		root:       root,
		newline:    "\n",
		closing:    "---",
		separator:  []byte("\n"),
		recognised: true,
	}
}

// Parse recognises a leading delimited YAML mapping. Invalid YAML or a YAML
// scalar is treated as ordinary Markdown so a thematic break at the beginning
// of a note can never make text disappear.
func Parse(raw []byte) (*Document, bool) {
	doc := New()
	doc.bom = bytes.HasPrefix(raw, utf8BOM)
	if doc.bom {
		raw = raw[len(utf8BOM):]
	}
	doc.newline = detectNewline(raw)

	yamlPart, after, closing, ok := split(raw)
	if !ok {
		doc.body = append([]byte(nil), raw...)
		doc.recognised = false
		return doc, false
	}

	var root yaml.Node
	if len(bytes.TrimSpace(yamlPart)) == 0 {
		root.Kind = yaml.DocumentNode
		root.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	} else if err := yaml.Unmarshal(yamlPart, &root); err != nil ||
		len(root.Content) == 0 || root.Content[0].Kind != yaml.MappingNode {
		doc.body = append([]byte(nil), raw...)
		doc.recognised = false
		return doc, false
	}

	doc.root = root
	doc.closing = closing
	doc.separator, doc.body = splitSeparator(after, doc.newline)
	doc.recognised = true
	return doc, true
}

func detectNewline(raw []byte) string {
	if i := bytes.IndexByte(raw, '\n'); i > 0 && raw[i-1] == '\r' {
		return "\r\n"
	}
	return "\n"
}

func split(raw []byte) (yamlPart, after []byte, closing string, ok bool) {
	if !bytes.HasPrefix(raw, delimiter) {
		return nil, nil, "", false
	}
	openEnd := bytes.IndexByte(raw, '\n')
	if openEnd < 0 || string(bytes.TrimRight(raw[:openEnd], "\r \t")) != "---" {
		return nil, nil, "", false
	}
	start := openEnd + 1
	for at := start; at <= len(raw); {
		next := bytes.IndexByte(raw[at:], '\n')
		lineEnd := len(raw)
		if next >= 0 {
			lineEnd = at + next
		}
		line := string(bytes.TrimRight(raw[at:lineEnd], "\r \t"))
		if line == "---" || line == "..." {
			afterAt := lineEnd
			if next >= 0 {
				afterAt++
			}
			return raw[start:at], raw[afterAt:], line, true
		}
		if next < 0 {
			break
		}
		at = lineEnd + 1
	}
	return nil, nil, "", false
}

func splitSeparator(after []byte, newline string) (separator, body []byte) {
	if bytes.HasPrefix(after, []byte(newline)) {
		return append([]byte(nil), []byte(newline)...), append([]byte(nil), after[len(newline):]...)
	}
	return nil, append([]byte(nil), after...)
}

// Body returns a copy of the Markdown body.
func (d *Document) Body() []byte { return append([]byte(nil), d.body...) }

// Recognised reports whether the source contained a valid delimited YAML
// mapping. Callers can edit plain Markdown bodies without silently adding a
// front matter block the user did not have.
func (d *Document) Recognised() bool { return d != nil && d.recognised }

// RenderBody replaces only the body. Plain Markdown remains plain Markdown;
// recognised front matter is rendered with its preserved presentation.
func (d *Document) RenderBody(body []byte) ([]byte, error) {
	if d == nil {
		return append([]byte(nil), body...), nil
	}
	if d.recognised {
		return d.Render(body)
	}
	out := make([]byte, 0, len(body)+len(utf8BOM))
	if d.bom {
		out = append(out, utf8BOM...)
	}
	out = append(out, body...)
	return out, nil
}

// Decode decodes only the mapping values callers model. It does not mutate
// the yaml.Node tree used for the eventual write.
func (d *Document) Decode(out any) error {
	if d == nil || !d.recognised || len(d.root.Content) == 0 {
		return errors.New("front matter is not a YAML mapping")
	}
	return d.root.Content[0].Decode(out)
}

func (d *Document) mapping() *yaml.Node {
	if d == nil {
		return nil
	}
	if len(d.root.Content) == 0 {
		d.root.Kind = yaml.DocumentNode
		d.root.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	}
	return d.root.Content[0]
}

// Get decodes one key and reports whether it exists.
func (d *Document) Get(key string, out any) bool {
	_, value := d.find(key)
	if value == nil || value.Decode(out) != nil {
		return false
	}
	return true
}

// Set replaces or appends one mapping value. A semantically unchanged value
// leaves the original node untouched, preserving its quotes, comments, anchor
// and flow/block formatting.
func (d *Document) Set(key string, value any) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("front matter key is empty")
	}
	var encoded yaml.Node
	if err := encoded.Encode(value); err != nil {
		return err
	}
	if encoded.Kind == yaml.DocumentNode && len(encoded.Content) > 0 {
		encoded = *encoded.Content[0]
	}

	index, current := d.find(key)
	if current != nil && semanticallyEqual(current, &encoded, value) {
		return nil
	}
	if current != nil {
		preservePresentation(current, &encoded)
		d.mapping().Content[index+1] = &encoded
		return nil
	}

	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	d.mapping().Content = append(d.mapping().Content, keyNode, &encoded)
	return nil
}

// Delete removes a mapping pair and its owned comments.
func (d *Document) Delete(key string) {
	index, current := d.find(key)
	if current == nil {
		return
	}
	mapping := d.mapping()
	mapping.Content = append(mapping.Content[:index], mapping.Content[index+2:]...)
}

func (d *Document) find(key string) (int, *yaml.Node) {
	mapping := d.mapping()
	if mapping == nil {
		return -1, nil
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return i, mapping.Content[i+1]
		}
	}
	return -1, nil
}

func semanticallyEqual(current, encoded *yaml.Node, value any) bool {
	if sameValueTree(current, encoded) {
		return true
	}
	typ := reflect.TypeOf(value)
	if typ == nil {
		return current.Tag == "!!null"
	}
	target := reflect.New(typ)
	if current.Decode(target.Interface()) == nil {
		return reflect.DeepEqual(target.Elem().Interface(), value)
	}
	return false
}

func sameValueTree(a, b *yaml.Node) bool {
	if a == nil || b == nil || a.Kind != b.Kind || a.Tag != b.Tag || a.Value != b.Value || len(a.Content) != len(b.Content) {
		return false
	}
	for i := range a.Content {
		if !sameValueTree(a.Content[i], b.Content[i]) {
			return false
		}
	}
	return true
}

func preservePresentation(old, next *yaml.Node) {
	next.HeadComment = old.HeadComment
	next.LineComment = old.LineComment
	next.FootComment = old.FootComment
	if old.Kind == next.Kind {
		next.Style = old.Style
	}
}

// Render writes the edited mapping and supplied body. Unknown keys and all
// untouched nodes remain in their original order with their comments.
func (d *Document) Render(body []byte) ([]byte, error) {
	if d == nil {
		d = New()
	}
	var yamlBuf bytes.Buffer
	enc := yaml.NewEncoder(&yamlBuf)
	enc.SetIndent(2)
	// Encode the document node, not only its mapping child. Comments that sit
	// before the first key are attached to the document by yaml.v3.
	if err := enc.Encode(&d.root); err != nil {
		_ = enc.Close()
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	yamlBytes := yamlBuf.Bytes()
	yamlBytes = bytes.TrimPrefix(yamlBytes, []byte("---\n"))
	yamlBytes = bytes.TrimSuffix(yamlBytes, []byte("\n"))
	if d.newline == "\r\n" {
		yamlBytes = bytes.ReplaceAll(yamlBytes, []byte("\n"), []byte("\r\n"))
	}

	newline := []byte(d.newline)
	closing := d.closing
	if closing == "" {
		closing = "---"
	}
	separator := d.separator
	if !d.recognised && separator == nil {
		separator = newline
	}

	var out bytes.Buffer
	if d.bom {
		out.Write(utf8BOM)
	}
	out.WriteString("---")
	out.Write(newline)
	out.Write(yamlBytes)
	out.Write(newline)
	out.WriteString(closing)
	out.Write(newline)
	out.Write(separator)
	out.Write(body)
	return out.Bytes(), nil
}
