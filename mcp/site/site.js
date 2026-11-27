// Copy buttons for code blocks and the endpoint, and the live status dot in the rail.
(function () {
  var COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.innerHTML = COPY + "<span>Copy</span>";
    button.addEventListener("click", function () {
      var target = document.getElementById(button.getAttribute("data-copy"));
      if (!target || !navigator.clipboard) return;
      navigator.clipboard.writeText(target.textContent.trim()).then(function () {
        button.querySelector("span").textContent = "Copied";
        setTimeout(function () { button.querySelector("span").textContent = "Copy"; }, 1500);
      });
    });
  });
  var dot = document.getElementById("status-dot"), label = document.getElementById("status-label");
  if (dot && label && window.fetch) {
    fetch("/job-kit-ai/healthz", { cache: "no-store" }).then(function (r) {
      dot.className = "dot " + (r.ok ? "ok" : "down");
      label.textContent = r.ok ? "operational" : "degraded";
    }).catch(function () { dot.className = "dot down"; label.textContent = "unreachable"; });
  }
})();

// Theme toggle: light, dark, or follow the system. The choice is a per-browser convenience.
(function () {
  var root = document.documentElement;
  function current() { return root.getAttribute("data-theme") || "system"; }
  function render() {
    document.querySelectorAll("[data-theme-choice]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-theme-choice") === current()));
    });
  }
  document.querySelectorAll("[data-theme-choice]").forEach(function (button) {
    button.addEventListener("click", function () {
      var choice = button.getAttribute("data-theme-choice");
      if (choice === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", choice);
      try { if (choice === "system") localStorage.removeItem("rc-theme"); else localStorage.setItem("rc-theme", choice); } catch (e) {}
      render();
    });
  });
  render();
})();
