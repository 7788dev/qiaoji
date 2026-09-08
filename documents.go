package main

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"qiaoji/internal/config"
	"qiaoji/internal/document"
	"qiaoji/internal/store"
)

func (a *App) NewDocument() document.Document { return a.documents.New() }

func (a *App) OpenDocument(path string) (document.Document, error) {
	if path == "" {
		var err error
		path, err = runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
			Title:            "打开 Markdown 文件",
			DefaultDirectory: a.settings.Get().WorkspacePath,
			Filters:          []runtime.FileFilter{{DisplayName: "Markdown 文件", Pattern: "*.md;*.markdown"}},
		})
		if err != nil || path == "" {
			return document.Document{}, err
		}
	}
	return a.documents.Open(path)
}

func (a *App) SaveDocument(id, content, revision string, force bool) (document.Document, error) {
	doc, err := a.documents.Get(id)
	if err != nil {
		return document.Document{}, err
	}
	if doc.Path == "" {
		return a.SaveDocumentAs(id, content)
	}
	return a.documents.Save(document.SaveRequest{
		ID: id, Content: content, ExpectedRevision: revision, Force: force,
	})
}

func (a *App) SaveDocumentAs(id, content string) (document.Document, error) {
	doc, err := a.documents.Get(id)
	if err != nil {
		return document.Document{}, err
	}
	dir := a.settings.Get().WorkspacePath
	name := doc.Name
	if doc.Path != "" {
		dir = filepath.Dir(doc.Path)
	} else {
		name = "未命名.md"
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title: "另存为", DefaultDirectory: dir, DefaultFilename: name,
		Filters: []runtime.FileFilter{{DisplayName: "Markdown 文件", Pattern: "*.md;*.markdown"}},
	})
	if err != nil || path == "" {
		return document.Document{}, err
	}
	addedExtension := filepath.Ext(path) == ""
	if addedExtension {
		path += ".md"
	}
	targetRevision := ""
	if target, readErr := document.Read(path); readErr == nil {
		targetRevision = target.Revision
		if addedExtension {
			answer, dialogErr := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
				Type: runtime.QuestionDialog, Title: "替换文件",
				Message: path + " 已存在，要替换这个文件吗？",
				Buttons: []string{"替换", "取消"}, DefaultButton: "取消", CancelButton: "取消",
			})
			if dialogErr != nil || answer != "替换" {
				return document.Document{}, dialogErr
			}
		}
	} else if !os.IsNotExist(readErr) {
		return document.Document{}, readErr
	}
	// The native save dialog confirms replacing an existing destination.
	// A race after that dialog is still checked against its exact revision.
	return a.documents.Save(document.SaveRequest{
		ID: id, Content: content, Path: path, ExpectedRevision: doc.Revision, TargetRevision: targetRevision,
	})
}

func (a *App) CloseDocument(id string)           { a.documents.Close(id) }
func (a *App) CheckDocuments() []document.Change { return a.documents.Check() }
func (a *App) ReloadDocument(id, revision string) (document.Document, error) {
	return a.documents.AcceptDisk(id, revision)
}
func (a *App) ReadDocumentDisk(id string) (document.Document, error) {
	return a.documents.Disk(id)
}
func (a *App) AuthorizeDocumentImages(id, content string) error {
	return a.documents.AuthorizeImages(id, content)
}
func (a *App) RenameDocument(id, name string) (document.Document, error) {
	return a.documents.Rename(id, name)
}

func (a *App) OpenFolder(path string) (Bootstrap, error) {
	if path == "" {
		var err error
		path, err = runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
			Title: "打开文件夹", DefaultDirectory: a.settings.Get().WorkspacePath,
		})
		if err != nil || path == "" {
			return Bootstrap{}, err
		}
	}
	return a.OpenVault(path)
}

func (a *App) ListDirectory(path, cursor string) (document.DirectoryPage, error) {
	s := a.session()
	if s == nil {
		return document.DirectoryPage{Entries: []document.Entry{}}, nil
	}
	if !s.acquire() {
		return document.DirectoryPage{}, errors.New("文件夹已关闭")
	}
	defer s.release()
	return document.ListDirectory(s.vault.Root(), path, cursor)
}

func (a *App) RememberDocuments(documents []config.DocumentState, active string) error {
	return a.settings.Patch(func(s *config.Settings) {
		s.OpenDocuments = documents
		s.ActiveDocument = active
	})
}

func (a *App) documentTrash(id string) (*store.Vault, error) {
	if filepath.IsAbs(id) {
		return store.OpenFolder(id)
	}
	root := ""
	if s := a.session(); s != nil {
		root = s.vault.Root()
	}
	if id != "" {
		doc, err := a.documents.Get(id)
		if err != nil {
			return nil, err
		}
		if doc.Path == "" && root == "" {
			return nil, errors.New("请先打开文件夹")
		}
		if doc.Path != "" {
			rel, err := filepath.Rel(root, doc.Path)
			if root == "" || err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				root = filepath.Dir(doc.Path)
			}
		}
	}
	if root == "" {
		return nil, errors.New("请先打开文件夹")
	}
	return store.OpenFolder(root)
}

func (a *App) TrashDocument(id string) (store.TrashItem, error) {
	doc, err := a.documents.Get(id)
	if err != nil {
		return store.TrashItem{}, err
	}
	v, err := a.documentTrash(id)
	if err != nil {
		return store.TrashItem{}, err
	}
	if err := a.settings.Patch(func(s *config.Settings) {
		roots := []string{v.Root()}
		for _, root := range s.TrashRoots {
			if document.PathKey(root) != document.PathKey(v.Root()) {
				roots = append(roots, root)
			}
		}
		s.TrashRoots = roots
	}); err != nil {
		return store.TrashItem{}, err
	}
	item, err := v.Trash(doc.Path)
	if err == nil {
		a.documents.Close(id)
	}
	return item, err
}

type DocumentTrashItem struct {
	store.TrashItem
	Root string `json:"root"`
}

func (a *App) ListDocumentTrash(id string) ([]DocumentTrashItem, error) {
	roots := append([]string{}, a.settings.Get().TrashRoots...)
	if v, err := a.documentTrash(id); err == nil {
		roots = append(roots, v.Root())
	}
	seen := map[string]bool{}
	result := []DocumentTrashItem{}
	for _, root := range roots {
		key := document.PathKey(root)
		if seen[key] {
			continue
		}
		seen[key] = true
		v, err := store.OpenFolder(root)
		if err != nil {
			continue
		}
		entries, err := v.ListTrash()
		if err != nil {
			return nil, err
		}
		for _, item := range entries {
			result = append(result, DocumentTrashItem{TrashItem: item, Root: v.Root()})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].DeletedAt.After(result[j].DeletedAt) })
	return result, nil
}
func (a *App) RestoreDocumentTrash(id, entry string) (store.Restored, error) {
	v, err := a.documentTrash(id)
	if err != nil {
		return store.Restored{}, err
	}
	return v.Restore(entry)
}
