package exporter

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
)

// writeDOCX converts the Markdown source (not the rendered HTML) so the result
// is a real Word document with live styles, navigable headings and selectable
// table cells, rather than a screenshot-like dump.
func writeDOCX(r Request, out string) error {
	src := []byte(strings.ReplaceAll(r.Markdown, "\r\n", "\n"))

	md := goldmark.New(goldmark.WithExtensions(
		extension.GFM,
		extension.Strikethrough,
		extension.Table,
		extension.TaskList,
	))
	doc := md.Parser().Parse(text.NewReader(src))

	b := &docxBuilder{src: src}
	b.walkChildren(doc)

	if b.body.Len() == 0 {
		b.paragraph("Normal", "", func() { b.text(strings.TrimSpace(r.Markdown), runStyle{}) })
	}

	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	title := strings.TrimSpace(r.Title)
	if title == "" {
		title = "未命名笔记"
	}

	parts := []part{
		{"[Content_Types].xml", contentTypesXML},
		{"_rels/.rels", rootRelsXML},
		{"docProps/core.xml", corePropsXML(title, now)},
		{"docProps/app.xml", appPropsXML()},
		{"word/_rels/document.xml.rels", b.relsXML()},
		{"word/styles.xml", stylesXML()},
		{"word/numbering.xml", numberingXML(b.numInstances)},
		{"word/document.xml", b.documentXML()},
	}
	return writeDocxZip(out, parts)
}

// ---------------------------------------------------------------- builder

type relationship struct {
	id     string
	target string
}

type runStyle struct {
	bold      bool
	italic    bool
	strike    bool
	code      bool
	math      bool
	hyperlink bool
}

type docxBuilder struct {
	src  []byte
	body strings.Builder

	rels         []relationship
	numInstances []int // index+1 == numId, value == abstract numbering id

	listStack []listFrame
}

type listFrame struct {
	numID   int
	ordered bool
	depth   int
}

func (b *docxBuilder) documentXML() string {
	var sb strings.Builder
	sb.WriteString(xmlHeader)
	fmt.Fprintf(&sb, `<w:document xmlns:w="%s" xmlns:r="%s"><w:body>`, nsW, nsR)
	sb.WriteString(b.body.String())
	sb.WriteString(`<w:sectPr>` +
		`<w:pgSz w:w="11906" w:h="16838"/>` +
		`<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/>` +
		`<w:cols w:space="425"/><w:docGrid w:linePitch="312"/>` +
		`</w:sectPr>`)
	sb.WriteString(`</w:body></w:document>`)
	return sb.String()
}

func (b *docxBuilder) relsXML() string {
	var sb strings.Builder
	sb.WriteString(xmlHeader)
	sb.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	sb.WriteString(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`)
	sb.WriteString(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`)
	for _, rel := range b.rels {
		fmt.Fprintf(&sb,
			`<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="%s" TargetMode="External"/>`,
			rel.id, esc(rel.target))
	}
	sb.WriteString(`</Relationships>`)
	return sb.String()
}

func (b *docxBuilder) addHyperlink(target string) string {
	id := fmt.Sprintf("rId%d", len(b.rels)+100)
	b.rels = append(b.rels, relationship{id: id, target: target})
	return id
}

func (b *docxBuilder) newList(ordered bool) int {
	abstract := abstractBullet
	if ordered {
		abstract = abstractDecimal
	}
	b.numInstances = append(b.numInstances, abstract)
	return len(b.numInstances)
}

// ---------------------------------------------------------------- emitters

func (b *docxBuilder) paragraph(style, extraPPr string, content func()) {
	b.body.WriteString(`<w:p>`)
	if style != "" || extraPPr != "" {
		b.body.WriteString(`<w:pPr>`)
		if style != "" {
			fmt.Fprintf(&b.body, `<w:pStyle w:val="%s"/>`, style)
		}
		b.body.WriteString(extraPPr)
		b.body.WriteString(`</w:pPr>`)
	}
	if content != nil {
		content()
	}
	b.body.WriteString(`</w:p>`)
}

func (b *docxBuilder) text(s string, st runStyle) {
	if s == "" {
		return
	}
	// Word keeps a run's text on one line; explicit breaks need <w:br/>.
	segments := strings.Split(s, "\n")
	for i, seg := range segments {
		if i > 0 {
			b.body.WriteString(`<w:r><w:br/></w:r>`)
		}
		if seg == "" {
			continue
		}
		b.body.WriteString(`<w:r>`)
		b.runProps(st)
		fmt.Fprintf(&b.body, `<w:t xml:space="preserve">%s</w:t>`, esc(seg))
		b.body.WriteString(`</w:r>`)
	}
}

func (b *docxBuilder) runProps(st runStyle) {
	var p strings.Builder
	switch {
	case st.code:
		p.WriteString(`<w:rStyle w:val="CodeChar"/>`)
	case st.math:
		p.WriteString(`<w:rStyle w:val="MathChar"/>`)
	case st.hyperlink:
		p.WriteString(`<w:rStyle w:val="Hyperlink"/>`)
	}
	if st.bold {
		p.WriteString(`<w:b/>`)
	}
	if st.italic {
		p.WriteString(`<w:i/>`)
	}
	if st.strike {
		p.WriteString(`<w:strike/>`)
	}
	if p.Len() > 0 {
		fmt.Fprintf(&b.body, `<w:rPr>%s</w:rPr>`, p.String())
	}
}

// ---------------------------------------------------------------- walking

func (b *docxBuilder) walkChildren(n ast.Node) {
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		b.block(c)
	}
}

func (b *docxBuilder) block(n ast.Node) {
	switch node := n.(type) {
	case *ast.Heading:
		level := node.Level
		if level < 1 {
			level = 1
		}
		if level > 6 {
			level = 6
		}
		b.paragraph(fmt.Sprintf("Heading%d", level), "", func() {
			b.inlineChildren(node, runStyle{})
		})

	case *ast.Paragraph, *ast.TextBlock:
		if b.emitDisplayMath(n) {
			return
		}
		style, extra := b.listContext(hasTaskCheckbox(n))
		b.paragraph(style, extra, func() { b.inlineChildren(n, runStyle{}) })

	case *ast.Blockquote:
		b.walkQuote(node)

	case *ast.List:
		b.walkList(node)

	case *ast.ListItem:
		b.walkChildren(node)

	case *ast.FencedCodeBlock:
		b.codeBlock(node.Lines(), string(node.Language(b.src)))

	case *ast.CodeBlock:
		b.codeBlock(node.Lines(), "")

	case *ast.ThematicBreak:
		b.paragraph("Normal",
			`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9DCE1"/></w:pBdr>`+
				`<w:spacing w:before="160" w:after="160"/>`, nil)

	case *extast.Table:
		b.table(node)

	case *ast.HTMLBlock:
		// Raw HTML has no Word equivalent; keep the source visible instead of
		// silently dropping content.
		b.codeBlock(node.Lines(), "html")

	default:
		if n.Type() == ast.TypeBlock {
			b.walkChildren(n)
		}
	}
}

// listContext returns the paragraph style and numbering properties for the
// list level currently being walked.
//
// Task items are indented but not numbered: the checkbox already marks the
// item, and a bullet next to it reads as a duplicate, which is also how the
// in-app preview renders them.
func (b *docxBuilder) listContext(isTask bool) (string, string) {
	if len(b.listStack) == 0 {
		return "", ""
	}
	f := b.listStack[len(b.listStack)-1]
	ilvl := f.depth
	if ilvl > 8 {
		ilvl = 8
	}
	if isTask {
		return "ListParagraph", fmt.Sprintf(`<w:ind w:left="%d"/>`, 420+ilvl*420)
	}
	return "ListParagraph", fmt.Sprintf(
		`<w:numPr><w:ilvl w:val="%d"/><w:numId w:val="%d"/></w:numPr>`, ilvl, f.numID)
}

func hasTaskCheckbox(n ast.Node) bool {
	first := n.FirstChild()
	if first == nil {
		return false
	}
	_, ok := first.(*extast.TaskCheckBox)
	return ok
}

func (b *docxBuilder) walkList(list *ast.List) {
	depth := 0
	numID := 0
	if len(b.listStack) > 0 {
		parent := b.listStack[len(b.listStack)-1]
		depth = parent.depth + 1
		// Nested levels reuse the parent's instance so Word treats them as one
		// multi-level list.
		if parent.ordered == list.IsOrdered() {
			numID = parent.numID
		}
	}
	if numID == 0 {
		numID = b.newList(list.IsOrdered())
	}

	b.listStack = append(b.listStack, listFrame{numID: numID, ordered: list.IsOrdered(), depth: depth})
	for item := list.FirstChild(); item != nil; item = item.NextSibling() {
		b.walkChildren(item)
	}
	b.listStack = b.listStack[:len(b.listStack)-1]
}

func (b *docxBuilder) walkQuote(q *ast.Blockquote) {
	for c := q.FirstChild(); c != nil; c = c.NextSibling() {
		switch c.(type) {
		case *ast.Paragraph, *ast.TextBlock:
			b.paragraph("Quote", "", func() { b.inlineChildren(c, runStyle{}) })
		default:
			b.block(c)
		}
	}
}

func (b *docxBuilder) codeBlock(lines *text.Segments, lang string) {
	// A one-cell shaded run of paragraphs reads as a code block in Word while
	// staying selectable and copyable.
	if lang != "" {
		b.paragraph("SourceCode",
			`<w:spacing w:before="160" w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="EDEFF2"/>`,
			func() {
				b.text(lang, runStyle{italic: true})
			})
	}
	count := lines.Len()
	if count == 0 {
		return
	}
	for i := 0; i < count; i++ {
		seg := lines.At(i)
		line := strings.TrimRight(string(seg.Value(b.src)), "\r\n")
		extra := ""
		if i == 0 && lang == "" {
			extra = `<w:spacing w:before="160" w:after="0"/>`
		}
		if i == count-1 {
			extra += `<w:spacing w:before="0" w:after="200"/>`
		}
		b.paragraph("SourceCode", extra, func() {
			if line == "" {
				return
			}
			b.body.WriteString(`<w:r>`)
			fmt.Fprintf(&b.body, `<w:t xml:space="preserve">%s</w:t>`, esc(line))
			b.body.WriteString(`</w:r>`)
		})
	}
}

func (b *docxBuilder) table(t *extast.Table) {
	b.body.WriteString(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>` +
		`<w:tblW w:w="5000" w:type="pct"/>` +
		`<w:tblLayout w:type="autofit"/></w:tblPr>`)

	for row := t.FirstChild(); row != nil; row = row.NextSibling() {
		isHeader := false
		if _, ok := row.(*extast.TableHeader); ok {
			isHeader = true
		}
		b.body.WriteString(`<w:tr>`)
		if isHeader {
			b.body.WriteString(`<w:trPr><w:tblHeader/></w:trPr>`)
		}
		for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
			b.body.WriteString(`<w:tc><w:tcPr><w:vAlign w:val="center"/>`)
			if isHeader {
				b.body.WriteString(`<w:shd w:val="clear" w:color="auto" w:fill="F5F6F8"/>`)
			}
			b.body.WriteString(`</w:tcPr>`)

			align := ""
			if tc, ok := cell.(*extast.TableCell); ok {
				switch tc.Alignment {
				case extast.AlignCenter:
					align = `<w:jc w:val="center"/>`
				case extast.AlignRight:
					align = `<w:jc w:val="right"/>`
				}
			}
			b.paragraph("Normal", align+`<w:spacing w:before="40" w:after="40"/>`, func() {
				b.inlineChildren(cell, runStyle{bold: isHeader})
			})
			b.body.WriteString(`</w:tc>`)
		}
		b.body.WriteString(`</w:tr>`)
	}
	b.body.WriteString(`</w:tbl>`)
	// Word needs a paragraph after a table, otherwise consecutive tables merge.
	b.paragraph("Normal", `<w:spacing w:before="0" w:after="120"/>`, nil)
}

// ---------------------------------------------------------------- inlines

func (b *docxBuilder) inlineChildren(n ast.Node, st runStyle) {
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		b.inline(c, st)
	}
}

func (b *docxBuilder) inline(n ast.Node, st runStyle) {
	switch node := n.(type) {
	case *ast.Text:
		b.mathAwareText(string(node.Segment.Value(b.src)), st)
		if node.SoftLineBreak() {
			b.text(" ", st)
		}
		if node.HardLineBreak() {
			b.body.WriteString(`<w:r><w:br/></w:r>`)
		}

	case *ast.String:
		b.mathAwareText(string(node.Value), st)

	case *ast.Emphasis:
		next := st
		if node.Level >= 2 {
			next.bold = true
		} else {
			next.italic = true
		}
		b.inlineChildren(node, next)

	case *extast.Strikethrough:
		next := st
		next.strike = true
		b.inlineChildren(node, next)

	case *ast.CodeSpan:
		next := st
		next.code = true
		b.text(nodeText(node, b.src), next)

	case *ast.Link:
		id := b.addHyperlink(string(node.Destination))
		fmt.Fprintf(&b.body, `<w:hyperlink r:id="%s">`, id)
		next := st
		next.hyperlink = true
		b.inlineChildren(node, next)
		b.body.WriteString(`</w:hyperlink>`)

	case *ast.AutoLink:
		url := string(node.URL(b.src))
		id := b.addHyperlink(url)
		fmt.Fprintf(&b.body, `<w:hyperlink r:id="%s">`, id)
		next := st
		next.hyperlink = true
		b.text(url, next)
		b.body.WriteString(`</w:hyperlink>`)

	case *ast.Image:
		alt := nodeText(node, b.src)
		if alt == "" {
			alt = "图片"
		}
		b.text("[图片: "+alt+"]", runStyle{italic: true})

	case *extast.TaskCheckBox:
		if node.IsChecked {
			b.text("☑ ", st)
		} else {
			b.text("☐ ", st)
		}

	case *ast.RawHTML:
		var sb strings.Builder
		for i := 0; i < node.Segments.Len(); i++ {
			seg := node.Segments.At(i)
			sb.Write(seg.Value(b.src))
		}
		raw := sb.String()
		// The preview escapes raw HTML rather than rendering it, so the export
		// shows the same literal text. Only a bare <br> is honoured, matching
		// the one exception the renderer makes.
		if isLineBreakTag(strings.TrimSpace(raw)) {
			b.body.WriteString(`<w:r><w:br/></w:r>`)
			return
		}
		b.text(raw, st)

	default:
		b.inlineChildren(n, st)
	}
}

// isLineBreakTag matches the handful of bare <br> spellings, and nothing that
// carries attributes.
func isLineBreakTag(s string) bool {
	switch strings.ToLower(s) {
	case "<br>", "<br/>", "<br />":
		return true
	}
	return false
}

func nodeText(n ast.Node, src []byte) string {
	var sb strings.Builder
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		switch t := c.(type) {
		case *ast.Text:
			sb.Write(t.Segment.Value(src))
		case *ast.String:
			sb.Write(t.Value)
		default:
			sb.WriteString(nodeText(c, src))
		}
	}
	if sb.Len() == 0 {
		if t, ok := n.(*ast.Text); ok {
			sb.Write(t.Segment.Value(src))
		}
	}
	return sb.String()
}

// ---------------------------------------------------------------- maths

// goldmark has no maths extension enabled here, so TeX arrives as plain text
// and is split out at the run level.
var inlineMathRe = regexp.MustCompile(`\$([^$\n]+?)\$`)

func (b *docxBuilder) mathAwareText(s string, st runStyle) {
	if st.code || !strings.Contains(s, "$") {
		b.text(s, st)
		return
	}
	locs := inlineMathRe.FindAllStringSubmatchIndex(s, -1)
	if locs == nil {
		b.text(s, st)
		return
	}
	cursor := 0
	for _, loc := range locs {
		if loc[0] > cursor {
			b.text(s[cursor:loc[0]], st)
		}
		mathSt := st
		mathSt.math = true
		b.text(strings.TrimSpace(s[loc[2]:loc[3]]), mathSt)
		cursor = loc[1]
	}
	if cursor < len(s) {
		b.text(s[cursor:], st)
	}
}

// emitDisplayMath renders a `$$ ... $$` paragraph as a centred formula block.
// Word has no way to consume KaTeX output, so the TeX source is presented
// verbatim in a monospace style rather than being dropped.
func (b *docxBuilder) emitDisplayMath(n ast.Node) bool {
	raw := strings.TrimSpace(nodeLines(n, b.src))
	if !strings.HasPrefix(raw, "$$") || !strings.HasSuffix(raw, "$$") || len(raw) < 5 {
		return false
	}
	inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(raw, "$$"), "$$"))
	if inner == "" || strings.Contains(inner, "$$") {
		return false
	}
	for _, line := range strings.Split(inner, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		b.paragraph("MathBlock", "", func() { b.text(line, runStyle{}) })
	}
	return true
}

func nodeLines(n ast.Node, src []byte) string {
	lines := n.Lines()
	if lines == nil || lines.Len() == 0 {
		return ""
	}
	var sb strings.Builder
	for i := 0; i < lines.Len(); i++ {
		seg := lines.At(i)
		sb.Write(seg.Value(src))
	}
	return sb.String()
}
