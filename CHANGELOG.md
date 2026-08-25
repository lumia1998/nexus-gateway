# Changelog

本项目遵循语义化版本，记录 Nexus Gateway 面向使用者的重要变化。

## [0.1.4] - 2026-08-25

- 将 Gateway 拆分为独立仓库。
- 提供首次安装引导，由管理员手动设置至少 8 位的 Access Key。
- 新增独立 WebUI，支持 Agents、工作区白名单、密钥管理和亮色/暗色主题。
- 支持 OpenCode、Claude Code、Codex、Pi、OpenClaw 与 Hermes ACP Driver。
- 提供 Bearer 认证的 Agent inventory、Session、SSE 事件和控制面 API。
- 配置更新采用权限受限的临时文件原子替换，并热重载 Agent registry。

