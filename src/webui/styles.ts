export const styles = String.raw`
:root {
  color-scheme: light;
  --bg: #f7f7f8;
  --surface: #ffffff;
  --surface-subtle: #f1f1f3;
  --surface-hover: #ebebee;
  --text: #17171a;
  --text-muted: #696970;
  --text-faint: #929299;
  --border: #ddddE2;
  --border-strong: #c7c7cd;
  --accent: #6d5dfc;
  --accent-soft: #eeeafe;
  --accent-text: #ffffff;
  --success: #18864b;
  --success-soft: #e8f5ed;
  --danger: #c93636;
  --danger-soft: #fceaea;
  --focus: #6d5dfc;
  --overlay: rgba(18, 18, 20, .42);
  --radius: 8px;
  --radius-small: 6px;
  --sidebar-width: 232px;
}

html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111113;
  --surface: #19191c;
  --surface-subtle: #222226;
  --surface-hover: #29292e;
  --text: #f3f3f4;
  --text-muted: #a3a3aa;
  --text-faint: #777780;
  --border: #303036;
  --border-strong: #44444c;
  --accent: #8b7cff;
  --accent-soft: #292447;
  --accent-text: #ffffff;
  --success: #48bd79;
  --success-soft: #173525;
  --danger: #f06a6a;
  --danger-soft: #402020;
  --focus: #8b7cff;
  --overlay: rgba(0, 0, 0, .62);
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font-family: "Noto Sans SC", "Microsoft YaHei UI", "PingFang SC", "Hiragino Sans GB", ui-sans-serif, sans-serif; }
body { font-size: 14px; line-height: 1.45; }
button, input, select, textarea { font: inherit; }
button { color: inherit; }
.hidden { display: none !important; }

.auth-screen { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.auth-card { width: min(400px, 100%); padding: 28px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.auth-card h1 { margin: 18px 0 6px; font-size: 22px; letter-spacing: -.02em; }
.auth-card p { color: var(--text-muted); margin: 0 0 22px; }
.brand-mark { width: 38px; height: 38px; border-radius: 9px; display: grid; place-items: center; background: var(--text); color: var(--surface); font-weight: 750; font-size: 18px; }
.brand-mark.small { width: 28px; height: 28px; border-radius: 7px; font-size: 14px; }

label { display: grid; gap: 7px; margin-bottom: 16px; color: var(--text-muted); font-size: 13px; font-weight: 600; }
input, select, textarea { width: 100%; min-height: 38px; padding: 8px 10px; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-small); outline: none; }
textarea { min-height: 90px; resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible { border-color: var(--focus); outline: 2px solid var(--accent-soft); outline-offset: 1px; }
.form-error { min-height: 20px; margin: 12px 0 0 !important; color: var(--danger) !important; }

.app-shell { min-height: 100vh; }
.sidebar { position: fixed; inset: 0 auto 0 0; width: var(--sidebar-width); padding: 16px 12px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; z-index: 10; }
.brand { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 8px; font-weight: 700; letter-spacing: -.01em; }
nav { display: grid; gap: 3px; margin-top: 18px; }
.nav-item, .admin-button, .menu-button { border: 0; background: transparent; cursor: pointer; }
.nav-item { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 10px; border-radius: var(--radius-small); color: var(--text-muted); text-align: left; }
.nav-item:hover { background: var(--surface-subtle); color: var(--text); }
.nav-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
.nav-item svg, .admin-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.admin-menu-wrap { position: relative; margin-top: auto; }
.admin-button { width: 100%; display: flex; gap: 10px; align-items: center; padding: 10px; border-radius: var(--radius); text-align: left; }
.admin-button:hover { background: var(--surface-subtle); }
.admin-button span { display: grid; min-width: 0; }
.admin-button strong { font-size: 13px; }
.admin-button small { color: var(--text-muted); }
.admin-popover { position: absolute; inset: auto 0 calc(100% + 8px); padding: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.admin-popover label { margin: 0 0 8px; }
.menu-button { width: 100%; padding: 9px 8px; border-radius: var(--radius-small); text-align: left; }
.menu-button:hover { background: var(--surface-subtle); }
.danger-text { color: var(--danger); }

.main { margin-left: var(--sidebar-width); min-height: 100vh; padding: 32px clamp(24px, 5vw, 68px) 64px; }
.page-header { min-height: 66px; display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
.page-header h1 { margin: 0; font-size: 24px; letter-spacing: -.025em; }
.page-header p { margin: 5px 0 0; color: var(--text-muted); }
.page-actions { display: flex; gap: 8px; align-items: center; }
.page-content { max-width: 1180px; }
.button, .icon-button { min-height: 36px; border: 1px solid var(--border-strong); border-radius: var(--radius-small); background: var(--surface); cursor: pointer; font-weight: 600; }
.button { padding: 0 13px; }
.button:hover, .icon-button:hover { background: var(--surface-hover); }
.button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.button.primary:hover { background: var(--accent); }
.button.danger { border-color: var(--danger); color: var(--danger); }
.button.ghost { border-color: transparent; background: transparent; }
.button.small { min-height: 30px; padding: 0 9px; font-size: 12px; }
.icon-button { width: 36px; padding: 0; font-size: 22px; }

.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 22px; }
.stat, .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.stat { padding: 16px; }
.stat span { display: block; color: var(--text-muted); font-size: 12px; font-weight: 650; }
.stat strong { display: block; margin-top: 7px; font-size: 25px; letter-spacing: -.03em; }
.panel-header { min-height: 52px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
.panel-header h2 { margin: 0; font-size: 14px; }
.panel-body { padding: 16px; }
.empty { padding: 36px 18px; color: var(--text-muted); text-align: center; }

.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.toolbar input { max-width: 300px; }
.toolbar select { width: 150px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
table { width: 100%; border-collapse: collapse; min-width: 760px; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
th { color: var(--text-muted); background: var(--surface-subtle); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
tr:last-child td { border-bottom: 0; }
.agent-name { display: grid; gap: 2px; }
.agent-name strong { font-size: 13px; }
.agent-name small, .muted { color: var(--text-muted); }
.status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; }
.status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
.status.ready { color: var(--success); }
.status.ready::before { background: var(--success); }
.status.checking { color: var(--text-muted); }
.status.checking::before { background: var(--text-faint); }
.status.failed { color: var(--danger); }
.status.failed::before { background: var(--danger); }
.status.running { color: #1d68b3; }
.status.running::before { background: #2b7ecb; box-shadow: 0 0 0 3px rgba(43, 126, 203, .13); }
.status.waiting { color: #9a6500; }
.status.waiting::before { background: #d49313; }
.status.completed { color: var(--success); }
.status.completed::before { background: var(--success); }
.status.canceled { color: var(--text-muted); }
.badge { display: inline-flex; padding: 3px 7px; border-radius: 999px; background: var(--surface-subtle); color: var(--text-muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.row-actions { display: flex; justify-content: flex-end; gap: 5px; }
.error-detail { max-width: 280px; color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }

.run-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-bottom: 16px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--border); }
.run-summary-item { min-height: 74px; padding: 13px 15px; background: var(--surface); }
.run-summary-item span { display: block; color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.run-summary-item strong { display: block; margin-top: 5px; font: 700 22px/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
.run-section { margin-top: 18px; }
.run-section-title { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 9px; }
.run-section-title h2 { margin: 0; font-size: 14px; }
.run-section-title span { color: var(--text-muted); font-size: 12px; }
.run-live-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.run-card { position: relative; min-height: 148px; padding: 14px 15px; border: 1px solid var(--border); border-left: 3px solid #2b7ecb; border-radius: var(--radius); background: var(--surface); cursor: pointer; }
.run-card:hover { border-color: var(--border-strong); border-left-color: var(--accent); }
.run-card.waiting { border-left-color: #d49313; }
.run-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.run-card-agent { display: flex; align-items: center; gap: 8px; min-width: 0; }
.run-card-agent strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-task { margin: 13px 0 15px; display: -webkit-box; overflow: hidden; color: var(--text); font-size: 13px; line-height: 1.55; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: pre-wrap; }
.run-progress { display: grid; gap: 3px; }
.run-progress strong { font-size: 12px; }
.run-progress small { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-meta { margin-top: 12px; display: flex; align-items: center; justify-content: space-between; color: var(--text-muted); font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
.run-table { min-width: 940px; }
.run-table tbody tr { cursor: pointer; }
.run-table tbody tr:hover td { background: var(--surface-hover); }
.run-table .run-task-cell { max-width: 360px; }
.run-table .run-task-cell strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.run-table .run-task-cell small { display: block; margin-top: 3px; color: var(--text-muted); }
.run-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin-bottom: 18px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.run-detail-item { padding: 11px 12px; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.run-detail-item:nth-child(odd) { border-right: 1px solid var(--border); }
.run-detail-item span { display: block; color: var(--text-muted); font-size: 11px; }
.run-detail-item strong { display: block; margin-top: 4px; font-size: 13px; overflow-wrap: anywhere; }
.run-detail-block { margin: 0 0 16px; }
.run-detail-block h3 { margin: 0 0 7px; color: var(--text-muted); font-size: 11px; letter-spacing: .05em; }
.run-detail-code { margin: 0; padding: 12px; max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-small); background: var(--surface-subtle); color: var(--text); font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
.run-id { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }

.key-table { min-width: 900px; }
.key-table th:nth-child(1) { width: 21%; }
.key-table th:nth-child(2) { width: 12%; }
.key-table th:nth-child(3) { width: 18%; }
.key-table th:nth-child(4) { width: 17%; }
.key-table th:nth-child(5) { width: 19%; }
.key-table td { height: 66px; }
.key-actions-heading { text-align: right; }
.key-secret-cell { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.key-secret-cell code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text-muted); letter-spacing: .02em; }
.key-copy-button, .key-icon-button { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-small); background: transparent; color: var(--text-muted); cursor: pointer; }
.key-copy-button { width: 28px; height: 28px; }
.key-copy-button:hover, .key-icon-button:hover, .key-icon-button[aria-expanded="true"] { color: var(--text); background: var(--surface-hover); }
.key-copy-button svg, .key-icon-button svg, .key-action-menu svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.key-icon-button.danger-action { color: var(--danger); }
.key-icon-button.danger-action:hover { background: var(--danger-soft); }
.key-scope, .key-last-used { color: var(--text-muted); font-size: 13px; }
.key-actions-cell { text-align: right; }
.key-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 3px; }
.key-action-menu { position: fixed; z-index: 45; width: 190px; padding: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.key-action-menu button { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 10px; border: 0; border-radius: var(--radius-small); background: transparent; color: var(--text); cursor: pointer; text-align: left; font-size: 13px; }
.key-action-menu button:hover { background: var(--surface-hover); }
.key-action-menu button.danger-text { color: var(--danger); border-top: 1px solid var(--border); border-radius: 0 0 var(--radius-small) var(--radius-small); margin-top: 4px; padding-top: 4px; min-height: 42px; }
.key-action-menu button.danger-text:hover { background: var(--danger-soft); }

.workspace-list, .key-list, .overview-list { display: grid; gap: 8px; }
.list-row { min-height: 58px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.list-row-main { min-width: 0; display: grid; gap: 3px; }
.list-row-main strong, .path { overflow-wrap: anywhere; }
.list-row-main small { color: var(--text-muted); }
.tip { margin-top: 14px; padding: 12px; background: var(--surface-subtle); border-radius: var(--radius-small); color: var(--text-muted); font-size: 12px; }

.drawer-backdrop { position: fixed; inset: 0; background: var(--overlay); z-index: 30; }
.drawer { position: fixed; inset: 0 0 0 auto; width: min(460px, 100vw); background: var(--surface); border-left: 1px solid var(--border); z-index: 31; display: flex; flex-direction: column; }
.drawer-header { min-height: 64px; padding: 0 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
.drawer-header h2 { margin: 0; font-size: 17px; }
.drawer-body { padding: 20px; overflow-y: auto; }
.drawer-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px; }
.field-help { margin-top: -2px; color: var(--text-muted); font-size: 12px; font-weight: 400; line-height: 1.5; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.settings-layout { display: grid; grid-template-columns: minmax(0, 760px); }
.settings-form { overflow: hidden; }
.settings-form .panel-header { align-items: flex-start; padding-top: 16px; padding-bottom: 14px; }
.settings-form .panel-header h2 { font-size: 16px; }
.settings-subtitle { margin: 5px 0 0; color: var(--text-muted); font-size: 12px; }
.settings-fields { display: grid; gap: 18px; padding: 20px 16px 4px; }
.settings-fields label { gap: 7px; }
.settings-fields input { max-width: 260px; }
.settings-divider { height: 1px; margin: 18px 16px 0; background: var(--border); }
.settings-note { display: grid; gap: 4px; margin: 16px; padding: 12px; border-radius: var(--radius-small); background: var(--surface-subtle); color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.settings-note strong { color: var(--text); font-size: 13px; }
.settings-actions { display: flex; justify-content: flex-end; padding: 0 16px 16px; }
.checkbox { display: flex; align-items: center; gap: 8px; min-height: 34px; }
.checkbox input { width: 16px; min-height: 16px; }
.agent-scope { max-height: 170px; overflow: auto; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-small); }
.secret-box { margin: 12px 0; padding: 12px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: var(--radius); }
.secret-value { display: block; margin: 8px 0 10px; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }

.toast-region { position: fixed; right: 18px; bottom: 18px; z-index: 50; display: grid; gap: 8px; }
.toast { max-width: 380px; padding: 11px 13px; background: var(--text); color: var(--surface); border-radius: var(--radius-small); }
.toast.error { background: var(--danger); color: var(--accent-text); }

@media (max-width: 760px) {
  :root { --sidebar-width: 72px; }
  .brand span:last-child, .nav-item span, .admin-button span { display: none; }
  .brand { justify-content: center; }
  .nav-item, .admin-button { justify-content: center; }
  .main { padding: 24px 16px 48px; }
  .stats { grid-template-columns: 1fr; }
  .run-summary, .run-live-grid { grid-template-columns: 1fr; }
  .page-header { align-items: flex-start; }
  .toolbar { align-items: stretch; flex-direction: column; }
  .toolbar input, .toolbar select { max-width: none; width: 100%; }
  .admin-popover { left: 0; right: auto; width: 190px; }
}
`
