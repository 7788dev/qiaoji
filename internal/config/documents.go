package config

// DocumentState contains navigation state, never unsaved document content.
type DocumentState struct {
	Path      string  `json:"path"`
	Mode      string  `json:"mode"`
	Cursor    int     `json:"cursor"`
	ScrollTop float64 `json:"scrollTop"`
}
