import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nexus Gateway</title>
  <script nonce="__NONCE__">
    (function () {
      try {
        var saved = localStorage.getItem('nexus-agentd-theme');
        document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      } catch (_) {
        document.documentElement.dataset.theme = 'dark';
      }
    })();
  </script>
  <style nonce="__NONCE__">
    :root {
      color-scheme: dark;
      --bg: #090b12;
      --sidebar: rgba(15, 18, 29, .92);
      --surface: rgba(21, 25, 39, .72);
      --surface-hi: rgba(29, 34, 52, .82);
      --surface-soft: rgba(255, 255, 255, .035);
      --line: rgba(163, 174, 216, .12);
      --line-hi: rgba(166, 139, 255, .28);
      --ink: #f1f2f8;
      --muted: #8f96aa;
      --violet: #8b5cf6;
      --violet-hi: #a78bfa;
      --violet-soft: rgba(139, 92, 246, .15);
      --cyan: #5eead4;
      --green: #56e39f;
      --red: #ff7185;
      --amber: #f8c66d;
      --shadow: 0 24px 70px rgba(0, 0, 0, .36);
      --radius: 14px;
      font-family: Aptos, "Microsoft YaHei UI", "Segoe UI", sans-serif;
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #f2f3f8;
      --sidebar: rgba(251, 251, 254, .94);
      --surface: rgba(255, 255, 255, .9);
      --surface-hi: rgba(249, 249, 253, .98);
      --surface-soft: rgba(80, 67, 145, .045);
      --line: rgba(44, 47, 66, .1);
      --line-hi: rgba(109, 76, 225, .24);
      --ink: #202231;
      --muted: #73798c;
      --violet: #7351e8;
      --violet-hi: #6641dc;
      --violet-soft: rgba(115, 81, 232, .11);
      --cyan: #2fb5a5;
      --green: #16865a;
      --red: #d94c63;
      --amber: #ad7415;
      --shadow: 0 24px 70px rgba(41, 40, 57, .12);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        radial-gradient(circle at 88% -8%, rgba(103, 76, 220, .18), transparent 34%),
        radial-gradient(circle at 30% 110%, rgba(46, 213, 200, .075), transparent 34%),
        var(--bg);
      background-attachment: fixed;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .16;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.18'/%3E%3C/svg%3E");
      mix-blend-mode: soft-light;
    }
    html[data-theme="light"] body {
      background:
        radial-gradient(circle at 88% -8%, rgba(115, 81, 232, .11), transparent 35%),
        radial-gradient(circle at 25% 110%, rgba(47, 181, 165, .07), transparent 34%),
        var(--bg);
    }
    html[data-theme="light"] body::before { opacity: .045; mix-blend-mode: multiply; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .shell {
      position: relative;
      display: grid;
      grid-template-columns: 230px minmax(0, 1fr);
      width: min(1460px, calc(100% - 32px));
      min-height: calc(100vh - 32px);
      margin: 16px auto;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(10, 13, 22, .66);
      box-shadow: var(--shadow);
      animation: shell-in .55s cubic-bezier(.2,.8,.2,1) both;
    }
    .sidebar {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - 34px);
      padding: 24px 16px 18px;
      border-right: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(24, 29, 45, .72), transparent 24%),
        var(--sidebar);
      backdrop-filter: blur(22px);
    }
    .sidebar::after {
      content: "";
      position: absolute;
      top: 0;
      right: -1px;
      width: 1px;
      height: 150px;
      background: linear-gradient(var(--violet), transparent);
      opacity: .6;
    }
    .brand { display: flex; align-items: center; gap: 11px; padding: 4px 8px 28px; }
    .brand-mark {
      position: relative;
      width: 26px;
      height: 26px;
      flex: 0 0 auto;
      filter: drop-shadow(0 0 14px rgba(139,92,246,.48));
    }
    .brand-mark::before, .brand-mark::after, .brand-mark span::before, .brand-mark span::after {
      content: "";
      position: absolute;
      width: 9px;
      height: 9px;
      border-radius: 3px;
      transform: rotate(45deg);
      background: linear-gradient(135deg, var(--violet-hi), #6550e8);
    }
    .brand-mark::before { left: 1px; top: 2px; }
    .brand-mark::after { right: 1px; bottom: 2px; }
    .brand-mark span::before { right: 1px; top: 2px; background: linear-gradient(135deg, var(--cyan), #6b72f1); }
    .brand-mark span::after { left: 1px; bottom: 2px; background: linear-gradient(135deg, #db7cff, var(--violet)); }
    .brand-name { font-family: Bahnschrift, Aptos, sans-serif; font-weight: 720; letter-spacing: -.025em; }
    .brand-version { display: block; color: var(--muted); font: 9px "Cascadia Code", Consolas, monospace; letter-spacing: .12em; margin-top: 2px; }
    .nav-label, .eyebrow, .label, .metric-label, .agent-id {
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .nav-label { color: #646c83; font-size: 9px; padding: 0 11px 8px; }
    .nav { display: grid; gap: 5px; }
    .nav-button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 11px;
      border: 0;
      border-radius: 9px;
      padding: 10px 11px;
      color: #a7aec2;
      background: transparent;
      text-align: left;
      font-size: 13px;
      transition: color .18s, background .18s, transform .18s;
    }
    .nav-button:hover { color: #fff; background: rgba(255,255,255,.045); transform: translateX(2px); }
    .nav-button.active { color: #fff; background: linear-gradient(90deg, rgba(119,83,222,.3), rgba(119,83,222,.1)); box-shadow: inset 2px 0 var(--violet-hi); }
    .nav-icon {
      display: grid;
      place-items: center;
      width: 19px;
      height: 19px;
      color: currentColor;
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 14px;
    }
    .sidebar-foot {
      margin: auto -16px -18px;
      padding: 16px 16px 18px;
      border-top: 1px solid var(--line);
      background: rgba(9, 12, 20, .18);
    }
    .operator { display: flex; align-items: center; gap: 10px; }
    .avatar { display: grid; place-items: center; width: 31px; height: 31px; border: 1px solid var(--line-hi); border-radius: 10px; color: #e8defe; background: var(--violet-soft); font: 700 11px Bahnschrift, sans-serif; }
    .avatar svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .operator-name { font-size: 11px; font-weight: 650; }
    .operator-state { display: flex; align-items: center; gap: 5px; color: var(--green); font-size: 9px; margin-top: 3px; }
    .operator-state::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
    .icon-button { display: grid; place-items: center; min-width: 36px; height: 36px; padding: 0; }
    .sidebar-settings {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      margin-left: auto;
      padding: 0;
      border: 0;
      border-radius: 8px;
      color: var(--muted);
      background: transparent;
      transition: color .18s, background .18s, transform .18s;
    }
    .sidebar-settings:hover { color: var(--ink); background: var(--surface-soft); transform: rotate(16deg); }
    .sidebar-settings svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; }
    .main { min-width: 0; padding: 0 28px 34px; }
    .topbar { display: flex; justify-content: flex-end; align-items: center; gap: 9px; min-height: 76px; border-bottom: 1px solid var(--line); }
    .search-wrap { position: relative; width: min(360px, 46vw); }
    .search-wrap::before { content: "⌕"; position: absolute; left: 13px; top: 50%; transform: translateY(-54%); color: #747c92; font-size: 18px; pointer-events: none; }
    .search-wrap input { padding-left: 38px; }
    .masthead { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 30px 2px 22px; }
    .masthead > .status { flex: 0 0 auto; white-space: nowrap; }
    .eyebrow { color: var(--violet-hi); font-size: 9px; margin-bottom: 8px; }
    h1 { margin: 0; font-family: Bahnschrift, Aptos, sans-serif; font-size: clamp(29px, 3.4vw, 42px); line-height: 1; letter-spacing: -.045em; font-weight: 720; }
    .subtitle { margin: 10px 0 0; color: var(--muted); max-width: 620px; font-size: 13px; line-height: 1.55; }
    .view { animation: view-in .28s cubic-bezier(.2,.8,.2,1) both; }
    .view[hidden] { display: none !important; }
    .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 30px 2px 22px; }
    .page-head h1 { font-size: clamp(27px, 3vw, 38px); }
    .page-actions { display: flex; align-items: center; gap: 8px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .button {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 9px;
      color: var(--ink);
      background: rgba(30, 35, 52, .78);
      padding: 9px 13px;
      transition: border-color .18s, color .18s, transform .18s, background .18s, box-shadow .18s;
    }
    .button:hover { border-color: var(--line-hi); color: #fff; background: rgba(43,49,71,.9); transform: translateY(-1px); }
    .button.primary { background: linear-gradient(135deg, #7355e8, #925ef1); border-color: #9a74ef; color: #fff; font-weight: 680; box-shadow: 0 8px 24px rgba(110,72,220,.26); }
    .button.primary:hover { box-shadow: 0 10px 30px rgba(110,72,220,.38); }
    .button.danger:hover { border-color: var(--red); color: var(--red); }
    .button.small { padding: 6px 9px; font-size: 11px; }
    .button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--violet-hi);
      outline-offset: 2px;
    }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 11px; margin: 0 0 20px; }
    .metric {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: linear-gradient(145deg, var(--surface-hi), var(--surface));
      padding: 17px 18px 15px;
      min-height: 112px;
      animation: rise-in .45s cubic-bezier(.2,.8,.2,1) both;
    }
    .metric:nth-child(2) { animation-delay: .06s; }
    .metric:nth-child(3) { animation-delay: .12s; }
    .metric:nth-child(4) { animation-delay: .18s; }
    .metric::after {
      content: attr(data-symbol);
      position: absolute;
      right: 14px;
      top: 9px;
      color: rgba(139,92,246,.09);
      font: 700 40px/1 Bahnschrift, sans-serif;
      pointer-events: none;
    }
    .metric-value { display: block; font: 690 27px/1 Bahnschrift, Aptos, sans-serif; letter-spacing: -.02em; }
    .metric-label { display: block; margin-top: 8px; color: #a5acc0; font-size: 9px; }
    .metric-trend { display: block; margin-top: 8px; color: var(--green); font: 9px "Cascadia Code", Consolas, monospace; }
    .section-card { border: 1px solid var(--line); border-radius: var(--radius); background: linear-gradient(155deg, rgba(30,35,53,.66), rgba(17,21,33,.72)); overflow: hidden; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 58px; padding: 0 17px; border-bottom: 1px solid var(--line); }
    .section-head h2 { margin: 0; font: 680 14px Bahnschrift, Aptos, sans-serif; letter-spacing: .01em; }
    .section-tools { display: flex; align-items: center; gap: 10px; }
    .table-head, .agent-card { display: grid; grid-template-columns: minmax(210px, 1.25fr) 90px 115px minmax(170px, 1fr) 142px; align-items: center; gap: 12px; }
    .table-head { min-height: 39px; padding: 0 16px; color: #70788e; font: 9px "Cascadia Code", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; border-bottom: 1px solid var(--line); }
    .agent-grid { display: block; }
    .agent-card {
      position: relative;
      min-height: 66px;
      padding: 10px 16px;
      border-bottom: 1px solid rgba(163,174,216,.075);
      transition: background .18s, transform .18s;
      animation: row-in .36s cubic-bezier(.2,.8,.2,1) both;
      animation-delay: 0ms;
    }
    .agent-card:nth-child(2) { animation-delay: 45ms; }
    .agent-card:nth-child(3) { animation-delay: 90ms; }
    .agent-card:nth-child(4) { animation-delay: 135ms; }
    .agent-card:nth-child(5) { animation-delay: 180ms; }
    .agent-card:nth-child(n+6) { animation-delay: 225ms; }
    .agent-card:last-child { border-bottom: 0; }
    .agent-card:hover { background: rgba(139,92,246,.055); }
    .agent-card.offline { opacity: .64; }
    .agent-identity { display: flex; align-items: center; min-width: 0; gap: 11px; }
    .agent-avatar { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; border: 1px solid rgba(255,255,255,.1); border-radius: 9px; color: #fff; background: linear-gradient(135deg, #7956df, #43349b); font: 700 12px Bahnschrift, sans-serif; box-shadow: inset 0 1px rgba(255,255,255,.14); }
    .agent-avatar.hermes { background: linear-gradient(135deg, #4268d4, #24366f); }
    .agent-avatar.opencode { background: linear-gradient(135deg, #eb7d45, #98411f); }
    .agent-avatar.claude { background: linear-gradient(135deg, #d464d8, #75337a); }
    .agent-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 680; }
    .agent-id { display: block; margin-top: 3px; color: #737b91; font-size: 8px; text-transform: none; }
    .driver { color: #c5c9d5; font: 10px "Cascadia Code", Consolas, monospace; text-transform: uppercase; }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 3px rgba(133,141,133,.1); }
    .status.ready { color: var(--green); }
    .status.ready::before { background: var(--green); box-shadow: 0 0 0 3px rgba(86,227,159,.1), 0 0 10px rgba(86,227,159,.28); }
    .status.failed { color: var(--red); }
    .status.failed::before { background: var(--red); box-shadow: 0 0 0 3px rgba(255,107,87,.12); }
    .workspace { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #949bad; font: 9px "Cascadia Code", Consolas, monospace; }
    .card-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .empty { color: var(--muted); padding: 54px 24px; text-align: center; }
    .notice { display: none; margin: 0 0 16px; padding: 11px 13px; border: 1px solid rgba(255,113,133,.36); border-radius: 10px; background: rgba(255,113,133,.08); color: #ffadba; }
    .notice.visible { display: block; }
    .notice.success { border-color: rgba(86,227,159,.36); background: rgba(86,227,159,.08); color: var(--green); }
    .secondary-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(270px, .6fr); gap: 14px; margin-top: 14px; }
    .management-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr); gap: 14px; }
    .panel-body { padding: 17px; }
    .roots { display: flex; flex-wrap: wrap; gap: 8px; }
    .root-pill { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); color: #b3b8c8; padding: 8px 10px; font: 9px "Cascadia Code", Consolas, monospace; }
    .access-copy { color: var(--muted); font-size: 11px; line-height: 1.65; margin: 0 0 15px; }
    .access-actions { display: flex; gap: 8px; }
    .detail-stack { display: grid; gap: 14px; }
    .detail-card { border: 1px solid var(--line); border-radius: var(--radius); background: linear-gradient(145deg, var(--surface-hi), var(--surface)); padding: 19px; }
    .detail-kicker { color: var(--violet-hi); font: 9px "Cascadia Code", Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
    .detail-title { margin: 8px 0 7px; font: 680 17px Bahnschrift, Aptos, sans-serif; }
    .detail-copy { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.65; }
    .detail-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 17px; }
    .key-mask { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 17px 0 0; padding: 13px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
    .key-mask code { color: var(--ink); font: 12px "Cascadia Code", Consolas, monospace; letter-spacing: .12em; }
    .overview-agent-grid .agent-card { grid-template-columns: minmax(210px, 1.25fr) 90px 115px minmax(170px, 1fr); }
    .overview-agent-grid .card-actions { display: none; }
    .overview-table-head { grid-template-columns: minmax(210px, 1.25fr) 90px 115px minmax(170px, 1fr); }
    .overview-root { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); font: 10px "Cascadia Code", Consolas, monospace; }
    footer { margin-top: 26px; color: #5f667a; font: 9px "Cascadia Code", Consolas, monospace; display: flex; justify-content: space-between; }
    dialog { width: min(560px, calc(100% - 30px)); color: var(--ink); border: 1px solid var(--line-hi); border-radius: 16px; background: rgba(17,20,32,.96); padding: 0; box-shadow: 0 32px 100px rgba(0,0,0,.7); backdrop-filter: blur(24px); }
    dialog::backdrop { background: rgba(3,4,9,.75); backdrop-filter: blur(8px); }
    .dialog-head { padding: 20px 22px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
    .dialog-head h2 { margin: 0; font: 680 20px Bahnschrift, Aptos, sans-serif; }
    .dialog-body { padding: 22px; display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    .field { display: grid; gap: 6px; }
    .field.wide { grid-column: 1 / -1; }
    .label { color: var(--muted); font-size: 9px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 9px;
      background: rgba(8,10,18,.72);
      color: var(--ink);
      padding: 10px 11px;
      outline: none;
    }
    input::placeholder, textarea::placeholder { color: #555d72; }
    input:focus, select:focus, textarea:focus { border-color: var(--violet); box-shadow: 0 0 0 3px rgba(139,92,246,.1); }
    textarea { resize: vertical; min-height: 72px; }
    .check { display: flex; align-items: center; gap: 9px; padding-top: 19px; }
    .check input { width: auto; accent-color: var(--violet); }
    .dialog-actions { border-top: 1px solid var(--line); padding: 15px 22px; display: flex; justify-content: flex-end; gap: 8px; }
    .login { width: min(470px, calc(100% - 30px)); }
    .login .dialog-body { display: block; }
    .login-copy { color: var(--muted); line-height: 1.55; margin: 0; }
    .token-row { display: flex; gap: 8px; margin-top: 18px; }
    .token-row input { flex: 1; }
    .bootstrap { width: min(720px, calc(100% - 30px)); border-top: 2px solid var(--violet); }
    .bootstrap-head { padding: 22px 24px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: end; justify-content: space-between; gap: 20px; }
    .bootstrap-head h2 { margin: 0; font: 700 clamp(25px, 5vw, 38px) Bahnschrift, Aptos, sans-serif; letter-spacing: -.035em; }
    .setup-state { border: 1px solid var(--line-hi); border-radius: 6px; color: var(--violet-hi); padding: 6px 8px; font: 9px "Cascadia Code", Consolas, monospace; letter-spacing: .12em; }
    .bootstrap-body { display: grid; grid-template-columns: 190px 1fr; min-height: 300px; }
    .setup-brief { padding: 23px; border-right: 1px solid var(--line); background: linear-gradient(155deg, rgba(139,92,246,.12), transparent 62%); }
    .setup-index { color: rgba(167,139,250,.2); font: 800 72px/1 Bahnschrift, sans-serif; letter-spacing: -.08em; }
    .setup-brief p { color: #b6bbca; font-size: 13px; line-height: 1.58; margin: 15px 0 0; }
    .setup-warning { margin-top: 21px; padding-top: 15px; border-top: 1px solid var(--line-hi); color: var(--muted); font-size: 11px; line-height: 1.55; }
    .setup-warning strong { display: block; color: var(--violet-hi); font: 9px "Cascadia Code", Consolas, monospace; letter-spacing: .12em; margin-bottom: 5px; }
    .setup-fields { padding: 24px; display: grid; align-content: center; gap: 15px; }
    .secret-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .secret-toggle { min-width: 70px; min-height: 42px; }
    .key-status { min-height: 18px; color: var(--muted); font: 10px/1.5 "Cascadia Code", Consolas, monospace; margin: -4px 0 0; }
    .key-status.ready { color: var(--green); }
    .key-status.failed { color: var(--red); }
    .bootstrap-notice { display: none; border-left: 2px solid var(--red); padding: 8px 10px; background: rgba(255,113,133,.07); color: #ffadba; font-size: 12px; line-height: 1.45; }
    .bootstrap-notice.visible { display: block; }
    .bootstrap .dialog-actions { justify-content: space-between; align-items: center; }
    .setup-footnote { color: #666e82; font: 9px "Cascadia Code", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .key-copy { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 12px; }
    .key-copy input { font-family: "Cascadia Code", Consolas, monospace; }
    .hint { color: var(--muted); font-size: 12px; line-height: 1.55; margin: 0; }
    .busy { pointer-events: none; opacity: .55; }
    [hidden] { display: none !important; }
    @keyframes shell-in { from { opacity: 0; transform: translateY(8px) scale(.995); } }
    @keyframes rise-in { from { opacity: 0; transform: translateY(10px); } }
    @keyframes row-in { from { opacity: 0; transform: translateX(-7px); } }
    @keyframes view-in { from { opacity: 0; transform: translateY(6px); } }

    html[data-theme="light"] .shell { background: rgba(249, 249, 252, .76); }
    html[data-theme="light"] .sidebar {
      background:
        linear-gradient(180deg, rgba(238, 235, 253, .78), transparent 25%),
        var(--sidebar);
    }
    html[data-theme="light"] .sidebar-foot { background: rgba(82, 67, 148, .035); }
    html[data-theme="light"] .avatar { color: #fff; background: linear-gradient(135deg, #8b6cf2, #6545cf); }
    html[data-theme="light"] .nav-label { color: #9296a5; }
    html[data-theme="light"] .nav-button { color: #61677a; }
    html[data-theme="light"] .nav-button:hover { color: var(--ink); background: rgba(80,67,145,.05); }
    html[data-theme="light"] .nav-button.active { color: #5535c2; background: linear-gradient(90deg, rgba(115,81,232,.15), rgba(115,81,232,.055)); }
    html[data-theme="light"] .button { color: var(--ink); background: rgba(255,255,255,.86); }
    html[data-theme="light"] .button:hover { color: #4d31b3; background: #fff; }
    html[data-theme="light"] .button.primary { color: #fff; background: linear-gradient(135deg, #7151df, #8a5dea); }
    html[data-theme="light"] .metric-label { color: #686f81; }
    html[data-theme="light"] .section-card { background: linear-gradient(155deg, rgba(255,255,255,.96), rgba(248,248,252,.9)); }
    html[data-theme="light"] .agent-card { border-bottom-color: rgba(44,47,66,.075); }
    html[data-theme="light"] .agent-card:hover { background: rgba(115,81,232,.04); }
    html[data-theme="light"] .table-head { color: #9297a5; }
    html[data-theme="light"] .agent-id { color: #858a9a; }
    html[data-theme="light"] .driver { color: #555b6d; }
    html[data-theme="light"] .workspace { color: #717789; }
    html[data-theme="light"] .root-pill { color: #555b6d; }
    html[data-theme="light"] input, html[data-theme="light"] select, html[data-theme="light"] textarea { background: rgba(255,255,255,.9); }
    html[data-theme="light"] dialog { background: rgba(252,252,254,.97); box-shadow: 0 32px 100px rgba(48,43,70,.2); }
    html[data-theme="light"] dialog::backdrop { background: rgba(32,29,45,.32); }
    html[data-theme="light"] .setup-brief { background: linear-gradient(155deg, rgba(115,81,232,.1), transparent 62%); }
    html[data-theme="light"] .setup-brief p { color: #5f6575; }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 78px minmax(0,1fr); }
      .sidebar { padding-inline: 11px; }
      .sidebar-foot { margin-inline: -11px; padding-inline: 11px; }
      .brand { justify-content: center; padding-inline: 0; }
      .brand-copy, .nav-label, .nav-button span:last-child, .operator-copy { display: none; }
      .nav-button { justify-content: center; padding-inline: 0; }
      .operator { justify-content: center; }
      .sidebar-settings { display: none; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .table-head, .agent-card { grid-template-columns: minmax(190px,1.2fr) 75px 105px minmax(130px,1fr) 118px; gap: 8px; }
      .overview-agent-grid .agent-card, .overview-table-head { grid-template-columns: minmax(190px,1.2fr) 75px 105px minmax(130px,1fr); }
      .main { padding-inline: 20px; }
    }
    @media (max-width: 720px) {
      body { background: var(--bg); }
      .shell { width: 100%; min-height: 100vh; margin: 0; border: 0; border-radius: 0; grid-template-columns: 1fr; }
      .sidebar { min-height: auto; padding: 10px 13px; border-right: 0; border-bottom: 1px solid var(--line); flex-direction: row; align-items: center; position: sticky; top: 0; z-index: 10; }
      .brand { padding: 0; }
      .brand-copy { display: block; }
      .brand-version { display: none; }
      .nav { margin-left: auto; display: flex; }
      .nav-button { width: 36px; height: 36px; padding: 0; }
      .nav-button:nth-child(n+4), .nav-label, .sidebar-foot { display: none; }
      .main { padding: 0 13px 28px; }
      .topbar { min-height: 64px; }
      .search-wrap { flex: 1; width: auto; }
      .topbar .button.primary { font-size: 0; width: 38px; height: 38px; padding: 0; }
      .topbar .button.primary::after { content: "+"; font-size: 20px; }
      .masthead { align-items: flex-start; padding-top: 23px; }
      .masthead .actions { display: none; }
      .metrics { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .metric { min-height: 100px; padding: 15px; }
      .table-head { display: none; }
      .agent-card { grid-template-columns: minmax(0,1fr) auto; gap: 10px; padding: 14px; }
      .agent-card .driver { display: none; }
      .agent-card .status { justify-self: end; }
      .agent-card .workspace { grid-column: 1 / -1; padding-left: 45px; }
      .card-actions { grid-column: 1 / -1; padding-left: 45px; justify-content: flex-start; }
      .secondary-grid { grid-template-columns: 1fr; }
      .management-grid { grid-template-columns: 1fr; }
      .dialog-body { grid-template-columns: 1fr; }
      .field.wide { grid-column: auto; }
      .bootstrap-body { grid-template-columns: 1fr; }
      .setup-brief { border-right: 0; border-bottom: 1px solid var(--line); }
      .setup-index { font-size: 48px; }
      .bootstrap .dialog-actions { align-items: stretch; flex-direction: column-reverse; }
      footer { gap: 9px; flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }
  </style>
</head>
<body>
  <main class="shell" id="app">
    <aside class="sidebar" aria-label="Gateway navigation">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><span></span></span>
        <span class="brand-copy"><span class="brand-name">Nexus Gateway</span><span class="brand-version">NEXUS//CONTROL · 0.1.4</span></span>
      </div>
      <span class="nav-label">Control plane</span>
      <nav class="nav">
        <button class="nav-button active" type="button" data-view="overview"><span class="nav-icon">⌂</span><span>概览</span></button>
        <button class="nav-button" type="button" data-view="agents"><span class="nav-icon">⌘</span><span>Agents</span></button>
        <button class="nav-button" type="button" data-view="workspaces"><span class="nav-icon">□</span><span>工作区</span></button>
        <button class="nav-button" type="button" data-view="keys"><span class="nav-icon">⌁</span><span>密钥管理</span></button>
      </nav>
      <div class="sidebar-foot">
        <div class="operator">
          <span class="avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"></circle><path d="M5.5 20c.55-4 2.7-6 6.5-6s5.95 2 6.5 6"></path></svg></span>
          <span class="operator-copy"><span class="operator-name">Gateway Admin</span><span class="operator-state">本地节点</span></span>
          <button class="sidebar-settings" type="button" data-view="keys" title="打开密钥管理" aria-label="打开密钥管理">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.3h4.05v.1A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z"></path></svg>
          </button>
        </div>
      </div>
    </aside>

    <section class="main">
      <div class="topbar">
        <label class="search-wrap"><input id="agent-search" type="search" autocomplete="off" placeholder="搜索 Agent、驱动或工作区…" aria-label="搜索 Agent"></label>
        <button class="button icon-button" id="refresh" type="button" title="刷新探测" aria-label="刷新探测">↻</button>
        <button class="button icon-button" id="theme-toggle" type="button" title="切换亮色/暗色主题" aria-label="切换亮色/暗色主题">☼</button>
        <button class="button primary" id="add-agent" type="button">＋ 添加 Agent</button>
      </div>

      <div class="notice" id="notice" role="alert"></div>

      <section class="view" data-view-panel="overview">
        <header class="masthead">
          <div>
            <div class="eyebrow">Unified ACP Gateway</div>
            <h1>概览</h1>
            <p class="subtitle">统一接入、统一认证、统一调用的 Agent 网关。Koishi 只需要连接这里。</p>
          </div>
          <span class="status" id="gateway-status">等待连接</span>
        </header>

        <section class="metrics" aria-label="Gateway summary">
          <div class="metric" data-symbol="⌘"><strong class="metric-value" id="count-total">—</strong><span class="metric-label">已连接 Agents</span><span class="metric-trend">CONTROL PLANE</span></div>
          <div class="metric" data-symbol="✦"><strong class="metric-value" id="count-ready">—</strong><span class="metric-label">就绪 Agents</span><span class="metric-trend" id="ready-ratio">等待探测</span></div>
          <div class="metric" data-symbol="□"><strong class="metric-value" id="count-roots">—</strong><span class="metric-label">工作区根目录</span><span class="metric-trend">ALLOWLISTED</span></div>
          <div class="metric" data-symbol="◇"><strong class="metric-value" id="count-drivers">—</strong><span class="metric-label">可用 ACP 驱动</span><span class="metric-trend">NATIVE STDIO</span></div>
        </section>

        <section class="section-card">
          <div class="section-head"><h2>Agent 状态</h2><div class="section-tools"><span class="agent-id" id="overview-agent-count">—</span><button class="button small" type="button" data-go-view="agents">进入管理</button></div></div>
          <div class="table-head overview-table-head" aria-hidden="true"><span>名称</span><span>协议</span><span>状态</span><span>工作区</span></div>
          <div class="agent-grid overview-agent-grid" id="overview-agent-grid"></div>
        </section>

        <div class="secondary-grid">
          <section class="detail-card">
            <span class="detail-kicker">Workspace boundary</span>
            <h2 class="detail-title">默认工作区</h2>
            <p class="overview-root" id="overview-root">等待连接</p>
            <div class="detail-actions"><button class="button small" type="button" data-go-view="workspaces">管理工作区</button></div>
          </section>
          <section class="detail-card">
            <span class="detail-kicker">Gateway runtime</span>
            <h2 class="detail-title">控制面在线</h2>
            <p class="detail-copy">Agent 探测、Session 和配置写入均由当前 Gateway 统一处理。</p>
            <div class="detail-actions"><button class="button small" type="button" data-go-view="keys">打开密钥管理</button></div>
          </section>
        </div>
      </section>

      <section class="view" data-view-panel="agents" hidden>
        <header class="page-head">
          <div><div class="eyebrow">Agent inventory</div><h1>Agents</h1><p class="subtitle">管理 Gateway 暴露给 Koishi 的 ACP Agent、驱动、权限策略和默认工作区。</p></div>
          <div class="page-actions"><button class="button primary" type="button" data-add-agent>＋ 添加 Agent</button></div>
        </header>
        <section class="section-card">
          <div class="section-head"><h2>Agent 管理</h2><div class="section-tools"><span class="agent-id" id="agent-result-count">—</span></div></div>
          <div class="table-head" aria-hidden="true"><span>名称</span><span>协议</span><span>状态</span><span>工作区</span><span>操作</span></div>
          <div class="agent-grid" id="agent-grid"></div>
        </section>
      </section>

      <section class="view" data-view-panel="workspaces" hidden>
        <header class="page-head">
          <div><div class="eyebrow">Filesystem boundary</div><h1>工作区</h1><p class="subtitle">这里只配置允许 Agent 访问的根目录；每个 Agent 的默认目录必须位于白名单之内。</p></div>
          <div class="page-actions"><button class="button primary" id="edit-roots" type="button">管理白名单</button></div>
        </header>
        <div class="management-grid">
          <section class="section-card">
            <div class="section-head"><h2>允许的根目录</h2><span class="agent-id" id="workspace-root-count">—</span></div>
            <div class="panel-body"><div class="roots" id="roots"></div></div>
          </section>
          <div class="detail-stack">
            <section class="detail-card"><span class="detail-kicker">Realpath policy</span><h2 class="detail-title">边界校验已启用</h2><p class="detail-copy">保存时 Gateway 会解析真实路径，拒绝目录穿越、白名单外路径与符号链接逃逸。</p></section>
            <section class="detail-card"><span class="detail-kicker">Agent workspace</span><h2 class="detail-title">按 Agent 细分</h2><p class="detail-copy">根目录决定最大访问边界；具体 Agent 的默认 Workspace 请到 Agents 页面单独配置。</p><div class="detail-actions"><button class="button small" type="button" data-go-view="agents">配置 Agents</button></div></section>
          </div>
        </div>
      </section>

      <section class="view" data-view-panel="keys" hidden>
        <header class="page-head">
          <div><div class="eyebrow">Bearer authentication</div><h1>密钥管理</h1><p class="subtitle">管理 Koishi 与本控制台连接 Gateway 时使用的 Access Key。</p></div>
          <span class="status ready">已认证</span>
        </header>
        <div class="management-grid">
          <section class="detail-card">
            <span class="detail-kicker">Gateway access key</span>
            <h2 class="detail-title">当前 Access Key</h2>
            <p class="detail-copy">出于安全考虑，Gateway 不会再次读取或显示当前 Key。轮换后旧 Key 会立即失效，需要同步更新 Koishi。</p>
            <div class="key-mask"><code>••••••••••••••••</code><span class="status ready">生效中</span></div>
            <div class="detail-actions"><button class="button primary" id="rotate-key" type="button">轮换 Access Key</button></div>
          </section>
          <div class="detail-stack">
            <section class="detail-card"><span class="detail-kicker">Browser session</span><h2 class="detail-title">当前控制台已连接</h2><p class="detail-copy">Key 只保存在当前标签页的 sessionStorage，关闭标签页后不会继续保留。</p><div class="detail-actions"><button class="button danger" id="disconnect" type="button">断开当前控制台</button></div></section>
            <section class="detail-card"><span class="detail-kicker">Koishi connection</span><h2 class="detail-title">一处配置</h2><p class="detail-copy">Koishi AgentNexus 只需填写 Gateway 地址和同一个 Key，Agent 清单会自动同步。</p></section>
          </div>
        </div>
      </section>

      <footer><span>nexus-agentd · authenticated ACP control surface</span><span id="endpoint"></span></footer>
    </section>
  </main>

  <dialog class="bootstrap" id="bootstrap-dialog" aria-labelledby="bootstrap-title" aria-describedby="bootstrap-copy">
    <form id="bootstrap-form">
      <div class="bootstrap-head">
        <div><div class="eyebrow">First Run · Access Control</div><h2 id="bootstrap-title">初始化 Gateway</h2></div>
        <span class="setup-state">UNCLAIMED</span>
      </div>
      <div class="bootstrap-body">
        <section class="setup-brief" aria-label="Setup step">
          <div class="setup-index">01</div>
          <p id="bootstrap-copy">为这台 Gateway 设置你自己的 Access Key。以后 Koishi 和本控制台都使用它完成身份验证。</p>
          <div class="setup-warning"><strong>TRUST BOUNDARY</strong>首位完成初始化的管理员将取得控制权。只在可信局域网内操作，不要把未初始化端点暴露到公网。</div>
        </section>
        <section class="setup-fields">
          <div class="field"><label class="label" for="bootstrap-access-key">Gateway Access Key</label>
            <span class="secret-row"><input id="bootstrap-access-key" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" minlength="8" maxlength="256" placeholder="至少 8 个字符" required><button class="button small secret-toggle" type="button" data-secret-target="bootstrap-access-key" aria-label="显示 Access Key" aria-pressed="false">显示</button></span>
          </div>
          <div class="field"><label class="label" for="bootstrap-confirm">Confirm Access Key</label>
            <span class="secret-row"><input id="bootstrap-confirm" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" minlength="8" maxlength="256" placeholder="再次输入 Access Key" required><button class="button small secret-toggle" type="button" data-secret-target="bootstrap-confirm" aria-label="显示确认 Access Key" aria-pressed="false">显示</button></span>
          </div>
          <p class="key-status" id="bootstrap-status" aria-live="polite">最低 8 个字符；建议设置更长并妥善保存。</p>
          <div class="bootstrap-notice" id="bootstrap-notice" role="alert"></div>
        </section>
      </div>
      <div class="dialog-actions"><span class="setup-footnote" id="bootstrap-endpoint">LOCAL CONTROL PLANE</span><button class="button primary" id="bootstrap-submit" type="submit">保存并进入 Gateway</button></div>
    </form>
  </dialog>

  <dialog class="login" id="login-dialog" aria-labelledby="login-title" aria-describedby="login-copy">
    <div class="dialog-head"><h2 id="login-title">连接 Gateway</h2></div>
    <form id="login-form">
      <div class="dialog-body">
        <p class="login-copy" id="login-copy">输入初始化时设置的 Gateway Access Key。Key 只保存在当前浏览器标签页的 sessionStorage。</p>
        <label class="field" for="token"><span class="label">Gateway Access Key</span></label>
        <div class="token-row"><input id="token" type="password" autocomplete="current-password" placeholder="输入 Access Key" required><button class="button primary" type="submit">连接</button></div>
      </div>
    </form>
  </dialog>

  <dialog id="agent-dialog" aria-labelledby="dialog-title">
    <form id="agent-form">
      <div class="dialog-head"><h2 id="dialog-title">添加 Agent</h2><button class="button small" type="button" id="close-dialog">关闭</button></div>
      <div class="dialog-body">
        <label class="field"><span class="label">Agent ID</span><input id="agent-id" required pattern="[a-z0-9](?:[a-z0-9._]|-){0,63}" placeholder="codex"></label>
        <label class="field"><span class="label">Driver</span><select id="driver" required></select></label>
        <label class="field"><span class="label">Display name</span><input id="agent-name" placeholder="Codex"></label>
        <label class="field"><span class="label">Permission policy</span><select id="permission-policy"><option value="ask">Ask</option><option value="deny">Deny</option></select></label>
        <label class="field wide"><span class="label">Workspace</span><input id="workspace" required placeholder="/data/repos/project"></label>
        <label class="field wide"><span class="label">Description</span><textarea id="description" placeholder="这个 Agent 负责什么"></textarea></label>
        <label class="check wide"><input id="enabled" type="checkbox" checked><span>向上游暴露并允许创建 Session</span></label>
      </div>
      <div class="dialog-actions"><button class="button" type="button" id="cancel-dialog">取消</button><button class="button primary" type="submit">保存配置</button></div>
    </form>
  </dialog>

  <dialog id="roots-dialog" aria-labelledby="roots-title">
    <form id="roots-form">
      <div class="dialog-head"><h2 id="roots-title">Workspace Allowlist</h2><button class="button small" type="button" id="close-roots">关闭</button></div>
      <div class="dialog-body">
        <label class="field wide"><span class="label">One absolute path per line</span><textarea id="workspace-roots" required rows="7" placeholder="/data/repos"></textarea></label>
        <p class="hint field wide">Agent 的默认 Workspace 必须位于这些目录内；保存前会执行 realpath 边界校验。</p>
      </div>
      <div class="dialog-actions"><button class="button" type="button" id="cancel-roots">取消</button><button class="button primary" type="submit">保存目录</button></div>
    </form>
  </dialog>

  <dialog id="key-dialog" aria-labelledby="key-title">
    <div class="dialog-head"><h2 id="key-title">New Gateway Access Key</h2><button class="button small" type="button" id="close-key">关闭</button></div>
    <div class="dialog-body">
      <div class="field wide">
        <p class="hint">旧 Key 已立即失效。复制下面的新 Key，填入 Koishi 的 AgentNexus 插件设置；离开后 Gateway 不会再次显示它。</p>
        <div class="key-copy"><input id="new-key" type="text" readonly><button class="button primary" id="copy-key" type="button">复制</button></div>
      </div>
    </div>
  </dialog>

  <script nonce="__NONCE__">
    (function () {
      var tokenKey = 'nexus-agentd-token';
      var state = { token: sessionStorage.getItem(tokenKey) || '', config: null, probes: {} };
      var app = document.getElementById('app');
      var notice = document.getElementById('notice');
      var grid = document.getElementById('agent-grid');
      var overviewGrid = document.getElementById('overview-agent-grid');
      var roots = document.getElementById('roots');
      var search = document.getElementById('agent-search');
      var themeToggle = document.getElementById('theme-toggle');
      var bootstrapDialog = document.getElementById('bootstrap-dialog');
      var bootstrapForm = document.getElementById('bootstrap-form');
      var bootstrapNotice = document.getElementById('bootstrap-notice');
      var bootstrapStatus = document.getElementById('bootstrap-status');
      var loginDialog = document.getElementById('login-dialog');
      var agentDialog = document.getElementById('agent-dialog');
      var rootsDialog = document.getElementById('roots-dialog');
      var keyDialog = document.getElementById('key-dialog');
      var form = document.getElementById('agent-form');

      function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
        });
      }

      function showView(view) {
        var panel = document.querySelector('[data-view-panel="' + view + '"]');
        if (!panel) view = 'overview';
        document.querySelectorAll('[data-view-panel]').forEach(function (item) {
          item.hidden = item.dataset.viewPanel !== view;
        });
        document.querySelectorAll('.nav-button[data-view]').forEach(function (item) {
          item.classList.toggle('active', item.dataset.view === view);
        });
        try { localStorage.setItem('nexus-agentd-view', view); } catch (_) {}
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      function setTheme(theme, persist) {
        document.documentElement.dataset.theme = theme;
        themeToggle.textContent = theme === 'dark' ? '☼' : '☾';
        themeToggle.title = theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题';
        themeToggle.setAttribute('aria-label', themeToggle.title);
        if (persist) {
          try { localStorage.setItem('nexus-agentd-theme', theme); } catch (_) {}
        }
      }

      async function api(path, options) {
        options = options || {};
        options.headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + state.token });
        if (options.body) options.headers['Content-Type'] = 'application/json';
        var response = await fetch(path, options);
        var payload = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          if (response.status === 401) openModal(loginDialog);
          if (response.status === 428) showBootstrap();
          var error = new Error(payload.error || ('Request failed: ' + response.status));
          error.status = response.status;
          throw error;
        }
        return payload;
      }

      async function publicApi(path, options) {
        options = options || {};
        options.headers = Object.assign({}, options.headers || {});
        if (options.body) options.headers['Content-Type'] = 'application/json';
        var response = await fetch(path, options);
        var payload = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          var error = new Error(payload.error || ('Request failed: ' + response.status));
          error.status = response.status;
          throw error;
        }
        return payload;
      }

      function openModal(dialog) { if (!dialog.open) dialog.showModal(); }
      function setBusy(value) { app.classList.toggle('busy', value); }
      function showError(error) {
        notice.textContent = error instanceof Error ? error.message : String(error);
        notice.classList.remove('success');
        notice.classList.add('visible');
      }
      function showSuccess(message) {
        notice.textContent = message;
        notice.classList.add('visible', 'success');
      }
      function clearError() { notice.classList.remove('visible', 'success'); notice.textContent = ''; }
      function showBootstrapError(error) {
        bootstrapNotice.textContent = error instanceof Error ? error.message : String(error);
        bootstrapNotice.classList.add('visible');
      }
      function clearBootstrapError() {
        bootstrapNotice.classList.remove('visible');
        bootstrapNotice.textContent = '';
      }

      function updateBootstrapStatus() {
        var accessKey = document.getElementById('bootstrap-access-key').value.trim();
        var confirmation = document.getElementById('bootstrap-confirm').value.trim();
        bootstrapStatus.className = 'key-status';
        if (accessKey.length < 8) {
          bootstrapStatus.textContent = accessKey.length
            ? '还需要 ' + (8 - accessKey.length) + ' 个字符。'
            : '最低 8 个字符；建议设置更长并妥善保存。';
          if (accessKey.length) bootstrapStatus.classList.add('failed');
          return;
        }
        if (!confirmation) {
          bootstrapStatus.textContent = '长度符合要求，请再次输入确认。';
          return;
        }
        if (accessKey !== confirmation) {
          bootstrapStatus.textContent = '两次输入不一致。';
          bootstrapStatus.classList.add('failed');
          return;
        }
        bootstrapStatus.textContent = 'Access Key 已确认，可以初始化。';
        bootstrapStatus.classList.add('ready');
      }

      function showBootstrap() {
        sessionStorage.removeItem(tokenKey);
        state.token = '';
        state.config = null;
        if (loginDialog.open) loginDialog.close();
        document.getElementById('bootstrap-endpoint').textContent = 'ENDPOINT · ' + location.host;
        openModal(bootstrapDialog);
        requestAnimationFrame(function () {
          document.getElementById('bootstrap-access-key').focus();
        });
      }

      async function start() {
        clearError();
        try {
          var status = await publicApi('/v1/bootstrap/status');
          if (!status.initialized) { showBootstrap(); return; }
          if (bootstrapDialog.open) bootstrapDialog.close();
          await load();
        } catch (error) {
          showError(error);
        }
      }

      async function load() {
        if (!state.token) { openModal(loginDialog); return; }
        clearError();
        setBusy(true);
        try {
          var values = await Promise.all([api('/v1/config'), api('/v1/agents')]);
          state.config = values[0];
          state.probes = {};
          (values[1].agents || []).forEach(function (agent) { state.probes[agent.id] = agent; });
          render();
          if (loginDialog.open) loginDialog.close();
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      function render() {
        var agents = state.config.agents || [];
        var workspaceRoots = state.config.workspaceRoots || [];
        document.getElementById('driver').innerHTML = (state.config.driverKinds || []).map(function (driver) {
          return '<option value="' + escapeHtml(driver) + '">' + escapeHtml(driver) + '</option>';
        }).join('');
        var ready = agents.filter(function (agent) { return state.probes[agent.id] && state.probes[agent.id].ready; }).length;
        document.getElementById('count-total').textContent = agents.length;
        document.getElementById('count-ready').textContent = ready;
        document.getElementById('count-roots').textContent = workspaceRoots.length;
        document.getElementById('count-drivers').textContent = (state.config.driverKinds || []).length;
        document.getElementById('workspace-root-count').textContent = workspaceRoots.length + ' ROOTS';
        document.getElementById('overview-agent-count').textContent = agents.length + ' AGENTS';
        document.getElementById('overview-root').textContent = workspaceRoots[0] || '尚未配置工作区';
        document.getElementById('ready-ratio').textContent = agents.length ? Math.round((ready / agents.length) * 100) + '% READY' : 'NO AGENTS';
        document.getElementById('gateway-status').textContent = '已连接';
        document.getElementById('gateway-status').className = 'status ready';
        document.getElementById('endpoint').textContent = location.host;
        roots.innerHTML = workspaceRoots.length ? workspaceRoots.map(function (root) {
          return '<span class="root-pill">' + escapeHtml(root) + '</span>';
        }).join('') : '<span class="root-pill">尚未配置工作区</span>';
        grid.innerHTML = agents.length ? agents.map(function (agent, index) { return renderAgent(agent, index, false); }).join('') :
          '<div class="empty">这里还没有 Agent。添加第一个 Agent 后，AgentNexus 会自动同步对应工具。</div>';
        overviewGrid.innerHTML = agents.length ? agents.slice(0, 5).map(function (agent, index) { return renderAgent(agent, index, true); }).join('') :
          '<div class="empty">这里还没有 Agent。进入 Agents 页面添加第一个 Agent。</div>';
        applySearch();
      }

      function renderAgent(agent, index, compact) {
        var probe = state.probes[agent.id];
        var statusClass = !agent.enabled ? '' : probe && probe.ready ? 'ready' : 'failed';
        var statusText = !agent.enabled ? '已禁用' : probe && probe.ready ? '就绪' : '未就绪';
        var statusDetail = probe && probe.error ? probe.error : statusText;
        var avatarClass = ['hermes', 'opencode', 'claude'].indexOf(agent.driver) >= 0 ? ' ' + agent.driver : '';
        var searchText = [agent.id, agent.name, agent.driver, agent.workspace, agent.description].join(' ').toLowerCase();
        var actions = compact ? '' : '<div class="card-actions"><button class="button small" data-action="edit" data-id="' + escapeHtml(agent.id) + '">配置</button>' +
          '<button class="button small" data-action="toggle" data-id="' + escapeHtml(agent.id) + '">' + (agent.enabled ? '禁用' : '启用') + '</button>' +
          '<button class="button small danger" data-action="delete" data-id="' + escapeHtml(agent.id) + '" title="删除 Agent" aria-label="删除 ' + escapeHtml(agent.name) + '">×</button></div>';
        return '<article class="agent-card ' + (!agent.enabled ? 'offline' : '') + '" data-search="' + escapeHtml(searchText) + '" data-index="' + String(index + 1).padStart(2, '0') + '">' +
          '<div class="agent-identity" title="' + escapeHtml(agent.description || agent.name) + '"><span class="agent-avatar' + avatarClass + '">' + escapeHtml((agent.name || agent.id).charAt(0).toUpperCase()) + '</span><span><span class="agent-name">' + escapeHtml(agent.name) + '</span><span class="agent-id">' + escapeHtml(agent.id) + ' · ' + escapeHtml(agent.driver) + '</span></span></div>' +
          '<span class="driver">ACP</span>' +
          '<span class="status ' + statusClass + '" title="' + escapeHtml(statusDetail) + '">' + escapeHtml(statusText) + '</span>' +
          '<div class="workspace" title="' + escapeHtml(agent.workspace) + '">' + escapeHtml(agent.workspace) + '</div>' +
          actions + '</article>';
      }

      function applySearch() {
        var query = search.value.trim().toLowerCase();
        var rows = Array.prototype.slice.call(grid.querySelectorAll('.agent-card'));
        var visible = 0;
        rows.forEach(function (row) {
          row.hidden = Boolean(query) && row.dataset.search.indexOf(query) < 0;
          if (!row.hidden) visible += 1;
        });
        document.getElementById('agent-result-count').textContent = query ? visible + ' / ' + rows.length : rows.length + ' AGENTS';
      }

      function openEditor(agent) {
        agent = agent || {};
        document.getElementById('dialog-title').textContent = agent.id ? '配置 Agent' : '添加 Agent';
        var id = document.getElementById('agent-id');
        id.value = agent.id || '';
        id.readOnly = Boolean(agent.id);
        document.getElementById('driver').value = agent.driver || (state.config.driverKinds[0] || 'codex');
        document.getElementById('agent-name').value = agent.name || '';
        document.getElementById('permission-policy').value = agent.permissionPolicy || 'ask';
        document.getElementById('workspace').value = agent.workspace || state.config.workspaceRoots[0] || '';
        document.getElementById('description').value = agent.description || '';
        document.getElementById('enabled').checked = agent.enabled !== false;
        agentDialog.showModal();
      }

      function payloadFor(agent, enabledOverride) {
        return {
          driver: agent.driver,
          name: agent.name,
          description: agent.description || '',
          enabled: enabledOverride === undefined ? agent.enabled : enabledOverride,
          workspace: agent.workspace,
          permissionPolicy: agent.permissionPolicy || 'ask',
          permissionTimeoutMs: agent.permissionTimeoutMs
        };
      }

      async function save(id, payload) {
        setBusy(true);
        clearError();
        try {
          await api('/v1/config/agents/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
          await load();
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      document.getElementById('login-form').addEventListener('submit', function (event) {
        event.preventDefault();
        state.token = document.getElementById('token').value.trim();
        sessionStorage.setItem(tokenKey, state.token);
        load();
      });
      bootstrapDialog.addEventListener('cancel', function (event) { event.preventDefault(); });
      bootstrapForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        clearBootstrapError();
        var accessKey = document.getElementById('bootstrap-access-key').value.trim();
        var confirmation = document.getElementById('bootstrap-confirm').value.trim();
        if (accessKey.length < 8) {
          showBootstrapError('Access Key 至少需要 8 个字符。');
          document.getElementById('bootstrap-access-key').focus();
          return;
        }
        if (/^env:/i.test(accessKey)) {
          showBootstrapError('首次初始化请输入实际 Key，不能使用 env: 引用。');
          document.getElementById('bootstrap-access-key').focus();
          return;
        }
        if (accessKey !== confirmation) {
          showBootstrapError('两次输入的 Access Key 不一致。');
          document.getElementById('bootstrap-confirm').focus();
          return;
        }
        bootstrapForm.classList.add('busy');
        try {
          var result = await publicApi('/v1/bootstrap/initialize', {
            method: 'POST',
            body: JSON.stringify({ accessKey: accessKey, confirmAccessKey: confirmation })
          });
          if (!result.initialized) throw new Error('Gateway initialization did not complete');
          state.token = accessKey;
          sessionStorage.setItem(tokenKey, state.token);
          document.getElementById('token').value = state.token;
          document.getElementById('bootstrap-access-key').value = '';
          document.getElementById('bootstrap-confirm').value = '';
          bootstrapDialog.close();
          await load();
          showSuccess('Gateway 初始化完成。请把同一个 Access Key 填入 Koishi AgentNexus。');
        } catch (error) {
          if (error && error.status === 409) {
            bootstrapDialog.close();
            document.getElementById('login-copy').textContent = 'Gateway 已由管理员完成初始化。请输入现有 Gateway Access Key。';
            openModal(loginDialog);
          } else {
            showBootstrapError(error);
          }
        } finally {
          bootstrapForm.classList.remove('busy');
        }
      });
      ['bootstrap-access-key', 'bootstrap-confirm'].forEach(function (id) {
        document.getElementById(id).addEventListener('input', function () {
          clearBootstrapError();
          updateBootstrapStatus();
        });
      });
      document.querySelectorAll('[data-secret-target]').forEach(function (button) {
        button.addEventListener('click', function () {
          var input = document.getElementById(this.dataset.secretTarget);
          var visible = input.type === 'text';
          input.type = visible ? 'password' : 'text';
          this.textContent = visible ? '显示' : '隐藏';
          this.setAttribute('aria-pressed', String(!visible));
          this.setAttribute('aria-label', (visible ? '显示' : '隐藏') + (this.dataset.secretTarget === 'bootstrap-confirm' ? '确认 Access Key' : ' Access Key'));
          input.focus();
        });
      });
      document.getElementById('refresh').addEventListener('click', load);
      function beginAddAgent() { showView('agents'); openEditor(); }
      document.getElementById('add-agent').addEventListener('click', beginAddAgent);
      document.querySelectorAll('[data-add-agent]').forEach(function (button) { button.addEventListener('click', beginAddAgent); });
      search.addEventListener('input', function () {
        if (this.value.trim()) showView('agents');
        applySearch();
      });
      document.querySelectorAll('[data-view]').forEach(function (button) {
        button.addEventListener('click', function () {
          showView(this.dataset.view);
        });
      });
      document.querySelectorAll('[data-go-view]').forEach(function (button) {
        button.addEventListener('click', function () { showView(this.dataset.goView); });
      });
      themeToggle.addEventListener('click', function () {
        setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
      });
      document.getElementById('edit-roots').addEventListener('click', function () {
        document.getElementById('workspace-roots').value = (state.config.workspaceRoots || []).join('\n');
        rootsDialog.showModal();
      });
      document.getElementById('rotate-key').addEventListener('click', async function () {
        if (!confirm('轮换 Access Key？旧 Key 会立即失效，Koishi 必须改用新 Key。')) return;
        setBusy(true);
        clearError();
        try {
          var result = await api('/v1/config/access-key/rotate', { method: 'POST' });
          state.token = result.accessKey;
          sessionStorage.setItem(tokenKey, state.token);
          document.getElementById('token').value = state.token;
          document.getElementById('new-key').value = state.token;
          keyDialog.showModal();
        } catch (error) { showError(error); }
        finally { setBusy(false); }
      });
      document.getElementById('disconnect').addEventListener('click', function () {
        sessionStorage.removeItem(tokenKey); state.token = ''; state.config = null; openModal(loginDialog);
      });
      document.getElementById('close-dialog').addEventListener('click', function () { agentDialog.close(); });
      document.getElementById('cancel-dialog').addEventListener('click', function () { agentDialog.close(); });
      document.getElementById('close-roots').addEventListener('click', function () { rootsDialog.close(); });
      document.getElementById('cancel-roots').addEventListener('click', function () { rootsDialog.close(); });
      document.getElementById('close-key').addEventListener('click', function () { keyDialog.close(); });
      document.getElementById('copy-key').addEventListener('click', async function () {
        var input = document.getElementById('new-key');
        try { await navigator.clipboard.writeText(input.value); this.textContent = '已复制'; }
        catch (_) { input.select(); document.execCommand('copy'); this.textContent = '已复制'; }
      });
      grid.addEventListener('click', async function (event) {
        var button = event.target.closest('button[data-action]');
        if (!button) return;
        var agent = state.config.agents.find(function (item) { return item.id === button.dataset.id; });
        if (!agent) return;
        if (button.dataset.action === 'edit') openEditor(agent);
        if (button.dataset.action === 'toggle') await save(agent.id, payloadFor(agent, !agent.enabled));
        if (button.dataset.action === 'delete' && confirm('删除 Agent “' + agent.name + '”？已有 Session 不会被中断。')) {
          setBusy(true);
          try { await api('/v1/config/agents/' + encodeURIComponent(agent.id), { method: 'DELETE' }); await load(); }
          catch (error) { showError(error); }
          finally { setBusy(false); }
        }
      });
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        var id = document.getElementById('agent-id').value.trim().toLowerCase();
        var payload = {
          driver: document.getElementById('driver').value,
          name: document.getElementById('agent-name').value.trim(),
          description: document.getElementById('description').value.trim(),
          enabled: document.getElementById('enabled').checked,
          workspace: document.getElementById('workspace').value.trim(),
          permissionPolicy: document.getElementById('permission-policy').value
        };
        agentDialog.close();
        await save(id, payload);
      });
      document.getElementById('roots-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var workspaceRoots = document.getElementById('workspace-roots').value
          .split(/\r?\n/).map(function (value) { return value.trim(); }).filter(Boolean);
        rootsDialog.close();
        setBusy(true);
        clearError();
        try {
          await api('/v1/config/workspace-roots', {
            method: 'PUT',
            body: JSON.stringify({ workspaceRoots: workspaceRoots })
          });
          await load();
        } catch (error) { showError(error); }
        finally { setBusy(false); }
      });

      var initialView = 'overview';
      try { initialView = localStorage.getItem('nexus-agentd-view') || initialView; } catch (_) {}
      showView(initialView);
      setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', false);
      state.token && (document.getElementById('token').value = state.token);
      start();
    })();
  </script>
</body>
</html>
`

export function writeAgentdWebUi(response: ServerResponse) {
    const nonce = randomBytes(18).toString('base64')
    const body = PAGE.replaceAll('__NONCE__', nonce)
    response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Content-Security-Policy': [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            "connect-src 'self'",
            "img-src 'self' data:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
        ].join('; '),
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
    })
    response.end(body)
}

export function redirectToAgentdWebUi(response: ServerResponse) {
    response.writeHead(302, {
        Location: '/ui/',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    })
    response.end()
}
