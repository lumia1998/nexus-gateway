export const styles = String.raw`
:root {
  color-scheme: light;
  --bg: #fafafa;
  --surface: #ffffff;
  --surface-subtle: #f8f9fa;
  --surface-hover: #f1f3f5;
  --text: #09090b;
  --text-muted: #71717a;
  --text-faint: #a1a1aa;
  --border: #e4e4e7;
  --border-strong: #d4d4d8;
  --accent: #18181b;
  --accent-hover: #27272a;
  --accent-soft: #f4f4f5;
  --accent-text: #fafafa;
  --success: #16a34a;
  --success-soft: #f0fdf4;
  --danger: #dc2626;
  --danger-soft: #fef2f2;
  --warning: #f59e0b;
  --warning-soft: #fffbeb;
  --info: #3b82f6;
  --info-soft: #eff6ff;
  --focus: #18181b;
  --overlay: rgba(9, 9, 11, .5);
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --radius: 6px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --sidebar-width: 240px;
}

html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #09090b;
  --surface: #18181b;
  --surface-subtle: #27272a;
  --surface-hover: #3f3f46;
  --text: #fafafa;
  --text-muted: #a1a1aa;
  --text-faint: #71717a;
  --border: #27272a;
  --border-strong: #3f3f46;
  --accent: #fafafa;
  --accent-hover: #e4e4e7;
  --accent-soft: #27272a;
  --accent-text: #09090b;
  --success: #22c55e;
  --success-soft: #14532d;
  --danger: #ef4444;
  --danger-soft: #450a0a;
  --warning: #fbbf24;
  --warning-soft: #451a03;
  --info: #60a5fa;
  --info-soft: #172554;
  --focus: #fafafa;
  --overlay: rgba(0, 0, 0, .7);
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.3);
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.4), 0 1px 2px -1px rgb(0 0 0 / 0.4);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.4);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.4), 0 4px 6px -4px rgb(0 0 0 / 0.4);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { min-height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; }
body { font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
button, input, select, textarea { font: inherit; border: none; outline: none; }
button { color: inherit; cursor: pointer; background: none; }
.hidden { display: none !important; }

/* Transitions */
* { transition-property: color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }

/* Auth Screens */
.auth-screen { min-height: 100vh; display: grid; place-items: center; padding: 32px; background: var(--bg); }
.auth-card { width: min(420px, 100%); padding: 32px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); }
.auth-card h1 { margin: 24px 0 8px; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; line-height: 1.2; }
.auth-card p { color: var(--text-muted); margin: 0 0 24px; font-size: 14px; line-height: 1.5; }
.brand-mark { width: 48px; height: 48px; border-radius: var(--radius-md); display: grid; place-items: center; background: var(--accent); color: var(--accent-text); font-weight: 700; font-size: 20px; letter-spacing: -0.02em; box-shadow: var(--shadow); }
.brand-mark.small { width: 32px; height: 32px; border-radius: var(--radius); font-size: 16px; font-weight: 600; }

/* Form Elements */
label { display: grid; gap: 8px; margin-bottom: 20px; color: var(--text); font-size: 14px; font-weight: 500; line-height: 1.4; }
input, select, textarea { width: 100%; min-height: 40px; padding: 10px 12px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); outline: none; font-size: 14px; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
textarea { min-height: 100px; resize: vertical; line-height: 1.5; }
input:hover, select:hover, textarea:hover { border-color: var(--border-strong); }
input:focus, select:focus, textarea:focus { border-color: var(--focus); box-shadow: 0 0 0 3px var(--accent-soft); }
input:disabled, select:disabled, textarea:disabled { opacity: 0.5; cursor: not-allowed; }
.form-error { min-height: 20px; margin: 16px 0 0 !important; color: var(--danger) !important; font-size: 13px; font-weight: 500; }

/* App Shell & Sidebar */
.app-shell { min-height: 100vh; display: flex; }
.sidebar { position: fixed; inset: 0 auto 0 0; width: var(--sidebar-width); padding: 20px 16px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; z-index: 10; box-shadow: var(--shadow-sm); }
.brand { display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 12px; font-weight: 600; font-size: 15px; letter-spacing: -0.01em; color: var(--text); margin-bottom: 8px; }
nav { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.nav-item, .admin-button, .menu-button { border: 0; background: transparent; cursor: pointer; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.nav-item { width: 100%; min-height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 12px; border-radius: var(--radius); color: var(--text-muted); text-align: left; font-size: 14px; font-weight: 500; }
.nav-item:hover { background: var(--surface-hover); color: var(--text); }
.nav-item.active { background: var(--accent); color: var(--accent-text); font-weight: 600; }
.nav-item svg, .admin-button svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
.admin-menu-wrap { position: relative; margin-top: auto; }
.admin-button { width: 100%; display: flex; gap: 12px; align-items: center; padding: 12px; border-radius: var(--radius-md); text-align: left; }
.admin-button:hover { background: var(--surface-hover); }
.admin-button span { display: grid; gap: 2px; min-width: 0; }
.admin-button strong { font-size: 14px; font-weight: 600; }
.admin-button small { color: var(--text-muted); font-size: 12px; }
.admin-popover { position: absolute; inset: auto 0 calc(100% + 12px); padding: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); z-index: 20; }
.admin-popover label { margin: 0 0 8px; font-size: 13px; }
.menu-button { width: 100%; padding: 10px 12px; border-radius: var(--radius); text-align: left; font-size: 14px; font-weight: 500; }
.menu-button:hover { background: var(--surface-hover); }
.danger-text { color: var(--danger); }

/* Main Content */
.main { margin-left: var(--sidebar-width); min-height: 100vh; padding: 40px 0 80px; background: var(--bg); }
.page-header { min-height: 72px; display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; margin-bottom: 32px; padding: 0 clamp(32px, 5vw, 80px); max-width: 1600px; margin-left: auto; margin-right: auto; }
.page-header h1 { margin: 0; font-size: 30px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.2; }
.page-header p { margin: 8px 0 0; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
.page-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.page-content { max-width: 1600px; padding: 0 clamp(32px, 5vw, 80px); margin: 0 auto; }
/* Buttons */
.button, .icon-button {
  min-height: 40px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font-weight: 500;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--shadow-sm);
}
.button { padding: 0 16px; }
.button:hover:not(:disabled), .icon-button:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--border-strong); transform: translateY(-1px); box-shadow: var(--shadow); }
.button:active:not(:disabled), .icon-button:active:not(:disabled) { transform: translateY(0); }
.button:disabled, .icon-button:disabled { opacity: 0.5; cursor: not-allowed; }
.button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
.button.danger { border-color: var(--danger); color: var(--danger); background: var(--surface); }
.button.danger:hover:not(:disabled) { background: var(--danger-soft); }
.button.ghost { border-color: transparent; background: transparent; box-shadow: none; }
.button.ghost:hover:not(:disabled) { background: var(--surface-hover); box-shadow: none; }
.button.small { min-height: 32px; padding: 0 12px; font-size: 13px; }
.icon-button { width: 40px; padding: 0; font-size: 20px; line-height: 1; }

/* Stats & Panels */
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 32px; }
.stat, .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); }
.stat { padding: 20px 24px; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.stat:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
.stat span { display: block; color: var(--text-muted); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.stat strong { display: block; margin-top: 12px; font-size: 32px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
.panel-header { min-height: 64px; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.panel-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.panel-body { padding: 24px; }
.empty { padding: 48px 24px; color: var(--text-muted); text-align: center; font-size: 14px; }

/* Toolbar & Tables */
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.toolbar input { max-width: 320px; flex: 1; min-width: 200px; }
.toolbar select { width: 180px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--shadow-sm); }
table { width: 100%; border-collapse: collapse; min-width: 800px; }
th, td { padding: 16px 20px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
th { color: var(--text-muted); background: var(--surface-subtle); font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; white-space: nowrap; }
tbody tr { transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1); }
tbody tr:hover { background: var(--surface-hover); }
tr:last-child td { border-bottom: 0; }
.agent-name { display: grid; gap: 4px; }
.agent-name strong { font-size: 14px; font-weight: 600; }
.agent-name small, .muted { color: var(--text-muted); font-size: 13px; }
/* Status Badges */
.status { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 9999px; background: var(--surface-subtle); }
.status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
.status.ready { color: var(--success); background: var(--success-soft); }
.status.ready::before { background: var(--success); }
.status.checking { color: var(--text-muted); }
.status.checking::before { background: var(--text-faint); animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
.status.failed { color: var(--danger); background: var(--danger-soft); }
.status.failed::before { background: var(--danger); }
.status.running { color: var(--info); background: var(--info-soft); }
.status.running::before { background: var(--info); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2); animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
.status.waiting { color: var(--warning); background: var(--warning-soft); }
.status.waiting::before { background: var(--warning); }
.status.completed { color: var(--success); background: var(--success-soft); }
.status.completed::before { background: var(--success); }
.status.canceled { color: var(--text-muted); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.badge { display: inline-flex; padding: 4px 10px; border-radius: 6px; background: var(--surface-subtle); color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; border: 1px solid var(--border); }
.row-actions { display: flex; justify-content: flex-end; gap: 8px; }
.error-detail { max-width: 300px; color: var(--danger); font-size: 13px; overflow-wrap: anywhere; margin-top: 4px; line-height: 1.4; }

/* Run Cards & Summary */
.run-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
.run-summary-item { min-height: 88px; padding: 20px 24px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.run-summary-item:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
.run-summary-item span { display: block; color: var(--text-muted); font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
.run-summary-item strong { display: block; margin-top: 8px; font: 700 28px/1 ui-monospace, "SF Mono", Consolas, monospace; letter-spacing: -0.02em; }
.run-section { margin-top: 32px; }
.run-section-title { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 16px; }
.run-section-title h2 { margin: 0; font-size: 18px; font-weight: 600; }
.run-section-title span { color: var(--text-muted); font-size: 14px; font-weight: 500; }
.run-live-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.run-card { position: relative; min-height: 160px; padding: 20px 24px; border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); box-shadow: var(--shadow-sm); }
.run-card:hover { border-color: var(--border-strong); border-left-color: var(--accent); box-shadow: var(--shadow-md); transform: translateY(-2px); }
.run-card.waiting { border-left-color: var(--warning); }
.run-card-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.run-card-agent { display: flex; align-items: center; gap: 10px; min-width: 0; }
.run-card-agent strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 14px; }
.run-task { margin: 0 0 20px; display: -webkit-box; overflow: hidden; color: var(--text); font-size: 14px; line-height: 1.6; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: pre-wrap; }
.run-progress { display: grid; gap: 6px; }
.run-progress strong { font-size: 13px; font-weight: 600; }
.run-progress small { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.run-meta { margin-top: 16px; display: flex; align-items: center; justify-content: space-between; color: var(--text-muted); font: 12px/1.4 ui-monospace, "SF Mono", Consolas, monospace; }
.run-table { min-width: 1000px; }
.run-table tbody tr { cursor: pointer; }
.run-table tbody tr:hover td { background: var(--surface-hover); }
.run-table .run-task-cell { max-width: 400px; }
.run-table .run-task-cell strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 14px; }
.run-table .run-task-cell small { display: block; margin-top: 4px; color: var(--text-muted); font-size: 12px; }
/* Run Details */
.run-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin-bottom: 24px; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--border); }
.run-detail-item { padding: 16px 20px; background: var(--surface); }
.run-detail-item:nth-child(odd) { border-right: 1px solid var(--border); }
.run-detail-item span { display: block; color: var(--text-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.run-detail-item strong { display: block; margin-top: 8px; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.run-detail-block { margin: 0 0 24px; }
.run-detail-block h3 { margin: 0 0 12px; color: var(--text-muted); font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
.run-detail-code { margin: 0; padding: 16px 20px; max-height: 400px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-subtle); color: var(--text); font: 13px/1.6 ui-monospace, "SF Mono", Consolas, monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
.run-id { font-family: ui-monospace, "SF Mono", Consolas, monospace; }

/* API Keys */
.key-table { min-width: 1000px; }
.key-table th:nth-child(1) { width: 22%; }
.key-table th:nth-child(2) { width: 12%; }
.key-table th:nth-child(3) { width: 18%; }
.key-table th:nth-child(4) { width: 18%; }
.key-table th:nth-child(5) { width: 18%; }
.key-table td { height: 72px; vertical-align: middle; }
.key-actions-heading { text-align: right; }
.key-secret-cell { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.key-secret-cell code { font-family: ui-monospace, "SF Mono", Consolas, monospace; color: var(--text-muted); letter-spacing: 0.02em; font-size: 13px; }
.key-copy-button, .key-icon-button { display: inline-grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: var(--radius); background: transparent; color: var(--text-muted); cursor: pointer; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.key-copy-button { width: 32px; height: 32px; }
.key-copy-button:hover, .key-icon-button:hover, .key-icon-button[aria-expanded="true"] { color: var(--text); background: var(--surface-hover); }
.key-copy-button svg, .key-icon-button svg, .key-action-menu svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.key-icon-button.danger-action { color: var(--danger); }
.key-icon-button.danger-action:hover { background: var(--danger-soft); }
.key-scope, .key-last-used { color: var(--text-muted); font-size: 13px; }
.key-actions-cell { text-align: right; }
.key-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; }
.key-action-menu { position: fixed; z-index: 50; width: 200px; padding: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); }
.key-action-menu button { width: 100%; min-height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 12px; border: 0; border-radius: var(--radius); background: transparent; color: var(--text); cursor: pointer; text-align: left; font-size: 14px; font-weight: 500; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.key-action-menu button:hover { background: var(--surface-hover); }
.key-action-menu button.danger-text { color: var(--danger); border-top: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); margin-top: 8px; padding-top: 8px; min-height: 44px; }
.key-action-menu button.danger-text:hover { background: var(--danger-soft); }

/* Lists & Cards */
.workspace-list, .key-list, .overview-list { display: grid; gap: 12px; }
.list-row { min-height: 64px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 20px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); box-shadow: var(--shadow-sm); }
.list-row:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
.list-row-main { min-width: 0; display: grid; gap: 6px; }
.list-row-main strong, .path { overflow-wrap: anywhere; font-weight: 600; font-size: 14px; }
.list-row-main small { color: var(--text-muted); font-size: 13px; }
.tip { margin-top: 20px; padding: 16px 20px; background: var(--surface-subtle); border-radius: var(--radius-md); border: 1px solid var(--border); color: var(--text-muted); font-size: 13px; line-height: 1.5; }

/* Drawer */
.drawer-backdrop { position: fixed; inset: 0; background: var(--overlay); z-index: 40; backdrop-filter: blur(4px); animation: fadeIn 200ms cubic-bezier(0.4, 0, 0.2, 1); }
.drawer { position: fixed; inset: 0 0 0 auto; width: min(520px, 100vw); background: var(--surface); border-left: 1px solid var(--border); z-index: 41; display: flex; flex-direction: column; box-shadow: var(--shadow-lg); animation: slideInRight 250ms cubic-bezier(0.4, 0, 0.2, 1); }
.drawer-header { min-height: 72px; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.drawer-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
.drawer-body { padding: 24px; overflow-y: auto; flex: 1; }
.drawer-footer { display: flex; justify-content: flex-end; gap: 12px; padding-top: 24px; margin-top: auto; border-top: 1px solid var(--border); }
.field-help { margin-top: 4px; color: var(--text-muted); font-size: 13px; font-weight: 400; line-height: 1.5; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
/* Settings */
.settings-layout { display: grid; grid-template-columns: minmax(0, 800px); }
.settings-form { overflow: hidden; border-radius: var(--radius-md); }
.settings-form .panel-header { align-items: flex-start; padding-top: 20px; padding-bottom: 20px; }
.settings-form .panel-header h2 { font-size: 18px; font-weight: 600; }
.settings-subtitle { margin: 6px 0 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
.settings-fields { display: grid; gap: 24px; padding: 24px; }
.settings-fields label { gap: 8px; }
.settings-fields input { max-width: 280px; }
.settings-divider { height: 1px; margin: 24px 0; background: var(--border); }
.settings-note { display: grid; gap: 8px; margin: 24px; padding: 16px 20px; border-radius: var(--radius-md); background: var(--surface-subtle); border: 1px solid var(--border); color: var(--text-muted); font-size: 13px; line-height: 1.5; }
.settings-note strong { color: var(--text); font-size: 14px; font-weight: 600; }
.settings-actions { display: flex; justify-content: flex-end; padding: 0 24px 24px; }
.checkbox { display: flex; align-items: center; gap: 10px; min-height: 40px; cursor: pointer; }
.checkbox input { width: 18px; min-height: 18px; cursor: pointer; accent-color: var(--accent); }
.agent-scope { max-height: 200px; overflow: auto; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-subtle); }
.secret-box { margin: 16px 0; padding: 16px 20px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: var(--radius-md); }
.secret-value { display: block; margin: 12px 0; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow-wrap: anywhere; font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; }

/* Toast */
.toast-region { position: fixed; right: 24px; bottom: 24px; z-index: 60; display: grid; gap: 12px; max-width: 420px; }
.toast { padding: 16px 20px; background: var(--accent); color: var(--accent-text); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); font-size: 14px; font-weight: 500; line-height: 1.5; animation: slideInUp 250ms cubic-bezier(0.4, 0, 0.2, 1); }
.toast.error { background: var(--danger); color: #ffffff; }
@keyframes slideInUp { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: translateY(0); } }

/* Responsive */
@media (max-width: 768px) {
  :root { --sidebar-width: 80px; }
  .brand span:last-child, .nav-item span, .admin-button span { display: none; }
  .brand { justify-content: center; padding: 0; }
  .nav-item, .admin-button { justify-content: center; padding: 0 8px; }
  .main { padding: 24px 16px 48px; }
  .page-header { flex-direction: column; gap: 16px; }
  .page-header h1 { font-size: 24px; }
  .page-actions { width: 100%; }
  .stats { grid-template-columns: 1fr; }
  .run-summary { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .run-live-grid { grid-template-columns: 1fr; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar input, .toolbar select { max-width: none; width: 100%; }
  .admin-popover { left: 0; right: auto; width: 200px; }
  .drawer { width: 100vw; }
  .field-row { grid-template-columns: 1fr; }
}

@media (max-width: 480px) {
  .run-summary { grid-template-columns: 1fr; }
  .page-header h1 { font-size: 20px; }
  .stat strong { font-size: 24px; }
}
`
