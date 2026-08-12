/**
 * Languages highlighted inside fenced code blocks in the editor.
 *
 * `@codemirror/language-data` offers about 130 grammars, but naming them all
 * means shipping every one inside the executable. This curated table covers
 * what people actually paste into notes and keeps the bundle roughly a
 * megabyte smaller; each entry is still fetched on demand, so a note with no
 * Python in it never loads the Python parser.
 */

import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from "@codemirror/language";

interface Spec {
  name: string;
  alias: string[];
  extensions: string[];
  load: () => Promise<LanguageSupport>;
}

function describe(spec: Spec): LanguageDescription {
  return LanguageDescription.of(spec);
}

/** Adapts a CodeMirror 5 style mode from the legacy-modes package. */
async function legacy(
  loader: () => Promise<Record<string, unknown>>,
  key: string,
): Promise<LanguageSupport> {
  const mod = await loader();
  const mode = mod[key] as StreamParser<unknown>;
  return new LanguageSupport(StreamLanguage.define(mode));
}

export const codeLanguages: LanguageDescription[] = [
  describe({
    name: "JavaScript",
    alias: ["js", "node", "mjs", "cjs"],
    extensions: ["js", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  }),
  describe({
    name: "TypeScript",
    alias: ["ts"],
    extensions: ["ts", "mts"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  }),
  describe({
    name: "JSX",
    alias: ["jsx"],
    extensions: ["jsx"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  }),
  describe({
    name: "TSX",
    alias: ["tsx"],
    extensions: ["tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  describe({
    name: "Python",
    alias: ["py", "python3"],
    extensions: ["py", "pyw"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  describe({
    name: "Go",
    alias: ["golang"],
    extensions: ["go"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  }),
  describe({
    name: "Rust",
    alias: ["rs"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  }),
  describe({
    name: "Java",
    alias: [],
    extensions: ["java"],
    load: () => import("@codemirror/lang-java").then((m) => m.java()),
  }),
  describe({
    name: "C++",
    alias: ["cpp", "c", "cc", "h", "hpp", "objc"],
    extensions: ["cpp", "cc", "c", "h", "hpp"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  }),
  describe({
    name: "PHP",
    alias: [],
    extensions: ["php"],
    load: () => import("@codemirror/lang-php").then((m) => m.php()),
  }),
  describe({
    name: "HTML",
    alias: ["htm", "vue", "svelte"],
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
  describe({
    name: "CSS",
    alias: ["scss", "less"],
    extensions: ["css", "scss", "less"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  describe({
    name: "JSON",
    alias: ["jsonc", "json5"],
    extensions: ["json"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  describe({
    name: "XML",
    alias: ["svg", "xsl", "plist"],
    extensions: ["xml", "svg"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  }),
  describe({
    name: "YAML",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  }),
  describe({
    name: "SQL",
    alias: ["mysql", "postgres", "postgresql", "sqlite"],
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  }),
  describe({
    name: "Shell",
    alias: ["bash", "sh", "zsh", "console", "shell-session"],
    extensions: ["sh", "bash", "zsh"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  }),
  describe({
    name: "PowerShell",
    alias: ["ps1", "pwsh"],
    extensions: ["ps1"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell"),
  }),
  describe({
    name: "TOML",
    alias: ["ini", "cfg", "conf"],
    extensions: ["toml", "ini"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  }),
  describe({
    name: "Dockerfile",
    alias: ["docker"],
    extensions: ["dockerfile"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"),
  }),
  describe({
    name: "Diff",
    alias: ["patch"],
    extensions: ["diff", "patch"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/diff"), "diff"),
  }),
  describe({
    name: "Lua",
    alias: [],
    extensions: ["lua"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/lua"), "lua"),
  }),
  describe({
    name: "Ruby",
    alias: ["rb"],
    extensions: ["rb"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  }),
  describe({
    name: "Swift",
    alias: [],
    extensions: ["swift"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/swift"), "swift"),
  }),
  describe({
    name: "Kotlin",
    alias: ["kt"],
    extensions: ["kt", "kts"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  }),
  describe({
    name: "C#",
    alias: ["csharp", "cs"],
    extensions: ["cs"],
    load: () => legacy(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"),
  }),
];
