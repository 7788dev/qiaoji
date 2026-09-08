# Repository Guidelines

## Project structure

巧记 is a Windows-first Wails desktop app: Go owns the local Markdown vault, while TypeScript renders the UI.

- Root Go files (`main.go`, `app.go`, `tray.go`, and platform-specific `*_windows.go`/`*_other.go`) contain the application shell and bindings.
- `internal/` holds backend packages: `store`, `index`, `exporter`, `config`, and `watch`.
- `frontend/src/` contains the Vite/TypeScript UI; `frontend/public/` and `frontend/src/assets/` hold web assets. `frontend/wailsjs/` is committed generated Wails glue.
- `tools/` contains asset/KaTeX generators; `UI/` contains brand files and screenshots. Packaging lives under `build/windows/`; release automation is `.github/workflows/release.yml`.
- Tests sit beside their code (`*_test.go` and `*.test.ts`).

## Build, test, and development commands

Use Go 1.25+, Node 20.19+, Wails v2.13.0, and NSIS on Windows.

```powershell
wails dev                                  # run the desktop app with hot reload
Push-Location frontend
npm ci                                     # install the locked frontend dependencies
npx tsc --noEmit; npm test; npm run build # type-check, tests, and production bundle
Pop-Location
go vet ./...; go test ./...                # backend quality gates
$env:CGO_ENABLED = "0"
wails build -platform windows/amd64 -nsis -installscope user -trimpath
```

The installer is written to `build/bin/`. Run `go run ./tools/genkatex` or `python tools/genicon.py` only when bundled assets change.

## Coding style and naming

Format Go with `gofmt`; use idiomatic lower-case package names and `Test...` test functions. TypeScript uses two-space indentation, double quotes, semicolons, `camelCase` values/functions, and `PascalCase` types. No separate formatter or linter is configured, so keep changes consistent with nearby files and rely on `tsc` for static checks.

## Testing guidelines

Add focused regression tests for backend behavior and platform-sensitive paths. Vitest tests should describe observable behavior with `describe`/`it` and live beside the module under test. There is no fixed coverage threshold; behavior changes should include or update a meaningful test. Run the quality gates before opening a PR.

## Commits and pull requests

Use imperative commit subjects matching history (for example, `Fix ...`, `Update ...`, or `Add ...`); keep each commit focused. A PR should explain user-visible impact and implementation, link a related issue when applicable, list validation commands, and include before/after screenshots for UI changes. Do not commit `node_modules`, build output, secrets, or private note data. Release-only edits to `version.json` and tags should be coordinated with the release workflow.

## Data and configuration safety

The app stores notes in the user-selected vault and settings under `%APPDATA%\巧记`. Use temporary directories in tests, preserve existing Markdown/front matter, and never use real personal notes or credentials in fixtures.
