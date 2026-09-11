# Agent Nexus Gateway

[![CI](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/lumia1998/nexus-gateway/actions/workflows/ci.yml)

`nexus-agentd` 是一个单进程的本地 Agent 网关。它把本机上的 ACP 进程和远程 A2A Agent 统一管理起来，
通过 HTTP/SSE 向 Koishi AgentNexus 等客户端提供一致的会话、消息、事件、权限、取消和产物接口，
并内置一个不依赖 CDN、前端框架或父仓库的管理控制台。

适用场景：在自己管理的机器或服务器上运行编码 Agent，希望多个客户端共享同一套 Agent 配置，
并且能随时看清任务执行到了哪一步。

## 快速开始

```bash
npm install -g nexus-agentd
nexus-agentd
```

首次启动会在当前目录创建 `./nexus-agentd.json`，默认监听 `0.0.0.0:8787`。打开终端打印的 WebUI
地址，输入启动日志中的 **Setup token**，设置至少 12 位的 Console Password，然后登录。

新安装不会自动创建 API Key，请在控制台 **API Keys** 页面按客户端需要创建。

局域网使用（所有网卡本就是默认值，也可显式指定）：

```bash
mkdir -p /data/repos
nexus-agentd --host 0.0.0.0 --workspace /data/repos
```

CLI 会同时打印本机与检测到的 LAN IPv4 地址。`--host`、`--port`、`--workspace` 只在首次创建配置
时生效；配置已存在时直接指定文件：

```bash
nexus-agentd --config /etc/agent-nexus/nexus-agentd.json
```

## 认证边界

控制面与数据面使用不同凭证，互不替代：

- **Console Password** 仅用于管理员登录。服务端以 scrypt 哈希保存，登录后只下发
  `HttpOnly; SameSite=Strict` Cookie，浏览器不保存密码。
- **API Key** 仅用于 `/v1/agents` 与 `/v1/sessions/*`。Key 可命名、限定全部或指定 Agent、停用、
  删除、重新生成，并按需 reveal。
- Key 自动生成为 `nx_sk_...`，也可设置至少 16 位的自定义值。
- 为支持管理员按需 reveal，API Key 可恢复地保存在权限 `0600` 的配置文件中，不会出现在普通配置
  响应或日志里。

旧配置中的 `authToken` 继续作为名为 `Legacy Access Key` 的全 Agent 数据面 Key 工作，它不会被当作
Console Password。升级后首次打开 WebUI 会要求单独设置管理员密码，原有 Agent 与 Workspace 配置不变。

首次安装和旧配置补设密码都需要 Setup token。令牌只存在于当前进程，初始化成功即失效，未初始化时
每次启动重新生成，且不会写入 URL、配置文件或匿名接口。嵌入使用时从
`startAgentd(...).controlPlane.setupToken` 获取。不要向不可信人员开放服务启动日志。

## 完成契约

每个任务都附带协议级完成约束：Agent 在结束 turn 前必须处理完工作，等待用户输入或授权时必须使用
协议请求，并提供非空最终说明或 Artifact。Gateway 只接受以下完成证明：

- ACP `session/prompt` 返回 `stopReason=end_turn`；`max_tokens`、`max_turn_requests`、拒绝和取消
  不会被误报为成功。
- A2A Task 明确进入 `COMPLETED`；若远端直接返回 Message 而未创建 Task，则以完整消息流结束作为 turn
  边界。已经出现 Task 状态但没有终态的流会标记失败。
- Session 仍有待处理的 permission/input 请求，或最终文本与 Artifact 都为空时，不允许进入 `completed`。

成功的 Session 响应包含 `completion`，记录当前 Run ID、协议、完成来源、stop reason、最终文本、
产物存在性与完成时间。它验证的是协议边界和结果存在性，不替代业务内容的语义验收。

## WebUI

侧栏按「运行」和「网关配置」分组，提供总览、运行记录、智能体、工作区、产物、API 密钥页面；
底部是独立的「设置」与「退出登录」。

- **总览**：统计卡一行四个并支持点击跳转（智能体、活动任务、异常）。「智能体状态」面板只在有异常、
  未配置智能体或配置读取失败时出现，健康时整块隐藏。系统指标（会话 / SSE / 内存 / 配额 / 存储）
  合并为紧凑网格。失败与等待处理的列表支持行内取消与删除记录。
- **运行记录**：当前任务与历史任务分开显示，记录原始任务、真实运行阶段、状态、结果摘要、耗时和产物。
  每 5 秒自动刷新，搜索、筛选和统计作用于全部保留记录（默认最多 1000 条），默认每页 50 条。
  列表只返回最多 240 字符的任务预览，详情按需读取全文。轮询保留搜索框、输入法组合态与筛选控件，
  表格详情和菜单支持键盘操作。详情支持取消、补充输入、显式选择权限和重试；断线会明确标注旧数据。
- **智能体**：支持本地 ACP 与远程 A2A。总览/智能体页在前台时每 20 秒刷新 readiness，也可手动刷新。
  ACP 的「命令可用」只代表命令探测通过，不代表 ACP 握手成功；A2A 的「Card 可用」也不保证任务执行成功。
- **工作区**：管理 ACP 的 realpath allowlist，每行显示该根目录正被哪些智能体使用。A2A 不使用本地工作区。
- **产物**：跨运行浏览 Agent 产出的文件，支持图片 / 视频 / 音频 / 文本在线预览、复制文件链接、下载与
  单个删除。列表默认不加载内容，点击进入详情抽屉预览；文本预览超过 512 KiB 不自动加载，
  超过 64 KiB 截断显示。
- **API 密钥**：显示真实状态与最后使用时间，提供独立的显式 reveal 操作。

登录成功即显示控制台；配置、密钥、历史和 Agent 探测独立加载，某项失败不影响其余页面，并显示重试
与上次成功时间。设置中的运行参数与控制台密码独立保存，保留毫秒精度，只改密码不会写运行参数。

运行参数默认值：会话空闲有效期 24 小时、单次 ACP 任务超时 30 分钟、清理周期 60 秒。会话空闲有效期
和清理周期热生效；任务期限与智能体参数影响新建会话，已有会话保留创建时的值。A2A 请求超时在每个
Agent 的编辑页单独设置，默认 60 秒、最大 30 分钟。

## 接入 Agent

### ACP

| Driver | 默认入口 |
|---|---|
| `stdio` | 本地配置文件中的显式 `command`、`args` |
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

`command`、`args`、`probeArgs`、`inheritEnv` 和 `env` 是仅可在本机配置文件修改的高级字段，WebUI
不接受这些字段。Workspace 在启动进程前经过 `realpath` 边界校验。通用 `stdio` 驱动用于自定义入口，
必须指定 `command`，用 `probeArgs` 指定可用性检查参数（例如 `["--version"]`）；编辑其他字段时保留
这些本地配置。命令探测不等于 ACP 握手成功。

权限策略支持 `ask`（询问）、`allow`（自动允许单次）和 `deny`（拒绝）。`allow` 只选择 Agent 提供的
`allow_once`，缺少该选项则取消授权，不回退到永久授权。`ask` 模式下普通 `action: "accept"` 也只选择
单次授权，永久授权需要客户端明确传入对应 `optionId`。这不限制重复的单次自动授权，但只提供永久选项的
Agent 需要改用 `ask` 并显式处理。默认仍为 `ask`。

ACP 初始化和 `session/new` 共用 30 秒握手期限，超时会失败并回收子进程及会话槽位，该期限独立于任务
执行超时。

### A2A

A2A 使用官方 `@a2a-js/sdk` 客户端，通过完整的 Agent Card URL 发现名称、能力和实际调用地址，支持
JSON-RPC / HTTP+JSON 传输、流式消息（SDK 自动回退为非流式）、任务状态、Artifacts 和取消。首选传输
可设为 `auto`、`jsonrpc` 或 `http-json`；可配置无认证、Bearer 或自定义 Header。私有网段和局域网 URL
不会被禁止。

Agent Card 和它声明的全部接口 URL 必须使用 HTTP(S)，不含用户名、密码或 fragment；接口必须与配置的
Card 地址同源（协议、主机、端口均一致）。发现和业务请求都拒绝 HTTP 重定向（包括同源重定向），请直接
配置最终地址。跨源部署可通过同源反向代理接入，避免把认证值发送给 Card 指定的其他站点。

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

旧配置中的 `agentUrl` 仍按「服务根地址 + `/.well-known/agent-card.json`」方式发现 Card，无需手工
迁移；在 WebUI 中保存一次后会写入新的 `agentCardUrl` 字段。

A2A 超时分为三种，均为整数毫秒：

| 字段 | 作用 | 默认 / 范围 |
|---|---|---|
| `timeoutMs` | Card、普通请求全程及流建连 | 60 秒；1 秒至 30 分钟 |
| `taskTimeoutMs` | 单轮任务总期限 | 继承全局 `promptTimeoutMs`；10 秒至 24 小时 |
| `streamIdleTimeoutMs` | 流持续没有进度时的等待期限 | 继承 `timeoutMs`；1 秒至 30 分钟 |

旧配置的 `timeoutMs` 继续限制请求，并作为未配置流失联期限时的默认值，不再隐式缩短任务总期限。长任务
持续输出时可超过请求超时。通过管理 API 更新时，省略可选字段保留原值，传 `null` 清除覆盖并恢复继承。

控制面更新的影响范围：

| 配置 | 生效范围 |
|---|---|
| Key 启用、scope、轮换与删除 | 新请求立即校验，受影响旧 SSE 立即关闭；任务继续执行 |
| 会话 TTL、清理周期 | 当前清理任务使用新值 |
| Agent 参数、权限策略、任务期限、Workspace | 新会话使用新值；已有会话与 ACP 文件来源根保留创建时的值 |
| 监听地址、端口、来源、Cookie / HTTP 连接设置 | 重启生效 |

## 配置

推荐从首次启动生成的待初始化配置开始，完整示例见 [`nexus-agentd.example.json`](./nexus-agentd.example.json)。
数值和数组字段会严格校验，错误配置会在启动或原子热重载前被拒绝，不会静默截断或忽略错误类型。

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

API Key 与 A2A 认证值支持 `env:VAR`。Console Password 哈希由 WebUI 管理，不要手工生成，也不要把旧
`authToken` 复制到该字段。

### 输入附件

输入附件通过 Session 临时保存：默认单个文件最多 16 MiB、单个 Session 最多 32 MiB、最多 16 个文件。
HTTP 上传总上限由 `maxAttachmentBytes` 控制，默认 32 MiB，可调整到 64 MiB。Session 释放时附件一并清理。

ACP 优先使用 Agent 声明支持的 image/audio/embeddedContext 能力，否则提供受限的 `file://` resource
link；A2A 则以带文件名和媒体类型的二进制 Part 发送。

### 产物

ACP Session 支持显式发布工作区文件。发布接口只接受 realpath 仍位于该 Session 工作区中的普通文件，
拒绝目录、路径穿越和符号链接逃逸，单个文件最多 12 MiB。请求 body 支持单文件 `{ "path": "..." }` 或
批量 `{ "paths": ["..."] }`（一次最多 32 条），响应在正常 Session 视图上附加 `publishedArtifacts`
数组，本次发布的文件以 base64 内联返回；不会暴露宿主机绝对路径，也不生成外部 URL。

Agent 也可以在最终文本里用 `MEDIA:<path>` 行声明交付文件，Gateway 在该轮完成前把它们快照为 Artifact，
已处理的 `MEDIA:` 行不会出现在最终输出里。这条路径的边界是配置的 `workspaceRoots`，比发布接口的
Session 工作区更宽——Agent 常把交付文件写在工作区旁边的 skill 目录，该目录必须在 `workspaceRoots` 内
才会被附加。单轮最多 8 个文件、单个文件最多 12 MiB；越界路径（含 `file://` 形式）被拒绝，原因写入
Session 事件流，该轮仍正常完成。

产物有可用内容时持久化到运行历史文件旁的 `.artifacts` 目录；仅有远端 URL 的产物保留元数据，不主动
下载。详情中的 `downloadable` 和 `storageStatus` 表示下载状态。下载需要身份验证，不能将链接作为公开
分享地址。

### 配额与保留

本地配置的 `quotas` 设置每 Key 的 Session、运行任务、SSE 和上传字节限制，默认分别为 16、4、8、
32 MiB，连接数量默认也受全局上限约束。`history` 默认保留 1000 条、30 天、64 MiB；`artifacts` 默认
保留 30 天、总量 512 MiB、单项 12 MiB、排队内容 64 MiB。活动任务受保护，因此历史预算不是强制截断
活动记录的硬上限。完整字段见 `nexus-agentd.example.json`。

运行记录保存在配置文件同目录的 `nexus-agentd-runs.json` sidecar 中。记录文件使用 `0600` 权限和原子
替换；进行中的任务若遇到 Gateway 重启，会在下次启动时标记为「已中断/失败」，而不会一直显示为运行中。

## API

### 匿名端点

```text
GET  /health
GET  /v1/bootstrap/status
POST /v1/bootstrap/initialize
GET  /v1/admin/auth/status
POST /v1/admin/auth/login
POST /v1/admin/auth/logout
```

### 管理员 Cookie 端点

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

### Bearer API Key 数据面

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
GET  /v1/runs/:runId/artifacts/:artifactId
```

### 管理操作与诊断

控制台运行详情支持取消、补充输入、显式选择权限和重试。管理员 Cookie 可以跨 Key 执行这些操作，数据面
仍检查原 Key 归属及 Agent scope。对应接口为 `POST /v1/admin/runs/:id/cancel`、
`POST /v1/admin/runs/:id/respond` 和 `POST /v1/admin/runs/:id/retry`。取消和重试发送 `{}`；回复发送
当前 `requestId` 与 `message`、`optionId` 或 `action`。过期请求及非当前轮次不能修改后续任务。

「重置/重试」以原任务创建新 Session，保留旧记录和原 Key 归属，并记录 `retryOfRunId`。运行中、任务
文本被截断或带输入附件的历史不能直接重试，需要调用方重新提交完整任务及附件；新任务使用当前 Agent 配置。

重复的重试请求在进程内复用已创建的任务：成功去重记录最多保留 512 条、24 小时，目标历史已被淘汰时
失效。该机制防止重复点击，不提供跨网关重启的持久幂等保证。

`GET /v1/admin/metrics` 提供管理指标；`POST /v1/admin/agents/:id/diagnostics` 以空 JSON 对象发起
显式连接诊断，不提交任务提示词。通用 ACP 命令、参数和环境变量仍在本地配置中管理。

### 行为约定

`/v1/meta` 和 Session 响应包含 Gateway `instanceId`；完成的 Session 还包含与当前 Run 绑定的
`completion` 证明，客户端可识别进程重启和迟到/伪造的完成状态。授权与输入通过精确的 `requestId` 解析，
过期 ID 返回 `409`，不会误答后续请求。

`DELETE /v1/sessions/:id` 会取消活动任务、释放 Agent 整个进程组并移除内存 Session。Gateway 停止时会先
终止 Session，再在有限宽限期后关闭残留 HTTP/SSE 连接，避免长连接或 Agent 孙进程阻塞服务重启。

消息和待输入回复的 `202` 表示已接受，执行结果通过 Session/SSE 查询；A2A 回复等待旧消息流结束后发送，
不会在等待期间占用会话操作锁。取消 ACP 或 A2A 会话会释放 runtime，随后向该会话提交消息或回复返回
`409`，需要新建会话继续。

API Key 的 Agent scope 在 Agent inventory、Session 创建和后续 Session 操作上都会检查；Session 还绑定
创建它的 Key，其他 Key 即使拥有同一 Agent scope 也不能读取或控制该 Session。运行记录接口仅接受管理员
Cookie，数据面 API Key 无权读取。

Key 停用、删除、轮换及 scope 缩小时，受影响的现有 SSE 会断开；已经接受的任务继续执行，断开输出不等于
取消任务。轮换保留 Key ID，新密钥可在原 scope 内继续原 Session；停用后可重新启用恢复访问。删除后不能
用其他 Key 接管原 Session，任务结果仍可在管理员历史中查看。

### SSE 断线恢复

使用 `Last-Event-ID` 请求头或 `?after=` 恢复，客户端按事件 ID 去重。游标非法、超前或已被淘汰时，网关
发送独立的 `event: reset` 控制帧，包含 `reason`（`invalid` / `ahead` / `expired`）、`earliestId`、
`latestId` 与 `snapshotUrl`。空日志的最早 ID 为 `null`，最新 ID 为 `"0"`。

收到 reset 后，读取同一 Session 的快照、替换当前展示，再使用快照的 `lastEventId` 重连。快照只恢复当前
状态，不能补回已淘汰的完整事件历史。首次连接没有游标且历史已淘汰时也会 reset；网关重启导致原 Session
返回 404，需要新建会话。

[`examples/client.mjs`](./examples/client.mjs) 提供带 Bearer 鉴权、去重、指数退避、心跳期限及缺口恢复
的 Node 20+ 客户端：

```js
import { createGatewayClient } from './examples/client.mjs'
const client = createGatewayClient('http://127.0.0.1:8787', process.env.NEXUS_API_KEY)
const session = await client.createSession('codex')
await client.message(session.id, '检查当前项目')
for await (const event of client.events(session.id)) {
  if (event.type === 'reset') console.log('替换当前状态：', event.data)
  else console.log(event)
  if (['completed', 'failed', 'canceled'].includes(event.type) ||
      event.type === 'reset' && ['completed', 'failed', 'canceled'].includes(event.data.state)) break
}
// 收到 pendingRequest 后，由用户明确选择对应 optionId 或输入：
// await client.resolve(session.id, pendingRequest.id, { optionId: '实际的一次授权选项ID' })
// await client.resolve(session.id, pendingRequest.id, { message: '用户的回复' })
// await client.cancel(session.id) // 取消任务；AbortSignal 只停止客户端监听
// await client.close(session.id)  // 释放 Session
```

示例遇到 401 / 403 / 404 会停止重连并向调用方抛错，需要更新凭据、权限或会话。不要把自动重连误当成
任务重试。

## 部署与安全

### 网络暴露

- 默认监听 `0.0.0.0`；已有配置的监听值不会被覆盖。用主机防火墙限制来源。
- LAN 上的纯 HTTP 为兼容 Cookie 默认不设置 `Secure`；跨不可信网络应放在 HTTPS/mTLS 反向代理或可信
  隧道后，并将 `secureAdminCookies` 设为 `true`。
- 不直接暴露公网，使用专用低权限系统账号运行 Gateway。

### Host 与 Origin

控制台和初始化接口校验 Host，默认允许 localhost、回环地址、请求到达的本机 IP 和配置的具体监听主机。
自定义域名 / TLS 反代在配置中增加 `"publicOrigins": ["https://gateway.example.com"]`，修改后重启。
配置值必须是准确的协议、主机、端口组合，不带路径或尾斜杠；反代需保留该 Host 与 Origin。不信任客户端
提供的 `X-Forwarded-*`。数据面不强制浏览器 Origin，保留通用 Bearer 客户端的兼容性。

管理写操作要求完整同源 `Origin`，Cookie 使用 `SameSite=Strict`；登录、初始化失败、无效 API Key 有限速。
reveal 每来源每分钟最多 20 次并记录不含密钥的审计事件。停用、删除和轮换后的旧 Key 不再回退到启动配置。

### 资源与并发

- 并发 Session 创建在异步初始化前预占容量。
- readiness 按 Key scope 先过滤，每 Agent 合并探测，手动刷新最短间隔 5 秒，普通缓存 20 秒，最多 4 个
  探测同时进行。
- 每条 SSE 连接的待发送缓冲最多 512 KiB，背压超过 5 秒断开并释放槽位；客户端应携带 `Last-Event-ID`
  重连。
- `workspaceRoots` 限制网关处理的 cwd / 文件来源。Agent 的 workspace 是默认值，客户端仍可选择任何
  允许根内路径。**这不是 OS 沙箱，也不是不互信租户隔离**；ACP 子进程拥有服务账号的系统权限。

### 隔离边界

配置更新使用 `0600` 临时文件校验后原子替换；Secret 不进入普通响应和结构化错误日志。

## 开发与验证

生产部署与升级使用统一的 SSH Key / systemd 流程，见[部署手册](./deploy-manual.md)。配置和历史存放在
独立状态目录，升级失败会恢复旧版本。项目内的开发运行数据可放在已忽略的 `data/` 或 `runtime/` 中。

```bash
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:webui
npm pack --dry-run --json
node scripts/package-deploy.mjs
node scripts/package-smoke.mjs nexus-gateway.tar.gz
```

测试套件按文件串行执行（`--test-concurrency=1`）：用例在启动和终止真实子进程，并发调度会让这些时序
敏感的断言互相干扰。`--test-force-exit` 用于在全部用例结束后立即退出，避免残留句柄拖住测试进程。

## License

MIT
