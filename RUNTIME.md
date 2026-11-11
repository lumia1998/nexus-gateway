# Agent 执行与远端控制

## 新增驱动

| 驱动 | 协议 | 默认入口 |
|---|---|---|
| `kimi` | ACP | `kimi acp` |
| `gemini` | ACP | `gemini --acp` |
| `cursor` | ACP | `cursor-agent acp`（其他发行版可本地覆盖为 `agent acp`） |
| `devin` | ACP | `devin acp` |
| `zcode` | ACP | `zcode-acp-server` |
| `minimax` | ACP | `mcode acp` |
| `antigravity` | CLI | `agy` stream-json |
| `codex-cli` | CLI | `codex exec --json` |

原有 `codex` 仍走 `codex-acp`。CLI 和 Adapter 需要在网关机器安装并登录；驱动预置不等于
安装或真实账户验证。原生 CLI 使用 stdin 发送提示词，按明确的完成事件验收，进程退出本身不代表成功。
原生 CLI 当前不接输入附件、任意 ACP 配置项或逐项权限申请，需要这些能力时使用 ACP / A2A。

```json
{
  "agents": {
    "kimi": { "driver": "kimi", "permissionPolicy": "auto" },
    "minimax": { "driver": "minimax", "permissionPolicy": "auto" },
    "agy": { "protocol": "cli", "driver": "antigravity", "permissionPolicy": "bypass" },
    "codex-native": { "protocol": "cli", "driver": "codex-cli", "permissionPolicy": "bypass" }
  }
}
```

## 权限

| 策略 | 行为 |
|---|---|
| `ask` | 申请发送给远端调用方，由电脑 A 的主 Agent 或客户端选择 `optionId`，无需电脑 B 人工操作 |
| `allow` | 保留旧行为，仅自动选 `allow_once`，没有该选项就取消授权 |
| `auto` | 无人值守自动授权，优先单次，否则接受 Agent 提供的永久授权，记录决策事件 |
| `bypass` | 自动授权，并在已适配且声明支持的 Agent 上应用原生免审批模式 |
| `deny` | 拒绝协议权限申请 |

旧配置默认仍为 `ask`。`ask` 的 `action: "accept"` 仍只接受单次授权，永久授权必须明确指定
`optionId`。拥有 Agent scope 的调用方可在自己的 Session `options.permissionPolicy` 中选择策略。
Key scope 与 Session 归属检查不变。原生 CLI 只接受显式 `bypass`，不会静默绕过 `ask` / `deny`。
离开原生 bypass 模式需要新建会话。Agent 自身免审批的动作不产生协议请求，`deny` 不是 OS 沙箱。

## 模型与模式

Agent 配置支持默认 `model`、`effort`、`mode` 和本地高级 `configOptions`。创建会话时的 `options`
覆盖默认值；空闲会话可通过 `PATCH /v1/sessions/:id/options` 修改。响应 `runtime` 包含实际声明的
`configOptions`、模式、运行状态、策略和恢复能力。

```json
{
  "agentId": "kimi",
  "options": { "model": "provider/model", "effort": "high", "permissionPolicy": "auto" }
}
```

先切模型，再按切换后的思考档位设置；不支持的值明确报错，不静默提高成本或降低强度。
ZCode 支持 `provider/model`，MiniMax 支持 `provider/model#variant` 并转换成实际 ACP 编码。
Cursor 模型与 Grok 思考强度使用启动参数，修改需要新建会话；Grok 的旧模型接口使用
`session/setModel`。Devin 没有独立思考设置时应选择包含等级的模型 ID。A2A 设置由远端服务管理。
运行中不能改配置；多项配置出现部分失败时，响应后的 Session 快照反映已经应用的设置。

## 生命周期

| Agent 字段 | 默认值 | 行为 |
|---|---|---|
| `startupTimeoutMs` | 30 秒 | ACP 初始化与会话建立期限 |
| `taskTimeoutMs` | 继承全局 30 分钟 | ACP 执行预算，CLI 总期限 |
| `stallTimeoutMs` | 10 分钟 | 无协议进展则失败并回收进程，0 关闭 |
| `idleUnloadMs` | 15 分钟 | 卸载支持原生恢复的空闲 ACP 进程，0 关闭 |
| `permissionTimeoutMs` | 15 分钟 | 远端权限决定和补充输入期限 |
| `resumeMethod` | `auto` | 按声明优先 resume，否则 load；本地可覆盖 resume / load / none |

等待授权或输入时暂停 ACP 执行与无进展计时，超出交互期限仍失败并回收。stderr 不作为协议进展，
避免日志循环占用进程。CLI 每轮退出后释放进程。空闲卸载保留逻辑会话，下一条消息恢复原生上下文；
不支持恢复的 Agent 保留至 Session TTL 或显式关闭。

网关重启后，`POST /v1/runs/:runId/resume` 可根据历史记录创建新的网关 Session 并恢复原生上下文，
仍检查原 Key 和 Agent scope。恢复不重发旧任务，也不是回到历史某一轮的快照。原生会话缺失、
Agent 无恢复能力或协议改变时明确失败，不偷偷创建空白会话。当前不提供 A2A 跨重启恢复。

## 控制台与接口

运行页支持派发任务、读取可选模型、设置权限、查看结果与执行事件、取消、新会话重试和继续会话。
新运行持久化最近 256 条事件，每条 payload 最多约 8 KiB；旧记录不会补造日志。

| 接口 | 认证 | 参数 / 用途 |
|---|---|---|
| `POST /v1/admin/runs` | 管理员 Cookie + Origin | `{ agentId, workspace?, message, options? }` 派发任务 |
| `POST /v1/admin/runs/:id/continue` | 管理员 Cookie + Origin | `{ message, options? }` 继续上下文 |
| `POST /v1/admin/agents/:id/capabilities` | 管理员 Cookie + Origin | `{ workspace? }` 临时建立会话取能力后释放，不发提示词 |
| `PATCH /v1/sessions/:id/options` | 原 Key | 修改空闲 Session 设置 |
| `GET /v1/runs/:id` | 原 Key | 单条任务、结果和保留的执行事件 |
| `POST /v1/runs/:id/resume` | 原 Key | `{}` 恢复原生上下文，不重发任务 |

Gemini CLI 独立于 Antigravity，使用当前发行版的 `--acp` 入口；旧版可在本地覆盖 args。
其 ACP 文件读写回调仅访问当前 Session 的工作区，文本文件最多 16 MiB，拒绝越界路径和非普通文件。
模型选择使用声明的配置项，必要时调用 Gemini 的 `session/set_model`。

运行记录列表仍仅管理员可读。远端主 Agent 可以调用已有的
`POST /v1/sessions/:id/requests/:requestId/resolve` 来决策，无需控制台参与。
原生 `/mcp` Streamable HTTP 入口已提供，详见 [MCP 接入指南](./MCP.md)。

## 验证

`test/agent-expansion.test.ts` 使用真实子进程模拟协议，覆盖动态模型、权限等待、自动授权、恢复、
空闲卸载、卡住回收和原生 CLI 完成契约。`test/dispatch-api.test.ts` 覆盖 HTTP 派发、权限回应和
归属隔离；`test/webui/dispatch.spec.ts` 覆盖控制台操作。它们不调用真实供应商账户或消费模型额度。
真实 CLI 升级后应在隔离工作区做登录、最小文件任务、取消和两轮会话恢复验证。
