package exporter

import (
	"embed"
	"html"
	"strings"
)

//go:embed assets/document.css assets/katex-inline.css
var assets embed.FS

func documentCSS() string {
	b, _ := assets.ReadFile("assets/document.css")
	return string(b)
}

// katexCSS is ~360 KB with the woff2 faces inlined, so it is only pulled in
// for notes that actually contain maths.
func katexCSS() string {
	b, _ := assets.ReadFile("assets/katex-inline.css")
	return string(b)
}

// standaloneHTML wraps the rendered preview markup into one self-contained
// file: no network, no sidecar assets, opens correctly years from now.
func standaloneHTML(r Request) (string, error) {
	title := strings.TrimSpace(r.Title)
	if title == "" {
		title = "未命名笔记"
	}

	var sb strings.Builder
	sb.Grow(len(r.BodyHTML) + 40*1024)
	sb.WriteString("<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n")
	sb.WriteString("<meta charset=\"utf-8\">\n")
	sb.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	sb.WriteString("<meta name=\"generator\" content=\"巧记\">\n")
	sb.WriteString("<title>" + html.EscapeString(title) + "</title>\n")
	sb.WriteString("<style>\n")
	sb.WriteString(documentCSS())
	if r.HasMath {
		sb.WriteString("\n")
		sb.WriteString(katexCSS())
	}
	sb.WriteString("\n</style>\n</head>\n<body>\n")
	sb.WriteString("<article class=\"qiaoji-doc\">\n")
	sb.WriteString(r.BodyHTML)
	sb.WriteString("\n</article>\n</body>\n</html>\n")
	return sb.String(), nil
}

// toPlainText flattens Markdown for .txt export: markers removed, structure
// kept through blank lines and indentation.
func toPlainText(md string) string {
	var out []string
	inFence := false

	for _, raw := range strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n") {
		line := raw
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			out = append(out, "    "+line)
			continue
		}
		if trimmed == "" {
			out = append(out, "")
			continue
		}
		if isThematicBreak(trimmed) {
			out = append(out, strings.Repeat("─", 40))
			continue
		}

		indent := line[:len(line)-len(strings.TrimLeft(line, " \t"))]

		if strings.HasPrefix(trimmed, "#") {
			text := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			out = append(out, inlinePlain(text))
			continue
		}
		if strings.HasPrefix(trimmed, ">") {
			out = append(out, indent+"| "+inlinePlain(strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))))
			continue
		}
		if m := listMarker(trimmed); m != "" {
			body := strings.TrimSpace(strings.TrimPrefix(trimmed, m))
			switch {
			case strings.HasPrefix(body, "[ ] "):
				body = "☐ " + strings.TrimPrefix(body, "[ ] ")
			case strings.HasPrefix(body, "[x] "), strings.HasPrefix(body, "[X] "):
				body = "☑ " + body[4:]
			}
			out = append(out, indent+"• "+inlinePlain(body))
			continue
		}
		out = append(out, indent+inlinePlain(trimmed))
	}

	text := strings.Join(out, "\n")
	for strings.Contains(text, "\n\n\n") {
		text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(text) + "\n"
}

func isThematicBreak(s string) bool {
	for _, ch := range []string{"-", "*", "_"} {
		if len(s) >= 3 && strings.Trim(s, ch+" ") == "" && strings.Contains(s, ch) {
			return true
		}
	}
	return false
}

func listMarker(s string) string {
	for _, m := range []string{"- ", "* ", "+ "} {
		if strings.HasPrefix(s, m) {
			return m
		}
	}
	// ordered list: digits followed by . or )
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i > 0 && i+1 < len(s) && (s[i] == '.' || s[i] == ')') && s[i+1] == ' ' {
		return s[:i+2]
	}
	return ""
}

// inlinePlain strips emphasis, code ticks and link syntax while keeping the
// visible text.
func inlinePlain(s string) string {
	s = stripLinks(s)
	s = strings.NewReplacer("**", "", "__", "", "~~", "", "`", "").Replace(s)
	return s
}

// stripLinks turns [text](url) into text and ![alt](url) into [图片: alt].
func stripLinks(s string) string {
	var sb strings.Builder
	i := 0
	for i < len(s) {
		isImage := false
		start := i
		if s[i] == '!' && i+1 < len(s) && s[i+1] == '[' {
			isImage = true
			i++
		}
		if s[i] != '[' {
			sb.WriteByte(s[i])
			i++
			continue
		}
		close := strings.IndexByte(s[i:], ']')
		if close < 0 || i+close+1 >= len(s) || s[i+close+1] != '(' {
			sb.WriteString(s[start : i+1])
			i++
			continue
		}
		text := s[i+1 : i+close]
		rest := s[i+close+2:]
		end := strings.IndexByte(rest, ')')
		if end < 0 {
			sb.WriteString(s[start : i+1])
			i++
			continue
		}
		if isImage {
			if text == "" {
				text = "图片"
			}
			sb.WriteString("[图片: " + text + "]")
		} else {
			sb.WriteString(text)
		}
		i = i + close + 2 + end + 1
	}
	return sb.String()
}
