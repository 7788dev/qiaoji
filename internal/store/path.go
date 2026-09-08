package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// resolveVaultPath validates a path against the canonical vault root. The
// lexical check rejects .. escapes, while the symlink check prevents a link
// inside the vault from redirecting an operation to another volume or folder.
// Missing final components are allowed for create/rename destinations when the
// existing parent can still be resolved safely. Both paths must already have
// absolute, long-name spellings, without resolving their symbolic links.
func resolveVaultPath(rootAbs, targetAbs string, allowMissing bool) (string, bool) {
	rootInfo, err := os.Lstat(rootAbs)
	if err != nil || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", false
	}
	if !lexicallyWithin(rootAbs, targetAbs) {
		return "", false
	}

	resolvedRoot, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		resolvedRoot = rootAbs
	}
	resolvedRoot = filepath.Clean(resolvedRoot)

	probe := targetAbs
	var suffix []string
	for {
		resolvedProbe, resolveErr := filepath.EvalSymlinks(probe)
		if resolveErr == nil {
			candidate := filepath.Clean(resolvedProbe)
			for i := len(suffix) - 1; i >= 0; i-- {
				candidate = filepath.Join(candidate, suffix[i])
			}
			if !lexicallyWithin(resolvedRoot, candidate) {
				return "", false
			}
			return candidate, true
		}
		if !allowMissing || !errors.Is(resolveErr, os.ErrNotExist) {
			return "", false
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", false
		}
		suffix = append(suffix, filepath.Base(probe))
		probe = parent
	}
}

// resolveUserPath is the common boundary check for paths exposed through the
// vault API. resolveVaultPath verifies the canonical vault boundary, while
// this wrapper also rejects aliases that resolve into the app-owned .qiaoji
// directory. Checking only the spelling supplied by a caller is insufficient:
// a user can create `alias -> .qiaoji` and otherwise reach the index/trash via
// a path that looks ordinary.
func resolveUserPath(root, target string, allowMissing bool) (string, bool) {
	// Expand Windows aliases once per operation. Repeating that filesystem
	// lookup for each boundary check makes large directory scans needlessly slow.
	rootAbs, err := AbsolutePath(root)
	if err != nil {
		return "", false
	}
	targetAbs, err := AbsolutePath(target)
	if err != nil {
		return "", false
	}
	resolved, ok := resolveVaultPath(rootAbs, targetAbs, allowMissing)
	if !ok || isInternalAbsolutePath(rootAbs, targetAbs) || isInternalAbsolutePath(rootAbs, resolved) || hasSymlinkComponent(rootAbs, targetAbs) {
		return "", false
	}
	return resolved, true
}

func lexicallyWithin(root, target string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func isInternalPath(root, target string) bool {
	rootAbs, err := AbsolutePath(root)
	if err != nil {
		return true
	}
	targetAbs, err := AbsolutePath(target)
	if err != nil {
		return true
	}
	return isInternalAbsolutePath(rootAbs, targetAbs)
}

func isInternalAbsolutePath(rootAbs, targetAbs string) bool {
	rel, err := filepath.Rel(filepath.Clean(rootAbs), filepath.Clean(targetAbs))
	if err != nil {
		return true
	}
	rel = filepath.Clean(rel)
	internal := strings.ToLower(InternalDir)
	rel = strings.ToLower(rel)
	return rel == internal || strings.HasPrefix(rel, internal+string(filepath.Separator))
}

// hasSymlinkComponent checks the spelling supplied by the caller rather than
// the resolved result. This intentionally rejects even a link that points back
// into the vault: an alias can be retargeted between validation and use, and
// allowing it makes watcher/index paths ambiguous. Missing leaf components are
// fine; every existing parent must still be an ordinary directory. Inputs have
// absolute, long-name spellings from resolveUserPath.
func hasSymlinkComponent(rootAbs, targetAbs string) bool {
	if info, statErr := os.Lstat(rootAbs); statErr != nil || info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	if !lexicallyWithin(rootAbs, targetAbs) {
		return true
	}
	rel, err := filepath.Rel(filepath.Clean(rootAbs), filepath.Clean(targetAbs))
	if err != nil || rel == "." {
		return false
	}
	current := filepath.Clean(rootAbs)
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			return false
		}
		if statErr != nil {
			return true
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return true
		}
	}
	return false
}

// rejectSymlink returns false for a final symlink. A symlinked note can change
// its destination independently of the index and should never be edited as if
// it were an ordinary Markdown file.
func rejectSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}
