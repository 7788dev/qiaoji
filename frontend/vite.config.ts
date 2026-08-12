/// <reference types="vitest/config" />
import { defineConfig } from "vite";

/** CodeMirror packages needed before the first keystroke. */
const EDITOR_CORE = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/search",
  "@codemirror/lang-markdown",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  "@lezer/markdown",
  "style-mod",
  "w3c-keyname",
  "crelt",
];

export default defineConfig({
  build: {
    target: "chrome110",
    // The app is served from an embedded asset server, so a source map would
    // only bloat the binary.
    sourcemap: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 700,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          // KaTeX and highlight.js are dynamically imported by the renderer, so
          // a note without maths or code blocks never pays to load them.
          if (id.includes("node_modules/katex")) return "katex";
          if (id.includes("node_modules/highlight.js")) return "hljs";
          if (id.includes("node_modules/markdown-it") || id.includes("node_modules/entities")) {
            return "markdown";
          }

          // Only the editor core is bundled eagerly. @codemirror/language-data
          // loads its ~100 grammars through dynamic import, and naming them
          // here would drag every one of them into the startup chunk.
          if (EDITOR_CORE.some((pkg) => id.includes(`node_modules/${pkg}/`))) {
            return "editor";
          }
          return undefined;
        },
      },
    },
  },
  esbuild: {
    legalComments: "none",
  },
  test: {
    // jsdom rather than a browser: the tests here cover pure logic and DOM
    // bookkeeping, which is where the interaction bugs actually lived.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
