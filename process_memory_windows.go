//go:build windows

package main

import (
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type processTreeMemoryStats struct {
	MainBytes    int64
	WebViewBytes int64
	NodeBytes    int64
	OtherBytes   int64
	TotalBytes   int64
	ProcessCount int
}

type processSnapshotEntry struct {
	PID       uint32
	ParentPID uint32
	Exe       string
}

type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var getProcessMemoryInfo = windows.NewLazySystemDLL("kernel32.dll").NewProc("K32GetProcessMemoryInfo")

func processWorkingSetBytes(handle windows.Handle) int64 {
	var counters processMemoryCounters
	counters.CB = uint32(unsafe.Sizeof(counters))
	ok, _, _ := getProcessMemoryInfo.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.CB),
	)
	if ok == 0 {
		return 0
	}
	return int64(counters.WorkingSetSize)
}

// processTreeMemory is intentionally called only by the diagnostics API. A
// Toolhelp snapshot is cheap for an explicit diagnostic request, but there is
// no reason to poll it during ordinary Markdown editing.
func processTreeMemory() processTreeMemoryStats {
	rootPID := uint32(os.Getpid())
	entries, err := processSnapshot()
	if err != nil {
		mainBytes := processWorkingSetBytes(windows.CurrentProcess())
		return processTreeMemoryStats{MainBytes: mainBytes, TotalBytes: mainBytes, ProcessCount: 1}
	}

	descendants := descendantProcesses(entries, rootPID)
	stats := processTreeMemoryStats{ProcessCount: len(descendants)}
	for _, entry := range descendants {
		var bytes int64
		if entry.PID == rootPID {
			bytes = processWorkingSetBytes(windows.CurrentProcess())
		} else {
			handle, openErr := windows.OpenProcess(
				windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ,
				false,
				entry.PID,
			)
			if openErr == nil {
				bytes = processWorkingSetBytes(handle)
				_ = windows.CloseHandle(handle)
			}
		}

		stats.TotalBytes += bytes
		switch {
		case entry.PID == rootPID:
			stats.MainBytes += bytes
		case isWebViewProcess(entry.Exe):
			stats.WebViewBytes += bytes
		case isNodeProcess(entry.Exe):
			stats.NodeBytes += bytes
		default:
			stats.OtherBytes += bytes
		}
	}
	return stats
}

func processSnapshot() ([]processSnapshotEntry, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}

	entries := make([]processSnapshotEntry, 0, 64)
	for {
		entries = append(entries, processSnapshotEntry{
			PID:       entry.ProcessID,
			ParentPID: entry.ParentProcessID,
			Exe:       windows.UTF16ToString(entry.ExeFile[:]),
		})
		entry.Size = uint32(unsafe.Sizeof(entry))
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			break
		}
	}
	return entries, nil
}

func descendantProcesses(entries []processSnapshotEntry, rootPID uint32) []processSnapshotEntry {
	inTree := map[uint32]bool{rootPID: true}
	for changed := true; changed; {
		changed = false
		for _, entry := range entries {
			if !inTree[entry.PID] && inTree[entry.ParentPID] {
				inTree[entry.PID] = true
				changed = true
			}
		}
	}

	out := make([]processSnapshotEntry, 0, len(inTree))
	foundRoot := false
	for _, entry := range entries {
		if inTree[entry.PID] {
			out = append(out, entry)
			foundRoot = foundRoot || entry.PID == rootPID
		}
	}
	if !foundRoot {
		out = append(out, processSnapshotEntry{PID: rootPID})
	}
	return out
}

func isWebViewProcess(exe string) bool {
	return strings.EqualFold(exe, "msedgewebview2.exe")
}

func isNodeProcess(exe string) bool {
	return strings.EqualFold(exe, "node.exe") || strings.EqualFold(exe, "node")
}
