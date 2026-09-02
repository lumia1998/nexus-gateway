import { icons } from './icons.js'

export const markup = String.raw`
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
      <button class="nav-item active" data-page="overview">${icons.overview}<span>总览</span></button>
      <button class="nav-item" data-page="runs">${icons.runs}<span>运行记录</span></button>
      <button class="nav-item" data-page="agents">${icons.agents}<span>智能体</span></button>
      <button class="nav-item" data-page="workspaces">${icons.workspaces}<span>工作区</span></button>
      <button class="nav-item" data-page="keys">${icons.keys}<span>API 密钥</span></button>
      <button class="nav-item" data-page="settings">${icons.settings}<span>运行设置</span></button>
    </nav>
    <div class="admin-menu-wrap">
      <div id="admin-popover" class="admin-popover hidden">
        <div class="field"><label for="theme-select">界面主题</label>
          <select id="theme-select">
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <button id="change-password" class="menu-button">修改密码</button>
        <button id="logout" class="menu-button danger-text">退出登录</button>
      </div>
      <button id="admin-menu" class="admin-button" aria-expanded="false">
        <span class="avatar">A</span>
        <span class="admin-meta"><strong>管理员</strong></span>
      </button>
    </div>
  </aside>
  <main class="main">
    <header class="topbar">
      <h1 id="page-title"></h1>
      <div id="page-actions" class="page-actions"></div>
    </header>
    <section id="page-content" class="page-content" aria-live="polite"></section>
  </main>
</div>

<div id="drawer-backdrop" class="drawer-backdrop hidden"></div>
<aside id="drawer" class="drawer hidden" aria-modal="true" role="dialog">
  <div class="drawer-header"><h2 id="drawer-title"></h2><button id="drawer-close" class="icon-button" aria-label="关闭">${icons.close}</button></div>
  <form id="drawer-form" class="drawer-body"></form>
  <div id="drawer-footer" class="drawer-footer"></div>
</aside>
<div id="toast-region" class="toast-region" aria-live="assertive"></div>
`
