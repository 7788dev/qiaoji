(function () {
  var WIDTH = 1240;
  var HEIGHT = 820;
  var PAD = 40;
  var NAV = 52;

  var device = document.getElementById("device");
  var hero = document.querySelector(".hero");
  var ticking = false;
  var unlocking = false;

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  function apply(el, prop, value) {
    if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === "important") {
      return;
    }
    el.style.setProperty(prop, value, "important");
  }

  function unlockScroll() {
    if (unlocking) return;
    unlocking = true;
    var html = document.documentElement;
    apply(html, "overflow", "auto");
    apply(html, "overflow-x", "hidden");
    apply(html, "overflow-y", "auto");
    apply(html, "height", "auto");
    apply(html, "min-height", "100%");
    apply(document.body, "overflow", "visible");
    apply(document.body, "overflow-x", "hidden");
    apply(document.body, "overflow-y", "visible");
    apply(document.body, "height", "auto");
    apply(document.body, "overscroll-behavior", "auto");
    apply(document.body, "display", "block");
    unlocking = false;
  }

  function largeScale() {
    var availW = window.innerWidth - PAD;
    var heroH = hero ? hero.offsetHeight : 0;
    var availH = window.innerHeight - NAV - heroH - 28;
    return clamp(Math.min(availW / WIDTH, availH / HEIGHT, 1), 0.35, 1);
  }

  function smallScale() {
    var availW = window.innerWidth - PAD;
    var availH = window.innerHeight * 0.34;
    return clamp(Math.min(availW / WIDTH, availH / HEIGHT), 0.22, 0.42);
  }

  function progress() {
    var hold = hero ? Math.max(hero.offsetHeight * 0.15, 12) : 12;
    var range = Math.max(window.innerHeight * 0.42, 260);
    return clamp((window.scrollY - hold) / range, 0, 1);
  }

  function fit() {
    unlockScroll();
    if (!device) return;
    if (device.classList.contains("is-max") || device.classList.contains("is-min")) {
      device.style.zoom = "";
      return;
    }
    var t = ease(progress());
    device.style.zoom = String(largeScale() + (smallScale() - largeScale()) * t);
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

  unlockScroll();
  fit();

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", fit);
  window.addEventListener("load", function () {
    unlockScroll();
    fit();
  });

  window.addEventListener(
    "wheel",
    function (ev) {
      if (ev.ctrlKey) return;
      if (!device || device.classList.contains("is-max")) return;
      if (!device.contains(ev.target)) return;
      ev.preventDefault();
      unlockScroll();
      window.scrollBy(0, wheelDelta(ev));
      fit();
    },
    { passive: false, capture: true },
  );

  if (device) {
    new MutationObserver(fit).observe(device, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  var unlockWatch = new MutationObserver(unlockScroll);
  unlockWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  unlockWatch.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });

  var n = 0;
  var boot = setInterval(function () {
    unlockScroll();
    fit();
    if (++n > 25) clearInterval(boot);
  }, 80);
})();
