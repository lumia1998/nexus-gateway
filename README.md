# Nexus Gateway

[![CI](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml)

`nexus-agentd` 是 Nexus Gateway 的服务端程序。它通过 WebUI 管理 ACP Agent、Workspace
allowlist、权限策略和 Access Key，再向 Koishi AgentNexus 或其他客户端提供统一 HTTP/SSE API。

这个仓库是完整的独立项目，不依赖 Koishi、CDN 或其他父仓库。运行时只在 Agent 所在机器启动
ACP stdio 子进程，客户端不需要逐个配置 Agent 命令。

## 一条命令启动

```bash
npm install -g nexus-agentd
nexus-agentd
```

配置不存在时会自动创建待初始化的 `./nexus-agentd.json`，使用当前目录作为 Workspace Root，
监听 `127.0.0.1:8787`，并打印 WebUI 地址。打开 WebUI 后会进入不可跳过的首次安装引导，
由管理员手动设置并确认至少 8 位的 Access Key；Gateway 不会自动生成或回显这个 Key。

Koishi 位于另一台机器时：

```bash
mkdir -p /data/repos
nexus-agentd --host 0.0.0.0 --workspace /data/repos
```

`--host`、`--port` 和 `--workspace` 只用于首次创建配置。之后通过当前配置文件启动：

```bash
nexus-agentd --config /etc/agent-nexus/nexus-agentd.json
```

## WebUI

首次打开 `http://HOST:8787/ui/` 时按引导设置 Access Key；初始化完成后输入同一个 Key 登录。
控制台支持：

- 添加、修改、启用、禁用和删除 Agent。
- 查看每个 Agent 的实际 readiness 和错误。
- 配置默认 Workspace 与 `ask` / `deny` 权限策略。
- 修改 Workspace Roots；保存前校验全部现有 Agent 仍位于 allowlist 内。
- 轮换 Access Key；旧 Key 立即失效，新 Key 只显示一次。
- 在概览、Agents、工作区和密钥管理之间切换，并保存亮色/暗色主题偏好。

WebUI 不依赖 CDN 或 Koishi，配置使用临时文件校验后原子替换并热重载；已运行 Session 不会因配置
变化而中断。

## Agent Driver

| Driver | 默认入口 |
|---|---|
| `opencode` | `opencode acp` |
| `claude` | `claude-agent-acp` |
| `codex` | `codex-acp` |
| `pi` | `pi-acp` |
| `openclaw` | `openclaw acp` |
| `hermes` | `hermes acp` |

Claude Code、Codex、Pi 通常需要先安装对应 Adapter：

```bash
npm install -g \
  @agentclientprotocol/claude-agent-acp \
  @agentclientprotocol/codex-acp \
  pi-acp
```

还需在本机完成各 Agent 自身的登录或 API Key 配置。
Hermes 使用原生 ACP extra；readiness 会执行 `hermes acp --check`。

## 配置

```json
{
  "initialized": true,
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "authToken": "env:NEXUS_AGENTD_TOKEN",
  "workspaceRoots": [
    "/data/repos"
  ],
  "agents": {
    "codex": {
      "driver": "codex",
      "name": "Codex",
      "workspace": "/data/repos/project",
      "permissionPolicy": "ask"
    }
  }
}
```

`command`、`args`、`inheritEnv` 和 `env` 属于本机高级配置，不可通过 HTTP/WebUI 写入。Secret
字段支持 `env:VAR`。

## API

```text
GET    /health
GET    /v1/bootstrap/status
POST   /v1/bootstrap/initialize
GET    /v1/agents
GET    /v1/config
PUT    /v1/config/workspace-roots
POST   /v1/config/access-key/rotate
PUT    /v1/config/agents/:id
DELETE /v1/config/agents/:id
POST   /v1/sessions
GET    /v1/sessions/:id
POST   /v1/sessions/:id/message
POST   /v1/sessions/:id/cancel
GET    /v1/sessions/:id/events
```

`/v1/bootstrap/status` 可匿名查询初始化状态；`/v1/bootstrap/initialize` 只在首次安装时可成功
一次，并要求同源 JSON 请求。除这两个端点、`/health` 和静态 WebUI 外均要求
`Authorization: Bearer ACCESS_KEY`。Session 创建只接受
`agentId` 与可选 `workspace`；消息接口只接受 `message`。额外 command、argv、shell 或环境字段会
返回 `400`。

## 安全

- 默认只监听 localhost；LAN 监听时使用防火墙限制 Koishi 来源地址。
- 不直接暴露公网；跨网络放在 HTTPS/mTLS 反向代理或可信隧道之后。
- 初始化后的配置文件包含 Key，应保持 `0600`；agentd 创建和更新配置时均保持该权限。
- Workspace 使用 `realpath` 边界校验，拒绝 traversal 和 symlink/junction 逃逸。
- 使用专用低权限系统账号运行 Gateway。
- `permissionPolicy=ask` 是默认值，`deny` 适合无人值守；没有自动批准模式。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
```

## License

[MIT](./LICENSE)
