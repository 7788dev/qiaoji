(function () {
  var WIDTH = 1240;
  var HEIGHT = 820;
  var NAV = 52;

  var device = document.getElementById("device");
  var hero = document.querySelector(".hero");
  var ticking = false;
  var lastZoom = "";

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  function largeScale() {
    var availW = window.innerWidth - 24;
    var availH = window.innerHeight - NAV - 16;
    return clamp(Math.min(availW / WIDTH, availH / HEIGHT, 1), 0.55, 1);
  }

  function smallScale() {
    var availW = window.innerWidth - 24;
    var availH = window.innerHeight * 0.48;
    return clamp(Math.min(availW / WIDTH, availH / HEIGHT), 0.32, 0.58);
  }

  function progress() {
    var hold = hero ? Math.max(hero.offsetHeight * 0.15, 12) : 12;
    var range = Math.max(window.innerHeight * 0.42, 260);
    return clamp((window.scrollY - hold) / range, 0, 1);
  }

  function fit() {
    if (!device) return;
    if (device.classList.contains("is-max") || device.classList.contains("is-min")) {
      if (lastZoom !== "") {
        device.style.zoom = "";
        lastZoom = "";
      }
      return;
    }
    var next = String(largeScale() + (smallScale() - largeScale()) * ease(progress()));
    if (next === lastZoom) return;
    lastZoom = next;
    device.style.zoom = next;
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      fit();
    });
  }

  function wheelDelta(ev) {
    var dy = ev.deltaY;
    if (ev.deltaMode === 1) dy *= 16;
    if (ev.deltaMode === 2) dy *= window.innerHeight;
    return dy;
  }

  function loadApp() {
    if (document.querySelector('script[data-qiaoji-app]')) return;
    var script = document.createElement("script");
    script.type = "module";
    script.crossOrigin = "anonymous";
    script.dataset.qiaojiApp = "1";
    script.src = "./assets/index-DsKTtC0Y.js";
    script.addEventListener("load", fit);
    document.body.appendChild(script);
  }

  fit();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", fit);
  window.addEventListener("load", fit);
  window.addEventListener("load", loadApp);
  requestAnimationFrame(function () {
    requestAnimationFrame(loadApp);
  });

  window.addEventListener(
    "wheel",
    function (ev) {
      if (ev.ctrlKey) return;
      if (!device || device.classList.contains("is-max")) return;
      if (!device.contains(ev.target)) return;
      ev.preventDefault();
      window.scrollBy(0, wheelDelta(ev));
      fit();
    },
    { passive: false, capture: true },
  );
})();
