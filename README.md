# Agent Nexus Gateway

[![CI](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml)

`nexus-agentd` 是 Agent Nexus 的本地 Gateway。它在一台机器上统一管理 ACP 进程和远程 A2A
Agent，并向 Koishi AgentNexus 或其他客户端提供 HTTP/SSE API。管理控制台使用 **Agent Nexus**
品牌，不依赖 CDN、前端框架或父仓库。

## 启动

```bash
npm install -g nexus-agentd
nexus-agentd
```

首次启动会创建 `./nexus-agentd.json`，默认监听 `127.0.0.1:8787`。打开打印出的 WebUI 地址，
设置至少 12 位的 Console Password，然后登录。新安装不会自动创建 API Key；在控制台的
**API Keys** 页面按实际客户端需要创建。

局域网使用时显式监听所有网卡：

```bash
mkdir -p /data/repos
nexus-agentd --host 0.0.0.0 --workspace /data/repos
```

`0.0.0.0` 是受支持的监听地址。CLI 会同时打印本机和检测到的 LAN IPv4 WebUI 地址。
`--host`、`--port` 和 `--workspace` 只用于首次创建配置；配置存在后直接指定文件：

```bash
nexus-agentd --config /etc/agent-nexus/nexus-agentd.json
```

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

固定侧栏有总览、运行记录、智能体、工作区、API 密钥和运行设置六个主页面。管理员菜单位于侧栏底部，
提供 Light / Dark / System 主题、修改密码和退出登录。

- Overview 只显示真实 Agent、Ready 和当前内存 Session 数量。
- 运行记录把当前任务和历史任务分开显示，记录用户原始任务、真实运行阶段、状态、结果摘要、
  耗时和产物；每 5 秒自动刷新，也可查看完整详情。
- Agents 支持本地 ACP 与远程 A2A；readiness 每 20 秒自动刷新，也可手动刷新。
- Workspaces 管理 ACP 的 realpath allowlist；A2A 不使用本地 Workspace。
- API Keys 显示真实状态和最后使用时间，并提供独立的显式 reveal 操作。
- 运行设置可以直接修改 Session 空闲有效期、ACP 单次任务超时和清理任务周期，保存后立即热生效。
  默认值分别是 24 小时、30 分钟和 60 秒；A2A 请求超时在每个 Agent 的编辑页单独设置，默认 60 秒、
  最大 30 分钟。

## Agent 协议

每个任务都会附带协议级完成约束：Agent 在结束 turn 前必须处理完工作，等待用户输入或授权时必须使用
协议请求，并提供非空最终说明或 Artifact。Gateway 只接受以下完成证明：

- ACP `session/prompt` 返回 `stopReason=end_turn`；`max_tokens`、`max_turn_requests`、拒绝和取消不会被
  误报为成功。
- A2A Task 明确进入 `COMPLETED`；如果远端直接返回 Message 而没有创建 Task，则以完整消息流结束作为
  turn 边界。已经出现 Task 状态但没有终态的流会标记失败。
- Session 仍有待处理的 permission/input 请求，或者最终文本与 Artifact 都为空时，不允许进入
  `completed`。

成功的 Session 响应包含 `completion`，其中记录当前 Run ID、协议、完成来源、stop reason、最终文本和
产物存在性以及完成时间。这个证明验证的是协议边界和结果存在性，不替代业务内容本身的语义验收。

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

### A2A

A2A 使用官方 `@a2a-js/sdk` 客户端，通过完整的 Agent Card URL 发现名称、能力和实际调用地址，
支持 JSON-RPC / HTTP+JSON 传输、流式消息（SDK 自动回退为非流式）、任务状态、Artifacts 和取消。
首选传输可设为 `auto`、`jsonrpc` 或 `http-json`；可配置无认证、Bearer 或自定义 Header。私有网段
和局域网 URL 不会被禁止。

```json
{
  "protocol": "a2a",
  "name": "Research Agent",
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

ACP Session 还支持显式发布工作区文件。发布接口只接受 realpath 仍位于该 Session 工作区中的普通文件，
拒绝目录、路径穿越和符号链接逃逸，单个文件最多 12 MiB。响应将文件作为 Session Artifact 返回；不会
暴露宿主机绝对路径。

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
```

Bearer API Key 数据面：

```text
GET  /v1/meta
GET  /v1/agents
POST /v1/sessions
GET  /v1/sessions/:id
DELETE /v1/sessions/:id
POST /v1/sessions/:id/attachments
POST /v1/sessions/:id/message
POST /v1/sessions/:id/requests/:requestId/resolve
POST /v1/sessions/:id/artifacts/publish
POST /v1/sessions/:id/cancel
GET  /v1/sessions/:id/events
```

`/v1/meta` 和 Session 响应包含 Gateway `instanceId`；完成的 Session 还包含与当前 Run 绑定的
`completion` 证明，客户端可识别进程重启和迟到/伪造的完成状态。授权与输入通过精确的
`requestId` 解析；过期 ID 返回 `409`，不会误答后续请求。`DELETE /v1/sessions/:id` 会取消活动任务、
释放 Agent 整个进程组并移除内存 Session。Gateway 停止时会先终止 Session，再在有限宽限期后关闭残留
HTTP/SSE 连接，避免长连接或 Agent 孙进程阻塞服务重启。

API Key 的 Agent scope 在 Agent inventory、Session 创建和后续 Session 操作上都会检查；Session
还绑定创建它的 Key，其他 Key 即使拥有同一 Agent scope 也不能读取或控制该 Session。
运行记录接口仅接受管理员 Cookie，数据面 API Key 无权读取。

## 局域网安全

- 默认仍只监听 localhost；需要 LAN 时显式使用 `--host 0.0.0.0`，并用主机防火墙限制来源。
- LAN 上的纯 HTTP 为兼容 Cookie 默认不设置 `Secure`；跨不可信网络应放在 HTTPS/mTLS 反向代理
  或可信隧道后，并将 `secureAdminCookies` 设为 `true`。
- 管理写操作要求同源 `Origin`，Cookie 使用 `SameSite=Strict`；登录和无效 API Key 有失败限速。
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
