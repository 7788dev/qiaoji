(function () {
  var WIDTH = 1240;
  var PAD = 48;
  var MAX = 0.68;

  function fit() {
    var el = document.getElementById("device");
    if (!el) return;
    if (el.classList.contains("is-max") || el.classList.contains("is-min")) {
      el.style.zoom = "";
      return;
    }
    var scale = Math.min((window.innerWidth - PAD) / WIDTH, MAX);
    el.style.zoom = String(Math.max(0.42, scale));
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
