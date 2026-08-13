/**
 * Browser stand-in for the Wails Go bindings.
 * The GitHub Pages demo runs the real frontend against this in-memory vault.
 */
(function () {
  "use strict";

  var VAULT = "C:\\Users\\Demo\\Documents\\巧记";
  var STORAGE_KEY = "qiaoji.webdemo.v2";
  var FOLDER_NAMES = ["工作", "学习", "项目", "日常"];

  function iso(msAgo) {
    return new Date(Date.now() - msAgo).toISOString();
  }

  function countWords(text) {
    var count = 0;
    var inWord = false;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) {
        count++;
        inWord = false;
        continue;
      }
      var word =
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122);
      if (!word) {
        inWord = false;
        continue;
      }
      if (!inWord) {
        count++;
        inWord = true;
      }
    }
    return count;
  }

  function excerptOf(text) {
    return text
      .replace(/^#+\s+/gm, "")
      .replace(/[`$*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function titleOf(content, fallback) {
    var m = /^#\s+(.+)$/m.exec(content || "");
    return (m && m[1].trim()) || fallback || "未命名笔记";
  }

  function revisionOf(content) {
    var h = 2166136261;
    var s = String(content || "");
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }

  function joinPath(folder, title) {
    var file = (title || "未命名笔记") + ".md";
    return folder ? VAULT + "\\" + folder + "\\" + file : VAULT + "\\" + file;
  }

  var seq = 1;
  var notes = [];
  var trash = [];
  var folderNames = FOLDER_NAMES.slice();
  var maximised = false;
  var settings = {
    vaultPath: VAULT,
    theme: "light",
    language: "zh-CN",
    zoom: 100,
    autostart: false,
    minimiseToTray: true,
    closeToTray: false,
    autoUpdate: false,
    hardwareAcceleration: true,
    fontFamily: "system",
    fontSize: 15,
    lineHeight: 1.8,
    tabSize: 4,
    showLineNumbers: false,
    autoSave: true,
    autoSaveDelayMs: 800,
    autoPairing: true,
    editorWidth: "medium",
    listView: "list",
    sortBy: "updated",
    showLivePreview: true,
    exportDir: "下载",
    lastExportFormat: "md",
    window: { width: 1240, height: 820, x: -1, y: -1, maximised: false },
  };

  var SEEDS = [
    {
      folder: "",
      title: "欢迎使用巧记",
      tags: ["灵感"],
      ageMin: 5,
      favored: true,
      body:
        "# 欢迎使用巧记\n\n" +
        "这是一款轻量、快速、专注的 Markdown 笔记应用。\n\n" +
        "## 主要特性\n\n" +
        "- 实时预览\n" +
        "- 数学公式渲染\n" +
        "- 多种格式导出\n" +
        "- 极低资源占用\n\n" +
        "## 数学公式示例\n\n" +
        "行内公式：$E = mc^2$\n\n" +
        "块公式：\n\n" +
        "$$\n\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}\n$$\n\n" +
        "$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\, dx = \\sqrt{\\pi}\n$$\n\n" +
        "## 上手提示\n\n" +
        "- 按 `Ctrl + Shift + P` 打开命令面板\n" +
        "- 按 `Ctrl + P` 在编辑与预览之间切换\n" +
        "- 按 `Ctrl + N` 新建一篇笔记\n" +
        "- 所有笔记都是本地 `.md` 文件，随时可以用别的编辑器打开\n",
    },
    {
      folder: "",
      title: "Markdown 语法示例",
      tags: ["学习"],
      ageMin: 90,
      favored: false,
      body:
        "# Markdown 语法示例\n\n" +
        "## 文本样式\n\n" +
        "**粗体**、*斜体*、~~删除线~~、`行内代码`，以及[链接](https://commonmark.org)。\n\n" +
        "## 列表\n\n" +
        "1. 有序列表第一项\n2. 有序列表第二项\n\n" +
        "- 无序列表\n- 支持嵌套\n  - 第二层\n\n" +
        "## 任务清单\n\n" +
        "- [x] 完成原型还原\n- [ ] 补充导出功能\n- [ ] 性能压测\n\n" +
        "## 引用与分割线\n\n" +
        "> 少即是多，专注内容本身。\n\n---\n\n" +
        "## 代码块\n\n" +
        "```go\nfunc main() {\n\tfmt.Println(\"hello, 巧记\")\n}\n```\n\n" +
        "## 表格\n\n" +
        "| 格式 | 扩展名 | 说明 |\n| --- | --- | --- |\n" +
        "| Markdown | .md | 原样导出 |\n| HTML | .html | 单文件自包含 |\n| PDF | .pdf | 排版与预览一致 |\n",
    },
    {
      folder: "",
      title: "公式示例",
      tags: ["学习", "项目"],
      ageMin: 200,
      favored: false,
      body:
        "# 公式示例\n\n" +
        "## 行内\n\n" +
        "质能方程 $E = mc^2$ 与欧拉恒等式 $e^{i\\pi} + 1 = 0$。\n\n" +
        "## 块级\n\n" +
        "高斯定理：\n\n$$\n\\oint_{\\partial V} \\mathbf{E} \\cdot d\\mathbf{A} = \\frac{Q}{\\varepsilon_0}\n$$\n\n" +
        "傅里叶变换：\n\n$$\n\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x)\\, e^{-2\\pi i x \\xi}\\, dx\n$$\n\n" +
        "矩阵：\n\n$$\nA = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$\n",
    },
    {
      folder: "工作",
      title: "周报计划",
      tags: ["工作"],
      ageMin: 60 * 26,
      favored: false,
      body:
        "# 周报计划\n\n## 本周完成\n\n- [x] 需求评审\n- [x] 接口联调\n\n" +
        "## 下周安排\n\n- [ ] 性能优化\n- [ ] 灰度发布\n\n## 风险\n\n> 依赖的第三方接口稳定性待观察。\n",
    },
    {
      folder: "学习",
      title: "读书笔记",
      tags: ["学习", "灵感"],
      ageMin: 60 * 50,
      favored: true,
      body:
        "# 读书笔记\n\n## 核心观点\n\n把复杂的问题拆成可以独立验证的小块。\n\n" +
        "## 摘录\n\n> 简单是可靠的先决条件。\n\n## 我的思考\n\n" +
        "工具的价值在于减少摩擦，而不是增加选项。\n",
    },
    {
      folder: "日常",
      title: "灵感记录",
      tags: ["灵感", "待办"],
      ageMin: 60 * 74,
      favored: false,
      body:
        "# 灵感记录\n\n- 用一个快捷键完成从想法到落笔的全过程\n" +
        "- 深色主题下的公式配色需要单独校准\n- 导出 PDF 时保留代码块的圆角边框\n",
    },
  ];

  function makeNote(seed) {
    var created = iso(seed.ageMin * 60000);
    var note = {
      id: "n" + seq++,
      title: seed.title,
      folder: seed.folder || "",
      path: joinPath(seed.folder || "", seed.title),
      tags: (seed.tags || []).slice(),
      created: created,
      updated: created,
      favorite: !!seed.favored,
      content: seed.body,
    };
    touchMeta(note);
    return note;
  }

  function touchMeta(note) {
    note.excerpt = excerptOf(note.content);
    note.words = countWords(note.content);
    note.size = new Blob([note.content]).size;
    note.revision = revisionOf(note.content);
  }

  function metaOf(note) {
    return {
      id: note.id,
      title: note.title,
      folder: note.folder,
      path: note.path,
      tags: note.tags.slice(),
      created: note.created,
      updated: note.updated,
      favorite: note.favorite,
      excerpt: note.excerpt,
      words: note.words,
      size: note.size,
      revision: note.revision,
    };
  }

  function fullOf(note) {
    var out = metaOf(note);
    out.content = note.content;
    return out;
  }

  function findNote(path, id) {
    return (
      notes.find(function (n) {
        return (path && n.path === path) || (id && n.id === id);
      }) || null
    );
  }

  function uniquePath(folder, title) {
    var base = String(title || "未命名笔记").replace(/[\\/:*?"<>|]/g, "").trim() || "未命名笔记";
    var path = joinPath(folder, base);
    var i = 2;
    while (notes.some(function (n) { return n.path === path; })) {
      path = joinPath(folder, base + "-" + i);
      i++;
    }
    return path;
  }

  function folderList() {
    return folderNames.map(function (name) {
      return {
        name: name,
        path: name,
        count: notes.filter(function (n) { return n.folder === name; }).length,
      };
    });
  }

  function tagList() {
    var map = {};
    notes.forEach(function (n) {
      n.tags.forEach(function (t) {
        map[t] = (map[t] || 0) + 1;
      });
    });
    return Object.keys(map)
      .sort()
      .map(function (name) {
        return { name: name, count: map[name] };
      });
  }

  function statsOf() {
    var words = 0;
    var bytes = 0;
    notes.forEach(function (n) {
      words += n.words;
      bytes += n.size;
    });
    return {
      notes: notes.length,
      words: words,
      folders: folderNames.length,
      tags: tagList().length,
      trash: trash.length,
      bytes: bytes,
    };
  }

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ notes: notes, trash: trash, folderNames: folderNames, settings: settings, seq: seq }),
      );
    } catch (e) {
      /* private mode */
    }
  }

  function seedAll() {
    seq = 1;
    notes = SEEDS.map(makeNote);
    trash = [];
    folderNames = FOLDER_NAMES.slice();
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.notes) && data.notes.length) {
          notes = data.notes;
          trash = data.trash || [];
          folderNames = data.folderNames || FOLDER_NAMES.slice();
          seq = data.seq || notes.length + 1;
          if (data.settings) settings = Object.assign(settings, data.settings, { autoUpdate: false, vaultPath: VAULT });
          return;
        }
      }
    } catch (e) {
      /* fall through to seed */
    }
    seedAll();
  }

  function listNotes(query) {
    query = query || {};
    var rows = notes.slice();
    var scope = query.scope || "all";
    if (scope === "favorites") rows = rows.filter(function (n) { return n.favorite; });
    else if (scope === "folder") rows = rows.filter(function (n) { return n.folder === query.value; });
    else if (scope === "tag") rows = rows.filter(function (n) { return n.tags.indexOf(query.value) >= 0; });
    else if (scope === "untagged") rows = rows.filter(function (n) { return !n.tags.length; });
    else if (scope === "recent") {
      rows.sort(function (a, b) { return new Date(b.updated) - new Date(a.updated); });
      rows = rows.slice(0, 8);
    }
    var sortBy = query.sortBy || "updated";
    if (sortBy === "title") rows.sort(function (a, b) { return a.title.localeCompare(b.title, "zh"); });
    else if (sortBy === "created") rows.sort(function (a, b) { return new Date(b.created) - new Date(a.created); });
    else if (scope !== "recent") rows.sort(function (a, b) { return new Date(b.updated) - new Date(a.updated); });
    return rows.map(metaOf);
  }

  function highlight(text, q) {
    var safe = text.replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
    if (!q) return safe;
    var re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    return safe.replace(re, function (m) { return "<mark>" + m + "</mark>"; });
  }

  function search(query, limit) {
    var q = String(query || "").trim();
    if (!q) return [];
    limit = limit || 60;
    var lower = q.toLowerCase();
    var hits = [];
    notes.forEach(function (n) {
      var hay = (n.title + "\n" + n.content).toLowerCase();
      if (hay.indexOf(lower) < 0) return;
      var idx = n.content.toLowerCase().indexOf(lower);
      var start = Math.max(0, idx - 24);
      var snippet = (idx >= 0 ? n.content.slice(start, start + 80) : n.excerpt).replace(/\s+/g, " ");
      hits.push({
        id: n.id,
        path: n.path,
        title: n.title,
        titleHtml: highlight(n.title, q),
        folder: n.folder,
        snippet: highlight(snippet, q),
        updated: n.updated,
        favorite: n.favorite,
      });
    });
    return hits.slice(0, limit);
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return "下载\\" + filename;
  }

  function device() {
    return document.getElementById("device");
  }

  function desktopOnly() {
    return Promise.reject("网页演示中请使用 Windows 版完成此操作");
  }

  var listeners = {};
  function onEvent(name, cb) {
    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(cb);
    return function () {
      listeners[name] = (listeners[name] || []).filter(function (fn) { return fn !== cb; });
    };
  }

  load();

  window.go = {
    main: {
      App: {
        ApplyTheme: function () { return Promise.resolve(); },
        ApplyUpdate: function () { return desktopOnly(); },
        Bootstrap: function () {
          return Promise.resolve({
            settings: settings,
            vaultReady: true,
            vaultPath: VAULT,
            version: "web",
            error: "",
            stats: statsOf(),
          });
        },
        CancelClose: function () { return Promise.resolve(); },
        CheckForUpdates: function () {
          return Promise.resolve({
            currentVersion: "web",
            latestVersion: "web",
            available: false,
            releaseUrl: "https://github.com/7788dev/qiaoji/releases/latest",
          });
        },
        ConfirmClose: function () { return Promise.resolve(); },
        CreateFolder: function (name) {
          name = String(name || "").trim();
          if (!name) return Promise.reject("文件夹名不能为空");
          if (folderNames.indexOf(name) >= 0) return Promise.reject("文件夹已存在");
          folderNames.push(name);
          persist();
          return Promise.resolve({ name: name, path: name, count: 0 });
        },
        CreateNote: function (folder, title) {
          title = String(title || "").trim() || "未命名笔记";
          folder = folder || "";
          var body = "# " + title + "\n\n";
          var note = makeNote({
            folder: folder,
            title: title,
            tags: [],
            ageMin: 0,
            favored: false,
            body: body,
          });
          note.path = uniquePath(folder, title);
          note.created = new Date().toISOString();
          note.updated = note.created;
          notes.unshift(note);
          persist();
          return Promise.resolve(fullOf(note));
        },
        DeleteFolder: function (path) {
          var moved = notes.filter(function (n) { return n.folder === path; });
          notes = notes.filter(function (n) { return n.folder !== path; });
          folderNames = folderNames.filter(function (n) { return n !== path; });
          var item = {
            id: "t" + seq++,
            kind: "folder",
            title: path,
            folder: "",
            excerpt: moved.length + " 篇笔记",
            deletedAt: new Date().toISOString(),
            originalRel: path,
            size: 0,
            notes: moved.length,
            files: moved.length,
            _notes: moved,
          };
          trash.unshift(item);
          persist();
          return Promise.resolve(item);
        },
        DeleteNote: function (path) {
          var note = findNote(path, "");
          if (!note) return Promise.reject("笔记不存在");
          notes = notes.filter(function (n) { return n.path !== path; });
          var item = {
            id: "t" + seq++,
            kind: "note",
            title: note.title,
            folder: note.folder,
            excerpt: note.excerpt,
            deletedAt: new Date().toISOString(),
            originalRel: note.path,
            size: note.size,
            notes: 1,
            files: 1,
            _note: note,
          };
          trash.unshift(item);
          persist();
          return Promise.resolve(item);
        },
        DeleteTag: function (name) {
          var count = 0;
          notes.forEach(function (n) {
            var next = n.tags.filter(function (t) { return t !== name; });
            if (next.length !== n.tags.length) {
              n.tags = next;
              count++;
            }
          });
          persist();
          return Promise.resolve(count);
        },
        DuplicateNote: function (path) {
          var note = findNote(path, "");
          if (!note) return Promise.reject("笔记不存在");
          var copy = makeNote({
            folder: note.folder,
            title: note.title + " 副本",
            tags: note.tags.slice(),
            ageMin: 0,
            favored: false,
            body: note.content,
          });
          copy.path = uniquePath(note.folder, copy.title);
          copy.created = new Date().toISOString();
          copy.updated = copy.created;
          notes.unshift(copy);
          persist();
          return Promise.resolve(metaOf(copy));
        },
        EmptyTrash: function () {
          trash = [];
          persist();
          return Promise.resolve();
        },
        Export: function (req) {
          req = req || {};
          var format = req.format || "md";
          var name = (req.fileName || req.title || "笔记") + "." + format;
          if (format === "md" || format === "txt") {
            return Promise.resolve(download(name, req.markdown || "", "text/plain;charset=utf-8"));
          }
          if (format === "html") {
            var html =
              "<!doctype html><meta charset=utf-8><title>" +
              (req.title || "笔记") +
              "</title><body>" +
              (req.bodyHtml || "") +
              "</body>";
            return Promise.resolve(download(name, html, "text/html;charset=utf-8"));
          }
          return desktopOnly();
        },
        GetNote: function (path, id) {
          var note = findNote(path, id);
          if (!note) return Promise.reject("笔记不存在");
          return Promise.resolve(fullOf(note));
        },
        GetSettings: function () { return Promise.resolve(settings); },
        ListFolders: function () { return Promise.resolve(folderList()); },
        ListNotes: function (query) { return Promise.resolve(listNotes(query)); },
        ListTags: function () { return Promise.resolve(tagList()); },
        ListTrash: function () {
          return Promise.resolve(
            trash.map(function (t) {
              return {
                id: t.id,
                kind: t.kind,
                title: t.title,
                folder: t.folder,
                excerpt: t.excerpt,
                deletedAt: t.deletedAt,
                originalRel: t.originalRel,
                size: t.size,
                notes: t.notes,
                files: t.files,
              };
            }),
          );
        },
        MoveNote: function (path, folder) {
          var note = findNote(path, "");
          if (!note) return Promise.reject("笔记不存在");
          note.folder = folder || "";
          note.path = uniquePath(note.folder, note.title);
          note.updated = new Date().toISOString();
          persist();
          return Promise.resolve(metaOf(note));
        },
        OpenExternal: function (url) {
          if (url) window.open(url, "_blank", "noopener");
          return Promise.resolve();
        },
        OpenPath: function () { return Promise.resolve(); },
        OpenVault: function () {
          return Promise.resolve({
            settings: settings,
            vaultReady: true,
            vaultPath: VAULT,
            version: "web",
            error: "",
            stats: statsOf(),
          });
        },
        PurgeTrashItem: function (id) {
          trash = trash.filter(function (t) { return t.id !== id; });
          persist();
          return Promise.resolve();
        },
        RebuildIndex: function () { return Promise.resolve(statsOf()); },
        RenameFolder: function (path, name) {
          name = String(name || "").trim();
          if (!path || !name) return Promise.reject("参数无效");
          var idx = folderNames.indexOf(path);
          if (idx < 0) return Promise.reject("文件夹不存在");
          folderNames[idx] = name;
          notes.forEach(function (n) {
            if (n.folder === path) {
              n.folder = name;
              n.path = uniquePath(name, n.title);
            }
          });
          persist();
          return Promise.resolve();
        },
        RenameNote: function (path, title) {
          var note = findNote(path, "");
          if (!note) return Promise.reject("笔记不存在");
          note.title = String(title || "").trim() || note.title;
          note.path = uniquePath(note.folder, note.title);
          note.updated = new Date().toISOString();
          persist();
          return Promise.resolve(metaOf(note));
        },
        RenameTag: function (oldName, newName) {
          var count = 0;
          notes.forEach(function (n) {
            n.tags = n.tags.map(function (t) {
              if (t === oldName) {
                count++;
                return newName;
              }
              return t;
            });
          });
          persist();
          return Promise.resolve(count);
        },
        RequestQuit: function () { return Promise.resolve(); },
        RestoreNote: function (id) {
          var idx = trash.findIndex(function (t) { return t.id === id; });
          if (idx < 0) return Promise.reject("回收站条目不存在");
          var item = trash.splice(idx, 1)[0];
          if (item.kind === "folder") {
            if (folderNames.indexOf(item.title) < 0) folderNames.push(item.title);
            (item._notes || []).forEach(function (n) { notes.unshift(n); });
            persist();
            return Promise.resolve({ kind: "folder", note: {}, folder: item.title, notes: item.notes || 0 });
          }
          var note = item._note;
          if (note) notes.unshift(note);
          persist();
          return Promise.resolve({ kind: "note", note: note ? fullOf(note) : {}, folder: note ? note.folder : "", notes: 1 });
        },
        RevealInExplorer: function () { return desktopOnly(); },
        SaveAsset: function () { return desktopOnly(); },
        SaveNote: function (path, content, expectedRevision, force) {
          var note = findNote(path, "");
          if (!note) return Promise.reject("笔记不存在");
          if (!force && expectedRevision && expectedRevision !== note.revision) {
            return Promise.reject("笔记已在其他位置被修改");
          }
          note.content = String(content || "");
          note.title = titleOf(note.content, note.title);
          note.updated = new Date().toISOString();
          touchMeta(note);
          persist();
          return Promise.resolve(metaOf(note));
        },
        SaveSettings: function (next) {
          settings = Object.assign(settings, next || {}, { autoUpdate: false, vaultPath: VAULT });
          persist();
          return Promise.resolve(settings);
        },
        SaveWindowState: function () { return Promise.resolve(); },
        Search: function (query, limit) { return Promise.resolve(search(query, limit)); },
        SelectExportDir: function () { return Promise.resolve("下载"); },
        SelectVaultDir: function () { return Promise.resolve(""); },
        SetFavorite: function (path, favorite) {
          var note = findNote(path, "");
          if (!note) return Promise.reject("笔记不存在");
          note.favorite = !!favorite;
          note.updated = new Date().toISOString();
          persist();
          return Promise.resolve(metaOf(note));
        },
        SetNoteTags: function (path, tags) {
          var note = findNote(path, "");
          if (!note) return Promise.reject("笔记不存在");
          note.tags = Array.isArray(tags) ? tags.slice() : [];
          persist();
          return Promise.resolve(metaOf(note));
        },
        ShowWindow: function () {
          var el = device();
          if (el) el.classList.remove("is-min", "is-closed");
          return Promise.resolve();
        },
        Sidebar: function () {
          return Promise.resolve({
            folders: folderList(),
            tags: tagList(),
            stats: statsOf(),
          });
        },
        SortedFolderNames: function () { return Promise.resolve(folderNames.slice()); },
        Stats: function () { return Promise.resolve(statsOf()); },
        Suggest: function (query, limit) {
          var q = String(query || "").trim().toLowerCase();
          var rows = notes.filter(function (n) { return !q || n.title.toLowerCase().indexOf(q) >= 0; });
          return Promise.resolve(rows.slice(0, limit || 20).map(metaOf));
        },
        WindowClose: function () {
          var el = device();
          if (el) {
            el.classList.add("is-closed");
            setTimeout(function () { el.classList.remove("is-closed"); }, 900);
          }
          return Promise.resolve();
        },
        WindowIsMaximised: function () { return Promise.resolve(maximised); },
        WindowMinimise: function () {
          var el = device();
          if (el) {
            el.classList.remove("is-max");
            el.classList.add("is-min");
          }
          maximised = false;
          return Promise.resolve();
        },
        WindowToggleMaximise: function () {
          maximised = !maximised;
          var el = device();
          if (el) {
            el.classList.remove("is-min");
            el.classList.toggle("is-max", maximised);
          }
          window.dispatchEvent(new Event("resize"));
          return Promise.resolve(maximised);
        },
      },
    },
  };

  function noop() {}
  function okFalse() { return Promise.resolve(false); }
  function okTrue() { return Promise.resolve(true); }

  window.runtime = {
    EventsOnMultiple: function (eventName, callback) { return onEvent(eventName, callback); },
    EventsOn: function (eventName, callback) { return onEvent(eventName, callback); },
    EventsOff: noop,
    EventsOffAll: noop,
    EventsOnce: function (eventName, callback) {
      var off = onEvent(eventName, function (data) {
        off();
        callback(data);
      });
      return off;
    },
    EventsEmit: noop,
    LogPrint: noop,
    LogTrace: noop,
    LogDebug: noop,
    LogInfo: noop,
    LogWarning: noop,
    LogError: function (message) { console.error(message); },
    LogFatal: function (message) { console.error(message); },
    WindowReload: function () { location.reload(); },
    WindowReloadApp: function () { location.reload(); },
    WindowSetAlwaysOnTop: noop,
    WindowSetSystemDefaultTheme: noop,
    WindowSetLightTheme: noop,
    WindowSetDarkTheme: noop,
    WindowCenter: noop,
    WindowSetTitle: function (title) {
      document.title = title ? title + " — 巧记" : "巧记";
    },
    WindowFullscreen: noop,
    WindowUnfullscreen: noop,
    WindowIsFullscreen: okFalse,
    WindowGetSize: function () { return Promise.resolve({ w: 1240, h: 820 }); },
    WindowSetSize: noop,
    WindowSetMaxSize: noop,
    WindowSetMinSize: noop,
    WindowSetPosition: noop,
    WindowGetPosition: function () { return Promise.resolve({ x: 0, y: 0 }); },
    WindowHide: noop,
    WindowShow: noop,
    WindowMaximise: function () { return window.go.main.App.WindowToggleMaximise(); },
    WindowToggleMaximise: function () { return window.go.main.App.WindowToggleMaximise(); },
    WindowUnmaximise: noop,
    WindowIsMaximised: function () { return window.go.main.App.WindowIsMaximised(); },
    WindowMinimise: function () { return window.go.main.App.WindowMinimise(); },
    WindowUnminimise: noop,
    WindowSetBackgroundColour: noop,
    ScreenGetAll: function () { return Promise.resolve([]); },
    WindowIsMinimised: okFalse,
    WindowIsNormal: okTrue,
    BrowserOpenURL: function (url) { if (url) window.open(url, "_blank", "noopener"); },
    Environment: function () { return Promise.resolve({ platform: "web", arch: "amd64" }); },
    Quit: noop,
    Hide: noop,
    Show: noop,
    ClipboardGetText: function () {
      return navigator.clipboard && navigator.clipboard.readText
        ? navigator.clipboard.readText()
        : Promise.resolve("");
    },
    ClipboardSetText: function (text) {
      return navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text)
        : Promise.resolve();
    },
    OnFileDrop: noop,
    OnFileDropOff: noop,
    CanResolveFilePaths: okFalse,
    ResolveFilePaths: function () { return Promise.resolve([]); },
  };

  document.addEventListener("click", function (ev) {
    var el = device();
    if (!el || !el.classList.contains("is-min")) return;
    if (el.contains(ev.target)) {
      el.classList.remove("is-min");
      window.dispatchEvent(new Event("resize"));
    }
  });
})();
