import { icons } from './icons.js'

export const markup = String.raw`
<div id="setup-screen" class="auth-screen hidden">
  <form id="setup-form" class="auth-card">
    <div class="brand-mark">N</div>
    <h1>初始化 Agent Nexus</h1>
    <p>创建仅用于后台管理的控制台密码。客户端 API 密钥将在登录后单独管理。</p>
    <label>控制台密码<input name="password" type="password" minlength="12" autocomplete="new-password" required></label>
    <label>确认密码<input name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required></label>
    <button class="button primary" type="submit">完成初始化</button>
    <p class="form-error" data-form-error></p>
  </form>
</div>

<div id="login-screen" class="auth-screen hidden">
  <form id="login-form" class="auth-card">
    <div class="brand-mark">N</div>
    <h1>Agent Nexus</h1>
    <p>登录后管理智能体、工作区和客户端 API 密钥。</p>
    <label>控制台密码<input name="password" type="password" autocomplete="current-password" required autofocus></label>
    <button class="button primary" type="submit">登录</button>
    <p class="form-error" data-form-error></p>
  </form>
</div>

<div id="app" class="app-shell hidden">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark small">N</span><span>Agent Nexus</span></div>
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
        <label>界面主题
          <select id="theme-select">
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <button id="change-password" class="menu-button">修改密码</button>
        <button id="logout" class="menu-button danger-text">退出登录</button>
      </div>
      <button id="admin-menu" class="admin-button" aria-expanded="false">${icons.settings}<span><strong>管理员</strong><small>控制台设置</small></span></button>
    </div>
  </aside>
  <main class="main">
    <header class="page-header">
      <div><h1 id="page-title"></h1><p id="page-description"></p></div>
      <div id="page-actions" class="page-actions"></div>
    </header>
    <section id="page-content" class="page-content" aria-live="polite"></section>
  </main>
</div>

<div id="drawer-backdrop" class="drawer-backdrop hidden"></div>
<aside id="drawer" class="drawer hidden" aria-modal="true" role="dialog">
  <div class="drawer-header"><h2 id="drawer-title"></h2><button id="drawer-close" class="icon-button" aria-label="关闭">×</button></div>
  <form id="drawer-form" class="drawer-body"></form>
</aside>
<div id="toast-region" class="toast-region" aria-live="assertive"></div>
`
