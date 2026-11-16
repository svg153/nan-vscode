// Self-contained iframe UI for the NaN Builders canvas (theme tokens from the host).

export function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#1f2328" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<title>NaN Builders</title>
<style>
  :root { --status-bar-color: var(--background-color-default, #ffffff); }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--background-color-default, #ffffff);
    color: var(--text-color-default, #1f2328);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; border-bottom: 1px solid var(--border-color-default, #d0d7de);
  }
  header h1 { font-size: var(--text-title-medium, 18px); font-weight: var(--font-weight-semibold, 600); margin: 0; }
  .chip {
    font-size: 12px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border-color-default, #d0d7de); color: var(--text-color-muted, #656d76);
  }
  .chip.ok { color: var(--true-color-blue, #0969da); }
  .chip.warn { color: var(--true-color-red, #cf222e); }
  main { padding: 16px; max-width: 960px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border-color-default, #d0d7de); }
  .tabs button {
    all: unset; cursor: pointer; padding: 8px 14px; font-size: 13px; color: var(--text-color-muted, #656d76);
    border-bottom: 2px solid transparent;
  }
  .tabs button.active { color: var(--text-color-default, #1f2328); border-bottom-color: var(--true-color-blue, #0969da); font-weight: var(--font-weight-semibold, 600); }
  button.action, input[type="text"], input[type="password"], input[type="url"] {
    font: inherit; padding: 6px 10px; border-radius: 6px;
    border: 1px solid var(--border-color-default, #d0d7de); background: var(--background-color-default, #fff); color: inherit;
  }
  button.action { cursor: pointer; }
  button.action:hover { border-color: var(--true-color-blue, #0969da); }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border-color-default, #d0d7de); font-size: 13px; }
  th { color: var(--text-color-muted, #656d76); font-weight: var(--font-weight-semibold, 600); }
  .bar { position: relative; height: 8px; width: 140px; border-radius: 4px; background: var(--border-color-default, #d0d7de); overflow: hidden; }
  .bar > div { position: absolute; inset: 0 auto 0 0; background: var(--true-color-blue, #0969da); }
  .bar.hot > div { background: var(--true-color-red, #cf222e); }
  .headline { display: flex; align-items: baseline; gap: 10px; margin: 8px 0 4px; }
  .headline .pct { font-size: 32px; font-weight: var(--font-weight-semibold, 600); }
  .muted { color: var(--text-color-muted, #656d76); font-size: 12px; }
  .error { color: var(--true-color-red, #cf222e); background: var(--true-color-red-muted, #ffebe9); padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
  .settings label { display: block; margin: 14px 0 4px; font-weight: var(--font-weight-semibold, 600); font-size: 13px; }
  .settings input { width: 360px; max-width: 100%; }
  .settings .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  code { font-family: var(--font-mono, Consolas, monospace); font-size: var(--text-code-inline, 12px); }
  dialog {
    background: var(--background-color-default, #fff); color: var(--text-color-default, #1f2328);
    border: 1px solid var(--border-color-default, #d0d7de); border-radius: 8px; padding: 16px; max-width: 460px;
  }
  dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
</style>
</head>
<body>
<header>
  <h1>NaN Builders</h1>
  <span id="keyChip" class="chip">loading…</span>
  <span id="updated" class="muted"></span>
  <span style="flex:1"></span>
  <button class="action" id="refreshBtn">Refresh</button>
</header>
<main>
  <div id="error" class="error" hidden></div>
  <div class="tabs" role="tablist">
    <button data-tab="usage" class="active">Usage</button>
    <button data-tab="models">Models</button>
    <button data-tab="settings">Settings</button>
  </div>
  <section id="tab-usage">
    <div id="headline"></div>
    <table>
      <thead><tr><th>Model</th><th>Used (month)</th><th>Published cap</th><th>Quota</th></tr></thead>
      <tbody id="usageRows"><tr><td colspan="4" class="muted">No usage data yet.</td></tr></tbody>
    </table>
    <p class="muted">Percentages are computed only for models with a documented fixed monthly counter; other rows show the published cap note. Source: GET /v1/usage (UTC current month).</p>
  </section>
  <section id="tab-models" hidden>
    <table>
      <thead><tr><th>Model</th><th>Context</th><th>Max output</th><th>Image in</th><th>Tool calls</th><th>Quota cap</th></tr></thead>
      <tbody id="modelRows"><tr><td colspan="6" class="muted">No model data yet.</td></tr></tbody>
    </table>
    <p class="muted">GET /v1/models for the configured key, enriched with published metadata.</p>
  </section>
  <section id="tab-settings" class="settings" hidden>
    <label for="keyInput">API key</label>
    <input id="keyInput" type="password" placeholder="configured — type to replace, or set new key" autocomplete="off" />
    <div class="row">
      <button class="action" id="saveKey">Save key</button>
      <button class="action" id="clearKey">Clear key</button>
    </div>
    <p class="muted">Stored locally at <code id="cfgPath"></code>. Override with the <code>NAN_BUILDERS_API_KEY</code> environment variable. The key never leaves your machine except as the Bearer header to the base URL below.</p>
    <label for="urlInput">API base URL</label>
    <input id="urlInput" type="url" spellcheck="false" />
    <div class="row">
      <button class="action" id="saveUrl">Save URL</button>
      <span class="muted">default: https://api.nan.builders/v1</span>
    </div>
  </section>
</main>
<dialog id="confirmDialog">
  <p id="confirmText"></p>
  <div class="row"><button class="action" id="confirmYes">Allow insecure HTTP</button><button class="action" id="confirmNo">Cancel</button></div>
</dialog>
<script>
(function () {
  var state = null;
  var tab = (location.hash.match(/tab=(\\w+)/) || [])[1] || "usage";

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }

  function showError(message) {
    var el = document.getElementById("error");
    if (message) { el.hidden = false; el.textContent = message; } else { el.hidden = true; el.textContent = ""; }
  }

  function selectTab(next) {
    tab = next;
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === tab); });
    ["usage", "models", "settings"].forEach(function (t) { document.getElementById("tab-" + t).hidden = t !== tab; });
  }
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { selectTab(b.dataset.tab); }); });

  function render() {
    if (!state) return;
    var chip = document.getElementById("keyChip");
    chip.textContent = state.hasKey ? "API key set" : "No API key";
    chip.className = "chip " + (state.hasKey ? "ok" : "warn");
    document.getElementById("updated").textContent = state.usage && state.usage.fetchedAt ? "usage " + new Date(state.usage.fetchedAt).toLocaleTimeString() : "";
    document.getElementById("cfgPath").textContent = state.configPath || "";
    if (tab === "settings") { document.getElementById("urlInput").value = state.baseUrl || ""; }
    showError(state.error);

    var headline = document.getElementById("headline");
    var rows = document.getElementById("usageRows");
    if (state.usage) {
      var items = state.usage.items || [];
      var top = items.filter(function (i) { return i.percent !== null; })[0];
      headline.innerHTML = top
        ? '<div class="headline"><span class="pct">' + top.percent + '%</span><span class="muted">most-used monthly quota · ' + esc(top.model) + '</span></div>'
        : '<div class="headline"><span class="pct">' + fmt(state.usage.totals.totalTokens) + '</span><span class="muted">tokens this month (no fixed monthly-counter quota applies)</span></div>';
      if (!items.length) { rows.innerHTML = '<tr><td colspan="4" class="muted">No token usage recorded this month.</td></tr>'; }
      else {
        rows.innerHTML = items.map(function (i) {
          var bar = i.percent === null ? '<span class="muted">—</span>'
            : '<div class="bar' + (i.percent >= 80 ? ' hot' : '') + '"><div style="width:' + Math.min(i.percent, 100) + '%"></div></div> <span>' + i.percent + '%</span>';
          return "<tr><td>" + esc(i.model) + "</td><td>" + fmt(i.usedTokens) + " tok" + (i.requests ? " · " + fmt(i.requests) + " req" : "") +
            "</td><td>" + esc(i.cap) + "</td><td>" + bar + "</td></tr>";
        }).join("");
      }
    }

    var modelRows = document.getElementById("modelRows");
    if (state.models) {
      if (!state.models.length) { modelRows.innerHTML = '<tr><td colspan="6" class="muted">No models returned for this key.</td></tr>'; }
      else {
        modelRows.innerHTML = state.models.map(function (m) {
          return "<tr><td>" + esc(m.id) + (m.chat ? "" : ' <span class="muted">(non-chat)</span>') + "</td><td>" +
            (m.contextWindow ? fmt(m.contextWindow) : "—") + "</td><td>" + (m.maxOutputTokens ? fmt(m.maxOutputTokens) : "—") +
            "</td><td>" + (m.imageInput === undefined ? "—" : m.imageInput ? "yes" : "no") +
            "</td><td>" + (m.toolCalling === undefined ? "—" : m.toolCalling ? "yes" : "XML") +
            "</td><td>" + esc(m.cap || "") + "</td></tr>";
        }).join("");
      }
    }
  }

  function apply(next) { state = next; render(); }

  function markOffline() {
    offline = true;
    document.getElementById("keyChip").textContent = "backend offline";
    showError("Canvas backend unreachable. Retrying automatically...");
  }

  async function post(path, body) {
    var res;
    try {
      res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    } catch (e) {
      markOffline();
      return null;
    }
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) { showError(json.error || ("Request failed (" + res.status + ")")); return null; }
    showError(null);
    if (json.state) apply(json.state);
    return json;
  }

  document.getElementById("refreshBtn").addEventListener("click", function () { post("/api/refresh", { force: true }); });
  document.getElementById("saveKey").addEventListener("click", function () {
    var value = document.getElementById("keyInput").value.trim();
    if (!value) { showError("Enter a key first, or use Clear key."); return; }
    post("/api/key", { key: value }).then(function () { document.getElementById("keyInput").value = ""; });
  });
  document.getElementById("clearKey").addEventListener("click", function () { post("/api/key", { key: "" }); });
  document.getElementById("saveUrl").addEventListener("click", function () {
    saveUrl(document.getElementById("urlInput").value.trim(), false);
  });
  async function saveUrl(value, confirmInsecure) {
    var res = await fetch("/api/base-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value, confirmInsecure: confirmInsecure }) });
    if (res.status === 428) {
      var json = await res.json().catch(function () { return {}; });
      document.getElementById("confirmText").textContent = json.error || "Plain HTTP to a non-loopback host sends your key unencrypted. Allow it?";
      document.getElementById("confirmDialog").showModal();
      return;
    }
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) { showError(body.error || ("Request failed (" + res.status + ")")); return; }
    showError(null);
    if (body.state) apply(body.state);
  }
  document.getElementById("confirmYes").addEventListener("click", function () {
    document.getElementById("confirmDialog").close();
    saveUrl(document.getElementById("urlInput").value.trim(), true);
  });
  document.getElementById("confirmNo").addEventListener("click", function () { document.getElementById("confirmDialog").close(); });

  var offline = false;
  async function loadState() {
    try {
      var res = await fetch("/api/state");
      if (!res.ok) throw new Error("HTTP " + res.status);
      apply(await res.json());
      if (offline) { offline = false; showError(null); }
    } catch (e) {
      markOffline();
    }
  }
  loadState();
  setInterval(function () { if (offline && document.visibilityState !== "hidden") loadState(); }, 5000);
  var source = new EventSource("/events");
  source.addEventListener("state", function (event) { apply(JSON.parse(event.data)); offline = false; });
  source.addEventListener("error", function () { /* EventSource reconnects; poll loop above recovers state if the backend flaked */ });
  selectTab(tab);
})();
</script>
</body>
</html>`;
}
