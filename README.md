# 巧记

<img src="UI/brand/logo.png" alt="巧记" width="286">


轻量 · 高效 · 专注的本地 Markdown 笔记应用。按 `UI/` 目录下的原型图实现，Go + Wails v2 编写，打包为单个 Windows 可执行文件。

笔记就是磁盘上的 `.md` 文件。应用不锁定任何数据：随时可以用别的编辑器打开、丢进网盘或 Git 同步，卸载后笔记依旧在。

---

## 实测数据

在 Windows 11 24H2 / Ryzen 9 7945HX 上测得：

| 指标 | 数值 |
| --- | --- |
| 可执行文件 | 18.7 MB（单文件，无需安装运行时） |
| 首次启动 | 1675 ms（含创建笔记库与写入示例笔记） |
| 日常启动 | 721 ms（到窗口可见） |
| 常驻内存 | 170–190 MB 私有工作集 |
| 1200 篇笔记冷建索引 | 444 ms |
| 1200 篇笔记热启动 | 5 ms |
| 全文搜索（≥3 字） | 5 ms |
| 中文两字搜索（LIKE 回退） | 2 ms |

内存按**私有工作集**统计。任务管理器显示的「工作集」约 440 MB，那个数字把 Chromium 多个进程共享的代码页重复计算了好几遍，并不代表真实占用。典型构成：

| 进程 | 私有内存 |
| --- | --- |
| GPU 进程 | 79–106 MB（随显卡驱动波动，本机有双显卡） |
| 渲染进程 | 约 34 MB |
| 浏览器进程 | 约 32 MB |
| Go 主进程 | 约 12 MB |
| 辅助进程 | 约 12 MB |

Go 主进程只占 12 MB —— 剩下的几乎全是 WebView2，其中 GPU 进程占了大头。这是选择 WebView2 的代价，换来的是与原型完全一致的界面、KaTeX 公式排版和所见即所得的 PDF 导出。设置里的「硬件加速」开关**不会**降低内存：关掉之后 Chromium 依然会保留 GPU 进程做软件合成，实测反而更高，所以那个开关只作为显示异常时的排查手段。

---

## 功能

- **三栏布局**：笔记库导航 / 笔记列表 / 编辑器，侧边栏与列表都可折叠
- **实时 Markdown 编辑**：标题按真实字号显示、语法标记保持可见可编辑，公式在编辑时就渲染成排版结果，光标移入自动还原为 TeX 源码
- **右键插入**：正文里点右键（或点工具栏的 `+`）可以插入标题、列表、表格、代码块、公式、日期，以及会议纪要 / 日报 / 周报 / 待办清单 / 读书笔记 / 技术方案六套整篇模板。模板里的日期是实时生成的，插入后光标会停在第一个要填的位置
- **预览模式**：`Ctrl + P` 在编辑与全渲染预览之间切换
- **数学公式**：KaTeX 行内 `$...$` 与块级 `$$...$$`
- **代码高亮**：26 种常用语言，按需加载
- **组织方式**：文件夹、标签、收藏、最近使用、回收站
- **搜索**：SQLite FTS5 全文检索，结果带高亮片段
- **命令面板**：`Ctrl + Shift + P`，同时搜索命令与笔记
- **导出**：Markdown / HTML / PDF / Word / 纯文本
- **深色主题**：可跟随系统
- **系统托盘**：最小化到托盘、开机自启

---

## 数据存放在哪里

```
%USERPROFILE%\Documents\巧记\      笔记库（可在设置里更改）
├─ 工作\  学习\  项目\  日常\             文件夹就是侧边栏分类
│  └─ 周报计划.md
├─ 欢迎使用巧记.md
└─ .qiaoji\
   ├─ index.db      搜索索引（可随时删除，下次启动自动重建）
   ├─ vault.json    初始化标记
   └─ trash\        回收站

%APPDATA%\巧记\settings.json        应用设置
```

每篇笔记的元数据放在 YAML front matter 里，用别的编辑器打开也不会乱：

```markdown
---
id: 01j8xq2n5m7p
title: 欢迎使用巧记
tags:
  - 灵感
created: 2026-08-11T23:47:35+08:00
updated: 2026-08-12T00:10:00+08:00
favorite: true
---

# 欢迎使用巧记
```

**关于示例笔记**：首次使用某个文件夹时会写入几篇示例笔记，同时留下 `.qiaoji/vault.json` 标记。把示例笔记全部删掉后，下次启动就是空的——不会再塞回来。想重新拿到示例笔记，删掉 `vault.json` 即可。

---

## 快捷键

| 操作 | 快捷键 | | 操作 | 快捷键 |
| --- | --- | --- | --- | --- |
| 新建笔记 | `Ctrl + N` | | 加粗 | `Ctrl + B` |
| 保存 | `Ctrl + S` | | 斜体 | `Ctrl + I` |
| 导出 | `Ctrl + E` | | 行内代码 | `Ctrl + E` |
| 关闭标签 | `Ctrl + W` | | 插入链接 | `Ctrl + K` |
| 查找 | `Ctrl + F` | | 任务项 | `Ctrl + Shift + L` |
| 替换 | `Ctrl + H` | | 一至四级标题 | `Ctrl + 1` ~ `4` |
| 全文搜索 | `Ctrl + Shift + F` | | 预览切换 | `Ctrl + P` |
| 命令面板 | `Ctrl + Shift + P` | | 侧边栏 | `Ctrl + \` |
| 设置 | `Ctrl + ,` | | 快捷键一览 | `Ctrl + /` |

---

## 技术选型的几个理由

**为什么用 Wails v2 而不是 Electron**
Electron 每个应用都要带一份 Chromium（约 150 MB）。Wails 用系统自带的 WebView2，可执行文件只有 18.7 MB，内存占用大约是同类 Electron 笔记应用的三分之一。

**必须锁 Wails v2.13.0**
Go 1.25 默认输出 DWARF5 调试信息，旧版 Wails 生成的 `wailsbindings.exe` 在 Windows 上会直接报「不是有效的 Win32 应用程序」。v2.13.0 通过在构建绑定工具时加 `-ldflags "-s -w"` 修掉了这个问题。

**CGO_ENABLED=0**
Wails 的 Windows 后端是纯 Go（go-webview2 走 COM），SQLite 用纯 Go 的 `modernc.org/sqlite`。产物是完全静态的可执行文件，不依赖任何 MinGW 运行时。

**中文搜索为什么要两条路径**
FTS5 的 `trigram` 分词器一次索引三个字符，查询短于三个字符时无法命中——而中文里「笔记」「工作」这类两字词恰恰是最常搜的。所以三字及以上走 FTS5 索引（5 ms），一到两字回退到 `LIKE` 扫描（2 ms）。两条路径的高亮片段都在 Go 侧统一生成，结果表现一致。

**预览为什么不走后端渲染**
Markdown 渲染放在前端。每次敲键盘都往 Go 端往返一次会明显掉帧，本地渲染 + 140 ms 防抖才能保证长文档打字不卡。

**PDF 为什么调 Edge**
PDF 用系统自带的 Edge 无头模式打印生成。渲染预览的就是同一个引擎，公式、代码高亮、表格、中文断行的结果完全一致，不需要重新实现一套排版和字体处理。

**Word 导出为什么手写 OOXML**
现成的 Go docx 库无法设置代码块的等宽字体、中文 eastAsia 字体和列表重新编号。直接写 WordprocessingML 多花几百行，但换来真正可用的 Word 文档：标题进导航窗格、表格可编辑、代码块等宽带底纹、相邻有序列表各自从 1 开始。

**HTML 导出为什么是单文件**
导出的 HTML 内嵌了 KaTeX 样式与 20 个 woff2 字体（base64），不联网、不带附属文件也能正确显示公式。应用内则用只引用 woff2 的版本，比 KaTeX 原版少打包 40 个字体文件，约 800 KB。

---

## 从源码构建

需要 Go 1.24+、Node 18+、WebView2 运行时（Windows 10/11 自带）。

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0

# 开发模式
wails dev

# 生产构建，产物在 build/bin/巧记.exe
set CGO_ENABLED=0
wails build -platform windows/amd64 -trimpath -ldflags "-s -w"
```

代码检查与测试：

```bash
go vet ./...
go test ./internal/...
cd frontend && npx tsc --noEmit
```

升级 KaTeX 或修改品牌资源后需要重新生成：

```bash
go run ./tools/genkatex   # 两份 KaTeX 样式表（内联版给导出，woff2 版给应用）
python tools/genicon.py   # 应用图标、.ico、界面用的 mark 与文档用的 logo
```

`tools/genicon.py` 的输入是 `UI/brand/icon-source.png`（1024px 母版）。图标的圆角是一条超椭圆曲线（半径 15%、指数 1.75），这两个数字是量出来的而不是猜的，所以裁切正好落在画好的边缘上，既不会切进去也不会留下白边。

---

## 项目结构

```
main.go                  窗口、托盘、单实例锁
app.go                   绑定给前端的 API
internal/store/          .md 读写、front matter、回收站、示例笔记
internal/index/          SQLite FTS5 索引与混合搜索
internal/watch/          外部改动监听（防抖合并）
internal/exporter/       md / txt / html / pdf / docx 导出
internal/config/         设置持久化、开机自启
tools/                   KaTeX 样式表与品牌资源生成器
UI/brand/                图标母版与生成的 logo
frontend/src/
  lib/                   DOM 辅助、编辑器、Markdown、虚拟列表、公式装饰
  ui/                    标题栏、侧边栏、列表、编辑区、状态栏、各类对话框
  styles/                设计令牌与样式
```
