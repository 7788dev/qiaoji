(function () {
  var WIDTH = 1240;
  var HEIGHT = 820;
  var PAD = 40;
  var NAV = 52;

  var device = document.getElementById("device");
  var pin = document.querySelector(".stage-pin");
  var ticking = false;

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  function unlockScroll() {
    var html = document.documentElement;
    html.style.setProperty("overflow", "auto", "important");
    html.style.setProperty("height", "auto", "important");
    document.body.style.setProperty("overflow", "auto", "important");
    document.body.style.setProperty("height", "auto", "important");
    document.body.style.setProperty("overscroll-behavior", "auto", "important");
  }

  function largeScale() {
    var availW = window.innerWidth - PAD;
    var availH = window.innerHeight - NAV - 24;
    return clamp(Math.min(availW / WIDTH, availH / HEIGHT, 0.9), 0.5, 0.9);
  }

  function smallScale() {
    var availW = window.innerWidth - PAD;
    return clamp(Math.min(availW / WIDTH, 0.58), 0.42, 0.58);
  }

  function progress() {
    if (!pin) return 0;
    var start = pin.offsetTop - NAV;
    var end = pin.offsetTop + pin.offsetHeight - window.innerHeight;
    if (end <= start) return 0;
    return clamp((window.scrollY - start) / (end - start), 0, 1);
  }

  function fit() {
    unlockScroll();
    if (!device) return;
    if (device.classList.contains("is-max") || device.classList.contains("is-min")) {
      device.style.zoom = "";
      return;
    }
    var t = ease(progress());
    var scale = largeScale() + (smallScale() - largeScale()) * t;
    device.style.zoom = String(scale);
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      fit();
    });
  }

  unlockScroll();
  fit();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", fit);

  if (device) {
    device.addEventListener(
      "wheel",
      function (ev) {
        if (device.classList.contains("is-max")) return;
        ev.preventDefault();
        window.scrollBy(0, ev.deltaY);
      },
      { passive: false, capture: true },
    );

    new MutationObserver(fit).observe(device, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
})();
