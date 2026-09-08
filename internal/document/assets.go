package document

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

const MaxAssetBytes = 25 << 20

type asset struct {
	data      []byte
	mime, ext string
}

func imageAsset(data []byte) (asset, error) {
	if len(data) == 0 || len(data) > MaxAssetBytes {
		return asset{}, errors.New("图片为空或超过 25 MB")
	}
	mime := http.DetectContentType(data)
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[mime]
	if ext == "" {
		return asset{}, errors.New("支持 PNG、JPEG、GIF 和 WebP 图片")
	}
	return asset{data: data, mime: mime, ext: ext}, nil
}

func (m *Manager) StageAsset(id string, reader io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxAssetBytes+1))
	if err != nil {
		return "", err
	}
	value, err := imageAsset(data)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.docs[id]
	if s == nil {
		return "", ErrClosed
	}
	key := Revision(data)
	if _, ok := s.assets[key]; ok {
		return "qiaoji-asset:" + key, nil
	}
	total := len(data)
	for _, a := range s.assets {
		total += len(a.data)
	}
	if total > 100<<20 {
		return "", errors.New("暂存图片超过 100 MB，请先保存文档")
	}
	s.assets[key] = value
	return "qiaoji-asset:" + key, nil
}

// AuthorizeImages records only image references from the live editing buffer.
// It neither acknowledges a disk revision nor writes the document or assets.
func (m *Manager) AuthorizeImages(id, source string) error {
	if len(source) > MaxBytes {
		return errors.New("文档超过 8 MB 限制")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.docs[id]
	if s == nil {
		return ErrClosed
	}
	revision := Revision([]byte(source))
	if s.imageSource == revision {
		return nil
	}
	refs := make(map[string]bool)
	for _, ref := range imageReferences(source) {
		refs[ref.href] = true
	}
	s.imageSource, s.imageRefs = revision, refs
	return nil
}

// Asset only serves raster images belonging to an open document. It cannot be
// used to read arbitrary text files or execute local HTML in the WebView.
func (m *Manager) Asset(id, href string) ([]byte, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.docs[id]
	if s == nil {
		return nil, "", ErrClosed
	}
	if path, ok := s.assetAliases[href]; ok {
		a, err := readImage(path)
		return a.data, a.mime, err
	}
	if strings.HasPrefix(href, "qiaoji-asset:") {
		a, ok := s.assets[strings.TrimPrefix(href, "qiaoji-asset:")]
		if !ok {
			return nil, "", os.ErrNotExist
		}
		return a.data, a.mime, nil
	}
	path, err := localImagePath(s.document.Path, href)
	if err != nil {
		return nil, "", err
	}
	rel, err := filepath.Rel(filepath.Dir(s.document.Path), path)
	inside := err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	if !inside {
		// References explicitly present in a file the user opened may point to
		// sibling image folders. Unrelated paths are not an asset API.
		found := s.imageRefs[href]
		for _, ref := range imageReferences(s.document.Content) {
			if ref.href == href {
				found = true
				break
			}
		}
		if !found {
			return nil, "", errors.New("图片未被当前文档引用")
		}
	}
	a, err := readImage(path)
	return a.data, a.mime, err
}

func localImagePath(note, href string) (string, error) {
	if note == "" {
		return "", errors.New("请先保存文档再使用本地图片路径")
	}
	href = strings.ReplaceAll(strings.ReplaceAll(href, `\)`, ")"), `\(`, "(")
	href = strings.ReplaceAll(href, `\`, "/")
	if len(href) > 2 && href[1] == ':' && href[2] == '/' {
		href = "file:///" + href
	}
	parsed, err := url.Parse(href)
	if err != nil {
		return "", err
	}
	var path string
	if parsed.Scheme == "file" {
		if parsed.Host != "" {
			return "", errors.New("不支持网络共享图片")
		}
		path = parsed.Path
		if len(path) > 2 && path[0] == '/' && path[2] == ':' {
			path = path[1:]
		}
	} else if parsed.Scheme == "" && parsed.Host == "" {
		path = parsed.Path
	} else {
		return "", errors.New("不是本地图片")
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(filepath.Dir(note), filepath.FromSlash(path))
	}
	path = filepath.Clean(path)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	if PathKey(resolved) != PathKey(path) {
		return "", errors.New("不允许通过符号链接读取图片")
	}
	return path, nil
}

func readImage(path string) (asset, error) {
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return asset{}, err
	}
	if PathKey(canonical) != PathKey(path) {
		return asset{}, errors.New("不允许通过符号链接读取图片")
	}
	f, err := os.Open(path)
	if err != nil {
		return asset{}, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, MaxAssetBytes+1))
	if err != nil {
		return asset{}, err
	}
	return imageAsset(raw)
}

type imageReference struct {
	from, to int
	href     string
	angle    bool
}

var inlineImage = regexp.MustCompile(`!\[(?:\\.|[^\]\\\r\n])*\]\([ \t]*(<[^>\r\n]+>|(?:\\.|[^()\s]|\([^()\r\n]*\))+)(?:[ \t]+[^)\r\n]*)?\)`)
var referenceImage = regexp.MustCompile(`!\[([^\]\r\n]+)\](?:\[([^\]\r\n]*)\])?`)
var referenceDefinition = regexp.MustCompile(`(?m)^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(<[^>\r\n]+>|[^\s]+)`)
var frontMatterEnvelope = regexp.MustCompile("(?ms)^\\x{FEFF}?---[ \\t]*\\r?\\n(.*?)^(?:---|\\.\\.\\.)[ \\t]*(?:\\r?\\n|$)")

func imageReferences(source string) []imageReference {
	raw := []byte(source)
	tree := goldmark.New().Parser().Parse(text.NewReader(raw))
	type span struct{ from, to int }
	var code []span
	if header := frontMatterEnvelope.FindStringIndex(source); header != nil && header[0] == 0 {
		code = append(code, span{0, header[1]})
	}
	_ = ast.Walk(tree, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n.(type) {
		case *ast.FencedCodeBlock, *ast.CodeBlock:
			lines := n.Lines()
			for i := 0; i < lines.Len(); i++ {
				line := lines.At(i)
				code = append(code, span{line.Start, line.Stop})
			}
		case *ast.CodeSpan:
			for c := n.FirstChild(); c != nil; c = c.NextSibling() {
				if t, ok := c.(*ast.Text); ok {
					code = append(code, span{t.Segment.Start, t.Segment.Stop})
				}
			}
		}
		return ast.WalkContinue, nil
	})
	inCode := func(at int) bool {
		escapes := 0
		for i := at - 1; i >= 0 && source[i] == '\\'; i-- {
			escapes++
		}
		if escapes%2 != 0 {
			return true
		}
		for _, s := range code {
			if at >= s.from && at < s.to {
				return true
			}
		}
		return false
	}
	var out []imageReference
	add := func(from, to int) {
		value := source[from:to]
		angle := strings.HasPrefix(value, "<")
		if angle {
			value = strings.TrimSuffix(strings.TrimPrefix(value, "<"), ">")
		}
		out = append(out, imageReference{from: from, to: to, href: value, angle: angle})
	}
	for _, match := range inlineImage.FindAllStringSubmatchIndex(source, -1) {
		if !inCode(match[0]) {
			add(match[2], match[3])
		}
	}
	labels := map[string]bool{}
	labelKey := func(v string) string { return strings.ToLower(strings.Join(strings.Fields(v), " ")) }
	for _, match := range referenceImage.FindAllStringSubmatchIndex(source, -1) {
		if inCode(match[0]) || (match[1] < len(source) && source[match[1]] == '(') {
			continue
		}
		label := source[match[2]:match[3]]
		if match[4] >= 0 && match[5] > match[4] {
			label = source[match[4]:match[5]]
		}
		labels[labelKey(label)] = true
	}
	for _, match := range referenceDefinition.FindAllStringSubmatchIndex(source, -1) {
		if !inCode(match[0]) && labels[labelKey(source[match[2]:match[3]])] {
			add(match[4], match[5])
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].from < out[j].from })
	return out
}

func writeImage(dir string, a asset) (relative, created string, err error) {
	assetsDir := filepath.Join(dir, "assets")
	if info, statErr := os.Lstat(assetsDir); statErr == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()) {
		return "", "", errors.New("assets 必须是普通文件夹")
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return "", "", statErr
	}
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		return "", "", err
	}
	base := "image-" + Revision(a.data)[:16]
	for attempt := 0; attempt < 8; attempt++ {
		name := base + a.ext
		if attempt > 0 {
			name = base + "-" + newID()[:8] + a.ext
		}
		path := filepath.Join(assetsDir, name)
		if info, e := os.Lstat(path); e == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			existing, e := os.ReadFile(path)
			if e == nil && bytes.Equal(existing, a.data) {
				return "assets/" + name, "", nil
			}
			continue
		}
		f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if os.IsExist(e) {
			continue
		}
		if e != nil {
			return "", "", e
		}
		_, e = f.Write(a.data)
		if e == nil {
			e = f.Sync()
		}
		closeErr := f.Close()
		if e == nil {
			e = closeErr
		}
		if e != nil {
			_ = os.Remove(path)
			return "", "", e
		}
		return "assets/" + name, path, nil
	}
	return "", "", errors.New("无法为图片创建文件")
}

func (s *session) prepareAssets(content, target string) (string, []string, map[string]string, error) {
	refs := imageReferences(content)
	copyLocal := s.document.Path != "" && PathKey(filepath.Dir(target)) != PathKey(filepath.Dir(s.document.Path))
	created := []string{}
	aliases := map[string]string{}
	var out strings.Builder
	last := 0
	for _, ref := range refs {
		var value asset
		var err error
		staged := strings.HasPrefix(ref.href, "qiaoji-asset:")
		if previous, ok := s.assetAliases[ref.href]; ok {
			value, err = readImage(previous)
		} else if staged {
			var ok bool
			value, ok = s.assets[strings.TrimPrefix(ref.href, "qiaoji-asset:")]
			if !ok {
				err = errors.New("暂存图片不存在，请重新插入")
			}
		} else if copyLocal {
			windowsPath := len(ref.href) > 2 && ref.href[1] == ':' && (ref.href[2] == '/' || ref.href[2] == '\\')
			parsed, e := url.Parse(strings.ReplaceAll(ref.href, `\`, "/"))
			if !windowsPath && (e != nil || (parsed.Scheme != "" && parsed.Scheme != "file") || parsed.Host != "") {
				continue
			}
			path, e := localImagePath(s.document.Path, ref.href)
			if e == nil {
				value, e = readImage(path)
			}
			err = e
		} else {
			continue
		}
		if err != nil {
			for _, path := range created {
				_ = os.Remove(path)
			}
			return "", nil, nil, fmt.Errorf("无法保存图片 %s: %w", ref.href, err)
		}
		relative, path, err := writeImage(filepath.Dir(target), value)
		if err != nil {
			for _, path := range created {
				_ = os.Remove(path)
			}
			return "", nil, nil, err
		}
		if path != "" {
			created = append(created, path)
		}
		aliases[ref.href] = filepath.Join(filepath.Dir(target), filepath.FromSlash(relative))
		out.WriteString(content[last:ref.from])
		if ref.angle {
			relative = "<" + relative + ">"
		}
		out.WriteString(relative)
		last = ref.to
	}
	out.WriteString(content[last:])
	return out.String(), created, aliases, nil
}
