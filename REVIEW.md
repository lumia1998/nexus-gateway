# Agent Nexus Gateway（nexus-agentd）评审与实施计划

评审日期：2026-09-03 · 基线 HEAD `3935d5c`（v0.2.5）
执行进度见 [`PROGRESS.md`](./PROGRESS.md)

**2026-09-03 执行更新：Step 0–9、A2A P0-2、健壮性 P1-A/B/E 已完成。** 下文评分、基线行号与发现描述保留评审时语境；前端“行为测试为零”、工作区删除 500、CI 缺少生成物检查等条目已修复。Linux Node 全量 59/59 通过，含真实 ACP 进程和符号链接测试；其他平台及浏览器的最终结果见 PROGRESS.md。安全 P1 六项、健壮性 P1-C/D 及 P2 仍待处理。

---

## 0. 一个需要先纠正的前提

README 与 `package.json` 把本项目描述成"通过 HTTP/SSE 和 ACP 暴露 Agent"，但代码不是这样：

- `src/acp/runtime.ts:85-100` 用的是 `acp.client({...})` —— 守护进程扮演 **ACP Client**，被 spawn 的编码 Agent 才是 ACP 服务端
- `src/a2a/runtime.ts:91-99` 用的是 `ClientFactory` / `DefaultAgentCardResolver` —— 守护进程是 **A2A Client**，全仓库没有任何 `AgentExecutor` / `DefaultRequestHandler`

**真实拓扑：对外只有一个 surface（HTTP/SSE REST + 内嵌 WebUI），ACP 与 A2A 是上游适配层。** 当前 README 与 package 描述已同步到这一拓扑。

---

## 1. 多维评分

| 维度 | 分 | 依据 |
|---|---|---|
| 架构设计 | 8.5 | 分层清晰，`session-contract.ts` 是真抽象边界，驱动层薄到恰到好处 |
| 功能完整度 | 8.5 | 单 surface 但闭环完整（完成证明、按 requestId 解析授权、SSE 断点续传、原子热重载等） |
| 代码质量 | 7 | 4 个千行文件、9 组重复逻辑、`zod` 装了零使用 |
| 安全 | 5 | 威胁模型理解到位，但有 2 个 P0 和一条贯穿性失效模式 |
| 测试 | 7 | 核心不变量扎实，并发/限流/SSE/A2A 大面积留白 |
| UI 视觉 | 7.5 | 颜色与字号 token 纪律真实（0 硬编码 hex），第二层 token 缺失 |
| UI 交互 | 5.5 | 中文输入法被销毁是 P0；无加载态；全量重渲染破坏操作 |
| 无障碍 | 5 | 语义结构与表单标签做得好，对比度和窄屏命名不达标 |
| 文案 | 8.5 | 上一轮清理后已相当干净，确认框都写了真实后果 |

**总评 7/10**：认真做的本地基础设施，不是玩具。`control-plane.persist()` 的"临时文件 + fsync + 重新加载校验 + rename"、`publishSingleFile` 的双重 realpath TOCTOU 防护、`stdio.ts` 的环境变量白名单、零 CORS + `timingSafeEqual` + HttpOnly/SameSite=Strict —— 体现了作者对本地守护进程威胁模型的真实理解。

---

## 2. 贯穿性失效模式（最该改的）

不是"某个检查漏了"，而是**同一个安全检查在 A 路径做得很好、在 B 路径完全缺失**：

| A 路径（做对了） | B 路径（漏了） |
|---|---|
| `session.ts` `publishSingleFile` 三重 realpath 防护 | ~~`acp/runtime.ts` `artifactFromMediaMarker` 零防护~~ ✅ 已修 |
| `deleteAgent` 用 `Object.hasOwn` | `validateScope`（`control-plane.ts:400`）不用 |
| `control-plane.persist` 有 fsync | `run-store.persist` 没有 |
| `run-store.ts:241` 的 fire-and-forget 有 `.catch()` | ~~`session.ts:815` 没有~~ ✅ 已补逐会话捕获与定时器兜底 |
| `acp/runtime.ts` 的 image/resource 分支过 `usableUrl()` | `resource_link` 分支不过 |
| POSIX 进程组终止完整 | Windows taskkill 失败无兜底（**已排除，Linux-only**） |

**结论：修复重点不是逐个打补丁，而是把这些检查抽成单一共享函数，让"忘记调用"在结构上不可能。** Step 1 已按这个原则做了路径包含性；其余同理。

---

## 3. 安全发现清单

### ✅ P0-1 `MEDIA:` 标记任意文件读取 —— 已修（Step 1）

`artifactFromMediaMarker` 对 Agent 输出的 `MEDIA:<path>` 做 `realpath → stat → readFile`，无任何包含性检查。持一个数据面 API Key（或被提示注入的 Agent）即可让守护进程读出用户可读的任何文件（SSH 私钥、云凭据）并 base64 回传。

**重要**：跨目录读取本身是 `CHANGELOG.md:53` 记录的 **0.2.3 已发布能力**（"不再遗漏 Hermes/ppt-master 写在 skill 目录中的交付文件"）。所以 containment 边界是配置的 **`workspaceRoots` 允许列表**而非会话工作区；`test/runtime.test.ts:137-190` 不能反转断言。修法详见 PROGRESS.md。

### ✅ P0-2 A2A 自定义认证头随跨域重定向外泄 —— 已修

`src/a2a/runtime.ts:408-426` 的 `authenticatedFetch` 未设 `redirect`，默认 `follow`。按 Fetch 规范，跨源重定向时**只有 `Authorization` 头会被剥离**，而 `auth.type === 'header'` 用的是自定义头名（如 `X-Api-Key`），**不会被剥离**。远端返回 `302 Location: https://attacker.tld/` 即把凭据原样送出，日志无异常。

叠加：`createFromAgentCard`（`:99`）用 **Agent Card 里声明的 url** 建后续全部传输，却从不校验它与 `agentCardUrl` 同源 —— 一张被篡改的 card 可把所有流量连同 bearer 头指向任意主机。

**修法**：`redirect: 'error'`（或每跳重新判同源）；校验 `card.url` 与 `agentCardUrl` 同源。
注：`README:112` 明说"私有网段和局域网 URL 不会被禁止"，所以 **SSRF 是有意识的设计取舍，不算缺陷**。

**实施与验证**：SDK 将旧版 `url/additionalInterfaces` 归一为 `supportedInterfaces`，现在发现阶段逐个校验同源；共享 `authenticatedFetch` 在附加认证前再次检查最终请求 URL 并强制 `redirect: 'error'`。URL 仅允许无凭据、无 fragment 的 HTTP(S)。真实双 HTTP 服务复现原行为会向外域发请求，修复后 Card 302、JSON-RPC/REST 307 和恶意接口均使外域请求数为 0；同源两种传输、两种认证、v1/旧版 Card 均正常。已完成独立补丁复核。测试见 `test/a2a-security.test.ts`。

### ⏳ P1 安全项（6 条，均未修）

1. **首启可被抢占管理员** —— `POST /v1/bootstrap/initialize` 在认证闸门之前、无速率限制，唯一防护 `assertTrustedOrigin` 是**拿 Origin 与 Host 头互相比**（`server.ts:730-745`），curl 下两者都由攻击者填。而 `nexus-agentd.example.json` 是 `"host": "0.0.0.0"` + `"initialized": false`，用户按 README:134 复制示例后 `created === false`，`cli.ts:25-29` 的警告**永不打印**。README:232 却写"默认仍只监听 localhost" —— **文档、示例、代码三方矛盾**。
   修法：一次性 setup token（首启打印到 stdout）或校验 `socket.remoteAddress`；示例改回 `127.0.0.1`；加载已存在配置时也检查并警告。
2. **无 Host 头白名单 → DNS Rebinding** —— `server.ts:120` 用 `new URL(request.url, 'http://localhost')` **丢弃了 Host 头**。rebinding 下 Origin 与 Host 同时变成攻击者域名，比较必然通过，`SameSite=Strict` 在此无效（浏览器视角是同站）。
   修法：维护 Host 白名单（`127.0.0.1:port` / `localhost:port` / `[::1]:port` + 显式配置的 LAN 地址），在入口统一拒绝不匹配的 Host。
3. **`?refresh=1` 无限流 → 子进程放大** —— 任意有效 Key（哪怕 scope 为空）即可绕过 20s 缓存，对每个 ACP Agent **并发无上限**地 `spawn()` 真实子进程；scope 过滤发生在探测**之后**（`session.ts:595`）。且并发 refresh 之间不做 in-flight 去重。
   修法：single-flight + 冷却窗口；探测并发上限；scope 过滤提到探测之前。
4. **SSE 连接槽可被永久占用** —— `server.ts:623-626` 的注释声称 socket idle timeout 能保证释放，**实测不成立**：`response.write()` 会重置 `socket.setTimeout()` 的空闲计时器，15s 心跳每跳一次就清零，`socket.once('timeout')` 永不触发。对端 `pause()` 且不发 FIN 时，`write()` 返回 false 但既不抛异常也不置 `writableEnded`，兜底检查也不成立。持 Key 者可永久占满 128 个槽 → 所有合法客户端收 429。
   修法：改成检查 `write()` 返回值 + 独立的背压超时；**同时修正那条给出虚假安全感的注释**。
5. **`permissionPolicy:'allow'` 可能升级为永久授权** —— `acp/runtime.ts:336-352` 第一优先级是 `allow_once`（正确），但兜底 `startsWith('allow')` 会命中 `allow_always`（语义是"此后同类操作不再询问"）。把一次性的配置意图静默升级成 Agent 侧持久放行，之后连 `permission_required` 事件都不再产生 → **审计轨迹静默留白**。`respondPending` 的人工 accept 分支同样无 `allow_once` 优先 —— 人工点一次同意也可能变成永久同意。
   修法：`allow_once` → 需显式开关才可选 `allow_always` → 否则 fail-closed；选 `allow_always` 时记一条审计事件。
6. **客户端可自由指定 workspace，Agent scope ≠ 文件系统 scope** —— `session.ts:612-617` 校验的是"是否在 `workspaceRoots` 内"，不是"是否属于该 Agent 配置的 workspace"。某 Key 只有 `sandbox-claude`（workspace 限定在沙箱目录）的 scope，却可以 `POST /v1/sessions {"agentId":"sandbox-claude","workspace":"/data/repos/production-secrets"}` → **Key 的 Agent 级最小权限在文件系统维度被架空**。
   修法：忽略客户端传入的 workspace，或把 Agent 配置的 workspace 作为该会话的强制上界，或在 Key scope 里加 workspace 维度。

### ⏳ P2 安全项摘要

`FailureRateLimiter.entries` 永不淘汰（仅 `success()` 删；公网扫描器可制造数十万常驻条目）· 限流键是 socket 地址，本地进程可故意输错 8 次锁死管理员登录 · API Key 明文存盘且 reveal 无速率限制无审计（对比 admin 密码用了 scrypt，两种凭据保护等级不一致）· `auth.ts` 的 `has()` 为"常量时间"做 O(n) 全表扫描 + 每次 SHA-256（用真实 CPU 成本换不存在的威胁）· scrypt 参数未编码进哈希串（将来提高 cost 会让所有既有哈希失效）· 三套密钥比较函数两种安全等级 · 502/400 错误回显子进程路径与配置绝对路径 · `control-plane.ts:400` 缺 `Object.hasOwn`（可给不存在的 `constructor` Agent 建 scope 授权）· `config.ts:117` 对 `__proto__` 键用赋值语义（手编配置可触发原型污染）· `artifact.url` 的 `resource_link` 分支未过 `usableUrl()`（WebUI 当前渲染为文本所以不可利用，第三方客户端渲染成链接即成 XSS）

---

## 4. 正确性与健壮性（A/B/E 已修，C/D 待办）

- **✅ P1-A 所列异常路径遗留 Agent 子进程** —— 基线 `session.ts:815` 的 `() => void this.cleanup()` 无 `.catch()`，ACP `connection.close()` 抛错会跳过进程清理，Server 在 listening 后无 error 监听。现在定时清理逐会话捕获并继续、外层处理拒绝；ACP 关闭异常仍继续终止进程和删除输入目录；Server 运行期 error 触发幂等关闭并等待会话与 RunStore 清理。未增加全局吞错 handler，也不承诺 SIGKILL/OS 崩溃后的清理。
- **✅ P1-B `runtime.start()` 握手无超时** —— 基线 `initialize` 与 `session/new` 无期限，会永久占槽。现在两阶段共享 30 秒期限，失败后 dispose 并从 SessionManager 移除；迟到结果检查 disposed，不会恢复已终止 runtime。真实子进程分别挂在 initialize、session/new 以及正常握手的测试均在 Linux 通过。
- **P1-C 流式输出 O(n²) 三重放大** —— 每个 `agent_message_chunk` 都：全量字符串拼接 output（512KiB 上限 × 10K chunk ≈ 2.5GB 累计复制）→ `syncRun` 重建最多 64 个 artifact 视图 → `structuredClone(patch)` 深拷贝 256KiB → `summarize` 全文正则再扫一遍 → `prune()` 分配 1000 元素数组 → 事件环形缓冲用 `splice` 搬 2048 元素 → 每 250ms 把全部 1000 条 run **带 `null,2` 缩进**全量写盘。**无需任何恶意输入，正常使用即可触发。**
- **P1-D A2A `promptTimeoutMs` 被 `Math.min` 静默压到 60 秒** —— `a2a/runtime.ts:115-118`。注：README/UI 都把它标为"ACP 单次任务超时"，所以这更像语义混淆而非纯 bug，但 `config.timeoutMs` 同时充当"单次 HTTP 请求超时"和"整轮流次超时"（相差可达 30 倍）是明确的语义错误。
- **✅ P1-E A2A 与 ACP 时序语义不一致** —— A2A 回复现在立即接受并释放锁，在旧流结束后发送；已接受回复抑制旧流尾部状态，取消会阻止排队回复继续执行。两种协议取消时都摘除并 dispose runtime，后续 message/resolve 在创建任务前返回 409。`test/lifecycle.test.ts` 用暂停的旧流验证回复返回、取消无需等待旧流、正常续发和取消后不续发。

生命周期补丁已独立复核。剩余限制：A2A 排队回复仍等待旧流结束或现有超时；P1-D 的超时语义未在此轮改动。Windows taskkill 失败无兜底属于已排除平台限制，新增 4 项真实进程测试仅在 Linux/POSIX 运行。

### 测试覆盖缺口（对照 `test/*.test.ts`）

本节为基线记录。现已补齐 A2A 同源/重定向边界、会话取消和待输入回复时序、握手超时、清理故障及 11 项 WebUI 行为测试；其余缺口继续保留。

覆盖得好：ACP 轮次完成语义（取消不可被覆盖、只有 `end_turn` 产生 proof、权限超时仍 failed）、workspace 白名单与穿越、发布路径与符号链接逃逸、控制面密码/Key 全流程与"不泄露 secret"、配置解析拒绝畸形字段、run 持久化与重启关闭陈旧 run、Key scope 与会话所有权独立生效。

空白：**并发与竞态**（`withSessionLock` 有 6 行注释说明它防什么，却没有一个测试并发调用两个操作去验证它真的防住了）、**限流器**（`FailureRateLimiter` 零测试）、**SSE 生命周期**（429 配额、`Last-Event-ID` 续传、非法 after、对端停止读取）、**A2A 覆盖极薄**（仅 3 例）、**POSIX 进程组是否真杀掉孙子进程**、`persist()` 原子性的注入式测试。**前端行为测试为零**，且 `test/server.test.ts:18-62` 把断言耦合到 UI 文案字符串（改一个字就红），却不测任何 DOM/键盘/转义行为。

测试风格：多个巨型用例（`server.test.ts:83` 一个用例 159 行、`control-plane.test.ts:48` 165 行），主干覆盖扎实但分支与失败路径大量留白。

---

## 5. 实施计划（10 步）

分类判据贯穿始终：**Windows 已排除（Linux-only）**；每个"缺口"先判断是否必要，每个"bug"先查 CHANGELOG/文档是否记为有意设计。

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 仓库卫生：`.gitattributes` + 生成器 EOL 归一（**Step 2 的前置**） | ✅ |
| 1 | 后端 P0-1：抽出 `readContainedFile` 共享 helper，两条文件读取路径强制走它 | ✅ |
| 2 | CSS 从 TS 模板抽出为真实 `.css` 文件，生成器用 `String.raw` 回填 | ✅ |
| 3 | 第二层设计令牌（纯重构、零视觉变化）+ reduced-motion + 修 `:focus-visible` 圆角 bug | ✅ |
| 4 | 对比度 a11y（唯一有视觉变化的一步） | ✅ |
| 5 | 信息架构重构（导航分组 + 设置页收纳 + 总览去重） | ✅ |
| 6 | 工具栏/结果区拆分（**IME P0**：搜索框被每次轮询重渲染销毁） | ✅ |
| 7 | 文案统一 + 统计口径 + 工作区删除冲突 | ✅ |
| 8 | a11y / 键盘 / 焦点 | ✅ |
| 9 | 交互反馈 | ✅ |

每步之后 `npm run typecheck` + `npx tsx --test test/*.test.ts` 必须绿。破测试的步骤：Step 7（`server.test.ts:41` 的 `Session 空闲有效期` 断言）；Step 5 已同 commit 更新了 `:27-29` 的导航标签数组。

### Step 6 详细设计（已完成，验证见 PROGRESS.md）

根因：`render.js` 的 6 个页面函数把**整页含搜索框**写进 `content.innerHTML`，而 `main.js` 每 5s（runs）/ 20s（agents、overview）触发重渲染 → 中文输入法组合态被销毁，焦点、选区、展开的下拉全丢。现有 `bindSearch` 的光标还原 hack 只覆盖 `oninput`，覆盖不了轮询。

- `#page-content` 拆三槽 `#page-stats` / `#page-toolbar` / `#page-results`（三个而非两个：runs 页的 stats 必须留在易变区，但要显示在 toolbar **之上**，而 CSS `order` 无法把 results 的第一个子节点提到兄弟元素之前）
- **`aria-live="polite"` 从整页彻底移除**，改为专用 `#page-status` 只在有意义变化时写一句摘要（搬到 results 仍然每 5s 全量替换 → 读屏整表刷屏）
- 签名门控：runs = `'runs|' + agentIds`（`state.runAgent`/`runStatus` **不要进签名** —— 用户改的是活的 `<select>`，进了反而每次筛选都重建）；agents = `'agents'`（筛选 option 全是静态字面量）
- **必须显式清空 toolbar/stats 的分支**：4 个无 toolbar 的页面 + `renderRuns` 的空数据早退分支（漏了会残留上一页的搜索框，或出现"搜索框 + 空态"的怪状态）
- CSS：`#page-results` 自己 `display:flex; flex-direction:column; gap: var(--sp-4)`（否则原 `.page-content` 的 gap 全塌成 0）；**`.page-content > :empty { display: none }`**（flex `gap` 对每个 item 生效，零高度空 div 仍是 item，会白多 16px —— 最容易漏的视觉回归）
- 删 `bindSearch` 的光标 hack，但**仍要加 `isComposing` 守卫 + `compositionend`**：input 不再被销毁，可 `oninput` 在组合期间仍逐次触发，会用半截拼音重过滤 results
- `#page-actions` 有同样的病：每次 `render()` 重建 topbar 按钮，轮询会偷走刷新按钮的焦点 → 同样按 `state.page` 做签名门控
- `main.js:158` 的 `content.addEventListener('click')` **不用改**（监听器挂在静态节点上，事件从子节点冒泡照样命中，`handleContentClick` 全是 `closest()` 属性查找）

### Step 7–9 摘要

**Step 7 文案**：`Session`→`会话`（三处同 commit：`render.js` + `api.js:71` + `server.test.ts:41`）· 术语统一到「工作区 + 删除」（`main.js:106-110` 现有四种说法；**别碰 nav 文案**，被测试锁住）· 删两条刷新 toast **且同 commit 给刷新按钮加 busy 态**（否则按钮手感像坏了）· 删 `runCard` 的 `'运行中'`/`'等待最新进度'` 兜底（与"等待授权/等待输入"矛盾）· `'保留记录'`→`'记录总数'` **但改标签解决不了口径 bug**（`run-store.ts` `limit=200` vs `total=matched.length` 上限 1000 → 四个统计数字基数不一致）· legacy 密钥改徽章而非字符串比较 · 工作区删除预检（后端保护是对的但报 **500 "Internal server error"**）

**Step 8 a11y**：`aria-current="page"` · `#drawer` 加 `aria-labelledby` · **历史表格行不能用 `tabindex=0 role=button`**（`<tr>` 隐式 `role=row`，覆盖会破坏整表语义）→ 末尾 `<td>` 放真 `<button data-run-detail>` · `keyActionMenu` 补 `id` + `aria-haspopup` + roving tabindex · drawer 焦点陷阱/归还/scroll lock（`inert` 加在 `#app` 上**管不到** body 级的 toast 和菜单）· **toast 的 `role="status"` 加在子节点上无效**（容器已带 assertive）→ 拆两个容器

**Step 9 反馈**：`Intl.DateTimeFormat` 提到模块级（一次渲染省 100–400ms）· `boot()` 白屏加占位 · run 详情先开抽屉再填内容 · busy 态（提交按钮在 `drawerFooter` **不在 `drawerForm` 里**；**`openConfirmDrawer` 先 close 再 await 是刻意的，不要"顺手修正"那个顺序**）· 签名跳过重渲染**必须排除 `durationMs == null` 的活动运行**，否则耗时列冻结

---

## 6. 明确不做（判断过，不是遗漏）

- **会话恢复** —— ACP 会话状态活在被 spawn 的子进程里，守护进程重启后子进程已死，没有可恢复的对象；网关是代理层不是记录系统，客户端本来持有上下文；`run-store` 把中断运行改写成 failed 已是正确语义。**不是缺口。**
  保留两个窄项：① A2A 的 `taskId`/`contextId` 是**远端持有的持久句柄**，只存在 runtime 内存里，网关重启后一个仍在远跑的任务彻底失联（取消不了、看不到结束、远端还在烧 token）；② `protocolSessionId`/`acpSessionId` 对外暴露并写进运行记录，若只是诊断元数据应在文档里说明，否则客户端作者会误当恢复句柄来用。
- **Windows 支持** —— 环境变量白名单缺 `SystemRoot`/`APPDATA`/`USERPROFILE`（会导致 adapter 找不到凭据目录）、`taskkill` 失败无 `child.kill()` 兜底、CI 无 win 矩阵。用户明确排除。
- **渲染层改 tagged template** 让转义成为默认而非人工纪律 —— 要重写 render.js 500+ 行字符串拼接（`:312` 单行 2006 字符），diff 巨大且有引入转义漏洞的风险。现状 20 处 innerHTML 已逐点审计，`escapeHtml` 覆盖完整含属性上下文，**无 XSS**。结构性风险记在这里，不现在动。
- **`api.js:23-79` 的 37 项英文→中文错误映射表**（靠精确匹配服务端 message，服务端改措辞就漏英文）：正解是服务端错误带稳定 `code` 字段，属跨端设计变更。本地守护进程、单一前端、错误集合稳定，现在这套能工作 —— 取舍而非缺口。Step 7 的 500 就是它兜不住的实例。
- **运行记录服务端过滤**（`server.ts:411-423` 早已支持 `agentId`/`sessionId`/`state`/`q`/`limit`，`run-store.ts` 全部实现，控制台一个都没用，全在 `render.js:95-100` 客户端过滤）。
- **用起 `zod`**（在 dependencies 里但 `src/` 零 import，300 行手写 `typeof` 校验）—— 后端范围。
- **控件尺寸阶梯 `--control-*`**（26/28/30/32/34/36/40/44/52/56 十种散落值）—— 独立重构。**也不要加 `--sp-7`**（0 消费者，加了就是死令牌）。

---

## 7. 前端工程质量备忘

- **构建管线**：`scripts/generate-webui-sources.mjs` 自动发现 `src/webui/app/*.js` 全部内联进 `sources.ts`（也自动发现 `styles.css` 生成 `styles.ts`）。生成物**提交进 git**（`npm test` 没有 generate 前缀，新克隆直接跑测试依赖已提交产物）。新增 `app/*.js` 模块不用改脚本，但要补 `test/server.test.ts:52` 的模块清单。
- **CI 没有漂移检查**：`ci.yml` 跑 `typecheck → test → build` 但没有一步检查工作树是否变脏，所以 EOL 漂移一直没被发现。**建议 build 后追加 `git diff --exit-code src/webui`。**
- **CSP 严格且正确**：`default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` + `nosniff`；`unsafe-inline` 仅用于样式。`server.test.ts:31-32` 的禁词表（`gradient|backdrop-filter|sessionStorage|react|vue|unpkg|jsdelivr`）覆盖整个内联 HTML，**约束所有未来的 CSS/markup 改动**。
- **认证面是干净的**：无前端 token，会话走 `HttpOnly + SameSite=Strict` cookie，`localStorage` 只存主题偏好，变更类请求服务端做 Origin 校验，测试还显式断言不出现 `sessionStorage`。风险集中在可用性/无障碍/工程流程，不在安全。
- **对比度的取值方法**：状态色既作文字也作自己的 10% 染色底，**必须按合成后的背景算**，量纯白卡片会得到偏乐观的数字。实测比值已写进 `styles.css` 注释以防被"调亮一点"回退。
