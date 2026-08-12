package store

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// InternalDir holds everything the app owns inside the vault. It is skipped by
// the scanner so it never shows up as notes.
const InternalDir = ".qiaoji"

var (
	ErrNotFound = errors.New("note not found")
	ErrExists   = errors.New("already exists")
)

type Vault struct {
	mu   sync.RWMutex
	root string
}

func Open(root string) (*Vault, error) {
	if root == "" {
		return nil, errors.New("vault path is empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(abs, InternalDir, "trash"), 0o755); err != nil {
		return nil, err
	}
	return &Vault{root: abs}, nil
}

func (v *Vault) Root() string { return v.root }

func (v *Vault) InternalPath(parts ...string) string {
	return filepath.Join(append([]string{v.root, InternalDir}, parts...)...)
}

// markerFile records that this folder has already been set up as a vault.
const markerFile = "vault.json"

// IsInitialised reports whether the starter notes have already been written
// here.
//
// This is deliberately a marker inside the vault rather than a flag in
// settings: once someone deletes the sample notes, the folder must stay empty
// on the next launch, and that decision belongs to the folder, not to a
// preferences file that could be reset or copied between machines.
func (v *Vault) IsInitialised() bool {
	_, err := os.Stat(v.InternalPath(markerFile))
	return err == nil
}

func (v *Vault) MarkInitialised() error {
	payload := fmt.Sprintf(
		"{\n  \"createdAt\": %q,\n  \"note\": \"巧记 用这个文件记录笔记库已初始化，删除它会在下次启动时重新写入示例笔记。\"\n}\n",
		time.Now().Format(time.RFC3339),
	)
	return os.WriteFile(v.InternalPath(markerFile), []byte(payload), 0o644)
}

// IsEmpty reports whether the vault has no notes yet, which drives first-run
// seeding.
func (v *Vault) IsEmpty() bool {
	found := false
	_ = filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || found {
			return nil
		}
		if d.IsDir() {
			if skipDir(d.Name()) && p != v.root {
				return fs.SkipDir
			}
			return nil
		}
		if isMarkdown(d.Name()) {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	return !found
}

func skipDir(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules" || name == "$RECYCLE.BIN"
}

func isMarkdown(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".md" || ext == ".markdown" || ext == ".mdown"
}

// ---------------------------------------------------------------- reading

// Scan walks the vault and returns every note with its body loaded. Notes are
// small text files, so a single pass that also fills the search index is
// cheaper than statting first and re-reading later.
func (v *Vault) Scan() ([]Note, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	var notes []Note
	err := filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries must not abort the whole scan
		}
		if d.IsDir() {
			if p != v.root && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !isMarkdown(d.Name()) {
			return nil
		}
		n, err := v.readNote(p)
		if err != nil {
			return nil
		}
		notes = append(notes, n)
		return nil
	})
	return notes, err
}

func (v *Vault) readNote(abs string) (Note, error) {
	raw, err := os.ReadFile(abs)
	if err != nil {
		return Note{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Note{}, err
	}
	fm, body := parseFrontMatter(raw)

	rel, _ := filepath.Rel(v.root, abs)
	folder := filepath.ToSlash(filepath.Dir(rel))
	if folder == "." {
		folder = ""
	}

	title := titleFromBody(body)
	if title == "" {
		title = fm.Title
	}
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	}

	created := fm.Created
	if created.IsZero() {
		created = info.ModTime()
	}
	updated := fm.Updated
	if updated.IsZero() || info.ModTime().After(updated) {
		// An external editor touched the file; trust the filesystem.
		updated = info.ModTime()
	}

	id := fm.ID
	if id == "" {
		id = newID()
	}

	return Note{
		Meta: Meta{
			ID:       id,
			Title:    title,
			Folder:   folder,
			Path:     abs,
			Tags:     normaliseTags(fm.Tags),
			Created:  created,
			Updated:  updated,
			Favorite: fm.Favorite,
			Excerpt:  excerptOf(body, 90),
			Words:    countWords(body),
			Size:     info.Size(),
		},
		Content: body,
	}, nil
}

// Read loads one note by absolute path.
func (v *Vault) Read(abs string) (Note, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if !v.contains(abs) {
		return Note{}, ErrNotFound
	}
	return v.readNote(abs)
}

func (v *Vault) contains(abs string) bool {
	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// ---------------------------------------------------------------- writing

// Create writes a new note and returns it. An empty title produces the
// localised "untitled" name.
func (v *Vault) Create(folder, title, body string) (Note, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	dir := filepath.Join(v.root, filepath.FromSlash(folder))
	if !v.contains(dir) {
		return Note{}, errors.New("folder outside vault")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Note{}, err
	}
	if title == "" {
		title = "未命名笔记"
	}
	if body == "" {
		body = "# " + title + "\n\n"
	}

	now := time.Now()
	fm := frontMatter{ID: newID(), Title: title, Created: now, Updated: now}
	abs := uniquePath(dir, slugify(title))
	if err := os.WriteFile(abs, renderFile(fm, body), 0o644); err != nil {
		return Note{}, err
	}
	return v.readNote(abs)
}

// Save writes a new body for an existing note. The file is renamed when the
// first heading changed, so Explorer keeps showing meaningful filenames.
func (v *Vault) Save(abs, body string) (Note, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.contains(abs) {
		return Note{}, ErrNotFound
	}

	raw, err := os.ReadFile(abs)
	if err != nil {
		return Note{}, err
	}
	fm, _ := parseFrontMatter(raw)
	if fm.ID == "" {
		fm.ID = newID()
	}
	if fm.Created.IsZero() {
		fm.Created = time.Now()
	}

	title := titleFromBody(body)
	if title == "" {
		title = fm.Title
	}
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	}
	renamed := !strings.EqualFold(fm.Title, title)
	fm.Title = title
	fm.Updated = time.Now()

	if err := writeAtomic(abs, renderFile(fm, body)); err != nil {
		return Note{}, err
	}

	if renamed {
		dir := filepath.Dir(abs)
		want := slugify(title) + ".md"
		if !strings.EqualFold(filepath.Base(abs), want) {
			target := uniquePath(dir, slugify(title))
			if err := os.Rename(abs, target); err == nil {
				abs = target
			}
		}
	}
	return v.readNote(abs)
}

// UpdateMeta mutates front matter without touching the body.
func (v *Vault) UpdateMeta(abs string, fn func(*frontMatter)) (Note, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.contains(abs) {
		return Note{}, ErrNotFound
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return Note{}, err
	}
	fm, body := parseFrontMatter(raw)
	if fm.ID == "" {
		fm.ID = newID()
	}
	fn(&fm)
	fm.Tags = normaliseTags(fm.Tags)
	if err := writeAtomic(abs, renderFile(fm, body)); err != nil {
		return Note{}, err
	}
	return v.readNote(abs)
}

func (v *Vault) SetFavorite(abs string, fav bool) (Note, error) {
	return v.UpdateMeta(abs, func(fm *frontMatter) { fm.Favorite = fav })
}

func (v *Vault) SetTags(abs string, tags []string) (Note, error) {
	return v.UpdateMeta(abs, func(fm *frontMatter) { fm.Tags = tags })
}

// Rename changes the title (first heading and front matter) and the filename.
func (v *Vault) Rename(abs, title string) (Note, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Note{}, errors.New("标题不能为空")
	}
	v.mu.Lock()
	if !v.contains(abs) {
		v.mu.Unlock()
		return Note{}, ErrNotFound
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		v.mu.Unlock()
		return Note{}, err
	}
	fm, body := parseFrontMatter(raw)
	if fm.ID == "" {
		fm.ID = newID()
	}
	fm.Title = title
	fm.Updated = time.Now()
	body = replaceFirstHeading(body, title)

	if err := writeAtomic(abs, renderFile(fm, body)); err != nil {
		v.mu.Unlock()
		return Note{}, err
	}
	dir := filepath.Dir(abs)
	if want := slugify(title) + ".md"; !strings.EqualFold(filepath.Base(abs), want) {
		target := uniquePath(dir, slugify(title))
		if err := os.Rename(abs, target); err == nil {
			abs = target
		}
	}
	v.mu.Unlock()
	return v.Read(abs)
}

// Move relocates a note into another folder, keeping its id and body.
func (v *Vault) Move(abs, folder string) (Note, error) {
	v.mu.Lock()
	if !v.contains(abs) {
		v.mu.Unlock()
		return Note{}, ErrNotFound
	}
	dir := filepath.Join(v.root, filepath.FromSlash(folder))
	if !v.contains(dir) {
		v.mu.Unlock()
		return Note{}, errors.New("folder outside vault")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		v.mu.Unlock()
		return Note{}, err
	}
	if filepath.Clean(filepath.Dir(abs)) == filepath.Clean(dir) {
		v.mu.Unlock()
		return v.Read(abs)
	}
	target := uniquePath(dir, strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs)))
	if err := os.Rename(abs, target); err != nil {
		v.mu.Unlock()
		return Note{}, err
	}
	v.mu.Unlock()
	return v.Read(target)
}

// Duplicate copies a note next to the original with a fresh id.
func (v *Vault) Duplicate(abs string) (Note, error) {
	n, err := v.Read(abs)
	if err != nil {
		return Note{}, err
	}
	title := n.Title + " 副本"
	body := replaceFirstHeading(n.Content, title)
	return v.Create(n.Folder, title, body)
}

func writeAtomic(abs string, data []byte) error {
	tmp := abs + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func replaceFirstHeading(body, title string) string {
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "#") {
			level := len(t) - len(strings.TrimLeft(t, "#"))
			if level > 6 {
				level = 6
			}
			lines[i] = strings.Repeat("#", level) + " " + title
			return strings.Join(lines, "\n")
		}
		break
	}
	return "# " + title + "\n\n" + strings.TrimLeft(body, "\n")
}

// ---------------------------------------------------------------- folders

func (v *Vault) Folders() ([]Folder, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	counts := map[string]int{}
	var order []string
	err := filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p == v.root {
				return nil
			}
			if skipDir(d.Name()) {
				return fs.SkipDir
			}
			rel, _ := filepath.Rel(v.root, p)
			key := filepath.ToSlash(rel)
			if _, ok := counts[key]; !ok {
				counts[key] = 0
				order = append(order, key)
			}
			return nil
		}
		if !isMarkdown(d.Name()) {
			return nil
		}
		rel, _ := filepath.Rel(v.root, filepath.Dir(p))
		key := filepath.ToSlash(rel)
		if key == "." {
			return nil
		}
		counts[key]++
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(order)
	out := make([]Folder, 0, len(order))
	for _, key := range order {
		out = append(out, Folder{Name: pathLeaf(key), Path: key, Count: counts[key]})
	}
	return out, nil
}

func pathLeaf(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

func (v *Vault) CreateFolder(name string) (Folder, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Folder{}, errors.New("文件夹名不能为空")
	}
	safe := slugify(name)
	v.mu.Lock()
	defer v.mu.Unlock()
	dir := filepath.Join(v.root, safe)
	if _, err := os.Stat(dir); err == nil {
		return Folder{}, ErrExists
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Folder{}, err
	}
	return Folder{Name: safe, Path: safe}, nil
}

func (v *Vault) RenameFolder(rel, name string) error {
	name = strings.TrimSpace(name)
	if rel == "" || name == "" {
		return errors.New("参数无效")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	src := filepath.Join(v.root, filepath.FromSlash(rel))
	dst := filepath.Join(filepath.Dir(src), slugify(name))
	if !v.contains(src) || !v.contains(dst) {
		return errors.New("folder outside vault")
	}
	if strings.EqualFold(src, dst) {
		return nil
	}
	if _, err := os.Stat(dst); err == nil {
		return ErrExists
	}
	return os.Rename(src, dst)
}

// DeleteFolder moves every note inside to the trash, then removes the folder.
func (v *Vault) DeleteFolder(rel string) error {
	if rel == "" {
		return errors.New("参数无效")
	}
	dir := filepath.Join(v.root, filepath.FromSlash(rel))
	if !v.contains(dir) {
		return errors.New("folder outside vault")
	}
	var files []string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && isMarkdown(d.Name()) {
			files = append(files, p)
		}
		return nil
	})
	for _, f := range files {
		if _, err := v.Trash(f); err != nil {
			return err
		}
	}
	return os.RemoveAll(dir)
}

// ---------------------------------------------------------------- filenames

var reservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// slugify turns a note title into a filename that Windows accepts while
// keeping CJK characters readable.
func slugify(title string) string {
	var sb strings.Builder
	for _, r := range title {
		switch {
		case r < 0x20 || r == 0x7f:
			// drop control characters
		case strings.ContainsRune(`<>:"/\|?*`, r):
			sb.WriteRune('-')
		default:
			sb.WriteRune(r)
		}
	}
	s := strings.TrimSpace(sb.String())
	s = strings.Trim(s, ". ")
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	if r := []rune(s); len(r) > 80 {
		s = strings.TrimSpace(string(r[:80]))
	}
	if s == "" || reservedNames[strings.ToLower(s)] {
		s = "note-" + newID()[:8]
	}
	return s
}

func uniquePath(dir, base string) string {
	p := filepath.Join(dir, base+".md")
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p
	}
	for i := 2; i < 10000; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s-%d.md", base, i))
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
	return filepath.Join(dir, base+"-"+newID()[:8]+".md")
}
