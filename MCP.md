# 远端 MCP

Gateway 原生提供 `POST /mcp`，使用官方 TypeScript SDK 的 **Streamable HTTP**。
连接电脑 B 的此入口，电脑 A 的主 Agent 就能调用 B 已配置的执行端。协议采用无状态传输和 JSON
响应，不保留 MCP 连接会话；任务与 Agent 会话由 Gateway 独立持久化 / 管理，断线不取消任务。
`GET /mcp` 和 `DELETE /mcp` 返回 405；没有旧版 `/sse` 入口。这是标准 Streamable HTTP 的可选
JSON 响应模式，不是自定义 RPC，也不要求 worker 一直占着一条 MCP 连接。

## 默认执行约定

- `dispatch_task` 的必需项是 `agent_id`、`message`、`request_id`。
- 不传 `options`，就沿用服务器 Agent 的默认模型、思考强度、模式和权限策略。
- `message` 保持原文。正文中提到 Opus、Sonnet、子 Agent 或团队，不会触发网关解析、换模型、
  创建子任务或写入 CLI 的配置目录。既有运行时完成契约仍作为独立提示内容附加。
- 例如“Opus 负责，并创建两个 Sonnet 子 Agent”由 B 上的默认模型接单，自行决定如何通过其原生
  能力执行。文字要求不保证某个 CLI 在当前运行方式下具备原生团队能力。
- 只有明确要更换接单模型时才传 `options.model`；这是父会话参数，和正文中对子 Agent 的要求独立。
- 工作区是 B 上的目录。省略时使用 Agent 默认目录；不会自动同步 A 的文件。
- 各家 CLI 自己管理内部子 Agent。网关不注入子 Agent 定义、不默认接管原生编排，也不会把 API Key
  随任务传入 worker 环境。

## 客户端配置

先在 B 的控制台创建只允许需要的 Agent 的 API Key。支持远程 MCP 的客户端配置形状如下（实际
字段以该客户端为准；这是 Claude Code `.mcp.json` 形式）：

```json
{
  "mcpServers": {
    "nexus-server-b": {
      "type": "http",
      "url": "https://gateway.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <在控制台生成的 API Key>"
      }
    }
  }
}
```

API Key 与控制台密码不同。管理 Cookie 不可调用 MCP。服务不实现 OAuth 自动登录，客户端需要支持
自定义 Bearer Header。域名反代需要在现有 `publicOrigins` 中配置精确来源，并保留 Host；MCP 验证
Host，存在 Origin 时验证同源，非浏览器客户端可以省略 Origin。局域网可直接用 `http://B的IP:8787/mcp`。

连接多台 Gateway 时分别添加 `nexus-server-b`、`nexus-server-c`。Agent ID 在各 Gateway 内唯一；
`list_agents` 返回 `claude` 就传 `claude`，不要自行拼成 `server-b/claude`。设备选择由所连接的 MCP
服务入口确定。

## 五个工具

| 工具 | 作用 |
|---|---|
| `list_agents` | 返回 API Key 范围内已配置 Agent、命令 / Card 探测状态、默认参数和活动任务数 |
| `dispatch_task` | 派发或继续任务，立即返回 `task_id`、`session_id` |
| `get_task` | 查看、等待（最多 30 秒）、分页读取结果与执行日志 |
| `cancel_task` | 显式取消当前任务，历史任务不能取消后续轮次 |
| `respond_task` | 回应权限申请 / 输入请求，由电脑 A 决策，无需电脑 B 人工介入 |

普通 `list_agents` 使用就绪缓存，`refresh: true` 强制刷新（仍受探测冷却与并发限制）。它检查已经
配置的 Agent，不扫描任意安装目录或自动添加可执行程序。`ready` 的层级由 `readiness` 标出，命令
探测通过并不等于登录或真实任务执行成功。

单独读取某个 Agent 的模型 / 模式：

```json
{ "agent_id": "claude", "include_capabilities": true }
```

这会临时建立一个会话、不发送提示词、读取能力后释放进程。ACP 返回其实际声明的配置项，原生 CLI
只返回配置而不是实时模型列表。不会伪造 CLI 未声明的能力。

派发并沿用默认值：

```json
{
  "agent_id": "claude",
  "message": "让 Opus 负责这项任务，并创建两个 Sonnet 子 Agent 分别检查前端和后端。",
  "request_id": "review-20261111-001"
}
```

显式覆盖接单参数（可选）：

```json
{
  "agent_id": "claude",
  "message": "审查项目",
  "request_id": "review-20261111-002",
  "options": {
    "model": "使用能力列表返回的模型 ID",
    "permission_policy": "delegate"
  }
}
```

`permission_policy` 支持 `delegate` / `ask`（相同含义）、`allow`、`auto`、`bypass`、`deny`；不填
则保留 B 配置。`options.effort` 和 `options.mode` 同样可选。

等待或获取结果：

```json
{ "task_id": "返回的 Run ID", "wait_seconds": 30 }
```

`wait_timed_out: true` 只表示本次等待结束，不表示失败，不应重新派发。收到 `pending_request` 时，
用 `respond_task` 传 `task_id`、精确的 `request_id` 和选项 `option_id` 或输入 `message`。
`action: "accept"` 只选单次授权，永久授权必须显式指定选项 ID。

最终输出默认返回 12000 字符，使用 `next_output_offset` 继续读取；运行中的输出可能变化，最终完成
后再稳定分页。`include_logs: true` 返回保留窗口中的事件，使用 `logs.next_cursor` 作为 `log_after`，
`logs.has_more` 判断是否还有页。过期 / 未知游标返回 `cursor_reset: true`。日志仅保留最近 256 条。
可下载产物附带同一 Gateway 的 `download_path`，访问时仍使用 API Key。

继续会话时传 `session_id`；网关重启后传 `resume_task_id`。二者只能选择一个，且 Agent ID 必须
一致，不允许同时改变工作区。恢复只恢复上下文，不重发旧任务，也不回滚到历史轮次。

## 重试与权限边界

每个逻辑派发使用一个 `request_id`（8–128 位字母、数字、点、下划线、冒号或连字符）。网络重试
必须复用同一 ID 和相同参数；同 ID 不同参数被拒绝。同 Key 的并发重复提交共享一个派发结果。
接收回执存在运行历史旁的 `.mcp-dispatch.json` 中，权限为 0600，保留 24 小时、最多 2048 条。
在启动 worker 前先写入预留记录；崩溃发生在确认结果前时，重试会明确报告不确定，不自动重复执行。
失败回执不会自动重跑，需要检查原因后以新 ID 提交。超过保留期的旧 ID 不再保证去重。

每次 HTTP 请求、工具操作及长等待期间都重新验证 Key；结果、取消、回应与恢复检查原 Key 归属和
Agent scope。撤销 Key 会使等待失败，但不会取消已经接受的 worker 任务。MCP 复用现有会话、运行
和连接配额；MCP 在途请求占一个 SSE / 长连接配额，用于限制并行等待。

客户端丢失连接只中止其等待，worker 继续。只有 `cancel_task` 明确取消。MCP 传输是无状态的，
因此不提供协议级取消某次 `tools/call` 后自动取消后台任务的行为。

## 验证范围

`test/mcp.test.ts` 使用官方 MCP Client + StreamableHTTPClientTransport 通过真实 HTTP 服务测试五个
工具、默认值透传、权限回应、分页、重试去重、重启恢复、范围隔离、Origin/Host 与 Key 撤销。
Gemini 文件回调使用真实子进程模拟协议验证。测试不消费真实模型额度，也不代替 CLI 实机账户验证。
