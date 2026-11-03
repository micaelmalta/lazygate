// src/gateway/ui-assets.ts
// The gateway web UI: one HTML page, one script, one stylesheet. No build step, no dependencies.
// The script builds DOM with textContent only (never innerHTML) and the CSP forbids inline script.

export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lazygate</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<header class="chrome">
  <a class="brand" href="/ui">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-text">lazygate</span>
  </a>
  <nav id="tabs" class="tabs" hidden></nav>
  <div id="who" class="who"></div>
</header>
<main id="app"></main>
<script src="/ui/app.js"></script>
</body>
</html>
`;

export const UI_CSS = String.raw`
:root {
  --ink: #16181d;
  --ink-2: #3a3f48;
  --muted: #6b717c;
  --line: #e1ddd3;
  --line-2: #cfc9bc;
  --panel: #fffefb;
  --bg: #f6f4ee;
  --bg-deep: #ece9e0;
  --accent: #0f766e;
  --accent-ink: #0b5c56;
  --accent-soft: #d9f2ee;
  --warn: #b45309;
  --warn-soft: #fdecd3;
  --bad: #b42318;
  --bad-soft: #fde4e1;
  --good: #197a3c;
  --good-soft: #dcf3e3;
  --skill: #1d5fa8;
  --skill-soft: #e1ecfa;
  --mcp: #0f766e;
  --mcp-soft: #d9f2ee;
  --shadow: 0 1px 0 rgba(22,24,29,.03), 0 10px 28px -18px rgba(22,24,29,.22);
  --radius: 12px;
  --font: ui-sans-serif, "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  --display: ui-serif, "New York", "Iowan Old Style", Georgia, serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #eceae4;
    --ink-2: #c9c6bd;
    --muted: #9a9a94;
    --line: #2b2e33;
    --line-2: #3a3e45;
    --panel: #1a1c20;
    --bg: #131417;
    --bg-deep: #0f1012;
    --accent: #2dd4bf;
    --accent-ink: #5eead4;
    --accent-soft: #11332f;
    --warn: #f0a24b;
    --warn-soft: #3a2a12;
    --bad: #f47067;
    --bad-soft: #3b1a18;
    --good: #5fd48a;
    --good-soft: #14301f;
    --skill: #7ab4f5;
    --skill-soft: #162a42;
    --mcp: #2dd4bf;
    --mcp-soft: #11332f;
    --shadow: 0 1px 0 rgba(0,0,0,.4), 0 14px 32px -18px rgba(0,0,0,.7);
  }
  html { color-scheme: dark; }
}
* { box-sizing: border-box; }
html { color-scheme: light; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(1000px 380px at 50% -140px, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%),
    var(--bg);
  color: var(--ink);
  font: 14.5px/1.55 var(--font);
  -webkit-font-smoothing: antialiased;
}
.grain { display: none; }
main { position: relative; z-index: 1; }
::selection { background: var(--accent-soft); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ── chrome ───────────────────────────────────────────────── */
.chrome {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 8px 22px;
  padding: 0 28px;
  min-height: 56px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 86%, transparent);
  backdrop-filter: saturate(1.4) blur(14px);
  overflow: visible;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  text-decoration: none;
  color: var(--ink);
}
.brand-mark {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--ink);
  position: relative;
}
.brand-mark::after {
  content: "";
  position: absolute;
  inset: 5px 5px 5px 9px;
  border-radius: 2px;
  background: var(--accent);
}
.brand-text {
  font: 600 1.15rem/1 var(--display);
  letter-spacing: -0.02em;
}
.who {
  display: flex;
  align-items: center;
  gap: 4px 12px;
  flex: 0 0 auto;
  margin-left: auto;
  overflow: visible;
}
.who .account {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding-left: 14px;
  border-left: 1px solid var(--line);
  margin-left: 4px;
}
.who .user { color: var(--muted); font: 500 12.5px/1 var(--mono); }
.who .signout {
  background: none;
  border: 0;
  padding: 0;
  color: var(--muted);
  font: 500 12.5px/1 var(--font);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: transparent;
  transition: color .15s ease, text-decoration-color .15s ease;
}
.who .signout:hover { color: var(--ink); text-decoration-color: var(--line-2); }

.tabs {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tabs button.tab {
  position: relative;
  background: none;
  border: 0;
  padding: 0 12px;
  color: var(--muted);
  cursor: pointer;
  font: 500 13.5px/1 var(--font);
  white-space: nowrap;
  transition: color .15s ease;
}
.tabs button.tab::after {
  content: "";
  position: absolute;
  left: 12px; right: 12px; bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: transparent;
  transition: background .15s ease;
}
.tabs button.tab:hover { color: var(--ink); }
.tabs button.tab.on { color: var(--ink); }
.tabs button.tab.on::after { background: var(--accent); }

.admin-menu { position: relative; flex: 0 0 auto; display: flex; align-items: stretch; align-self: stretch; }
.admin-menu > button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 0;
  padding: 0 12px;
  color: var(--muted);
  cursor: pointer;
  font: 500 13.5px/1 var(--font);
  white-space: nowrap;
  transition: color .15s ease;
}
.admin-menu > button:hover, .admin-menu.open > button { color: var(--ink); }
.admin-menu > button.on { color: var(--ink); }
.admin-menu > button.on::after {
  content: "";
  position: absolute;
  left: 12px; right: 12px; bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
}
.admin-menu > button .chev {
  width: 0; height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
  opacity: .55;
  transition: transform .18s ease;
}
.admin-menu.open > button .chev { transform: rotate(180deg); }
.admin-menu .panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 210px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  box-shadow: var(--shadow), 0 20px 40px -24px rgba(0,0,0,.4);
  z-index: 50;
  animation: menu-in .14s ease both;
}
.admin-menu .panel[hidden] { display: none !important; }
.admin-menu .panel button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ink);
  cursor: pointer;
  font: 500 13.5px/1.2 var(--font);
  transition: background .12s ease;
}
.admin-menu .panel button:hover { background: var(--bg); }
.admin-menu .panel button.on { color: var(--accent-ink); background: var(--accent-soft); }
.admin-menu .panel .group {
  margin: 6px 10px 6px;
  color: var(--muted);
  font: 600 10px/1 var(--mono);
  letter-spacing: .1em;
  text-transform: uppercase;
}
.admin-menu .panel .rule { height: 1px; margin: 4px 6px; background: var(--line); border: 0; }

@keyframes menu-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── layout ───────────────────────────────────────────────── */
main { max-width: 1040px; margin: 0 auto; padding: 40px 28px 88px; }

.hero { display: grid; gap: 6px; margin-bottom: 28px; max-width: 720px; animation: rise .35s ease both; }
.hero h1 {
  margin: 0;
  font: 600 2rem/1.1 var(--display);
  letter-spacing: -0.03em;
}
.hero p { margin: 0; color: var(--muted); font-size: 0.95rem; }

.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; animation: rise .35s ease .04s both; }
.toolbar .search {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.toolbar .search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.toolbar .search input { border: 0; outline: none; background: transparent; width: 100%; font: inherit; color: inherit; padding: 0; }
.toolbar .search .ico { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.chips {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  background: var(--bg-deep);
  border-radius: 8px;
  border: 1px solid var(--line);
  margin-bottom: 20px;
}
.chips button {
  font: 500 12.5px/1 var(--font);
  padding: 7px 12px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: color .12s ease, background .12s ease;
}
.chips button:hover { color: var(--ink); }
.chips button.on { background: var(--panel); color: var(--ink); box-shadow: 0 1px 2px rgba(22,24,29,.12); }
.editor textarea.body { min-height: 200px; }

/* catalog list */
.catalog {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: hidden;
  box-shadow: var(--shadow);
  animation: rise .4s ease .06s both;
}
.item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px 24px;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
  transition: background .12s ease;
}
.item:last-child { border-bottom: 0; }
.item:hover { background: color-mix(in srgb, var(--bg) 60%, var(--panel)); }
.item-main { min-width: 0; }
.item-main h2 {
  margin: 0;
  font: 600 0.92rem/1.3 var(--mono);
  letter-spacing: -0.01em;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.item-main .hint { font: 500 11.5px/1 var(--font); color: var(--muted); letter-spacing: 0; }
.item-main .hint.warn { color: var(--warn); }
.item-main .hint.good { color: var(--good); }
.item-main .hint.bad { color: var(--bad); }
.item-main .desc {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.item-actions .link {
  font: 500 12.5px/1 var(--font);
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  padding: 6px 4px;
}
.item-actions .link:hover { color: var(--ink); }
.item-actions .link.danger:hover { color: var(--bad); }

/* detail sheet */
.sheet {
  max-width: 760px;
  margin: 0 auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 24px 28px 28px;
  animation: rise .3s ease both;
  box-shadow: var(--shadow);
}
.sheet-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.sheet-top h1 { margin: 0; font: 600 1.35rem/1.2 var(--mono); letter-spacing: -0.02em; }
.back {
  font: 500 13px/1 var(--font);
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  margin: 0 0 16px;
  display: block;
}
.back::before { content: "\2190  "; }
.back:hover { color: var(--ink); }
.sheet-sec { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--line); }
.sheet-top + .sheet-sec { margin-top: 16px; padding-top: 0; border-top: 0; }
.sheet-sec h3 {
  margin: 0 0 6px;
  font: 600 10.5px/1.2 var(--mono);
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--muted);
}
.sheet-sec .sec-lede { margin: 0 0 12px; color: var(--muted); font-size: 13px; }

.secret-list { display: flex; flex-direction: column; gap: 8px; margin: 0 0 12px; }
.secret-row {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.secret-row .secret-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.secret-row .secret-path { font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.secret-row input { width: 100%; margin: 0; }

.sheet-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.sheet-actions .spacer { flex: 1 1 auto; }

/* cards + tables */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 22px 24px;
  margin-bottom: 18px;
  box-shadow: var(--shadow);
  animation: rise .35s ease both;
}
.card h2 { font: 600 1.2rem/1.2 var(--display); margin: 0 0 14px; letter-spacing: -0.02em; }

.table-wrap { overflow-x: auto; margin: 0 -8px; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 10px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: color-mix(in srgb, var(--bg) 60%, var(--panel)); }
td { white-space: nowrap; }
td .wrap { display: inline-block; white-space: normal; overflow-wrap: anywhere; min-width: 200px; max-width: 380px; }
td:last-child, th:last-child { font-variant-numeric: tabular-nums; }
th {
  color: var(--muted);
  font: 600 10.5px/1 var(--mono);
  letter-spacing: .08em;
  text-transform: uppercase;
  padding-top: 4px;
  border-bottom: 1px solid var(--line-2);
}
code, .mono { font-family: var(--mono); font-size: 12.5px; }
td code { color: var(--ink-2); }

/* forms */
input, select, textarea {
  font: inherit;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 8px 10px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
input[type=text], input[type=password], textarea { width: 100%; }
input[type=checkbox] { accent-color: var(--accent); }
textarea { min-height: 76px; font-family: var(--mono); font-size: 12.5px; }
button.btn {
  font: 500 13.5px/1 var(--font);
  padding: 9px 14px;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease, transform .1s ease;
}
button.btn:hover { border-color: var(--muted); }
button.btn:active { transform: translateY(1px); }
button.primary { background: var(--ink); border-color: var(--ink); color: var(--bg); }
button.primary:hover { background: var(--ink-2); border-color: var(--ink-2); }
button.accent { background: var(--accent); border-color: var(--accent); color: #fff; }
button.accent:hover { background: var(--accent-ink); border-color: var(--accent-ink); }
@media (prefers-color-scheme: dark) { button.accent { color: #06201d; } button.accent:hover { color: #06201d; } }
button.danger { color: var(--bad); }
button.danger:hover { border-color: var(--bad); }
button.btn:disabled { opacity: .45; cursor: not-allowed; }

.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row > * { flex: 0 0 auto; }
.row > .grow { flex: 1 1 200px; }
.muted { color: var(--muted); }
.bad { color: var(--bad); }
.good { color: var(--good); }
.warn { color: var(--warn); }

.pill {
  display: inline-flex;
  align-items: center;
  font: 500 11.5px/1 var(--mono);
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  color: var(--ink-2);
  background: var(--bg);
}
.pill.on { color: var(--good); border-color: transparent; background: var(--good-soft); }
.pill.off { color: var(--warn); border-color: transparent; background: var(--warn-soft); }
.pill.miss { color: var(--bad); border-color: transparent; background: var(--bad-soft); }

.notice {
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  border-left-width: 3px;
  margin-bottom: 14px;
  background: var(--panel);
}
.notice.error { border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); border-left-color: var(--bad); color: var(--bad); background: var(--bad-soft); }
.notice.ok { border-color: color-mix(in srgb, var(--good) 35%, var(--line)); border-left-color: var(--good); color: var(--good); background: var(--good-soft); }

.token {
  word-break: break-all;
  user-select: all;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px dashed var(--line-2);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12.5px;
}

.login {
  max-width: 440px;
  margin: 80px auto;
  padding: 32px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow);
  animation: rise .45s ease both;
}
.login h1 { margin: 0 0 6px; font: 600 2rem/1.1 var(--display); letter-spacing: -0.03em; }
.login .lede { margin: 0 0 20px; color: var(--muted); }
.ml { margin-left: 4px; }
.fieldname { min-width: 90px; font-family: var(--mono); font-size: 12.5px; }
label.inline { margin: 0; display: inline-flex; align-items: center; gap: 6px; }
label.inline.top { margin-top: 20px; }
label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; font-weight: 500; }

.empty {
  padding: 56px 24px;
  text-align: center;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted);
  animation: rise .35s ease both;
}
.empty strong { display: block; color: var(--ink); margin-bottom: 4px; font: 600 1.15rem/1.3 var(--display); }

@keyframes rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}

@media (max-width: 720px) {
  .chrome { flex-wrap: wrap; padding: 8px 14px 0; gap: 4px 12px; }
  .tabs { order: 2; flex: 1 1 100%; min-height: 40px; }
  main { padding: 24px 16px 56px; }
  .sheet { padding: 18px; }
  .item { grid-template-columns: 1fr; }
}
`;

export const UI_JS = String.raw`(function () {
  "use strict";
  var KEY = "lazygate.token";
  var KEY_AT = "lazygate.tokenAt";
  /** Clear the pasted token from sessionStorage after this long (tab close already clears it). */
  var TOKEN_TTL_MS = 30 * 60 * 1000;
  function loadStoredToken() {
    var t = sessionStorage.getItem(KEY) || "";
    var at = Number(sessionStorage.getItem(KEY_AT) || 0);
    if (!t) return "";
    if (!at || Date.now() - at > TOKEN_TTL_MS) {
      sessionStorage.removeItem(KEY);
      sessionStorage.removeItem(KEY_AT);
      return "";
    }
    return t;
  }
  var token = loadStoredToken();
  var me = null;
  var tab = null;
  var focusServer = null;
  var app = document.getElementById("app");
  var tabsEl = document.getElementById("tabs");
  var whoEl = document.getElementById("who");

  // ── helpers ──────────────────────────────────────────────────────────────
  function h(tag, props) {
    var el = document.createElement(tag);
    for (var k in props || {}) {
      var v = props[k];
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function api(method, path, body) {
    // Only expire a persisted session. On first sign-in the token is in memory
    // before sessionStorage is written — do not treat that as a timeout.
    if (sessionStorage.getItem(KEY) && !loadStoredToken()) {
      signOut();
      return Promise.reject(new Error("Signed out — session timed out after 30 minutes"));
    }
    var opts = { method: method, headers: { Authorization: "Bearer " + token } };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch("/ui/api/" + path, opts).then(function (r) {
      if (r.status === 204) return null;
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { signOut(); throw new Error("Signed out — the token is invalid or expired"); }
        if (!r.ok) throw new Error(data.error || ("Request failed (" + r.status + ")"));
        return data;
      });
    });
  }
  function notice(kind, text) { return h("div", { class: "notice " + kind }, text); }
  function ago(ts) {
    var s = Math.round((Date.now() - (typeof ts === "number" ? ts : Date.parse(ts))) / 1000);
    if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function guard(box, fn) { return function (e) { if (e && e.preventDefault) e.preventDefault(); fn(e).catch(function (err) { show(box, notice("error", err.message)); }); }; }
  function show(box, node) { clear(box); box.appendChild(node); }
  function table(head, rows, empty) {
    if (!rows.length) return h("p", { class: "muted" }, empty);
    return h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, head.map(function (t) { return h("th", null, t); }))),
      h("tbody", null, rows.map(function (r) { return h("tr", null, r.map(function (c) { return h("td", null, c); })); }))));
  }
  function pills(list) { return (list || []).map(function (g) { return h("span", { class: "pill" }, g); }); }
  function matchesQuery(q, parts) {
    if (!q) return true;
    var hay = parts.filter(Boolean).join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) !== -1; });
  }
  function go(next, server) {
    tab = next;
    focusServer = server || null;
    if (next !== "manage-mcps") focusConfig = null;
    if (next !== "manage-skills") focusSkill = null;
    render();
  }

  function mapToText(m) { return Object.keys(m || {}).map(function (k) { return k + "=" + m[k]; }).join("\n"); }
  function textToMap(t) {
    var out = {};
    t.split("\n").forEach(function (line) { var i = line.indexOf("="); if (line.trim() && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
    return out;
  }

  // ── sign in / out ────────────────────────────────────────────────────────
  function signOut() { token = ""; me = null; sessionStorage.removeItem(KEY); sessionStorage.removeItem(KEY_AT); render(); }

  function loginView() {
    var box = h("div"), input = h("input", { type: "password", placeholder: "lzg_…", autocomplete: "new-password" });
    var form = h("form", { onsubmit: guard(box, function () {
      // Accept raw lzg_… or "Bearer lzg_…" (common paste from docs / curl).
      token = input.value.trim().replace(/^Bearer\s+/i, "");
      return api("GET", "me").then(function (m) {
        me = m;
        sessionStorage.setItem(KEY, token);
        sessionStorage.setItem(KEY_AT, String(Date.now()));
        render();
      }).catch(function (e) { token = ""; throw e; });
    }) }, h("label", null, "Access token"), input,
      h("p", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Sign in")),
      h("p", { class: "muted" }, "Create one with: lazygate token create --user <you> [--admin]"),
      h("p", { class: "muted" }, "The token stays in this tab only and is cleared after 30 minutes or when you close the tab."), box);
    return h("div", { class: "login" },
      h("h1", null, "Sign in"),
      h("p", { class: "lede" }, "Browse MCP servers and skills on this gateway, then connect credentials when a tool needs them."),
      form);
  }

  var focusConfig = null; // server name open in configure sheet (manage-mcps)
  var focusSkill = null;  // skill name open in configure sheet (manage-skills)

  // ── tabs ─────────────────────────────────────────────────────────────────
  // [id, label, viewFn]
  var USER_TABS = [
    ["mcps", "Servers", function (r) { return mcpsView(r, false); }],
    ["skills", "Skills", function (r) { return skillsView(r, false); }],
    ["connections", "Credentials", connectionsView],
    ["activity", "Activity", activityView]
  ];
  var ADMIN_TABS = [
    ["manage-mcps", "Manage servers", function (r) { return mcpsView(r, true); }],
    ["manage-skills", "Manage skills", function (r) { return skillsView(r, true); }],
    ["sessions", "Sessions", sessionsView],
    ["tokens", "Tokens", tokensView],
    ["secrets", "All secrets", secretsView]
  ];

  function allTabs() {
    return me && me.admin ? USER_TABS.concat(ADMIN_TABS) : USER_TABS;
  }

  function adminTabOn() {
    return ADMIN_TABS.some(function (t) { return t[0] === tab; });
  }

  function adminMenuLabel() {
    var cur = ADMIN_TABS.filter(function (t) { return t[0] === tab; })[0];
    return cur ? cur[1] : "Admin";
  }

  var closeAdminMenu = null;
  function bindAdminMenu(wrap, panel, trigger) {
    if (closeAdminMenu) { document.removeEventListener("click", closeAdminMenu); closeAdminMenu = null; }
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = wrap.classList.toggle("open");
      panel.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    closeAdminMenu = function () {
      wrap.classList.remove("open");
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    };
    document.addEventListener("click", closeAdminMenu);
  }

  function render() {
    clear(app); clear(tabsEl); clear(whoEl);
    if (!token || !me) {
      tabsEl.hidden = true;
      if (token && !me) { api("GET", "me").then(function (m) { me = m; render(); }).catch(function () { signOut(); }); return; }
      app.appendChild(loginView());
      return;
    }
    var visible = allTabs();
    if (!tab || !visible.some(function (t) { return t[0] === tab; })) tab = visible[0][0];
    tabsEl.hidden = false;
    USER_TABS.forEach(function (t) {
      tabsEl.appendChild(h("button", { class: "tab" + (t[0] === tab ? " on" : ""), type: "button", onclick: function () { go(t[0]); } }, t[1]));
    });
    // Admin menu lives in .who (not .tabs) so overflow-x on tabs cannot clip the panel.
    if (me.admin) {
      var onAdmin = adminTabOn();
      var panel = h("div", { class: "panel", role: "menu", hidden: true });
      function addAdminItems(from, to) {
        for (var i = from; i < to; i++) {
          (function (t) {
            panel.appendChild(h("button", {
              type: "button", role: "menuitem", class: t[0] === tab ? "on" : "",
              onclick: function (e) { if (e) e.stopPropagation(); go(t[0]); }
            }, t[1]));
          })(ADMIN_TABS[i]);
        }
      }
      panel.appendChild(h("div", { class: "group" }, "Catalog"));
      addAdminItems(0, 2);
      panel.appendChild(h("hr", { class: "rule" }));
      panel.appendChild(h("div", { class: "group" }, "Gateway"));
      addAdminItems(2, ADMIN_TABS.length);
      panel.addEventListener("click", function (e) { e.stopPropagation(); });
      var trigger = h("button", {
        type: "button",
        class: onAdmin ? "on" : "",
        "aria-haspopup": "menu",
        "aria-expanded": "false"
      }, adminMenuLabel(), h("span", { class: "chev", "aria-hidden": "true" }));
      var wrap = h("div", { class: "admin-menu" }, trigger, panel);
      bindAdminMenu(wrap, panel, trigger);
      whoEl.appendChild(wrap);
    }
    whoEl.appendChild(h("div", { class: "account" },
      h("span", { class: "user" }, me.user),
      h("button", { class: "signout", type: "button", onclick: signOut }, "Sign out")));
    var view = visible.filter(function (t) { return t[0] === tab; })[0][2];
    var holder = h("div", null, h("p", { class: "muted" }, "Loading…"));
    app.appendChild(holder);
    view(holder);
  }

  function marketHero(title, lede) {
    return h("div", { class: "hero" }, h("h1", null, title), lede ? h("p", null, lede) : null);
  }

  function filterChips(host, value, onChange, adminCatalog) {
    clear(host);
    var keys = ["all", "installed", "available"];
    if (adminCatalog) keys.push("disabled");
    keys.forEach(function (k) {
      var label = k === "all" ? "All" : k === "installed" ? "Installed" : k === "available" ? "Available" : "Disabled";
      host.appendChild(h("button", {
        type: "button", class: value === k ? "on" : "",
        onclick: function () { onChange(k); filterChips(host, k, onChange, adminCatalog); }
      }, label));
    });
  }

  function catalogEmpty(parent, title, detail) {
    parent.appendChild(h("div", { class: "empty" }, h("strong", null, title), detail));
  }

  // ── Servers: user catalog (adminCatalog=false) | manage (true) ────────────
  function mcpsView(root, adminCatalog) {
    if (adminCatalog && focusConfig) return serverSheet(root, focusConfig);
    api("GET", "catalog/servers").then(function (d) {
      clear(root);
      var items = (d.servers || []).filter(function (s) { return adminCatalog || !s.disabled; });
      var q = "";
      var filter = "all";
      var flash = h("div");
      var installedN = items.filter(function (s) { return s.installed && !s.disabled; }).length;
      root.appendChild(marketHero(
        adminCatalog ? "Manage servers" : "Servers",
        adminCatalog
          ? "Enable, disable, configure, or delete catalog entries."
          : installedN + " installed of " + items.length
      ));
      root.appendChild(flash);
      var search = h("input", { type: "text", placeholder: "Search…", "aria-label": "Search servers" });
      root.appendChild(h("div", { class: "toolbar" },
        h("div", { class: "search" }, h("span", { class: "ico" }, "/"), search),
        adminCatalog ? h("button", { class: "btn primary", type: "button", onclick: function () { focusConfig = "__new__"; mcpsView(root, true); } }, "Add") : null));
      var chips = h("div", { class: "chips" });
      root.appendChild(chips);
      var list = h("div", { class: "catalog" });
      root.appendChild(list);

      function reload() { focusConfig = null; mcpsView(root, adminCatalog); }
      function paint() {
        clear(list);
        var shown = items.filter(function (s) {
          if (filter === "installed" && (!s.installed || s.disabled)) return false;
          if (filter === "available" && (s.installed || s.disabled)) return false;
          if (filter === "disabled" && !s.disabled) return false;
          return matchesQuery(q, [s.name, s.description].concat(s.keywords || []).concat([s.transport, s.target]));
        });
        if (!shown.length) {
          catalogEmpty(list, items.length ? "No matches" : "No servers yet",
            items.length ? "Try another filter or search." : (adminCatalog ? "Use Add to create one." : "Ask an admin to add one."));
          return;
        }
        shown.forEach(function (s) {
          var hints = [];
          if (s.disabled) hints.push(h("span", { class: "hint bad" }, "disabled"));
          else if (s.installed && s.needsCredentials && !s.connected) hints.push(h("span", { class: "hint warn" }, "needs connect"));
          else if (s.installed) hints.push(h("span", { class: "hint good" }, "installed"));
          else hints.push(h("span", { class: "hint" }, s.transport));
          if (s.local) hints.push(h("span", { class: "hint bad" }, "local-only"));
          if (adminCatalog && !s.disabled && s.missingSecrets > 0) hints.push(h("span", { class: "hint bad" }, "missing " + s.missingSecrets + " secret" + (s.missingSecrets === 1 ? "" : "s")));
          if (adminCatalog && s.sharedScopeMultiGroup) hints.push(h("span", { class: "hint warn" }, "shared creds, multi-group"));

          var actions = h("div", { class: "item-actions" });
          if (!adminCatalog) {
            if (s.installed && s.needsCredentials && !s.connected) {
              actions.appendChild(h("button", { class: "btn accent", type: "button", onclick: function () { go("connections", s.name); } }, "Connect"));
            }
            actions.appendChild(h("button", {
              class: s.installed ? "btn" : "btn accent", type: "button",
              onclick: guard(flash, function () {
                var path = "profile/servers/" + encodeURIComponent(s.name);
                return (s.installed ? api("DELETE", path) : api("POST", path, {})).then(reload);
              })
            }, s.installed ? "Remove" : "Install"));
          } else {
            actions.appendChild(h("button", { class: "link", type: "button", onclick: guard(flash, function () {
              return api("PATCH", "servers/" + encodeURIComponent(s.name), { disabled: !s.disabled }).then(reload);
            }) }, s.disabled ? "Enable" : "Disable"));
            actions.appendChild(h("button", { class: "link", type: "button", onclick: function () { focusConfig = s.name; mcpsView(root, true); } }, "Configure"));
            actions.appendChild(h("button", { class: "link danger", type: "button", onclick: guard(flash, function () {
              if (!confirm("Delete \"" + s.name + "\" from the catalog?")) return Promise.resolve();
              return api("DELETE", "servers/" + encodeURIComponent(s.name)).then(reload);
            }) }, "Delete"));
          }
          list.appendChild(h("article", { class: "item", title: s.target || "" },
            h("div", { class: "item-main" }, h("h2", null, s.name, hints), h("p", { class: "desc" }, s.description || "")),
            actions));
        });
      }
      search.addEventListener("input", function () { q = search.value.trim(); paint(); });
      filterChips(chips, filter, function (f) { filter = f; paint(); }, adminCatalog);
      paint();
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  function serverSheet(root, name) {
    var isNew = name === "__new__";
    var load = api("GET", "servers").then(function (d) {
      var existing = isNew ? null : (d.servers || []).filter(function (s) { return s.name === name; })[0] || null;
      return { existing: existing, commandAllowlist: d.commandAllowlist || null };
    });
    load.then(function (info) {
      var existing = info.existing;
      var allow = info.commandAllowlist;
      var canSetCommand = Array.isArray(allow) && allow.length > 0;
      if (!isNew && !existing) { focusConfig = null; return mcpsView(root, true); }
      clear(root);
      root.appendChild(h("button", { class: "back", type: "button", onclick: function () { focusConfig = null; mcpsView(root, true); } }, "← Manage servers"));

      var box = h("div");
      var nameIn = h("input", { type: "text", placeholder: "github" });
      if (existing) nameIn.value = existing.name;
      var description = h("input", { type: "text", placeholder: "What this server does" });
      if (existing) description.value = existing.description || "";
      var keywords = h("input", { type: "text", placeholder: "github, issues" });
      if (existing) keywords.value = (existing.keywords || []).join(", ");
      var transport = h("select", null, h("option", { value: "stdio" }, "stdio"), h("option", { value: "http" }, "http"));
      transport.value = existing && existing.transport === "http" ? "http" : (isNew && !canSetCommand ? "http" : "stdio");
      var command = h("input", { type: "text", placeholder: canSetCommand ? allow[0] : "set via servers.json", disabled: !canSetCommand && isNew });
      var args = h("input", { type: "text", placeholder: "-y @modelcontextprotocol/server-github", disabled: !canSetCommand && isNew });
      var url = h("input", { type: "text", placeholder: "https://mcp.example.com/mcp" });
      if (existing) {
        if (existing.transport === "http") url.value = existing.target || "";
        else {
          var parts = (existing.target || "").split(" ");
          command.value = parts[0] || "";
          args.value = parts.slice(1).join(" ");
          command.disabled = !canSetCommand;
          args.disabled = !canSetCommand;
        }
      }
      var a = existing && existing.auth;
      var scope = h("select", null, h("option", { value: "none" }, "none"), h("option", { value: "server" }, "server (shared secrets)"), h("option", { value: "user" }, "user (each person)"));
      scope.value = a ? a.scope : "none";
      var fallback = h("input", { type: "checkbox" }); fallback.checked = Boolean(a && a.fallback);
      var env = h("textarea", { placeholder: "GOOGLE_CLIENT_ID=\u0024{secret:google/client_id}" }, mapToText(a && a.env));
      var hdr = h("textarea", { placeholder: "Authorization=Bearer \u0024{cred:token}" }, mapToText(a && a.headers));
      var groups = h("input", { type: "text", placeholder: "everyone" });
      if (existing) groups.value = (existing.groups || []).join(", ");
      var auto = h("input", { type: "checkbox" }); auto.checked = Boolean(existing && existing.autoActivate);
      var cm = existing ? existing.toolChain : "off";
      var toolChainSel = h("select", null, h("option", { value: "off" }, "off (call_tool only)"), h("option", { value: "all" }, "all tools"), h("option", { value: "list" }, "allowlist"));
      toolChainSel.value = Array.isArray(cm) ? "list" : (cm === "all" ? "all" : "off");
      var toolChainList = h("input", { type: "text", placeholder: "search, get_issue" });
      if (Array.isArray(cm)) toolChainList.value = cm.join(", ");
      var disabledIn = h("input", { type: "checkbox" }); disabledIn.checked = Boolean(existing && existing.disabled);

      var sheet = h("div", { class: "sheet" },
        h("div", { class: "sheet-top" },
          h("h1", null, isNew ? "New server" : existing.name),
          !isNew && existing.disabled ? h("span", { class: "pill miss" }, "disabled") : null),
        existing && existing.sharedScopeMultiGroup
          ? h("p", { class: "warn" }, "Shared credentials (auth.scope=server) are visible to more than one group — every caller acts as the same identity. Prefer scope \"user\", or restrict Groups to one group.")
          : null,
        h("div", { class: "sheet-sec" },
          h("h3", null, "Basics"),
          h("label", null, "Name"), nameIn,
          !isNew ? h("p", { class: "muted" }, "Renaming updates installs, vault keys, OAuth tokens, and server/* secrets.") : null,
          h("label", null, "Description"), description,
          h("label", null, "Keywords"), keywords,
          h("label", null, "Transport"), transport,
          h("div", { class: "stdio-fields" },
            h("label", null, "Command"), command, h("label", null, "Args"), args,
            !canSetCommand ? h("p", { class: "muted" }, "Stdio command/args are CLI-only unless LAZYGATE_ALLOWED_COMMANDS is set on the gateway.") : h("p", { class: "muted" }, "Allowed: " + allow.join(", "))),
          h("div", { class: "http-fields" }, h("label", null, "URL"), url),
          !isNew ? h("label", { class: "inline" }, disabledIn, " Disabled (hidden from users; activate refused)") : null),
        h("div", { class: "sheet-sec" },
          h("h3", null, "Access"),
          h("p", { class: "sec-lede" }, "Who can install this server, and how credentials are resolved. HTTP defaults to per-user scope."),
          h("div", { class: "row" },
            h("div", null, h("label", null, "Credential scope"), scope),
            h("label", { class: "inline top" }, fallback, " fall back to shared secret"),
            h("label", { class: "inline top" }, auto, " auto-activate")),
          h("label", null, "Groups (comma separated, blank = everyone)"), groups,
          h("label", null, "Tool chain (run_chain scripts may call these tools)"), toolChainSel,
          h("label", null, "Allowlisted tools (comma separated, for allowlist only)"), toolChainList,
          h("label", null, "Env templates"), env,
          h("label", null, "Header templates"), hdr));

      var secretsHost = h("div", { class: "sheet-sec" });
      sheet.appendChild(secretsHost);

      var actions = h("div", { class: "sheet-actions" },
        h("button", { class: "btn primary", type: "button", onclick: guard(box, function () {
          var kw = keywords.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
          var payload = {
            description: description.value,
            keywords: kw,
            groups: groups.value.split(","),
            autoActivate: auto.checked,
            toolChain: toolChainSel.value === "list"
              ? toolChainList.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean)
              : toolChainSel.value,
            auth: scope.value === "none" ? null : { scope: scope.value, fallback: fallback.checked, env: textToMap(env.value), headers: textToMap(hdr.value) }
          };
          if (!isNew) payload.disabled = disabledIn.checked;
          if (transport.value === "http") payload.url = url.value.trim();
          else if (canSetCommand) {
            payload.command = command.value.trim();
            payload.args = args.value.trim() ? args.value.trim().split(/\s+/) : [];
          } else if (isNew) {
            return Promise.reject(new Error("Stdio servers need LAZYGATE_ALLOWED_COMMANDS, or pick HTTP transport"));
          }
          if (isNew) {
            payload.name = nameIn.value.trim();
            return api("POST", "servers", payload).then(function (created) { focusConfig = created.name; mcpsView(root, true); });
          }
          payload.name = nameIn.value.trim();
          var prevName = existing.name;
          return api("PATCH", "servers/" + encodeURIComponent(prevName), payload).then(function (saved) {
            if (saved && saved.name && saved.name !== prevName) focusConfig = saved.name;
            show(box, notice("ok", saved && saved.name !== prevName ? "Renamed to \"" + saved.name + "\"." : "Server saved."));
            return api("GET", "servers").then(function (d) {
              var want = (saved && saved.name) || prevName;
              var fresh = (d.servers || []).filter(function (s) { return s.name === want; })[0];
              if (saved && saved.name && saved.name !== prevName) {
                focusConfig = saved.name;
                return serverSheet(root, saved.name);
              }
              renderSecrets(fresh);
            });
          });
        }) }, isNew ? "Create server" : "Save server"),
        h("span", { class: "spacer" }),
        !isNew ? h("button", { class: "btn danger", type: "button", onclick: guard(box, function () {
          if (!confirm("Delete \"" + existing.name + "\" from the catalog?")) return Promise.resolve();
          return api("DELETE", "servers/" + encodeURIComponent(existing.name)).then(function () { focusConfig = null; mcpsView(root, true); });
        }) }, "Delete server") : null);
      sheet.appendChild(actions);
      sheet.appendChild(box);
      root.appendChild(sheet);

      function syncTransport() {
        sheet.querySelector(".stdio-fields").hidden = transport.value !== "stdio";
        sheet.querySelector(".http-fields").hidden = transport.value !== "http";
      }
      transport.addEventListener("change", syncTransport);
      syncTransport();

      function renderSecrets(s) {
        clear(secretsHost);
        var refs = (s && s.secretRefs) || [];
        secretsHost.appendChild(h("h3", null, "Secrets"));
        if (!refs.length) {
          secretsHost.appendChild(h("p", { class: "sec-lede" },
            "Add \u0024{secret:path} in the env/header templates above, then Save server — values appear here."));
          return;
        }
        var missing = refs.filter(function (r) { return !r.stored; }).length;
        secretsHost.appendChild(h("p", { class: "sec-lede" },
          "Shared defaults for this server. Values are never shown again." +
          (missing ? " " + missing + " still missing." : "")));

        var flash = h("div");
        var list = h("div", { class: "secret-list" });
        var fields = [];
        refs.forEach(function (ref) {
          var input = h("input", {
            type: "password",
            autocomplete: "new-password",
            "aria-label": ref.path,
            placeholder: ref.stored ? "stored — enter a new value to replace" : "paste value"
          });
          fields.push({ ref: ref, input: input });
          list.appendChild(h("div", { class: "secret-row" },
            h("div", { class: "secret-meta" },
              h("span", { class: "secret-path", title: ref.path }, ref.path),
              ref.stored ? h("span", { class: "pill on" }, "stored") : h("span", { class: "pill miss" }, "missing")),
            input));
        });
        secretsHost.appendChild(list);
        secretsHost.appendChild(flash);
        secretsHost.appendChild(h("p", { class: "row" },
          h("button", { class: "btn accent", type: "button", onclick: guard(flash, function () {
            var pending = fields.filter(function (f) { return f.input.value; });
            if (!pending.length) {
              show(flash, notice("error", "Enter at least one value, then Save secrets."));
              return Promise.resolve();
            }
            return Promise.all(pending.map(function (f) {
              return api("PUT", "secrets", { path: f.ref.path, value: f.input.value });
            })).then(function () {
              pending.forEach(function (f) { f.ref.stored = true; });
              renderSecrets(s);
              show(box, notice("ok", "Saved " + pending.length + " secret" + (pending.length === 1 ? "" : "s") + "."));
            });
          }) }, "Save secrets")));
      }
      if (!isNew) renderSecrets(existing);
      else {
        secretsHost.appendChild(h("h3", null, "Secrets"));
        secretsHost.appendChild(h("p", { class: "sec-lede" }, "Create the server first, then set secret values here."));
      }
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── Skills: user catalog (adminCatalog=false) | manage (true) ─────────────
  function skillsView(root, adminCatalog) {
    if (adminCatalog && focusSkill !== null) return skillSheet(root, focusSkill);
    api("GET", "catalog/skills").then(function (d) {
      clear(root);
      var items = (d.skills || []).filter(function (s) { return adminCatalog || !s.disabled; });
      var q = "";
      var filter = "all";
      var flash = h("div");
      var installedN = items.filter(function (s) { return s.installed && !s.disabled; }).length;
      root.appendChild(marketHero(
        adminCatalog ? "Manage skills" : "Skills",
        adminCatalog
          ? "Enable, disable, configure, or delete catalog entries."
          : installedN + " installed of " + items.length
      ));
      root.appendChild(flash);
      if (!items.length && !adminCatalog) {
        catalogEmpty(root, "No skills yet", "Ask an admin to add one.");
        return;
      }
      var search = h("input", { type: "text", placeholder: "Search…", "aria-label": "Search skills" });
      root.appendChild(h("div", { class: "toolbar" },
        h("div", { class: "search" }, h("span", { class: "ico" }, "/"), search),
        adminCatalog ? h("button", { class: "btn primary", type: "button", onclick: function () { focusSkill = "__new__"; skillsView(root, true); } }, "Add") : null));
      var chips = h("div", { class: "chips" });
      root.appendChild(chips);
      var list = h("div", { class: "catalog" });
      root.appendChild(list);

      function reload() { focusSkill = null; skillsView(root, adminCatalog); }
      function paint() {
        clear(list);
        var shown = items.filter(function (s) {
          if (filter === "installed" && (!s.installed || s.disabled)) return false;
          if (filter === "available" && (s.installed || s.disabled)) return false;
          if (filter === "disabled" && !s.disabled) return false;
          return matchesQuery(q, [s.name, s.description, s.plugin, s.migratedFrom].concat(s.keywords || []));
        });
        if (!shown.length) {
          catalogEmpty(list, items.length ? "No matches" : "No skills yet",
            items.length ? "Try another filter or search." : (adminCatalog ? "Use Add to create one." : "Ask an admin to add one."));
          return;
        }
        shown.forEach(function (s) {
          var hints = [];
          if (s.disabled) hints.push(h("span", { class: "hint bad" }, "disabled"));
          else if (s.installed) hints.push(s.available ? h("span", { class: "hint good" }, "installed") : h("span", { class: "hint bad" }, "file missing"));
          var actions = h("div", { class: "item-actions" });
          if (!adminCatalog) {
            actions.appendChild(h("button", {
              class: s.installed ? "btn" : "btn accent", type: "button",
              onclick: guard(flash, function () {
                var path = "profile/skills/" + encodeURIComponent(s.name);
                return (s.installed ? api("DELETE", path) : api("POST", path, {})).then(reload);
              })
            }, s.installed ? "Remove" : "Install"));
          } else {
            actions.appendChild(h("button", { class: "link", type: "button", onclick: guard(flash, function () {
              return api("PUT", "skills/" + encodeURIComponent(s.name), { disabled: !s.disabled }).then(reload);
            }) }, s.disabled ? "Enable" : "Disable"));
            actions.appendChild(h("button", { class: "link", type: "button", onclick: function () { focusSkill = s.name; skillsView(root, true); } }, "Configure"));
            actions.appendChild(h("button", { class: "link danger", type: "button", onclick: guard(flash, function () {
              if (!confirm("Delete \"" + s.name + "\" from the catalog?")) return Promise.resolve();
              return api("DELETE", "skills/" + encodeURIComponent(s.name)).then(reload);
            }) }, "Delete"));
          }
          list.appendChild(h("article", { class: "item", title: s.path || "" },
            h("div", { class: "item-main" }, h("h2", null, s.name, hints), h("p", { class: "desc" }, s.description || "")),
            actions));
        });
      }
      search.addEventListener("input", function () { q = search.value.trim(); paint(); });
      filterChips(chips, filter, function (f) { filter = f; paint(); }, adminCatalog);
      paint();
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  function skillSheet(root, name) {
    var isNew = name === "__new__";
    var load = isNew ? Promise.resolve(null) : api("GET", "skills/" + encodeURIComponent(name));
    load.then(function (existing) {
      clear(root);
      var box = h("div");
      root.appendChild(h("button", { class: "back", type: "button", onclick: function () { focusSkill = null; skillsView(root, true); } }, "← Manage skills"));
      var nameIn = h("input", { type: "text", placeholder: "docx" });
      if (existing) nameIn.value = existing.name;
      var description = h("input", { type: "text", placeholder: "Create or edit Word documents" });
      if (existing) description.value = existing.description || "";
      var keywords = h("input", { type: "text", placeholder: "word, docx" });
      if (existing) keywords.value = (existing.keywords || []).join(", ");
      var groups = h("input", { type: "text", placeholder: "everyone" });
      if (existing) groups.value = (existing.groups || []).join(", ");
      var body = h("textarea", { class: "body", placeholder: "Full skill instructions… Use {{arg}} and {{context.name}} when prompt is set." });
      if (existing) body.value = existing.body || "";
      var promptIn = h("textarea", { class: "body", rows: "8", placeholder: '{\n  "arguments": [{ "name": "service_name", "required": true }],\n  "context": [{ "name": "status", "url": "https://api.example/services/{{service_name}}" }]\n}' });
      if (existing && existing.prompt) promptIn.value = JSON.stringify(existing.prompt, null, 2);
      var disabledIn = h("input", { type: "checkbox" }); disabledIn.checked = Boolean(existing && existing.disabled);
      root.appendChild(h("div", { class: "sheet" },
        h("div", { class: "sheet-top" },
          h("h1", null, isNew ? "New skill" : existing.name),
          !isNew && existing.disabled ? h("span", { class: "pill miss" }, "disabled") : null),
        h("div", { class: "sheet-sec" },
          h("h3", null, "Basics"),
          h("label", null, "Name"), nameIn,
          !isNew ? h("p", { class: "muted" }, "Renaming updates installs and moves managed-skills/<name>/ when applicable.") : null,
          h("label", null, "Description"), description,
          h("label", null, "Keywords"), keywords,
          h("label", null, "Groups (comma separated, blank = everyone)"), groups,
          !isNew ? h("label", { class: "inline" }, disabledIn, " Disabled (hidden from users; load refused)") : null),
        h("div", { class: "sheet-sec" },
          h("h3", null, "Instructions"),
          h("p", { class: "sec-lede" }, "Loaded on demand via load_skill or MCP prompts/get. Bundled files are available as skill:// resources."),
          body),
        h("div", { class: "sheet-sec" },
          h("h3", null, "Dynamic prompt (optional)"),
          h("p", { class: "sec-lede" }, "JSON: arguments for slash-command params; context fetches inject {{context.name}}. Headers may use \${secret:path}. Clear the field to remove."),
          promptIn),
        h("div", { class: "sheet-actions" },
          h("button", { class: "btn primary", type: "button", onclick: guard(box, function () {
            var payload = {
              description: description.value,
              keywords: keywords.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
              groups: groups.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
              body: body.value
            };
            var rawPrompt = promptIn.value.trim();
            if (!rawPrompt) payload.prompt = null;
            else {
              try { payload.prompt = JSON.parse(rawPrompt); }
              catch (e) { return Promise.reject(new Error("prompt JSON: " + e.message)); }
            }
            if (isNew) {
              payload.name = nameIn.value.trim();
              return api("POST", "skills", payload).then(function () { focusSkill = null; skillsView(root, true); });
            }
            payload.name = nameIn.value.trim();
            payload.disabled = disabledIn.checked;
            var prevSkill = existing.name;
            return api("PUT", "skills/" + encodeURIComponent(prevSkill), payload).then(function (saved) {
              if (saved && saved.name && saved.name !== prevSkill) {
                focusSkill = saved.name;
                return skillSheet(root, saved.name);
              }
              show(box, notice("ok", "Saved."));
            });
          }) }, isNew ? "Create" : "Save"),
          h("span", { class: "spacer" }),
          !isNew ? h("button", { class: "btn danger", type: "button", onclick: guard(box, function () {
            if (!confirm("Delete \"" + existing.name + "\"?")) return Promise.resolve();
            return api("DELETE", "skills/" + encodeURIComponent(existing.name)).then(function () { focusSkill = null; skillsView(root, true); });
          }) }, "Delete") : null),
        box));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── my credentials ───────────────────────────────────────────────────────
  function connectionsView(root) {
    api("GET", "connections").then(function (d) {
      clear(root);
      root.appendChild(marketHero("Credentials", "Keys are encrypted on the gateway. Request headers still win."));
      var list = d.connections || [];
      if (focusServer) {
        list = list.filter(function (c) { return c.server === focusServer; }).concat(
          list.filter(function (c) { return c.server !== focusServer; })
        );
      }
      if (!list.length) {
        catalogEmpty(root, "Nothing to connect", "No server needs a personal credential for your account.");
        return;
      }
      list.forEach(function (c) {
        var card = h("div", { class: "card" }, h("h2", null, c.server,
          c.oauth ? h("span", { class: "pill ml" }, "OAuth") : null),
          h("p", { class: "muted" }, c.description));
        if (c.oauth) {
          var obox = h("div");
          if (c.oauthShared) {
            card.appendChild(h("p", { class: "warn" },
              c.sharedScopeMultiGroup
                ? "Shared OAuth visible to more than one group — every caller acts as this connection."
                : "Shared OAuth — every user of this server acts as this connection."));
          }
          card.appendChild(h("p", { class: "row" },
            c.oauthConnected ? h("span", { class: "good" }, "connected") : h("span", { class: "bad" }, "not connected"),
            h("button", { class: "btn accent", type: "button", onclick: guard(obox, function () {
              return api("POST", "connections/" + encodeURIComponent(c.server) + "/oauth", {}).then(function (r) {
                window.location.href = r.authorizationUrl;
              });
            }) }, c.oauthConnected ? "Reconnect" : "Connect"),
            c.oauthConnected ? h("button", { class: "btn danger", type: "button", onclick: guard(obox, function () {
              return api("DELETE", "connections/" + encodeURIComponent(c.server) + "/oauth").then(function () { connectionsView(root); });
            }) }, "Disconnect") : null));
          card.appendChild(obox);
        }
        c.fields.forEach(function (f) {
          var box = h("div"), input = h("input", { type: "password", placeholder: f.stored ? "stored — enter a new value to replace" : "value", autocomplete: "new-password" });
          var row = h("form", { class: "row", onsubmit: guard(box, function () {
            if (!input.value) return Promise.resolve();
            return api("PUT", "connections/" + encodeURIComponent(c.server) + "/" + encodeURIComponent(f.name), { value: input.value }).then(function () { connectionsView(root); });
          }) },
            h("span", { class: "mono fieldname" }, f.name), h("div", { class: "grow" }, input),
            h("button", { class: "btn primary", type: "submit" }, "Save"),
            f.stored ? h("button", { class: "btn danger", type: "button", onclick: guard(box, function () {
              return api("DELETE", "connections/" + encodeURIComponent(c.server) + "/" + encodeURIComponent(f.name)).then(function () { connectionsView(root); });
            }) }, "Remove") : null,
            f.stored ? h("span", { class: "good" }, "stored") : h("span", { class: f.sharedFallback ? "muted" : "bad" }, f.sharedFallback ? "using shared key" : "missing"));
          card.appendChild(row); card.appendChild(box);
        });
        root.appendChild(card);
      });
      focusServer = null;
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── activity ─────────────────────────────────────────────────────────────
  function activityView(root) {
    var all = me.admin ? "&all=1" : "";
    api("GET", "audit?limit=200" + all).then(function (d) {
      clear(root);
      var servers = [];
      d.events.forEach(function (e) { if (e.server && servers.indexOf(e.server) === -1) servers.push(e.server); });
      servers.sort();
      var serverSel = h("select", null, h("option", { value: "" }, "All servers"), servers.map(function (s) { return h("option", { value: s }, s); }));
      var errOnly = h("input", { type: "checkbox" });
      var out = h("div");
      function draw() {
        var rows = d.events.filter(function (e) {
          if (serverSel.value && e.server !== serverSel.value) return false;
          if (errOnly.checked && e.ok !== false) return false;
          return true;
        }).map(function (e) {
          var result = e.ok !== false
            ? h("span", { class: "good" }, "ok")
            : h("span", { class: "bad wrap", title: e.error || "" }, "error" + (e.error ? ": " + (e.error.length > 60 ? e.error.slice(0, 60) + "\u2026" : e.error) : ""));
          return [
            h("span", { title: new Date(e.ts).toLocaleString() }, ago(e.ts)),
            e.user,
            h("code", null, e.tool || e.action || ""),
            (e.server && e.target ? e.server + " \u00b7 " + e.target : e.server || e.target || ""),
            e.session ? h("code", { title: e.session }, String(e.session).slice(0, 8)) : "",
            result,
            String(e.ms || 0)
          ];
        });
        clear(out);
        out.appendChild(table(["When", "User", "Action", "Target", "Session", "Result", "ms"], rows, "Nothing yet."));
      }
      serverSel.addEventListener("change", draw);
      errOnly.addEventListener("change", draw);
      root.appendChild(h("div", { class: "card" }, h("h2", null, me.admin ? "Recent activity (everyone)" : "Your recent activity"),
        h("p", { class: "row" }, serverSel, h("label", { class: "inline" }, errOnly, " errors only")), out));
      draw();
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── sessions (admin) ─────────────────────────────────────────────────────
  function sessionsView(root) {
    api("GET", "status").then(function (s) {
      clear(root);
      var indexBox = h("div");
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Gateway"),
        h("p", null, "Up " + Math.round(s.uptimeSec / 60) + " min · " + s.servers + " servers · " + (s.skills || 0) + " skills · " + s.tokens + " tokens · " + s.secrets + " secrets · " + s.sessions.length + " live sessions"),
        h("p", { class: "row" },
          h("button", { class: "btn", onclick: function () { sessionsView(root); } }, "Refresh"),
          h("button", { class: "btn accent", type: "button", onclick: guard(indexBox, function () {
            return api("POST", "tool-index/rebuild", {}).then(function (r) {
              var msg = "Indexed " + (r.indexed || []).length +
                ", skipped " + (r.skipped || []).length +
                ", failed " + (r.failed || []).length +
                ". Only shared-scope servers are indexed (never user credentials).";
              show(indexBox, notice((r.failed || []).length ? "error" : "ok", msg));
            });
          }) }, "Index all tools")),
        indexBox,
        h("p", { class: "muted" }, "Index all activates each shared-scope catalog server once to populate discovery, then deactivates it. User-scoped servers are skipped so private tool lists never enter the shared index.")));
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Live sessions"),
        table(["Session", "User", "Started", "Last seen", "Active servers"], s.sessions.map(function (x) {
          return [h("code", null, x.id.slice(0, 8)), x.user, ago(x.createdAt), ago(x.lastSeen), pills(x.servers)];
        }), "No live sessions.")));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── tokens (admin) ───────────────────────────────────────────────────────
  function tokensView(root, created) {
    api("GET", "tokens").then(function (d) {
      clear(root);
      var box = h("div");
      if (created) root.appendChild(h("div", { class: "card" }, h("h2", null, "New token for " + created.user), h("p", { class: "muted" }, "Copy it now — it is not shown again."), h("div", { class: "token" }, created.token)));
      var user = h("input", { type: "text", placeholder: "alice" }), groups = h("input", { type: "text", placeholder: "eng, sre" }),
        expires = h("input", { type: "text", placeholder: "90d (optional)" }), label = h("input", { type: "text", placeholder: "label (optional)" }),
        admin = h("input", { type: "checkbox" });
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Create token"),
        h("form", { onsubmit: guard(box, function () {
          return api("POST", "tokens", { user: user.value.trim(), groups: groups.value.split(","), expires: expires.value, label: label.value, admin: admin.checked })
            .then(function (t) { tokensView(root, { user: user.value.trim(), token: t.token }); });
        }) }, h("div", { class: "row" }, h("div", { class: "grow" }, h("label", null, "User"), user), h("div", { class: "grow" }, h("label", null, "Groups"), groups),
          h("div", { class: "grow" }, h("label", null, "Expires"), expires), h("div", { class: "grow" }, h("label", null, "Label"), label)),
          h("p", { class: "row" }, h("label", { class: "inline" }, admin, " admin (manage tokens, secrets, servers)"), h("button", { class: "btn primary", type: "submit" }, "Create")), box)));
      var rbox = h("div");
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Tokens"), rbox,
        table(["ID", "User", "Groups", "Created", "Expires", ""], d.tokens.map(function (t) {
          return [h("code", null, t.id), [t.user, t.admin ? h("span", { class: "pill ml" }, "admin") : null, t.label ? h("span", { class: "muted" }, " " + t.label) : null],
            pills(t.groups), ago(t.createdAt), t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "never",
            h("button", { class: "btn danger", onclick: guard(rbox, function () {
              if (!confirm("Revoke token " + t.id + " for " + t.user + "?")) return Promise.resolve();
              return api("DELETE", "tokens/" + t.id).then(function () { tokensView(root); });
            }) }, "Revoke")];
        }), "No tokens.")));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  // ── secrets (admin) ──────────────────────────────────────────────────────
  function secretsView(root) {
    api("GET", "secrets").then(function (d) {
      clear(root);
      root.appendChild(marketHero("Secrets", "Shared server defaults. Values are never shown again after save."));
      var required = d.required || [];
      var missing = required.filter(function (r) { return !r.stored; });
      if (missing.length) {
        var flash = h("div");
        var list = h("div", { class: "secret-list" });
        var fields = [];
        missing.forEach(function (r) {
          var input = h("input", { type: "password", autocomplete: "new-password", "aria-label": r.path, placeholder: "paste value" });
          fields.push({ path: r.path, input: input });
          list.appendChild(h("div", { class: "secret-row" },
            h("div", { class: "secret-meta" },
              h("span", { class: "secret-path", title: r.path }, r.path),
              h("span", { class: "muted" }, (r.servers || []).join(", ") || "—")),
            input));
        });
        root.appendChild(h("div", { class: "card" },
          h("h2", null, "Missing (" + missing.length + ")"),
          h("p", { class: "muted" }, "Referenced by server auth templates but not stored yet."),
          list, flash,
          h("p", { class: "row" }, h("button", { class: "btn accent", type: "button", onclick: guard(flash, function () {
            var pending = fields.filter(function (f) { return f.input.value; });
            if (!pending.length) {
              show(flash, notice("error", "Enter at least one value."));
              return Promise.resolve();
            }
            return Promise.all(pending.map(function (f) {
              return api("PUT", "secrets", { path: f.path, value: f.input.value });
            })).then(function () { secretsView(root); });
          }) }, "Save secrets"))));
      }
      var box = h("div"), path = h("input", { type: "text", placeholder: "google/client_id" }), value = h("input", { type: "password", autocomplete: "new-password", placeholder: "value" });
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Add or replace"),
        h("form", { class: "row", onsubmit: guard(box, function () {
          return api("PUT", "secrets", { path: path.value.trim(), value: value.value }).then(function () { secretsView(root); });
        }) }, h("div", { class: "grow" }, path), h("div", { class: "grow" }, value), h("button", { class: "btn primary", type: "submit" }, "Save")), box));
      var rbox = h("div");
      var storedRows = (d.secrets || []).map(function (s) {
        var used = (required.find(function (r) { return r.path === s; }) || {}).servers || [];
        return [h("code", null, s), used.length ? h("span", { class: "muted" }, used.join(", ")) : "",
          h("button", { class: "btn danger", onclick: guard(rbox, function () {
            if (!confirm("Delete secret " + s + "?")) return Promise.resolve();
            return api("DELETE", "secrets?path=" + encodeURIComponent(s)).then(function () { secretsView(root); });
          }) }, "Delete")];
      });
      root.appendChild(h("div", { class: "card" }, h("h2", null, "Stored"), rbox,
        table(["Path", "Used by", ""], storedRows, "No secrets stored.")));
    }).catch(function (e) { show(root, notice("error", e.message)); });
  }

  render();
})();
`;
