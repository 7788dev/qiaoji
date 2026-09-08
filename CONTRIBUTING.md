# 贡献指南

## 开发环境

| 工具 | 版本 |
| --- | --- |
| Go | 1.25.13 或更高，见 `go.mod` |
| Node.js | 20.19+ |
| Wails | 2.13.0 |
| WebView2 Runtime | Windows 桌面运行所需 |
| NSIS | 仅安装包构建需要，`makensis` 应在 PATH 中 |

```powershell
git clone https://github.com/7788dev/qiaoji.git
Set-Location qiaoji
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
Push-Location frontend
npm ci
Pop-Location
wails dev
```

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `main.go`、`app.go`、`documents.go` | 桌面生命周期与 Wails API |
| `internal/document/` | 文档会话、保存、图片和目录读取 |
| `internal/store/` | Markdown 文件、路径与回收站 |
| `internal/index/`、`internal/watch/` | 搜索索引与文件监听 |
| `internal/exporter/`、`internal/config/` | 导出与配置 |
| `frontend/src/writing/` | 写作界面、文档控制器与编辑器 |
| `frontend/wailsjs/` | 已提交的 Wails 生成绑定 |
| `UI/screenshots/` | 当前界面截图及历史验收对照 |
| `build/windows/` | Windows 资源与 NSIS 配置 |

## 修改与验证

Go 使用 `gofmt`；TypeScript 使用双引号、分号和两空格缩进。行为变化应有聚焦回归测试，测试文件与实现放在同一目录。

```powershell
Push-Location frontend
npx tsc --noEmit
npm test
npm run build
Pop-Location
go vet ./...
go test ./...
git diff --check
```

修改后端公开方法时，同步更新并提交 `frontend/wailsjs/` 绑定。测试只使用临时目录和合成文档，尤其应覆盖中文路径、外部修改、保存取消和失败场景。索引规模测试在首次运行时可能需要数分钟。

UI 修改请在 Windows WebView2 中验证深浅主题、900×600 与 1280×800 窗口、缩放及中文输入法，并附上前后截图。公开文档截图统一采用 100% 应用缩放、16px 正文和合成内容；缩放测试图应明确标注，避免与默认界面混用。

## 构建安装包

版本来自 `wails.json`；正式发布应与 Git 标签一致。

```powershell
$releaseVersion = (Get-Content wails.json -Raw | ConvertFrom-Json).info.productVersion
$env:CGO_ENABLED = "0"
wails build -platform windows/amd64 -nsis -installscope user -trimpath `
  -ldflags "-s -w -X qiaoji/internal/config.AppVersion=$releaseVersion"
```

安装包输出到 `build/bin/`。正式发布与更新清单维护见 [发布指南](docs/releasing.md)。

## 提交 Pull Request

- 说明具体问题、用户可见变化和验证结果。
- 为 UI 变更提供截图，为行为修复提供复现或测试。
- 保留用户已有 Markdown、front matter 和附件。
- 不提交个人笔记、凭据、依赖目录、构建输出或临时验收数据。

提交标题使用简短的祈使句，例如 `Fix document save conflicts`。大范围设计调整可先通过 Issue 说明场景与范围。
