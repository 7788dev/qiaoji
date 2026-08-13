(function () {
  var WIDTH = 1240;
  var HEIGHT = 820;
  var NAV = 52;
  var PAD = 40;
  var MAX = 0.82;

  function fit() {
    var el = document.getElementById("device");
    if (!el) return;
    if (el.classList.contains("is-max") || el.classList.contains("is-min")) {
      el.style.zoom = "";
      return;
    }
    var scale = Math.min(
      (window.innerWidth - PAD) / WIDTH,
      (window.innerHeight - NAV - PAD) / HEIGHT,
      MAX,
    );
    el.style.zoom = String(Math.max(0.5, scale));
  }

  window.addEventListener("resize", fit);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fit);
  } else {
    fit();
  }
  var el = document.getElementById("device");
  if (el) {
    new MutationObserver(fit).observe(el, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
})();
