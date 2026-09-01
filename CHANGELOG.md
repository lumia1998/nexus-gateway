# Changelog

本项目遵循语义化版本，记录 Nexus Gateway 面向使用者的重要变化。

## [0.2.4] - 2026-09-01

### UI/UX 重大升级
- 🎨 WebUI 全面采用 shadcn 设计风格，提升专业度和现代感
- ✨ 新增完整的阴影系统（4 个层级）和微交互动画
- 🎯 优化间距体系：组件间距从 8-12px 提升到 16-32px，视觉更舒适
- 📐 改进排版层级：标题从 24px 提升到 30px，字重和行高全面优化
- 🌈 精细化配色方案：浅色和深色模式都更加柔和协调
- 💫 新增悬停动效：按钮上浮、卡片提升、状态脉冲等流畅过渡效果
- 🔄 动画增强：抽屉滑入、Toast 提示、状态指示器等都有细腻的动画
- 📱 响应式优化：改进移动端断点和小屏幕布局

### 视觉组件优化
- 按钮：高度 40px，悬停上移 1px + 阴影增强
- 卡片/面板：圆角 8-12px，悬停提升效果
- 表格：行高 72px，更好的悬停状态
- 表单：输入框 40px，聚焦时带阴影效果
- 状态徽章：圆角胶囊设计 + 背景色区分

### 部署工具
- 新增多种部署脚本（Bash、PowerShell、Batch）
- 新增详细的手动部署文档

## [0.2.3] - 2026-08-31

- ACP Agent 在文本结果中明确输出 `MEDIA:<path>` 时，Gateway 现在会在该轮完成前将该常规文件快照为受大小限制的二进制 Artifact；不再遗漏 Hermes/ppt-master 写在 skill 目录中的交付文件。
- 已处理的 `MEDIA:` 行不会再出现在最终输出中，避免上游模型根据裸本地路径再次发起“文件在哪里”的追问。

## [Unreleased]

- 恢复 ACP `allow`（始终允许）权限策略：WebUI、配置校验与运行时一致支持，无需逐次确认。
- WebUI 重构为 Agent Nexus 管理控制台，并拆分为独立的样式、结构、图标和行为模块。
- 管理员 Console Password 改为 scrypt 哈希与 HttpOnly Cookie；客户端改用可命名、可限制 Agent
  范围的多 API Key。
- 兼容迁移旧 `authToken` 为数据面 Legacy Access Key，旧 Agent 与 Workspace 配置保持不变。
- 新增基于官方 SDK 的 A2A Agent Card、消息流、任务状态、Artifact 和取消支持。
- 新增认证失败限速、请求/提示超时、Session/SSE/连接容量和隐藏内部 500 错误。
- 明确支持 `0.0.0.0` 局域网监听并打印可用 LAN 地址。
- WebUI 全面改为简体中文，包括初始化、登录、导航、表单、状态、提示和日期格式。
- API 密钥列表改为紧凑信息层级，常用操作使用图标，低频与危险操作收纳到更多菜单。
- 修复智能体状态并发加载时错误显示“尚未检查”，统一以总览探测结果为状态源。
- A2A 配置改用完整 Agent Card URL，支持自动、JSON-RPC、HTTP+JSON 首选传输，并兼容旧 `agentUrl` 根地址配置。
- 新增持久化运行记录：每个任务记录原始请求、真实阶段、状态、结果摘要、耗时和产物，重启后
  保留历史并将未完成任务标记为中断。
- 新增仅管理员 Cookie 可访问的 `/v1/admin/runs` 列表/筛选与详情 API，以及全中文“运行记录”
  页面，区分当前运行和历史记录并每 5 秒自动刷新。
- 修复 Session message 入站会 `trim()` 用户任务的问题，现仅判空并保持原文交给 Agent。

## [0.1.4] - 2026-08-25

- 将 Gateway 拆分为独立仓库。
- 提供首次安装引导，由管理员手动设置至少 8 位的 Access Key。
- 新增独立 WebUI，支持 Agents、工作区白名单、密钥管理和亮色/暗色主题。
- 支持 OpenCode、Claude Code、Codex、Pi、OpenClaw 与 Hermes ACP Driver。
- 提供 Bearer 认证的 Agent inventory、Session、SSE 事件和控制面 API。
- 配置更新采用权限受限的临时文件原子替换，并热重载 Agent registry。
