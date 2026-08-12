package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// TrashItem describes one deleted note. The original relative path is kept so
// "restore" puts the note back where the user expects it.
type TrashItem struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Folder      string    `json:"folder"`
	Excerpt     string    `json:"excerpt"`
	DeletedAt   time.Time `json:"deletedAt"`
	OriginalRel string    `json:"originalRel"`
	Size        int64     `json:"size"`
}

func (v *Vault) trashRoot() string { return v.InternalPath("trash") }

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
	entryID := n.ID
	if entryID == "" {
		entryID = newID()
	}
	dir := filepath.Join(v.trashRoot(), entryID)
	if _, err := os.Stat(dir); err == nil {
		dir = filepath.Join(v.trashRoot(), entryID+"-"+newID()[:6])
		entryID = filepath.Base(dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return TrashItem{}, err
	}

	dst := filepath.Join(dir, filepath.Base(abs))
	if err := os.Rename(abs, dst); err != nil {
		// Rename fails across volumes; fall back to copy + delete.
		data, rerr := os.ReadFile(abs)
		if rerr != nil {
			return TrashItem{}, rerr
		}
		if werr := os.WriteFile(dst, data, 0o644); werr != nil {
			return TrashItem{}, werr
		}
		if rerr := os.Remove(abs); rerr != nil {
			return TrashItem{}, rerr
		}
	}

	item := TrashItem{
		ID:          entryID,
		Title:       n.Title,
		Folder:      n.Folder,
		Excerpt:     n.Excerpt,
		DeletedAt:   time.Now(),
		OriginalRel: filepath.ToSlash(rel),
		Size:        n.Size,
	}
	meta, _ := json.MarshalIndent(item, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o644); err != nil {
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
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt.After(out[j].DeletedAt) })
	return out, nil
}

// Restore puts a trashed note back at its original location, creating the
// folder again when it was removed in the meantime.
func (v *Vault) Restore(entryID string) (Note, error) {
	v.mu.Lock()
	dir := filepath.Join(v.trashRoot(), filepath.Base(entryID))
	metaPath := filepath.Join(dir, "meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		v.mu.Unlock()
		return Note{}, ErrNotFound
	}
	var item TrashItem
	if err := json.Unmarshal(data, &item); err != nil {
		v.mu.Unlock()
		return Note{}, err
	}

	src := ""
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !e.IsDir() && isMarkdown(e.Name()) {
			src = filepath.Join(dir, e.Name())
			break
		}
	}
	if src == "" {
		v.mu.Unlock()
		return Note{}, ErrNotFound
	}

	target := filepath.Join(v.root, filepath.FromSlash(item.OriginalRel))
	if !v.contains(target) {
		target = filepath.Join(v.root, filepath.Base(src))
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		v.mu.Unlock()
		return Note{}, err
	}
	if _, err := os.Stat(target); err == nil {
		base := strings.TrimSuffix(filepath.Base(target), filepath.Ext(target))
		target = uniquePath(filepath.Dir(target), base)
	}
	if err := os.Rename(src, target); err != nil {
		v.mu.Unlock()
		return Note{}, err
	}
	_ = os.RemoveAll(dir)
	v.mu.Unlock()
	return v.Read(target)
}

func (v *Vault) PurgeTrash(entryID string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	dir := filepath.Join(v.trashRoot(), filepath.Base(entryID))
	if !strings.HasPrefix(dir, v.trashRoot()) {
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
