// Package document owns open Markdown files independently of the folder browser.
package document

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unicode/utf8"

	"qiaoji/internal/store"
)

const MaxBytes = 8 << 20

var (
	ErrConflict = errors.New("文件已在磁盘上被修改")
	ErrExists   = errors.New("目标文件已存在")
	ErrClosed   = errors.New("文档已经关闭")
)

type Document struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	Content  string `json:"content"`
	Revision string `json:"revision"`
	ReadOnly bool   `json:"readOnly"`
}

type SaveRequest struct {
	ID               string
	Content          string
	Path             string
	ExpectedRevision string
	TargetRevision   string
	Force            bool
}

type session struct {
	document     Document
	assets       map[string]asset
	assetAliases map[string]string
	imageSource  string
	imageRefs    map[string]bool
	observed     string
}

type Manager struct {
	mu    sync.Mutex
	docs  map[string]*session
	paths map[string]string
}

func NewManager() *Manager {
	return &Manager{docs: make(map[string]*session), paths: make(map[string]string)}
}

func newID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value[:])
}

func Revision(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func PathKey(path string) string {
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return path
}

func CanonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	// Resolve the selected parent, but reject a final symlink. Replacing a link
	// itself would change the meaning of a user-selected document.
	parent, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	abs = filepath.Join(parent, filepath.Base(abs))
	info, err := os.Lstat(abs)
	if err == nil && (info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return "", errors.New("请选择普通 Markdown 文件")
	}
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(abs))
	if ext != ".md" && ext != ".markdown" {
		return "", errors.New("请选择 .md 或 .markdown 文件")
	}
	return filepath.Clean(abs), nil
}

func Read(path string) (Document, error) {
	canonical, err := CanonicalPath(path)
	if err != nil {
		return Document{}, err
	}
	file, err := os.Open(canonical)
	if err != nil {
		return Document{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Document{}, err
	}
	if info.Size() > MaxBytes {
		return Document{}, errors.New("文档超过 8 MB 限制")
	}
	raw, err := io.ReadAll(io.LimitReader(file, MaxBytes+1))
	if err != nil {
		return Document{}, err
	}
	if len(raw) > MaxBytes {
		return Document{}, errors.New("文档超过 8 MB 限制")
	}
	if !utf8.Valid(raw) {
		return Document{}, errors.New("文件不是 UTF-8 编码，请先转换编码后打开")
	}
	return Document{
		Path: canonical, Name: filepath.Base(canonical), Content: string(raw),
		Revision: Revision(raw), ReadOnly: info.Mode().Perm()&0o222 == 0,
	}, nil
}

func (m *Manager) New() Document {
	m.mu.Lock()
	defer m.mu.Unlock()
	doc := Document{ID: newID(), Name: "未命名"}
	m.docs[doc.ID] = &session{document: doc, assets: make(map[string]asset)}
	return doc
}

func (m *Manager) Open(path string) (Document, error) {
	doc, err := Read(path)
	if err != nil {
		return Document{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.paths[PathKey(doc.Path)]; ok {
		return m.docs[id].document, nil
	}
	doc.ID = newID()
	m.docs[doc.ID] = &session{document: doc, assets: make(map[string]asset), observed: fileStamp(doc.Path)}
	m.paths[PathKey(doc.Path)] = doc.ID
	return doc, nil
}

func (m *Manager) Get(id string) (Document, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.docs[id]
	if s == nil {
		return Document{}, ErrClosed
	}
	return s.document, nil
}

func (m *Manager) Disk(id string) (Document, error) {
	doc, err := m.Get(id)
	if err != nil || doc.Path == "" {
		return doc, err
	}
	next, err := Read(doc.Path)
	next.ID = id
	return next, err
}

// AcceptDisk acknowledges a reload only if that exact revision is still current.
func (m *Manager) AcceptDisk(id, revision string) (Document, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.docs[id]
	if s == nil {
		return Document{}, ErrClosed
	}
	doc, err := Read(s.document.Path)
	if err != nil {
		return Document{}, err
	}
	if doc.Revision != revision {
		return Document{}, ErrConflict
	}
	doc.ID = id
	s.document = doc
	s.observed = fileStamp(doc.Path)
	return doc, nil
}

func (m *Manager) Close(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.docs[id]; s != nil {
		if s.document.Path != "" {
			delete(m.paths, PathKey(s.document.Path))
		}
		delete(m.docs, id)
	}
}

// Save serialises file writes with revision checking. A no-op save does not
// touch the mtime, header, BOM, newline style or Markdown spelling.
func (m *Manager) Save(req SaveRequest) (Document, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.docs[req.ID]
	if s == nil {
		return Document{}, ErrClosed
	}
	if len(req.Content) > MaxBytes {
		return Document{}, errors.New("文档超过 8 MB 限制")
	}
	if !utf8.ValidString(req.Content) {
		return Document{}, errors.New("文档不是 UTF-8 编码")
	}
	target := req.Path
	if target == "" {
		target = s.document.Path
	}
	if target == "" {
		return Document{}, errors.New("请先选择保存位置")
	}
	target, err := CanonicalPath(target)
	if err != nil {
		return Document{}, err
	}
	same := s.document.Path != "" && PathKey(target) == PathKey(s.document.Path)
	if other := m.paths[PathKey(target)]; other != "" && other != req.ID {
		return Document{}, errors.New("目标文件已在另一个标签页中打开")
	}
	disk, err := Read(target)
	exists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return Document{}, err
	}
	// Even an explicit overwrite applies only to the revision the user reviewed.
	if same && (!exists || disk.Revision != req.ExpectedRevision) {
		return Document{}, ErrConflict
	}
	if !same && exists && disk.Revision != req.TargetRevision {
		return Document{}, ErrExists
	}
	if same && exists && disk.Content == req.Content {
		disk.ID = req.ID
		s.document = disk
		s.observed = fileStamp(target)
		return disk, nil
	}
	if exists && disk.ReadOnly {
		return Document{}, errors.New("文件为只读，请使用另存为")
	}
	content, created, aliases, err := s.prepareAssets(req.Content, target)
	if err != nil {
		return Document{}, err
	}
	rollbackAssets := func() {
		for _, path := range created {
			_ = os.Remove(path)
		}
	}
	if len(content) > MaxBytes {
		rollbackAssets()
		return Document{}, errors.New("文档超过 8 MB 限制")
	}
	if !exists || disk.Content != content {
		if err := store.WriteDocument(target, []byte(content)); err != nil {
			rollbackAssets()
			return Document{}, fmt.Errorf("保存文件失败: %w", err)
		}
	}
	doc, err := Read(target)
	if err != nil {
		return Document{}, err
	}
	doc.ID = req.ID
	if s.document.Path != "" {
		delete(m.paths, PathKey(s.document.Path))
	}
	m.paths[PathKey(target)] = req.ID
	s.document = doc
	s.observed = fileStamp(doc.Path)
	if s.assetAliases == nil {
		s.assetAliases = make(map[string]string)
	}
	for href, path := range aliases {
		s.assetAliases[href] = path
		if strings.HasPrefix(href, "qiaoji-asset:") {
			delete(s.assets, strings.TrimPrefix(href, "qiaoji-asset:"))
		}
	}
	return doc, nil
}

type Change struct {
	ID       string    `json:"id"`
	Document *Document `json:"document"`
	Missing  bool      `json:"missing"`
	Error    string    `json:"error"`
}

func fileStamp(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "missing"
	}
	return fmt.Sprintf("%d:%d:%d", info.Size(), info.ModTime().UnixNano(), info.Mode())
}

// Check is the fallback for files outside the watched folder. Unchanged files
// cost a stat only; source is returned solely after an external change.
func (m *Manager) Check() []Change {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Change{}
	for id, s := range m.docs {
		if s.document.Path == "" {
			continue
		}
		stamp := fileStamp(s.document.Path)
		if stamp == s.observed {
			continue
		}
		s.observed = stamp
		if stamp == "missing" {
			out = append(out, Change{ID: id, Missing: true})
			continue
		}
		doc, err := Read(s.document.Path)
		if err != nil {
			out = append(out, Change{ID: id, Error: err.Error()})
			continue
		}
		doc.ID = id
		out = append(out, Change{ID: id, Document: &doc})
	}
	return out
}

func (m *Manager) Rename(id, name string) (Document, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.docs[id]
	if s == nil {
		return Document{}, ErrClosed
	}
	if s.document.Path == "" {
		return Document{}, errors.New("请先保存文档")
	}
	if name != filepath.Base(name) || strings.ContainsAny(name, `\/:*?"<>|`) || strings.TrimSpace(name) != name {
		return Document{}, errors.New("文件名无效")
	}
	target, err := CanonicalPath(filepath.Join(filepath.Dir(s.document.Path), name))
	if err != nil {
		return Document{}, err
	}
	if PathKey(target) == PathKey(s.document.Path) {
		return s.document, nil
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		return Document{}, ErrExists
	}
	if err := os.Rename(s.document.Path, target); err != nil {
		return Document{}, err
	}
	delete(m.paths, PathKey(s.document.Path))
	s.document.Path = target
	s.document.Name = filepath.Base(target)
	s.observed = fileStamp(target)
	m.paths[PathKey(target)] = id
	return s.document, nil
}
