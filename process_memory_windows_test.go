//go:build windows

package main

import "testing"

func TestDescendantProcessesIncludesNestedChildrenOnly(t *testing.T) {
	entries := []processSnapshotEntry{
		{PID: 1, ParentPID: 0, Exe: "qiaoji.exe"},
		{PID: 2, ParentPID: 1, Exe: "msedgewebview2.exe"},
		{PID: 3, ParentPID: 2, Exe: "utility.exe"},
		{PID: 4, ParentPID: 99, Exe: "unrelated.exe"},
		{PID: 5, ParentPID: 1, Exe: "node.exe"},
	}

	got := descendantProcesses(entries, 1)
	seen := make(map[uint32]bool, len(got))
	for _, entry := range got {
		seen[entry.PID] = true
	}
	for _, pid := range []uint32{1, 2, 3, 5} {
		if !seen[pid] {
			t.Errorf("missing descendant %d", pid)
		}
	}
	if seen[4] {
		t.Fatal("included an unrelated process")
	}
}

func TestProcessClassification(t *testing.T) {
	if !isWebViewProcess("MSEdgeWebView2.exe") {
		t.Fatal("WebView2 process was not recognized")
	}
	if !isNodeProcess("NODE.EXE") || isNodeProcess("npm.cmd") {
		t.Fatal("Node process classification is incorrect")
	}
}
