(function () {
  var WIDTH = 1240;
  var HEIGHT = 820;
  var NAV = 52;

  var device = document.getElementById("device");
  var stage = document.getElementById("stage");
  var track = document.getElementById("stage-track");
  var ticking = false;
  var lastScale = "";

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  function largeScale() {
    var availW = window.innerWidth - 48;
    var availH = window.innerHeight - NAV - 24;
    return clamp(Math.min(availW / WIDTH, availH / HEIGHT, 1), 0.45, 1);
  }

  function smallScale() {
    var availW = window.innerWidth - 48;
    var availH = (window.innerHeight - NAV) * 0.5;
    return clamp(Math.min(availW / WIDTH, availH / HEIGHT), 0.28, 0.58);
  }

  function layoutTrack() {
    if (!track || !stage) return;
    var stageH = window.innerHeight - NAV;
    var runway = Math.max(window.innerHeight * 0.55, 360);
    track.style.height = stageH + runway + "px";
  }

  function progress() {
    if (!track || !stage) return 0;
    var runway = track.offsetHeight - stage.offsetHeight;
    if (runway <= 1) return 0;
    var into = NAV - track.getBoundingClientRect().top;
    return clamp(into / runway, 0, 1);
  }

  function fit() {
    if (!device) return;
    if (device.classList.contains("is-max") || device.classList.contains("is-min")) {
      device.style.zoom = "";
      device.style.transform = "";
      lastScale = "";
      return;
    }
    var next = (largeScale() + (smallScale() - largeScale()) * ease(progress())).toFixed(3);
    if (next === lastScale) return;
    lastScale = next;
    device.style.zoom = "";
    device.style.transform = "scale(" + next + ")";
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      fit();
    });
  }

  function onResize() {
    layoutTrack();
    lastScale = "";
    fit();
  }

  function wheelDelta(ev) {
    var dy = ev.deltaY;
    if (ev.deltaMode === 1) dy *= 16;
    if (ev.deltaMode === 2) dy *= window.innerHeight;
    return dy;
  }

  function loadApp() {
    if (document.querySelector("script[data-qiaoji-app]")) return;
    var script = document.createElement("script");
    script.type = "module";
    script.crossOrigin = "anonymous";
    script.dataset.qiaojiApp = "1";
    script.src = "./assets/index-DsKTtC0Y.js";
    script.addEventListener("load", fit);
    document.body.appendChild(script);
  }

  layoutTrack();
  fit();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  window.addEventListener("load", onResize);
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
      ev.stopPropagation();
      var root = document.scrollingElement || document.documentElement;
      root.scrollTop += wheelDelta(ev);
    },
    { passive: false, capture: true },
  );
})();
