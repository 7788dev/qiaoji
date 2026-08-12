package exporter

import (
	"archive/zip"
	"fmt"
	"os"
	"strings"
)

// A .docx is a ZIP of WordprocessingML parts. Writing them directly (rather
// than through a builder library) is what lets code blocks keep a real
// monospace face, CJK text get an eastAsia font, and ordered lists restart
// properly.

const (
	nsW = `http://schemas.openxmlformats.org/wordprocessingml/2006/main`
	nsR = `http://schemas.openxmlformats.org/officeDocument/2006/relationships`

	latinFont = "Segoe UI"
	cjkFont   = "Microsoft YaHei"
	monoFont  = "Consolas"

	abstractBullet  = 0
	abstractDecimal = 1
)

const xmlHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n"

const contentTypesXML = xmlHeader + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const rootRelsXML = xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

// ---------------------------------------------------------------- styles

func stylesXML() string {
	var b strings.Builder
	b.WriteString(xmlHeader)
	fmt.Fprintf(&b, `<w:styles xmlns:w="%s">`, nsW)

	// Document defaults: 11pt body, 1.5 line spacing, CJK-aware font stack.
	fmt.Fprintf(&b, `<w:docDefaults><w:rPrDefault><w:rPr>`+
		`<w:rFonts w:ascii="%s" w:hAnsi="%s" w:eastAsia="%s" w:cs="%s"/>`+
		`<w:sz w:val="22"/><w:szCs w:val="22"/>`+
		`<w:lang w:val="en-US" w:eastAsia="zh-CN"/>`+
		`</w:rPr></w:rPrDefault>`+
		`<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="160" w:line="336" w:lineRule="auto"/></w:pPr></w:pPrDefault>`+
		`</w:docDefaults>`, latinFont, latinFont, cjkFont, latinFont)

	style(&b, "paragraph", "Normal", "正文", "", true, ``, ``)

	// Headings get outline levels so Word's navigation pane works.
	headings := []struct {
		id     string
		name   string
		size   int // half-points
		before int
		after  int
	}{
		{"Heading1", "标题 1", 40, 360, 200},
		{"Heading2", "标题 2", 30, 320, 160},
		{"Heading3", "标题 3", 26, 280, 140},
		{"Heading4", "标题 4", 23, 260, 130},
		{"Heading5", "标题 5", 22, 240, 120},
		{"Heading6", "标题 6", 22, 240, 120},
	}
	for i, h := range headings {
		pPr := fmt.Sprintf(
			`<w:keepNext/><w:keepLines/><w:spacing w:before="%d" w:after="%d" w:line="276" w:lineRule="auto"/><w:outlineLvl w:val="%d"/>`,
			h.before, h.after, i)
		rPr := fmt.Sprintf(`<w:b/><w:color w:val="1A1F26"/><w:sz w:val="%d"/><w:szCs w:val="%d"/>`, h.size, h.size)
		style(&b, "paragraph", h.id, h.name, "Normal", false, pPr, rPr)
	}

	style(&b, "paragraph", "Title", "标题", "Normal", false,
		`<w:spacing w:before="0" w:after="280"/>`,
		`<w:b/><w:sz w:val="52"/><w:szCs w:val="52"/><w:color w:val="1A1F26"/>`)

	style(&b, "paragraph", "Quote", "引用", "Normal", false,
		`<w:ind w:left="360"/><w:spacing w:before="120" w:after="120"/>`+
			`<w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="D5D8DD"/></w:pBdr>`,
		`<w:i/><w:color w:val="6B7280"/>`)

	style(&b, "paragraph", "SourceCode", "代码块", "Normal", false,
		`<w:spacing w:before="0" w:after="0" w:line="264" w:lineRule="auto"/>`+
			`<w:shd w:val="clear" w:color="auto" w:fill="F5F6F8"/>`+
			`<w:ind w:left="120" w:right="120"/>`+
			`<w:contextualSpacing/>`,
		fmt.Sprintf(`<w:rFonts w:ascii="%s" w:hAnsi="%s" w:eastAsia="%s" w:cs="%s"/><w:sz w:val="19"/><w:szCs w:val="19"/>`,
			monoFont, monoFont, monoFont, monoFont))

	style(&b, "paragraph", "MathBlock", "公式块", "Normal", false,
		`<w:jc w:val="center"/><w:spacing w:before="160" w:after="160"/>`,
		fmt.Sprintf(`<w:rFonts w:ascii="%s" w:hAnsi="%s" w:cs="%s"/><w:i/><w:color w:val="374151"/><w:sz w:val="21"/>`,
			monoFont, monoFont, monoFont))

	style(&b, "paragraph", "ListParagraph", "列表段落", "Normal", false,
		`<w:ind w:left="420"/><w:contextualSpacing/><w:spacing w:after="60"/>`, ``)

	style(&b, "character", "CodeChar", "行内代码", "", false, ``,
		fmt.Sprintf(`<w:rFonts w:ascii="%s" w:hAnsi="%s" w:cs="%s"/><w:sz w:val="19"/>`+
			`<w:shd w:val="clear" w:color="auto" w:fill="F0F1F4"/><w:color w:val="B5591B"/>`,
			monoFont, monoFont, monoFont))

	style(&b, "character", "Hyperlink", "超链接", "", false, ``,
		`<w:color w:val="2563A8"/><w:u w:val="single"/>`)

	style(&b, "character", "MathChar", "行内公式", "", false, ``,
		fmt.Sprintf(`<w:rFonts w:ascii="%s" w:hAnsi="%s" w:cs="%s"/><w:i/><w:color w:val="374151"/>`,
			monoFont, monoFont, monoFont))

	// TableGrid is the built-in name Word expects for a plainly bordered table.
	b.WriteString(`<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>` +
		`<w:basedOn w:val="TableNormal"/><w:tblPr>` +
		`<w:tblBorders>` +
		`<w:top w:val="single" w:sz="4" w:space="0" w:color="D9DCE1"/>` +
		`<w:left w:val="single" w:sz="4" w:space="0" w:color="D9DCE1"/>` +
		`<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D9DCE1"/>` +
		`<w:right w:val="single" w:sz="4" w:space="0" w:color="D9DCE1"/>` +
		`<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9DCE1"/>` +
		`<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9DCE1"/>` +
		`</w:tblBorders></w:tblPr></w:style>`)
	b.WriteString(`<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>` +
		`<w:tblPr><w:tblCellMar>` +
		`<w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>` +
		`<w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>` +
		`</w:tblCellMar></w:tblPr></w:style>`)

	b.WriteString(`</w:styles>`)
	return b.String()
}

func style(b *strings.Builder, kind, id, name, basedOn string, isDefault bool, pPr, rPr string) {
	def := ""
	if isDefault {
		def = ` w:default="1"`
	}
	fmt.Fprintf(b, `<w:style w:type="%s"%s w:styleId="%s"><w:name w:val="%s"/>`, kind, def, id, esc(name))
	if basedOn != "" {
		fmt.Fprintf(b, `<w:basedOn w:val="%s"/>`, basedOn)
	}
	fmt.Fprintf(b, `<w:qFormat/>`)
	if pPr != "" {
		fmt.Fprintf(b, `<w:pPr>%s</w:pPr>`, pPr)
	}
	if rPr != "" {
		fmt.Fprintf(b, `<w:rPr>%s</w:rPr>`, rPr)
	}
	b.WriteString(`</w:style>`)
}

// ---------------------------------------------------------------- numbering

// numberingXML emits one w:num per list instance so sibling ordered lists each
// restart at 1 instead of continuing the previous list's count.
func numberingXML(instances []int) string {
	var b strings.Builder
	b.WriteString(xmlHeader)
	fmt.Fprintf(&b, `<w:numbering xmlns:w="%s">`, nsW)

	for lvl := 0; lvl < 9; lvl++ {
		if lvl == 0 {
			fmt.Fprintf(&b, `<w:abstractNum w:abstractNumId="%d"><w:multiLevelType w:val="hybridMultilevel"/>`, abstractBullet)
		}
		font := "Wingdings"
		switch lvl % 3 {
		case 0:
			font = "Symbol"
		case 1:
			font = "Courier New"
		}
		fmt.Fprintf(&b,
			`<w:lvl w:ilvl="%d"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="%s"/>`+
				`<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="%d" w:hanging="360"/></w:pPr>`+
				`<w:rPr><w:rFonts w:ascii="%s" w:hAnsi="%s" w:hint="default"/></w:rPr></w:lvl>`,
			lvl, esc(bulletGlyph(lvl)), 420+lvl*420, font, font)
	}
	b.WriteString(`</w:abstractNum>`)

	for lvl := 0; lvl < 9; lvl++ {
		if lvl == 0 {
			fmt.Fprintf(&b, `<w:abstractNum w:abstractNumId="%d"><w:multiLevelType w:val="hybridMultilevel"/>`, abstractDecimal)
		}
		format := "decimal"
		switch lvl % 3 {
		case 1:
			format = "lowerLetter"
		case 2:
			format = "lowerRoman"
		}
		fmt.Fprintf(&b,
			`<w:lvl w:ilvl="%d"><w:start w:val="1"/><w:numFmt w:val="%s"/><w:lvlText w:val="%%%d."/>`+
				`<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="%d" w:hanging="360"/></w:pPr></w:lvl>`,
			lvl, format, lvl+1, 420+lvl*420)
	}
	b.WriteString(`</w:abstractNum>`)

	// Every instance overrides its start value. Without this, Word shares one
	// counter across all w:num entries that point at the same abstract
	// definition, so a second ordered list would continue at 3 instead of
	// restarting at 1.
	for i, abstract := range instances {
		fmt.Fprintf(&b, `<w:num w:numId="%d"><w:abstractNumId w:val="%d"/>`, i+1, abstract)
		for lvl := 0; lvl < 9; lvl++ {
			fmt.Fprintf(&b,
				`<w:lvlOverride w:ilvl="%d"><w:startOverride w:val="1"/></w:lvlOverride>`, lvl)
		}
		b.WriteString(`</w:num>`)
	}
	b.WriteString(`</w:numbering>`)
	return b.String()
}

func bulletGlyph(lvl int) string {
	switch lvl % 3 {
	case 0:
		return "\uf0b7" // Symbol bullet
	case 1:
		return "o"
	default:
		return "\uf0a7" // Wingdings square
	}
}

// ---------------------------------------------------------------- doc props

func corePropsXML(title, created string) string {
	return xmlHeader + `<cp:coreProperties ` +
		`xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
		`xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
		`xmlns:dcterms="http://purl.org/dc/terms/" ` +
		`xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
		`<dc:title>` + esc(title) + `</dc:title>` +
		`<dc:creator>巧记</dc:creator>` +
		`<cp:lastModifiedBy>巧记</cp:lastModifiedBy>` +
		`<dcterms:created xsi:type="dcterms:W3CDTF">` + created + `</dcterms:created>` +
		`<dcterms:modified xsi:type="dcterms:W3CDTF">` + created + `</dcterms:modified>` +
		`</cp:coreProperties>`
}

func appPropsXML() string {
	return xmlHeader + `<Properties ` +
		`xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
		`xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
		`<Application>巧记</Application>` +
		`<AppVersion>1.0000</AppVersion>` +
		`</Properties>`
}

// ---------------------------------------------------------------- packaging

type part struct {
	name string
	data string
}

func writeDocxZip(out string, parts []part) error {
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	for _, p := range parts {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: p.name, Method: zip.Deflate})
		if err != nil {
			zw.Close()
			return err
		}
		if _, err := w.Write([]byte(p.data)); err != nil {
			zw.Close()
			return err
		}
	}
	return zw.Close()
}

// esc escapes XML metacharacters and drops codepoints that are illegal in XML
// 1.0, which Word rejects outright.
func esc(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&apos;")
		case '\t', '\n', '\r':
			b.WriteRune(r)
		default:
			if r < 0x20 || (r >= 0xD800 && r <= 0xDFFF) || r == 0xFFFE || r == 0xFFFF {
				continue
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}
