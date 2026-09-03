import { icons } from './icons.js'

export const markup = String.raw`
<div id="boot-screen" class="auth-screen"><p role="status">正在加载控制台…</p></div>
<div id="setup-screen" class="auth-screen hidden">
  <form id="setup-form" class="auth-card">
    <header><span class="brand-mark">N</span><h1>初始化 Agent Nexus</h1></header>
    <p>此密码仅用于登录控制台；客户端 API 密钥在登录后单独创建。</p>
    <div class="field"><label for="setup-password">控制台密码</label><input id="setup-password" name="password" type="password" minlength="12" autocomplete="new-password" required></div>
    <div class="field"><label for="setup-confirm">确认密码</label><input id="setup-confirm" name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required></div>
    <button class="button primary auth-submit" type="submit">完成初始化</button>
    <p class="form-error" data-form-error></p>
  </form>
</div>

<div id="login-screen" class="auth-screen hidden">
  <form id="login-form" class="auth-card">
    <header><span class="brand-mark">N</span><h1>Agent Nexus</h1></header>
    <div class="field"><label for="login-password">控制台密码</label><input id="login-password" name="password" type="password" autocomplete="current-password" required autofocus></div>
    <button class="button primary auth-submit" type="submit">登录</button>
    <p class="form-error" data-form-error></p>
  </form>
</div>

<div id="app" class="app-shell hidden">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark">N</span><span>Agent Nexus</span></div>
    <nav aria-label="主导航">
      <div class="nav-group" role="group" aria-labelledby="nav-group-run">
        <p class="nav-group-label" id="nav-group-run">运行</p>
        <button class="nav-item active" data-page="overview">${icons.overview}<span>总览</span></button>
        <button class="nav-item" data-page="runs">${icons.runs}<span>运行记录</span></button>
      </div>
      <div class="nav-group" role="group" aria-labelledby="nav-group-config">
        <p class="nav-group-label" id="nav-group-config">网关配置</p>
        <button class="nav-item" data-page="agents">${icons.agents}<span>智能体</span></button>
        <button class="nav-item" data-page="workspaces">${icons.workspaces}<span>工作区</span></button>
        <button class="nav-item" data-page="keys">${icons.keys}<span>API 密钥</span></button>
      </div>
      <div class="nav-group nav-group-footer">
        <button class="nav-item" data-page="settings">${icons.settings}<span>设置</span></button>
        <button class="nav-item nav-item-danger" data-action="logout">${icons.logout}<span>退出登录</span></button>
      </div>
    </nav>
  </aside>
  <main class="main">
    <header class="topbar">
      <h1 id="page-title"></h1>
      <div id="page-actions" class="page-actions"></div>
    </header>
    <section id="page-content" class="page-content">
      <div id="page-stats"></div>
      <div id="page-toolbar"></div>
      <div id="page-results"></div>
    </section>
    <p id="page-status" class="visually-hidden" role="status" aria-atomic="true"></p>
  </main>
</div>

<div id="drawer-backdrop" class="drawer-backdrop hidden"></div>
<aside id="drawer" class="drawer hidden" aria-modal="true" role="dialog" aria-labelledby="drawer-title" tabindex="-1">
  <div class="drawer-header"><h2 id="drawer-title"></h2><button id="drawer-close" class="icon-button" aria-label="关闭">${icons.close}</button></div>
  <form id="drawer-form" class="drawer-body"></form>
  <div id="drawer-footer" class="drawer-footer"></div>
</aside>
<div id="notifications" class="toast-region">
  <div id="toast-status" role="status" aria-live="polite" aria-relevant="additions"></div>
  <div id="toast-alert" role="alert" aria-live="assertive" aria-relevant="additions"></div>
</div>
`
