package store

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Trash entry kinds. Entries written before folders were recoverable have no
// kind at all, so an empty value reads as a note.
const (
	TrashNote   = "note"
	TrashFolder = "folder"
)

// TrashItem describes one deleted note or folder. The original relative path is
// kept so "restore" puts it back where the user expects it.
type TrashItem struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Folder      string    `json:"folder"`
	Excerpt     string    `json:"excerpt"`
	DeletedAt   time.Time `json:"deletedAt"`
	OriginalRel string    `json:"originalRel"`
	Size        int64     `json:"size"`

	// Notes and Files describe a folder entry: how many notes it holds and how
	// many other files (images, PDFs, attachments) travelled with it.
	Notes int `json:"notes"`
	Files int `json:"files"`
}

// Restored reports what came back out of the trash, since an entry can be a
// single note or a whole folder.
type Restored struct {
	Kind   string `json:"kind"`
	Note   Note   `json:"note"`
	Folder string `json:"folder"`
	Notes  int    `json:"notes"`
}

func (v *Vault) trashRoot() string { return v.InternalPath("trash") }

// newTrashDir reserves a directory for one entry and returns it with the id it
// ended up using.
func (v *Vault) newTrashDir(preferred string) (dir, entryID string, err error) {
	entryID = preferred
	if entryID == "" {
		entryID = newID()
	}
	dir = filepath.Join(v.trashRoot(), entryID)
	if _, statErr := os.Stat(dir); statErr == nil {
		entryID += "-" + newID()[:6]
		dir = filepath.Join(v.trashRoot(), entryID)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	return dir, entryID, nil
}

// writeTrashMeta records the entry before the payload moves, so a failure can
// never strand files in a directory the UI cannot see.
func writeTrashMeta(dir string, item TrashItem) error {
	meta, err := json.MarshalIndent(item, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o644)
}

// Trash moves a note out of the vault tree into .qiaoji/trash/<id>/.
func (v *Vault) Trash(abs string) (TrashItem, error) {
	n, err := v.Read(abs)
	if err != nil {
		return TrashItem{}, err
	}

	v.mu.Lock()
	defer v.mu.Unlock()

	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return TrashItem{}, err
	}
	dir, entryID, err := v.newTrashDir(n.ID)
	if err != nil {
		return TrashItem{}, err
	}

	item := TrashItem{
		ID:          entryID,
		Kind:        TrashNote,
		Title:       n.Title,
		Folder:      n.Folder,
		Excerpt:     n.Excerpt,
		DeletedAt:   time.Now(),
		OriginalRel: filepath.ToSlash(rel),
		Size:        n.Size,
		Notes:       1,
	}
	if err := writeTrashMeta(dir, item); err != nil {
		_ = os.RemoveAll(dir)
		return TrashItem{}, err
	}
	if err := moveTree(abs, filepath.Join(dir, filepath.Base(abs))); err != nil {
		_ = os.RemoveAll(dir)
		return TrashItem{}, err
	}
	return item, nil
}

// TrashFolder moves a whole folder into the trash in one piece.
//
// Notes are not extracted and trashed one by one: everything the user keeps
// beside them — images, PDFs, spreadsheets — travels with the folder and comes
// back with it, which is what "可以随时还原" has to mean.
func (v *Vault) TrashFolder(rel string) (TrashItem, error) {
	rel = strings.Trim(filepath.ToSlash(strings.TrimSpace(rel)), "/")
	if rel == "" || rel == "." {
		return TrashItem{}, errors.New("参数无效")
	}

	v.mu.Lock()
	defer v.mu.Unlock()

	src := filepath.Join(v.root, filepath.FromSlash(rel))
	if !v.contains(src) || filepath.Clean(src) == filepath.Clean(v.root) {
		return TrashItem{}, errors.New("folder outside vault")
	}
	info, err := os.Stat(src)
	if err != nil {
		return TrashItem{}, ErrNotFound
	}
	if !info.IsDir() {
		return TrashItem{}, errors.New("不是文件夹")
	}

	notes, files, size := measureTree(src)
	dir, entryID, err := v.newTrashDir("")
	if err != nil {
		return TrashItem{}, err
	}

	item := TrashItem{
		ID:          entryID,
		Kind:        TrashFolder,
		Title:       pathLeaf(rel),
		Folder:      parentOf(rel),
		DeletedAt:   time.Now(),
		OriginalRel: rel,
		Size:        size,
		Notes:       notes,
		Files:       files,
	}
	if err := writeTrashMeta(dir, item); err != nil {
		_ = os.RemoveAll(dir)
		return TrashItem{}, err
	}
	if err := moveTree(src, filepath.Join(dir, filepath.Base(src))); err != nil {
		_ = os.RemoveAll(dir)
		return TrashItem{}, err
	}
	return item, nil
}

func (v *Vault) ListTrash() ([]TrashItem, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	entries, err := os.ReadDir(v.trashRoot())
	if err != nil {
		if os.IsNotExist(err) {
			return []TrashItem{}, nil
		}
		return nil, err
	}
	out := make([]TrashItem, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(v.trashRoot(), e.Name(), "meta.json"))
		if err != nil {
			continue
		}
		var item TrashItem
		if err := json.Unmarshal(data, &item); err != nil {
			continue
		}
		item.ID = e.Name()
		if item.Kind == "" {
			item.Kind = TrashNote
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt.After(out[j].DeletedAt) })
	return out, nil
}

// CountTrash returns how many entries the trash holds without parsing any
// metadata, because the sidebar only ever shows the number.
func (v *Vault) CountTrash() int {
	v.mu.RLock()
	defer v.mu.RUnlock()

	entries, err := os.ReadDir(v.trashRoot())
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			n++
		}
	}
	return n
}

// Restore puts a trashed note or folder back at its original location,
// recreating the parent folders when they were removed in the meantime.
func (v *Vault) Restore(entryID string) (Restored, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	dir := filepath.Join(v.trashRoot(), filepath.Base(entryID))
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return Restored{}, ErrNotFound
	}
	var item TrashItem
	if err := json.Unmarshal(data, &item); err != nil {
		return Restored{}, err
	}
	if item.Kind == TrashFolder {
		return v.restoreFolder(dir, item)
	}
	return v.restoreNote(dir, item)
}

func (v *Vault) restoreNote(dir string, item TrashItem) (Restored, error) {
	src := ""
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !e.IsDir() && isMarkdown(e.Name()) {
			src = filepath.Join(dir, e.Name())
			break
		}
	}
	if src == "" {
		return Restored{}, ErrNotFound
	}

	target := filepath.Join(v.root, filepath.FromSlash(item.OriginalRel))
	if !v.contains(target) {
		target = filepath.Join(v.root, filepath.Base(src))
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return Restored{}, err
	}
	if _, err := os.Stat(target); err == nil {
		base := strings.TrimSuffix(filepath.Base(target), filepath.Ext(target))
		target = uniquePath(filepath.Dir(target), base)
	}
	if err := moveTree(src, target); err != nil {
		return Restored{}, err
	}
	_ = os.RemoveAll(dir)

	n, err := v.readNote(target)
	if err != nil {
		return Restored{}, err
	}
	return Restored{Kind: TrashNote, Note: n, Notes: 1}, nil
}

func (v *Vault) restoreFolder(dir string, item TrashItem) (Restored, error) {
	src := ""
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() {
			src = filepath.Join(dir, e.Name())
			break
		}
	}
	if src == "" {
		return Restored{}, ErrNotFound
	}

	target := filepath.Join(v.root, filepath.FromSlash(item.OriginalRel))
	if !v.contains(target) || filepath.Clean(target) == filepath.Clean(v.root) {
		target = filepath.Join(v.root, filepath.Base(src))
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return Restored{}, err
	}
	target = uniqueDir(target)
	if err := moveTree(src, target); err != nil {
		return Restored{}, err
	}
	_ = os.RemoveAll(dir)

	rel, err := filepath.Rel(v.root, target)
	if err != nil {
		return Restored{}, err
	}
	notes, _, _ := measureTree(target)
	return Restored{Kind: TrashFolder, Folder: filepath.ToSlash(rel), Notes: notes}, nil
}

func (v *Vault) PurgeTrash(entryID string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if entryID == "" || entryID == "." || entryID == ".." ||
		entryID != filepath.Base(entryID) || strings.ContainsAny(entryID, `/\`) {
		return errors.New("invalid trash entry")
	}
	root := filepath.Clean(v.trashRoot())
	dir := filepath.Clean(filepath.Join(root, entryID))
	if dir == root || filepath.Dir(dir) != root {
		return errors.New("invalid trash entry")
	}
	return os.RemoveAll(dir)
}

func (v *Vault) EmptyTrash() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := os.RemoveAll(v.trashRoot()); err != nil {
		return err
	}
	return os.MkdirAll(v.trashRoot(), 0o755)
}

// ---------------------------------------------------------------- moving

// moveTree relocates a file or directory, falling back to copy-then-delete
// when the source and destination sit on different volumes.
func moveTree(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyTree(src, dst); err != nil {
		_ = os.RemoveAll(dst)
		return err
	}
	return os.RemoveAll(src)
}

func copyTree(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return copyFile(src, dst, info.Mode().Perm())
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if mode == 0 {
		mode = 0o644
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// measureTree counts the notes, the other files kept beside them, and the
// total bytes under a directory.
func measureTree(dir string) (notes, files int, size int64) {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if isMarkdown(d.Name()) {
			notes++
		} else {
			files++
		}
		if info, ierr := d.Info(); ierr == nil {
			size += info.Size()
		}
		return nil
	})
	return notes, files, size
}

func uniqueDir(target string) string {
	if _, err := os.Stat(target); os.IsNotExist(err) {
		return target
	}
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	for i := 2; i < 1000; i++ {
		candidate := filepath.Join(parent, base+"-"+strconv.Itoa(i))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return filepath.Join(parent, base+"-"+newID()[:8])
}

func parentOf(rel string) string {
	if i := strings.LastIndex(rel, "/"); i >= 0 {
		return rel[:i]
	}
	return ""
}
