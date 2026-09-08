package store

import (
	"encoding/json"
	"errors"
	"fmt"
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

// safeEntryID reports whether a value may be used verbatim as a trash
// directory name.
//
// A note id comes from YAML that a sync client, a shared vault or another text
// editor wrote, so it is untrusted input. An id such as `../../loot` would
// otherwise move the note out of the trash — with enough segments, out of the
// vault — where ListTrash cannot see it and the user cannot get it back.
func safeEntryID(value string) bool {
	if value == "" || value == "." || value == ".." || len(value) > 120 {
		return false
	}
	if value != filepath.Base(value) || value != filepath.Clean(value) {
		return false
	}
	if filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return false
	}
	for _, r := range value {
		if r == '/' || r == '\\' || r == ':' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// isWithinDir reports whether child is dir itself or sits below it.
func isWithinDir(dir, child string) bool {
	rel, err := filepath.Rel(filepath.Clean(dir), filepath.Clean(child))
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// newTrashDir reserves a directory for one entry and returns it with the id it
// ended up using.
//
// The directory is created with Mkdir rather than MkdirAll so an id that is
// already taken is reported instead of reused: sharing a directory would
// overwrite the earlier entry's meta.json and orphan its payload.
func (v *Vault) newTrashDir(preferred string) (dir, entryID string, err error) {
	entryID = preferred
	if !safeEntryID(entryID) {
		entryID = newID()
	}
	if err := os.MkdirAll(v.trashRoot(), 0o755); err != nil {
		return "", "", err
	}
	for attempt := 0; attempt < 8; attempt++ {
		dir = filepath.Join(v.trashRoot(), entryID)
		if !isWithinDir(v.trashRoot(), dir) || filepath.Clean(dir) == filepath.Clean(v.trashRoot()) {
			return "", "", errors.New("invalid trash entry")
		}
		if mkErr := os.Mkdir(dir, 0o755); mkErr == nil {
			return dir, entryID, nil
		} else if !os.IsExist(mkErr) {
			return "", "", mkErr
		}
		entryID = newID()
	}
	return "", "", errors.New("无法在回收站中创建条目")
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
	abs = n.Path

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
		// The payload reached the trash; only the original could not be removed.
		// Deleting the entry here would throw away the surviving copy.
		if !errors.Is(err, ErrSourceRetained) {
			_ = os.RemoveAll(dir)
		}
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
	resolved, safe := resolveUserPath(v.root, src, false)
	// isInternal matters as much as contains here: `.qiaoji` holds the trash
	// itself, so moving it would ask moveTree to copy a directory into its own
	// subtree.
	if !safe || filepath.Clean(src) == filepath.Clean(v.root) {
		return TrashItem{}, errors.New("folder outside vault")
	}
	src = resolved
	info, err := os.Stat(src)
	if err != nil {
		return TrashItem{}, ErrNotFound
	}
	if !info.IsDir() {
		return TrashItem{}, errors.New("不是文件夹")
	}
	if err := ensureNoSymlinks(src); err != nil {
		return TrashItem{}, err
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
	if !safeEntryID(entryID) {
		return Restored{}, errors.New("invalid trash entry")
	}

	dir := filepath.Join(v.trashRoot(), entryID)
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
	resolvedTarget, safe := resolveUserPath(v.root, target, true)
	if !safe {
		target = filepath.Join(v.root, filepath.Base(src))
	} else {
		target = resolvedTarget
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
	resolvedTarget, safe := resolveUserPath(v.root, target, true)
	if !safe || filepath.Clean(target) == filepath.Clean(v.root) {
		target = filepath.Join(v.root, filepath.Base(src))
	} else {
		target = resolvedTarget
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
	if !safeEntryID(entryID) {
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

// ErrSourceRetained reports that a move copied the payload successfully but
// could not delete the original. The copy is intact, so callers must keep it
// rather than clean up after the error.
var ErrSourceRetained = errors.New("原文件未能删除")

// moveTree relocates a file or directory, falling back to copy-then-delete
// when the source and destination sit on different volumes.
func moveTree(src, dst string) error {
	if err := ensureNoSymlinks(src); err != nil {
		return err
	}
	if err := ensureDestinationPath(dst); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// A destination inside the source is not a cross-volume move; copying would
	// walk into the copy it is making and recurse until the path length stops
	// it. Callers are expected to rule this out, so it is an error, not a
	// fallback.
	if isWithinDir(src, dst) {
		return errors.New("目标位置在源目录内")
	}
	if err := copyTree(src, dst); err != nil {
		_ = os.RemoveAll(dst)
		return err
	}
	if err := os.RemoveAll(src); err != nil {
		// The copy is now the only complete copy. Reporting a plain error would
		// have the caller delete it while the original is already partially
		// gone, which loses the note outright.
		return fmt.Errorf("%w: %v", ErrSourceRetained, err)
	}
	return nil
}

func ensureNoSymlinks(src string) error {
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("不支持移动含符号链接的目录")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("不支持移动含符号链接的目录")
		}
		return nil
	})
}

func copyTree(src, dst string) error {
	if err := ensureDestinationPath(dst); err != nil {
		return err
	}
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("不支持移动符号链接")
	}
	if !info.IsDir() {
		return copyFile(src, dst, info.Mode().Perm())
	}
	if err := os.Mkdir(dst, 0o755); err != nil {
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
	if err := ensureDestinationPath(dst); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if mode == 0 {
		mode = 0o644
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ensureDestinationPath rejects existing symlinks in the destination chain.
// The cross-volume fallback cannot rely on Rename's atomic replacement
// semantics, so it must never let MkdirAll or OpenFile follow an attacker-made
// link into another directory.
func ensureDestinationPath(target string) error {
	probe := filepath.Clean(target)
	for {
		info, err := os.Lstat(probe)
		switch {
		case err == nil:
			if info.Mode()&os.ModeSymlink != 0 {
				return errors.New("目标路径包含符号链接")
			}
		case errors.Is(err, os.ErrNotExist):
			// The final component may not exist yet; continue checking parents.
		default:
			return err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return nil
		}
		probe = parent
	}
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
