package watch

import "os"

func filepathStat(p string) (isDir bool, err error) {
	st, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	return st.IsDir(), nil
}
