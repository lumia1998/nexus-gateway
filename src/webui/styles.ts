export const styles = String.raw`
/* ── Nexus Gateway UI · shadcn-inspired design system ────────────────
   Design tokens follow the shadcn/ui "new-york" palette (neutral,
   high-contrast, tight radii). Every page shares ONE spacing contract:
     · page padding   : 24px (narrow gutters)
     · section gap    : 16px
     · card padding   : 16px
     · control height : 32px (compact) / 40px (auth forms)
     · table cell     : 10px 16px
   All sizes are expressed through the tokens below; do not introduce
   ad-hoc pixel values when extending the UI. */

:root {
  color-scheme: light;
  --background: 0 0% 100%;
  --foreground: 0 0% 3.9%;
  --card: 0 0% 100%;
  --card-foreground: 0 0% 3.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 3.9%;
  --primary: 0 0% 9%;
  --primary-foreground: 0 0% 98%;
  --secondary: 0 0% 96.1%;
  --secondary-foreground: 0 0% 9%;
  --muted: 0 0% 96.1%;
  --muted-foreground: 0 0% 45.1%;
  --accent: 0 0% 96.1%;
  --accent-foreground: 0 0% 9%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 76% 36%;
  --warning: 32 95% 44%;
  --info: 217 91% 60%;
  --border: 0 0% 89.8%;
  --input: 0 0% 89.8%;
  --ring: 0 0% 63.9%;

  /* spacing scale (px) — single source of truth */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px;

  --radius: 6px;
  --sidebar-width: 232px;
  --content-max: 1280px;
}

html[data-theme="dark"] {
  color-scheme: dark;
  --background: 0 0% 3.9%;
  --foreground: 0 0% 98%;
  --card: 0 0% 3.9%;
  --card-foreground: 0 0% 98%;
  --popover: 0 0% 3.9%;
  --popover-foreground: 0 0% 98%;
  --primary: 0 0% 98%;
  --primary-foreground: 0 0% 9%;
  --secondary: 0 0% 14.9%;
  --secondary-foreground: 0 0% 98%;
  --muted: 0 0% 14.9%;
  --muted-foreground: 0 0% 63.9%;
  --accent: 0 0% 14.9%;
  --accent-foreground: 0 0% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 71% 45%;
  --warning: 38 92% 50%;
  --info: 217 91% 65%;
  --border: 0 0% 14.9%;
  --input: 0 0% 14.9%;
  --ring: 0 0% 83.1%;
}

/* ── Base ─────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
html { scrollbar-gutter: stable; }
body {
  margin: 0;
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans",
        "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
h1, h2, h3, p { margin: 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; cursor: pointer; padding: 0; }
code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
.hidden { display: none !important; }
.muted { color: hsl(var(--muted-foreground)); font-size: 12px; }

:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
  border-radius: 2px;
}

::selection { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }

/* Thin scrollbars */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: hsl(var(--muted-foreground) / .35); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background-color: hsl(var(--muted-foreground) / .55); }
::-webkit-scrollbar-track { background: transparent; }

/* ── Brand ────────────────────────────────────────────────────────── */
.brand-mark {
  width: 28px; height: 28px;
  display: grid; place-items: center;
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  border-radius: var(--radius);
  font-weight: 700; font-size: 13px; letter-spacing: -.02em;
  flex-shrink: 0;
}

/* ── Auth screens ─────────────────────────────────────────────────── */
.auth-screen {
  min-height: 100vh;
  display: grid; place-items: center;
  padding: var(--sp-6);
  background: hsl(var(--muted) / .4);
}
.auth-card {
  width: min(360px, 100%);
  padding: var(--sp-6);
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
  box-shadow: 0 1px 2px rgb(0 0 0 / .05), 0 8px 24px -8px rgb(0 0 0 / .1);
}
.auth-card header { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-4); }
.auth-card h1 { font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.auth-card > p { color: hsl(var(--muted-foreground)); font-size: 13px; margin-bottom: var(--sp-5); }
.auth-submit { width: 100%; height: 36px; }
.avatar {
  width: 26px; height: 26px; flex-shrink: 0;
  display: grid; place-items: center;
  background: hsl(var(--secondary)); color: hsl(var(--secondary-foreground));
  border-radius: 50%;
  font-size: 11px; font-weight: 700;
}

/* ── Forms ────────────────────────────────────────────────────────── */
.field { display: grid; gap: 6px; margin-bottom: var(--sp-4); font-size: 13px; font-weight: 500; }
.field > small, .field-help { color: hsl(var(--muted-foreground)); font-size: 12px; font-weight: 400; line-height: 1.5; }
.field-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sp-4); align-items: start; }

input, select, textarea {
  width: 100%; height: 32px;
  padding: 0 var(--sp-3);
  background: transparent;
  border: 1px solid hsl(var(--input));
  border-radius: var(--radius);
  font-size: 13px;
  transition: border-color .12s ease, box-shadow .12s ease;
}
textarea { height: auto; min-height: 72px; padding: var(--sp-2) var(--sp-3); resize: vertical; line-height: 1.5; }
input:hover, select:hover, textarea:hover { border-color: hsl(var(--muted-foreground) / .6); }
input:focus, select:focus, textarea:focus { outline: none; border-color: hsl(var(--ring)); box-shadow: 0 0 0 2px hsl(var(--ring) / .2); }
input:disabled, select:disabled, textarea:disabled { opacity: .5; cursor: not-allowed; }
input[type="checkbox"] { width: 14px; height: 14px; padding: 0; accent-color: hsl(var(--primary)); }

.checkbox { display: flex; align-items: center; gap: var(--sp-2); height: 32px; font-weight: 500; cursor: pointer; }
.checkbox input { flex-shrink: 0; }

.form-error { min-height: 18px; margin-top: var(--sp-2); color: hsl(var(--destructive)); font-size: 12px; font-weight: 500; }

/* ── Buttons ──────────────────────────────────────────────────────── */
.button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 var(--sp-3);
  border: 1px solid hsl(var(--input));
  border-radius: var(--radius);
  background: hsl(var(--card));
  font-size: 13px; font-weight: 500; white-space: nowrap;
  box-shadow: 0 1px 2px rgb(0 0 0 / .04);
  transition: background-color .12s ease, border-color .12s ease;
}
.button:hover:not(:disabled) { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }
.button:disabled { opacity: .5; cursor: not-allowed; }
.button.primary { background: hsl(var(--primary)); border-color: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
.button.primary:hover:not(:disabled) { background: hsl(var(--primary) / .88); color: hsl(var(--primary-foreground)); }
.button.danger { border-color: hsl(var(--destructive) / .5); color: hsl(var(--destructive)); }
.button.danger:hover:not(:disabled) { background: hsl(var(--destructive) / .08); }
.button.ghost { border-color: transparent; box-shadow: none; background: transparent; }
.button.small { height: 26px; padding: 0 var(--sp-2); font-size: 12px; }
.button svg, .menu-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }

.icon-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; flex-shrink: 0;
  border-radius: var(--radius);
  color: hsl(var(--muted-foreground));
  transition: background-color .12s ease, color .12s ease;
}
.icon-button:hover { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }
.icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

/* ── App shell ────────────────────────────────────────────────────── */
.app-shell { min-height: 100vh; display: flex; }

.sidebar {
  position: fixed; inset: 0 auto 0 0;
  width: var(--sidebar-width);
  padding: var(--sp-3) var(--sp-2);
  display: flex; flex-direction: column; gap: var(--sp-2);
  background: hsl(var(--card));
  border-right: 1px solid hsl(var(--border));
  z-index: 10;
}
.brand {
  display: flex; align-items: center; gap: var(--sp-2);
  height: 40px; padding: 0 var(--sp-2);
  font-weight: 600; font-size: 13px; letter-spacing: -.01em;
}
nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  width: 100%; height: 32px;
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 0 var(--sp-2);
  border-radius: var(--radius);
  color: hsl(var(--muted-foreground));
  font-size: 13px; font-weight: 500; text-align: left;
  transition: background-color .12s ease, color .12s ease;
}
.nav-item:hover { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }
.nav-item.active { background: hsl(var(--secondary)); color: hsl(var(--secondary-foreground)); font-weight: 600; }
.nav-item svg { width: 15px; height: 15px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.admin-menu-wrap { position: relative; margin-top: auto; }
.admin-button {
  width: 100%; display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--radius);
  text-align: left;
  transition: background-color .12s ease;
}
.admin-button:hover { background: hsl(var(--accent)); }
.admin-button > svg { width: 15px; height: 15px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.admin-button span { display: grid; gap: 1px; min-width: 0; }
.admin-button strong { font-size: 13px; font-weight: 600; }
.admin-button small { color: hsl(var(--muted-foreground)); font-size: 11px; }
.admin-popover {
  position: absolute; inset: auto 0 calc(100% + var(--sp-2));
  padding: var(--sp-2);
  background: hsl(var(--popover));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
  box-shadow: 0 8px 24px -4px rgb(0 0 0 / .12), 0 2px 8px -2px rgb(0 0 0 / .08);
  z-index: 20;
}
.admin-popover .field { margin-bottom: var(--sp-2); font-size: 12px; }
.menu-button {
  width: 100%; height: 30px;
  display: flex; align-items: center;
  padding: 0 var(--sp-2);
  border-radius: var(--radius);
  font-size: 13px; font-weight: 500; text-align: left;
  transition: background-color .12s ease;
}
.menu-button:hover { background: hsl(var(--accent)); }
.danger-text { color: hsl(var(--destructive)); }

/* ── Main / page chrome ───────────────────────────────────────────── */
.main {
  flex: 1; min-width: 0;
  margin-left: var(--sidebar-width);
  min-height: 100vh;
  display: flex; flex-direction: column;
}
.topbar {
  position: sticky; top: 0; z-index: 5;
  height: 48px;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4);
  padding: 0 var(--sp-6);
  background: hsl(var(--background));
  border-bottom: 1px solid hsl(var(--border));
}
.topbar h1 { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.page-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

.page-lede { padding: var(--sp-4) var(--sp-6) 0; color: hsl(var(--muted-foreground)); font-size: 13px; }
.page-content {
  flex: 1; width: 100%; max-width: var(--content-max);
  margin: 0 auto;
  padding: var(--sp-3) var(--sp-6) var(--sp-6);
  display: flex; flex-direction: column; gap: var(--sp-4);
}

/* ── Cards / panels ───────────────────────────────────────────────── */
.panel {
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
}
.panel-header {
  min-height: 44px;
  padding: 0 var(--sp-4);
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4);
  border-bottom: 1px solid hsl(var(--border));
}
.panel-header h2 { font-size: 13px; font-weight: 600; }
.panel-body { padding: var(--sp-4); }
.empty { padding: var(--sp-8) var(--sp-4); color: hsl(var(--muted-foreground)); text-align: center; font-size: 13px; }
.empty-state { display: grid; place-items: center; gap: var(--sp-1); padding: var(--sp-8) var(--sp-4); text-align: center; }
.empty-state svg { width: 24px; height: 24px; margin-bottom: var(--sp-2); color: hsl(var(--muted-foreground) / .6); fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.empty-state strong { font-size: 13px; font-weight: 600; color: hsl(var(--foreground)); }
.empty-state span { font-size: 12px; color: hsl(var(--muted-foreground)); }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); }
.stat {
  padding: var(--sp-4);
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
  display: grid; gap: var(--sp-1);
}
.stat span { color: hsl(var(--muted-foreground)); font-size: 12px; font-weight: 500; }
.stat strong { font-size: 22px; font-weight: 600; letter-spacing: -.02em; line-height: 1.2; font-variant-numeric: tabular-nums; }

/* ── Toolbar ──────────────────────────────────────────────────────── */
.toolbar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.toolbar select { width: auto; min-width: 128px; }
.search-box { position: relative; flex: 1; min-width: 160px; max-width: 280px; }
.search-box svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: hsl(var(--muted-foreground)); fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.search-box input { width: 100%; padding-left: 30px; }

/* ── Tables ───────────────────────────────────────────────────────── */
.table-wrap {
  overflow-x: auto;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
}
table { width: 100%; border-collapse: collapse; min-width: 720px; }
th, td { padding: 0 var(--sp-4); height: 40px; border-bottom: 1px solid hsl(var(--border)); text-align: left; vertical-align: middle; }
th { height: 36px; color: hsl(var(--muted-foreground)); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: hsl(var(--muted) / .5); }
tr[data-run-detail] { cursor: pointer; }

.agent-name { display: grid; gap: 2px; min-width: 0; }
.agent-name strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.agent-name small { color: hsl(var(--muted-foreground)); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.error-detail { color: hsl(var(--destructive)); font-size: 12px; overflow-wrap: anywhere; line-height: 1.4; }
.row-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); }

/* ── Badges & status ──────────────────────────────────────────────── */
.badge {
  display: inline-flex; align-items: center;
  height: 20px; padding: 0 7px;
  border: 1px solid hsl(var(--border));
  border-radius: 4px;
  background: hsl(var(--secondary));
  color: hsl(var(--secondary-foreground));
  font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
}
.status {
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 8px;
  border-radius: 9999px;
  background: hsl(var(--secondary));
  color: hsl(var(--muted-foreground));
  font-size: 12px; font-weight: 500; white-space: nowrap;
}
.status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: hsl(var(--muted-foreground) / .5); flex-shrink: 0; }
.status.ready, .status.completed { color: hsl(var(--success)); background: hsl(var(--success) / .1); }
.status.ready::before, .status.completed::before { background: hsl(var(--success)); }
.status.failed { color: hsl(var(--destructive)); background: hsl(var(--destructive) / .1); }
.status.failed::before { background: hsl(var(--destructive)); }
.status.running { color: hsl(var(--info)); background: hsl(var(--info) / .1); }
.status.running::before { background: hsl(var(--info)); animation: pulse 2s cubic-bezier(.4, 0, .6, 1) infinite; }
.status.waiting { color: hsl(var(--warning)); background: hsl(var(--warning) / .12); }
.status.waiting::before { background: hsl(var(--warning)); animation: pulse 2s cubic-bezier(.4, 0, .6, 1) infinite; }
.status.checking::before { animation: pulse 2s cubic-bezier(.4, 0, .6, 1) infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

/* ── Runs page ────────────────────────────────────────────────────── */
.run-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-4); }
.run-section { display: flex; flex-direction: column; gap: var(--sp-3); }
.run-section-title { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-4); }
.run-section-title h2 { font-size: 13px; font-weight: 600; }
.run-section-title span { color: hsl(var(--muted-foreground)); font-size: 12px; }

.run-live-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--sp-3); }
.run-card {
  position: relative;
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-left: 3px solid hsl(var(--info));
  border-radius: calc(var(--radius) + 2px);
  cursor: pointer;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.run-card:hover { border-color: hsl(var(--muted-foreground) / .4); box-shadow: 0 2px 8px -2px rgb(0 0 0 / .08); }
.run-card.waiting { border-left-color: hsl(var(--warning)); }
.run-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.run-card-agent { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.run-card-agent strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.run-task {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
  color: hsl(var(--foreground));
  font-size: 13px; line-height: 1.5;
  white-space: pre-wrap;
}
.run-progress { display: grid; gap: 2px; }
.run-progress strong { font-size: 12px; font-weight: 600; }
.run-progress small { color: hsl(var(--muted-foreground)); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-meta {
  display: flex; align-items: center; justify-content: space-between;
  color: hsl(var(--muted-foreground));
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.run-table { min-width: 880px; }
.run-table .run-task-cell { max-width: 360px; }
.run-task-cell strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; font-size: 13px; }
.run-task-cell small { display: block; margin-top: 2px; color: hsl(var(--muted-foreground)); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Run detail (drawer) */
.run-detail-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
  margin-bottom: var(--sp-4);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
  overflow: hidden;
  background: hsl(var(--border));
}
.run-detail-item { padding: var(--sp-3); background: hsl(var(--card)); display: grid; gap: 4px; align-content: start; }
.run-detail-item span { color: hsl(var(--muted-foreground)); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.run-detail-item strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.run-detail-block { margin-bottom: var(--sp-4); }
.run-detail-block h3 { margin: 0 0 var(--sp-2); color: hsl(var(--muted-foreground)); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.run-detail-code {
  margin: 0; padding: var(--sp-3);
  max-height: 320px; overflow: auto;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--muted) / .4);
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere; white-space: pre-wrap;
}
.run-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* ── Lists (workspaces, overview, artifacts) ──────────────────────── */
.workspace-list, .overview-list { display: grid; gap: var(--sp-2); }
.list-row {
  min-height: 52px;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
  transition: border-color .12s ease;
}
.list-row:hover { border-color: hsl(var(--muted-foreground) / .4); }
.list-row-main { display: grid; gap: 2px; min-width: 0; }
.list-row-main strong, .path { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.list-row-main small { color: hsl(var(--muted-foreground)); font-size: 12px; }
.tip {
  padding: var(--sp-3) var(--sp-4);
  background: hsl(var(--muted) / .5);
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
  color: hsl(var(--muted-foreground));
  font-size: 12px; line-height: 1.6;
}

/* ── API keys ─────────────────────────────────────────────────────── */
.key-table { min-width: 0; width: 100%; table-layout: fixed; }
.key-table th:nth-child(1) { width: 21%; }
.key-table th:nth-child(2) { width: 15%; }
.key-table th:nth-child(3) { width: 20%; }
.key-table th:nth-child(4) { width: 15%; }
.key-table th:nth-child(5) { width: 15%; }
.key-table th:nth-child(6) { width: 14%; }
.key-table th, .key-table td { padding-left: 10px; padding-right: 10px; }
.key-table-wrap { overflow-x: hidden; }
.key-table td { height: 66px; }
.key-table th:last-child, .key-table td:last-child { text-align: right; }
.key-secret-cell { display: flex; align-items: center; gap: var(--sp-2); white-space: nowrap; }
.key-secret-cell code { color: hsl(var(--muted-foreground)); font-size: 12px; letter-spacing: .02em; }
.key-copy-button, .key-icon-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border-radius: var(--radius);
  color: hsl(var(--muted-foreground));
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.key-copy-button:hover, .key-icon-button:hover, .key-icon-button[aria-expanded="true"] { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }
.key-copy-button svg, .key-icon-button svg, .key-action-menu svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.key-icon-button.danger-action { color: hsl(var(--destructive)); }
.key-icon-button.danger-action:hover { background: hsl(var(--destructive) / .08); }
.key-scope, .key-last-used { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: hsl(var(--muted-foreground)); font-size: 12px; }
.key-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 2px; }

.key-action-menu {
  position: fixed; z-index: 50;
  width: 188px; padding: 4px;
  background: hsl(var(--popover));
  border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) + 2px);
  box-shadow: 0 8px 24px -4px rgb(0 0 0 / .12), 0 2px 8px -2px rgb(0 0 0 / .08);
}
.key-action-menu button {
  width: 100%; height: 30px;
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 0 var(--sp-2);
  border-radius: var(--radius);
  font-size: 13px; font-weight: 500; text-align: left;
  transition: background-color .12s ease;
}
.key-action-menu button:hover { background: hsl(var(--accent)); }
.key-action-menu button.danger-text { margin-top: 4px; padding-top: 0; border-top: 1px solid hsl(var(--border)); border-radius: 0 0 var(--radius) var(--radius); height: 34px; }
.key-action-menu button.danger-text:hover { background: hsl(var(--destructive) / .08); }

.agent-scope {
  max-height: 168px; overflow: auto;
  display: grid; gap: 2px;
  padding: var(--sp-2);
  margin-bottom: var(--sp-4);
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--muted) / .4);
}
.agent-scope .checkbox { height: 28px; padding: 0 var(--sp-2); border-radius: var(--radius); }
.agent-scope .checkbox:hover { background: hsl(var(--accent)); }
.secret-box { display: grid; gap: var(--sp-3); }
.secret-value {
  display: block; padding: var(--sp-3);
  background: hsl(var(--muted) / .5);
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

/* ── Drawer ───────────────────────────────────────────────────────── */
.drawer-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / .4); z-index: 40; animation: fadeIn .15s ease; }
.drawer {
  position: fixed; inset: 0 0 0 auto;
  width: min(480px, 100vw);
  display: flex; flex-direction: column;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
  box-shadow: -8px 0 32px -8px rgb(0 0 0 / .15);
  z-index: 41;
  animation: slideInRight .2s ease;
  overflow: hidden;
}
.drawer-header {
  height: 52px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 var(--sp-4);
  border-bottom: 1px solid hsl(var(--border));
}
.drawer-header h2 { font-size: 14px; font-weight: 600; }
.drawer-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: var(--sp-4); }
.drawer-footer {
  flex: 0 0 auto;
  display: flex; justify-content: flex-end; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
  border-top: 1px solid hsl(var(--border));
  margin: 0;
  background: hsl(var(--card));
}
@keyframes fadeIn { from { opacity: 0; } }
@keyframes slideInRight { from { transform: translateX(24px); opacity: 0; } }

/* ── Settings ─────────────────────────────────────────────────────── */
.settings-layout { max-width: 680px; }
.settings-form .panel-header { min-height: 0; padding: var(--sp-4); align-items: flex-start; }
.settings-form .panel-header h2 { font-size: 14px; }
.settings-subtitle { margin-top: 4px; color: hsl(var(--muted-foreground)); font-size: 12px; }
.settings-fields { display: grid; gap: 0; padding: var(--sp-4); }
.settings-fields .field input { max-width: 240px; }
.settings-divider { height: 1px; background: hsl(var(--border)); }
.settings-note {
  display: grid; gap: 4px;
  margin: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  background: hsl(var(--muted) / .5);
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  color: hsl(var(--muted-foreground));
  font-size: 12px; line-height: 1.6;
}
.settings-note strong { color: hsl(var(--foreground)); font-size: 13px; font-weight: 600; }
.settings-actions { display: flex; justify-content: flex-end; padding: 0 var(--sp-4) var(--sp-4); }

/* ── Toast ────────────────────────────────────────────────────────── */
.toast-region {
  position: fixed; right: var(--sp-6); bottom: var(--sp-6);
  z-index: 60;
  display: grid; gap: var(--sp-2);
  max-width: 360px;
}
.toast {
  padding: var(--sp-3) var(--sp-4);
  background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  border-radius: var(--radius);
  box-shadow: 0 8px 24px -4px rgb(0 0 0 / .18);
  font-size: 13px; font-weight: 500; line-height: 1.5;
  animation: slideInUp .2s ease;
}
.toast.error { background: hsl(var(--destructive)); color: hsl(var(--destructive-foreground)); }
@keyframes slideInUp { from { opacity: 0; transform: translateY(8px); } }

/* ── Responsive ───────────────────────────────────────────────────── */
@media (max-width: 860px) {
  :root { --sidebar-width: 56px; }
  .brand span:last-child, .nav-item span, .admin-button span { display: none; }
  .brand, .nav-item, .admin-button { justify-content: center; }
  .admin-popover { left: 0; right: auto; width: 200px; }
}
@media (max-width: 640px) {
  .page-lede { padding: var(--sp-4) var(--sp-4) 0; }
  .page-content { padding: var(--sp-3) var(--sp-4) var(--sp-4); }
  .topbar { padding: 0 var(--sp-4); }
  .search-box { max-width: none; }
  .stats { grid-template-columns: 1fr; }
  .run-summary { grid-template-columns: repeat(2, 1fr); }
  .run-live-grid { grid-template-columns: 1fr; }
  .toolbar input[type="search"], .toolbar select { max-width: none; width: 100%; }
  .field-row { grid-template-columns: 1fr; }
  .drawer { width: 100vw; }
  .run-detail-grid { grid-template-columns: 1fr; }
  .toast-region { right: var(--sp-4); bottom: var(--sp-4); left: var(--sp-4); max-width: none; }
}
`
