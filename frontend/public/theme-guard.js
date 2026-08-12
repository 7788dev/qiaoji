// Paints the saved theme before the bundle loads, otherwise a dark-theme
// launch shows a white flash for as long as the stylesheet takes to arrive.
//
// This lives in its own file rather than inline in the page because the
// Content-Security-Policy allows scripts from 'self' only; an inline block
// would be refused, which is exactly the flash it was written to prevent.
(function () {
  try {
    var saved = localStorage.getItem("qiaoji.theme") || "light";
    var dark =
      saved === "dark" ||
      (saved === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.background = dark ? "#1d2024" : "#eff0f2";
  } catch (e) {
    /* private mode or storage disabled: fall back to light */
  }
})();
