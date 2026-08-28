# Agent Nexus Gateway

[![CI](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml)

`nexus-agentd` 是 Agent Nexus 的本地 Gateway。它在一台机器上统一管理 ACP 进程和远程 A2A
Agent，并向 Koishi AgentNexus 或其他客户端提供 HTTP/SSE API。管理控制台使用 **Agent Nexus**
品牌，不依赖 CDN、前端框架或父仓库。

如果你从 Koishi 使用 Gateway，请先阅读配套插件的
[安装与配置说明](https://github.com/lumia1998/koishi-plugin-agent-nexus#readme)。

## 快速开始

当前稳定版本已发布到 npm，推荐按下面的 npm 流程启动；如果要运行 GitHub 上尚未发布的分支代码，
再使用下方的源码部署方式。首次初始化、systemd 和 Agent 准备的完整说明见下文。

```bash
NPM_CONFIG_PREFIX="$HOME/.local"
npm install --global --prefix "$NPM_CONFIG_PREFIX" nexus-agentd@latest
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
mkdir -p "$HOME/.config/agent-nexus" "$HOME/projects"
nexus-agentd \
 --config "$HOME/.config/agent-nexus/nexus-agentd.json" \
 --host 0.0.0.0 \
 --port 8787 \
 --workspace "$HOME/projects"
```

当前仓库版本 `0.1.6` 已发布到 npm；可用 `npm view nexus-agentd version` 检查 registry 的 latest，
也可以将安装命令固定为 `nexus-agentd@0.1.6`。

## 安装与部署

### 运行要求

- Node.js 20 或更高版本。
- 一个明确的工作区目录。Gateway 只允许 Agent 访问 workspaceRoots 及其子目录。
- 计划使用的 ACP CLI/Adapter 已安装，并且对运行 Gateway 的同一个操作系统用户可用。
- LAN 部署需要在主机防火墙中限制 8787 端口来源；公网部署应放在 HTTPS/mTLS 反向代理或可信隧道后。

Gateway 不会替你安装 Agent，也不会替你执行 OpenCode、Claude Code 或 Hermes 的登录命令；这些属于宿主机运维步骤。

### npm 包安装（已发布版本）

`0.1.6` 已发布到 npm。目标版本尚未发布时，请使用下面的源码部署，或将本仓库打包后的 tarball 安装到目标机器。

发布状态可用 `npm view nexus-agentd version` 检查；生产环境需要可复现部署时，建议固定为 `nexus-agentd@0.1.6`。

生产环境建议使用专用的低权限系统用户，并把 npm 全局包安装到用户目录：

~~~bash
NPM_CONFIG_PREFIX="$HOME/.local"
npm install --global --prefix "$NPM_CONFIG_PREFIX" nexus-agentd@0.1.6
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
~~~

启动命令是 nexus-agentd，npm 包的 CLI 入口是 dist/cli.js。

### 首次初始化

首次启动时指定配置文件、监听地址和工作区：

~~~bash
mkdir -p "$HOME/.config/agent-nexus" "$HOME/projects"
nexus-agentd \
  --config "$HOME/.config/agent-nexus/nexus-agentd.json" \
  --host 0.0.0.0 \
  --port 8787 \
  --workspace "$HOME/projects"
~~~

首次启动后：

1. 打开终端打印的 http://<gateway-host>:8787/ui/。
2. 设置至少 12 位的 Console Password。
3. 在 API Keys 页面创建给 Koishi 或其他客户端使用的数据面 API Key。
4. 在 Workspaces 页面确认工作区 allowlist，在 Agents 页面检查 ACP/A2A Agent。

Console Password 和 API Key 是两套凭证：前者只用于管理页面登录，后者只用于数据面 API。不要把 Console Password 填到 Koishi 插件的 gatewayKey。

配置已经存在时，--host、--port 和 --workspace 不会重新覆盖已有配置；后续启动只需要指定同一个 --config。
也可以通过 NEXUS_AGENTD_CONFIG 环境变量提供配置路径。

### systemd user service（可选）

仓库不内置 systemd unit。使用 npm 包时，可以创建 ~/.config/systemd/user/nexus-agentd.service：

~~~ini
[Unit]
Description=Nexus Agent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/projects
Environment=NODE_ENV=production
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=%h/.local/bin/nexus-agentd --config %h/.config/agent-nexus/nexus-agentd.json
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillMode=mixed
UMask=0077

[Install]
WantedBy=default.target
~~~

加载、启用和检查：

~~~bash
systemctl --user daemon-reload
systemctl --user enable --now nexus-agentd.service
systemctl --user status nexus-agentd.service
~~~

常用运维命令：

~~~bash
systemctl --user restart nexus-agentd.service
journalctl --user -u nexus-agentd.service -n 100 --no-pager
curl http://127.0.0.1:8787/health
~~~

如果使用 nvm、mise 或其他用户级 Node 安装方式，请把 unit 中的 PATH 改成实际值，否则 Gateway 可能能启动，但找不到 Agent CLI。
需要用户未登录时也自动启动时，可按发行版策略执行 loginctl enable-linger "$USER"。

如果按源码部署，把 unit 中的 `WorkingDirectory` 改成 Gateway 工作树，并将 `ExecStart` 改为实际 Node
绝对路径加上 `dist/cli.js`，例如：`/usr/bin/node %h/nexus-gateway/dist/cli.js --config
%h/.config/agent-nexus/nexus-agentd.json`。不要在 systemd 中依赖交互式 Shell 的 nvm 初始化。

### 源码部署（开发分支或未发布版本）

源码部署适合当前仓库和尚未发布到 npm 的版本；生产环境请使用外部进程管理器负责守护，
不要把运行数据、Artifact 仓库或密钥放进 Git 工作树：

~~~bash
git clone https://github.com/lumia1998/nexus-gateway.git
cd nexus-gateway
mkdir -p "$HOME/.config/agent-nexus" "$HOME/projects"
npm ci
npm run build
node dist/cli.js \
  --config "$HOME/.config/agent-nexus/nexus-agentd.json" \
  --host 0.0.0.0 \
  --port 8787 \
  --workspace "$HOME/projects"
~~~

源码仓库没有 Docker、PM2 或 systemd 配置，需要由宿主机的进程管理器负责守护和重启。

## 认证边界

控制面和数据面使用不同凭证：

- Console Password 只用于管理员登录。服务端以 scrypt 哈希保存，登录后只下发
  `HttpOnly; SameSite=Strict` Cookie，浏览器不保存密码。
- API Key 只用于 `/v1/agents` 和 `/v1/sessions/*`。Key 可以命名、限制为全部或指定 Agent、
  停用、删除、重生成和按需 reveal。
- Key 自动生成为 `nx_sk_...`；也可设置至少 16 位的自定义值。
- 为支持管理员按需 reveal，API Key 可恢复地保存在权限为 `0600` 的配置文件中，不会出现在
  普通配置响应或日志里。

旧配置中的 `authToken` 会继续作为名为 `Legacy Access Key` 的全 Agent 数据面 Key 工作。它不会
被当成 Console Password。升级后第一次打开 WebUI 会要求单独设置管理员密码，原有 Agent 和
Workspace 配置保持不变。

## WebUI

固定侧栏有总览、运行记录、智能体、工作区、文件、API 密钥和运行设置七个主页面。管理员菜单位于侧栏底部，
提供 Light / Dark / System 主题、修改密码和退出登录。

- Overview 只显示真实 Agent、Ready 和当前内存 Session 数量。
- 运行记录把当前任务和历史任务分开显示，记录用户原始任务、真实运行阶段、状态、结果摘要、
  耗时和产物；每 5 秒自动刷新，也可查看完整详情。
- Agents 支持本地 ACP 与远程 A2A；readiness 每 20 秒自动刷新，也可手动刷新。
- Workspaces 管理 ACP 的 realpath allowlist；A2A 不使用本地 Workspace。
- 文件页面在 allowlist 内浏览、上传、下载、新建目录、重命名和删除文件，并可生成临时公开链接。
  发布操作只复制选定文件，不会把工作区映射成公开静态目录。
- API Keys 显示真实状态和最后使用时间，并提供独立的显式 reveal 操作。
- 运行设置可以直接修改 Session 空闲有效期、ACP 单次任务超时和清理任务周期，保存后立即热生效。
  默认值分别是 24 小时、30 分钟和 60 秒；A2A 请求超时在每个 Agent 的编辑页单独设置，默认 60 秒、
  最大 30 分钟。

## Agent 协议

### ACP

| Driver | 默认入口 |
|---|---|
| `opencode` | `opencode acp` |
| `claude` | `claude-agent-acp` |
| `codex` | `codex-acp` |
| `pi` | `pi-acp` |
| `openclaw` | `openclaw acp` |
| `hermes` | `hermes acp` |

Claude Code、Codex、Pi 通常需要对应 Adapter：

```bash
npm install -g \
  @agentclientprotocol/claude-agent-acp \
  @agentclientprotocol/codex-acp \
  pi-acp
```

`command`、`args`、`inheritEnv` 和 `env` 是仅可在本机配置文件修改的高级字段，WebUI 不接受这些
字段。Workspace 在启动进程前经过 `realpath` 边界校验。

### OpenCode、Claude Code 和 Hermes 的宿主机准备

这三个 Agent 不需要修改 Gateway 源码，差异只在宿主机的可执行文件、ACP 入口和登录环境：

| Agent | Gateway 默认启动命令 | readiness 检查 | 宿主机要求 |
| --- | --- | --- | --- |
| OpenCode | opencode acp | opencode --version | 安装 OpenCode CLI；使用原生 ACP。 |
| Claude Code（CC） | claude-agent-acp | claude-agent-acp --version | 安装 @agentclientprotocol/claude-agent-acp，并准备 Claude Code 登录环境。 |
| Hermes | hermes acp | hermes acp --check | 安装 Hermes CLI；使用原生 ACP。 |

Claude Code、Codex 和 Pi 的常用 Adapter 可以一起安装：

~~~bash
npm install --global --prefix "$HOME/.local" \
  @agentclientprotocol/claude-agent-acp \
  @agentclientprotocol/codex-acp \
  pi-acp
~~~

OpenCode 和 Hermes 请按各自项目的官方方式安装。Gateway 不执行 OpenCode、Claude Code 或 Hermes 的登录命令；登录必须在运行 nexus-agentd 的同一个操作系统用户环境中完成。

可在同一用户的交互式 Shell 中检查：

~~~bash
command -v opencode && opencode --version
command -v claude-agent-acp && claude-agent-acp --version
command -v hermes && hermes acp --check
~~~

如果命令在交互式 Shell 中可用、在 systemd 中不可用，检查 unit 的 PATH、HOME、XDG_CONFIG_HOME 和登录凭据。某个 Agent 未安装或检查失败不会影响其他 Agent。

一个最小的 ACP 配置示例（可在 WebUI 的 Agents 页面创建，也可写入本机配置文件）：

~~~json
{
  "workspaceRoots": ["/home/lumia/projects"],
  "agents": {
    "opencode": {
      "protocol": "acp",
      "driver": "opencode",
      "name": "OpenCode",
      "workspace": "/home/lumia/projects"
    },
    "claude": {
      "protocol": "acp",
      "driver": "claude",
      "name": "Claude Code",
      "workspace": "/home/lumia/projects"
    },
    "hermes": {
      "protocol": "acp",
      "driver": "hermes",
      "name": "Hermes",
      "workspace": "/home/lumia/projects"
    }
  }
}
~~~

`workspace` 必须位于 `workspaceRoots` 之下；如果只通过 WebUI 配置，Gateway 会校验并保存这些字段。

Gateway 会在每个 Agent Session 的首次请求前自动注入一段 Agent Nexus 交互规范，提醒 Agent 在需要
用户选择、确认、支付或补充信息时使用 ACP elicitation/A2A `input-required`，不要只输出普通文本问题。
这段规范不需要为 OpenCode、Claude Code 或 Hermes 手工重复配置。若某个 Agent 还需要额外规则，可在 Agent
配置中增加 `instructions`；它会在内置规范之后追加，并限制为最多 32768 个字符。提示词注入只是行为约定，
Agent 仍必须实际支持相应的 ACP/A2A/MCP 用户输入机制，Gateway 不会把普通文本自动猜成等待状态。

### A2A

A2A 使用官方 `@a2a-js/sdk` 客户端，通过完整的 Agent Card URL 发现名称、能力和实际调用地址，
支持 JSON-RPC / HTTP+JSON 传输、流式消息（SDK 自动回退为非流式）、任务状态、Artifacts 和取消。
首选传输可设为 `auto`、`jsonrpc` 或 `http-json`；可配置无认证、Bearer 或自定义 Header。私有网段
和局域网 URL 不会被禁止。

```json
{
  "protocol": "a2a",
  "name": "Research Agent",
  "instructions": "需要用户确认时保持任务等待，并使用 Agent 的 input-required 能力。",
  "agentCardUrl": "http://192.168.1.20:8080/.well-known/agent-card.json",
  "preferredTransport": "auto",
  "auth": {
    "type": "bearer",
    "value": "env:RESEARCH_AGENT_TOKEN"
  },
  "timeoutMs": 60000
}
```

旧配置中的 `agentUrl` 仍按“服务根地址 + `/.well-known/agent-card.json`”方式发现 Card，无需手工
迁移；在 WebUI 中保存一次后会写入新的 `agentCardUrl` 字段。

## 配置

推荐从首次启动生成的待初始化配置开始。完整示例见
[`nexus-agentd.example.json`](./nexus-agentd.example.json)。数值和数组字段会严格校验，错误配置
会在启动或原子热重载前被拒绝，不再静默截断或忽略错误类型。

常用资源限制：

```json
{
  "maxRequestBytes": 1048576,
  "maxAttachmentBytes": 33554432,
  "artifactStoragePath": "./artifacts",
  "maxArtifactBytes": 536870912,
  "maxArtifactStorageBytes": 4294967296,
  "maxPublishedArtifacts": 4096,
  "maxConcurrentArtifactPublishes": 4,
  "artifactTtlMs": 86400000,
  "requestTimeoutMs": 30000,
  "promptTimeoutMs": 1800000,
  "cleanupIntervalMs": 60000,
  "maxSessions": 64,
  "maxSseConnections": 128,
  "maxConnections": 256,
  "sessionTtlMs": 86400000
}
```

输入附件通过 Session 临时保存，默认单个文件最多 16 MiB、单个 Session 最多 32 MiB、最多 16 个文件；
HTTP 上传总上限由 `maxAttachmentBytes` 控制，默认 32 MiB，允许调整到 64 MiB。Session 释放时附件也会
一起清理。ACP 会优先使用 Agent 声明支持的 image/audio/embeddedContext 能力，否则为 Agent 提供受限的
`file://` resource link；A2A 则以带文件名和媒体类型的二进制 Part 发送。

输出文件发布由 Gateway 自己的 `artifactStoragePath` 管理，默认单文件上限 512 MiB、链接有效期
24 小时。上传和复制均使用流，不把文件编码进 JSON；公开 URL 使用 256 位随机 token，过期文件由
后台清理。ACP/A2A 返回的内联二进制 Artifact 也会先落入该仓库，再在 Session 响应中改为 URL。

### 多轮输入与确认

ACP elicitation、ACP permission request 和 A2A `input_required` 都会让 Session 进入等待状态，并在
Session 响应的 `pendingRequest` 中返回等待提示和可选项。客户端只需重复调用同一个
`POST /v1/sessions/:id/message`：

~~~text
POST /v1/sessions/:id/message
{"message":"第一个"}
~~~

Gateway 会复用原来的协议 Session/Task/Context，不会创建新任务。Agent 可以在下一轮再次进入
`input_required`，因此套餐选择、堂食方式、取餐时间和支付完成可以组成一条连续流程。需要表达业务
步骤时，可在 `pendingRequest` 中提供可选的 `step`、`inputType` 和 JSON-safe `metadata`；这些字段
不应放入密钥或其他敏感信息。支付完成消息仍必须由上游 MCP 根据订单/支付状态核验，不能只信任用户文本。

对 ACP Agent，Gateway 会在 Session 首次 prompt 前注入内置交互规范；对 A2A Agent，则把同一规范放在首个
用户消息的前缀中。由于 A2A/ACP 的 system-message 能力在不同 Agent 实现中并不统一，这是一种兼容性更好的
宿主提示方式。它不能替代 Agent 对 elicitation 或 `input-required` 的实现：Agent 必须真正发起协议级等待，
Gateway 才能暂停 Session 并在用户回复后继续。

API Key 与 A2A 认证值支持 `env:VAR`。Console Password 哈希由 WebUI 管理，不要手工生成或把
旧 `authToken` 复制到该字段。

运行记录保存在配置文件同目录的 `nexus-agentd-runs.json` sidecar 中，默认最多保留 1000 条。
记录文件使用 `0600` 权限和原子替换；进行中的任务若遇到 Gateway 重启，会在下次启动时标记为
“已中断/失败”，而不会一直显示为运行中。

## API

匿名端点：

```text
GET  /health
GET  /v1/bootstrap/status
POST /v1/bootstrap/initialize
GET  /v1/admin/auth/status
POST /v1/admin/auth/login
POST /v1/admin/auth/logout
```

管理员 Cookie 端点：

```text
GET    /v1/admin/overview
GET    /v1/admin/config
GET    /v1/admin/agents
GET    /v1/admin/runs
GET    /v1/admin/runs/:id
PUT    /v1/admin/agents/:id
DELETE /v1/admin/agents/:id
PUT    /v1/admin/config/workspace-roots
PUT    /v1/admin/config/runtime
PUT    /v1/admin/password
GET    /v1/admin/api-keys
POST   /v1/admin/api-keys
PATCH  /v1/admin/api-keys/:id
DELETE /v1/admin/api-keys/:id
POST   /v1/admin/api-keys/:id/reveal
POST   /v1/admin/api-keys/:id/regenerate
GET    /v1/admin/files/roots
GET    /v1/admin/files
GET    /v1/admin/files/content
PUT    /v1/admin/files/content
DELETE /v1/admin/files/content
POST   /v1/admin/files/directory
POST   /v1/admin/files/move
POST   /v1/admin/files/publish
```

Bearer API Key 数据面：

```text
GET  /v1/agents
POST /v1/sessions
GET  /v1/sessions/:id
POST /v1/sessions/:id/attachments
POST /v1/sessions/:id/message
POST /v1/sessions/:id/cancel
GET  /v1/sessions/:id/events
GET  /v1/sessions/:id/files
GET  /v1/sessions/:id/files/content
POST /v1/sessions/:id/files/publish
```

`GET /v1/artifacts/:token/:expiresAt/:name` 是匿名下载端点；它只接受发布操作生成的不可猜测 token，并在 TTL
到期后返回 404。该端点不支持目录列举，也不能据此访问原工作区。

API Key 的 Agent scope 在 Agent inventory、Session 创建和后续 Session 操作上都会检查；Session
还绑定创建它的 Key，其他 Key 即使拥有同一 Agent scope 也不能读取或控制该 Session。
运行记录接口仅接受管理员 Cookie，数据面 API Key 无权读取。

## 局域网安全

- 默认仍只监听 localhost；需要 LAN 时显式使用 `--host 0.0.0.0`，并用主机防火墙限制来源。
- LAN 上的纯 HTTP 为兼容 Cookie 默认不设置 `Secure`；跨不可信网络应放在 HTTPS/mTLS 反向代理
  或可信隧道后，并将 `secureAdminCookies` 设为 `true`。
- 管理写操作要求同源 `Origin`，Cookie 使用 `SameSite=Strict`；登录和无效 API Key 有失败限速。
- File Browser 的所有路径都在 realpath 后重新校验工作区边界；Session 发布还同时校验 API Key
  scope 与 Session 所有权。公开链接应只发送给预期接收者。
- 不直接暴露公网。使用专用低权限系统账号运行 Gateway。
- 配置更新使用 `0600` 临时文件校验后原子替换；Secret 不进入普通响应和结构化错误日志。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
```

## License

[MIT](./LICENSE)
