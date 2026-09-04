# 执行进度

评审结论与完整计划见 [`REVIEW.md`](./REVIEW.md)
基线 HEAD `3935d5c`（v0.2.5）· 已发布 v0.2.6 · 更新时间 2026-09-04

## 当前状态

| | |
|---|---|
| 进度 | **Step 0–9 完成（10/10）**；后续已完成 A2A P0-2、健壮性 P1-A/B/E |
| typecheck | ✅ 通过 |
| Node 测试 | ✅ Linux 59/59 通过、0 跳过；Windows 52 通过、0 失败、7 跳过（仅 POSIX 进程回收用例） |
| WebUI 浏览器测试 | ✅ Windows 19/19；另完成真实本地网关的 124 场景布局巡检与 15 张提交流程截图 |
| build / pack | ✅ 通过，64 个文件 / 92,138 字节；包内 0 个 `.css`、0 个 `src/`，不含本地预览配置、凭据和截图 |
| **提交** | ✅ `main` 已推送；发布 Tag `v0.2.6` 已推送 |
| 改动范围 | 前后端源文件、测试、CI、生成物及进度文档均已纳入 Git |

新文件：`.gitattributes`、`src/webui/styles.css`、`playwright.config.ts`、`test/webui/app.spec.ts`、`test/a2a-security.test.ts`、`test/lifecycle.test.ts`、`test/fixtures/acp-handshake.mjs`，另有本文件与 `REVIEW.md`。

## 环境限制（影响验证完整性）

**开发机是 Windows，部署目标是 Linux。** 本轮在 WSL2 Ubuntu / Node v22.22.1 中复制源码到独立 Linux 目录、重新 `npm ci`，完成类型检查、59 项 Node 测试和构建：

- 原先跳过的 3 个符号链接逃逸拒绝用例已在 Linux 实测通过；`readContainedFile` 的 `swapped` 竞态分支仍未做确定性替换注入测试，不能将静态 symlink 用例当作该分支的覆盖。
- 新增 4 项真实 ACP 子进程测试验证初始化卡住、session/new 卡住、正常握手和 connection.close 抛错后的清理，Linux 全部通过。Windows 并行测试暴露既有 taskkill 无兜底限制；按项目 Linux 部署范围，这 4 项及 3 项 symlink 测试在 Windows 明确跳过。
- 这是本地 Linux 实测结果；发布提交 `fe86c71` 与状态提交 `fb83423` 的 GitHub Actions Node 20 流程均已通过。
- Chromium 用合成 `compositionstart/input/compositionend` 事件核验 IME 生命周期；未操作真实操作系统输入法，也未使用实际读屏软件。已核验 DOM 焦点、键盘行为、ARIA 容器与播报去重。

---

## 已完成

### Step 0 · 仓库卫生：EOL 归一

`core.autocrlf=true` + 无 `.gitattributes`，已提交的 `sources.ts` 里嵌了 7 处 `\r\n` —— 浏览器实际收到的 `render.js` 字节带 CR，Linux 贡献者重新生成会得到不同内容。

新增 `.gitattributes`（`* text=auto eol=lf`）、生成器读文件后归一、工作树 **49 个文件**归一为 LF。
**验证**：`git diff` 证明是零内容差异操作（索引里 67 个文件本来就全是 `i/lf`），真实改动只有生成器 + 重新生成的 `sources.ts`。

### Step 1 · 后端 P0：`MEDIA:` 任意文件读取

`artifactFromMediaMarker` 对 Agent 输出的 `MEDIA:<path>` 做 `realpath → stat → readFile` 且**无任何包含性检查**，而同仓库 `publishSingleFile` 有三重防护。

按"抽取而非原地打补丁"的原则修：

- `src/workspace.ts`：`isWithin` 导出；新增 `readContainedFile(roots, requested, {maxBytes})` + `ContainedReadError`（`outside|swapped|not-a-file|too-large` 枚举，让两个调用方各自映射到自己的错误契约），完整照搬 `publishSingleFile` 的检查序列（含 open 后**再次 realpath** 的反符号链接竞态检查）
- `src/session.ts`：`publishSingleFile` 改用 helper（根仍是会话工作区，保持 README 承诺的窄边界），删除本地 `assertWorkspacePath`
- `src/acp/runtime.ts`：构造器加 `allowedRoots`，marker 路径改用 helper；**边界是 `workspaceRoots` 允许列表**（不是会话工作区）
- `src/session.ts` 构造 runtime 时传入 `workspacePolicy.listRoots()` ← 漏了整个修复无效
- 顺带：`MAX_MEDIA_MARKER_FILE_BYTES` 32MB→12MB（12–32MB 的文件此前会被完整读取、base64、`structuredClone`，然后在 base64 预算处**静默丢弃**）；marker 数上限 8 + 超出时 emit 事件
- 文档：CHANGELOG 安全条目、README 补 MEDIA 边界段落（原先 README 完全没提 MEDIA）、`completion-contract.ts` 告知 Agent 路径必须在工作区根内

### ⚠ 一个避免回归的关键判断

`CHANGELOG.md:53` 记录 `MEDIA:` 跨目录读取是 **0.2.3 的已发布能力**（"不再遗漏 Hermes/ppt-master 写在 skill 目录中的交付文件"），`test/runtime.test.ts:137-190` 就是它的验收测试。所以**没有反转该测试**，而是传入 `allowedRoots = [directory]` 让它原样通过。

**验证**：
- `test/session.test.ts` **一行未改且全绿** → 共享 helper 精确复现了原防护，这是"抽取而非打补丁"最有价值的证明
- Hermes MEDIA 测试断言原样保留通过 → skill 目录能力没回归
- 新增 3 个拒绝用例（越界绝对路径 / `file://` 形式 / 超 8 个标记）+ 6 个 `readContainedFile` 直接单测
- 审计：`src/` 剩余 `readFile` 全部读网关自己的 config/runs 文件，路径来自 `this.configPath`，不受外部输入控制 → **这一类漏洞已封闭**

### Step 2 · CSS 抽出为真实文件

`src/webui/styles.css` 成为源，生成器读它并产出 `styles.ts`，用 `String.raw` 而非 `JSON.stringify`（后者产出单行 39014 字符、diff 完全不可用），并加断言拒绝含反引号 / `${` 的 CSS。`markup.ts` 保持 TS 模板（69 行且插值 7 处图标，抽出去要引入占位符机制，收益为负）。
**验证**：新 `styles.ts` 里的 CSS 与 `git HEAD` 的版本**逐字节相同**（31288 字节）；生成器注释没混进 CSS 字符串（否则会进 HTML）。

### Step 3 · 设计令牌（纯重构）

新增 25 个令牌：`--radius-lg`（9 处）、6 个 elevation 阴影 + 2 个焦点环、`--z-*`、5 个时长 + 4 个缓动曲线。
新增 `@media (prefers-reduced-motion: reduce)` 统一压制（覆盖 10 条 transition + 全部 animation 消费者）。
修掉一个真 bug：`:focus-visible { border-radius: 2px }` 作用在元素本身而非 outline，导致所有 6px 圆角控件一被键盘聚焦就跳成 2px。
**验证**：把新旧两版 CSS 的 `var()` 各自展开成字面量后逐行对比 —— **唯一减少的行就是被删的 `border-radius: 2px`**，唯一增加的是 reduced-motion 块。34 处替换全部按预期计数命中。

两处与计划的偏差（都是为了让"零视觉变化"成立）：阴影令牌是 **6 个不是 4 个**（现有 6 种配方压不进 4 级阶梯而不改外观）；**剔除了 `--sp-7`**（0 消费者，加了就是死令牌）。

### Step 4 · 对比度 a11y

**浅色主题不需要 `-text` 分离令牌** —— 状态色既作文字也作自己的 10% 染色底，解自洽方程后只压基色即达标。**暗色只有 destructive 需要拆**（作按钮底要暗、作文字要亮，一个值满足不了两边；把基色提到 58% 会让实心危险按钮掉到 3.88）。

浏览器实测（真实计算色 + alpha 合成背景，26 探针 × 2 主题，**0 失败**）：

| 探针 | 亮色 | 暗色 |
|---|---|---|
| `.status.failed` | 3.30 → **4.58** | **1.92** → **4.75** |
| `.status.ready` | 3.00 → **4.79** | 7.62 |
| `.status.waiting` | 2.78 → **4.63** | 7.86 |
| `.status.running` | 3.24 → **4.62** | 5.87 |
| `.button.solid-danger` 白字 | 3.60 → **5.21** | 9.60 |
| `.danger-text` / `.error-detail` / `.button.danger` / `.form-error` | 3.76 → **5.43** | 1.98 → **4.89** |
| 控件边框 `--input`（1.4.11） | 1.26 → **3.15** | 1.31 → **3.45** |
| 焦点环 `--ring` | 2.52 → **3.15** | 3.45 |

`--border`（22 处装饰性分隔）按 1.4.11 豁免原则**没动**；`--input` 与它拆分本身就是正确建模。删掉 `.button.danger` 的 `border-color` 覆盖（1.98:1，比默认边框还弱，语义反了）。
自查修正：亮色 `.status.ready` 第一次测出正好 4.50 零余量 → `--success` 从 28% 压到 27% 得 4.79。实测比值已写进 CSS 注释（原先写的是手算值，与实测不符，已替换）。

### Step 5 · 信息架构重构

分类判据：**改它会不会影响其他客户端？** 会 → 网关配置；不会 → 本机偏好/账户。

- 导航两组 `运行` / `网关配置`（`role="group"` + `aria-labelledby`）+ 底部 `设置` 入口
- 设置入口放 `<nav>` **内部** → `main.js` 的 `.nav-item` 绑定和 `render.js` 的 `.active` 切换**一行都没改**就自动生效
- **admin 弹层整个删除**，设置页三节接管：运行参数（对所有客户端生效）/ 外观（仅当前浏览器）/ 账户。两句节说明按"删冗余、留必要"必须保留 —— 生效范围是界面说不出来的信息，也是把服务端配置和本机偏好放进同一页后唯一的分类线索
- **修掉一个现存 bug**：主题 `<select>` 三个 option 都没有 `selected`，永远显示"跟随系统"，而 `applyTheme` 按 localStorage 生效。实测重载后 `selectValue: "dark"` / 显示"深色" / `htmlThemeAfterReload: "dark"` 三者一致
- 运行参数包进真 `<form>`（`min/max` 现在生效，实测 1-720 / 1-1440 / 5-3600），删掉原客户端预检（有洞：`1.5 小时 × 3_600_000 = 5400000` 是整数，直接通过）
- 总览页去重：从完整花名册改成只列"需要注意"的；抽 `readinessById`/`agentReadiness` 消掉与智能体页的重复合并逻辑；合并逐字重复的 `stat()`/`runSummary()`
- 窄屏 `display:none` 换成 clip-path 视觉隐藏，保住导航按钮可访问名（实时 CSSOM 已确认该媒体规则里无 `display:none`）
- 清理失去消费者的 `.admin-popover`/`.admin-button`/`.admin-meta`/`.avatar`/`.menu-button` 和 `--z-popover` 令牌（残留计数全 0）
- `test/server.test.ts:27-29` 导航标签数组同 commit 更新，并把两个分组标签锁进去

**验证**：6 个页面全部点击巡检，**0 个 JS 错误**。巡检中发现自己给 footer 组加了 `role="group"` 却无可访问名（无名分组在无障碍树上是噪音），已移除。

---

## 历史记录：Step 6 的一次半途尝试（本轮已完整重做）

Step 6 先落了 markup 三槽位 + `aria-live` 移除 + `dom.js` 导出 + CSS 规则，但 `render.js` 未改。因为 `render.js` 仍写 `content.innerHTML`，会把新槽位 div 替换掉，所以：界面渲染与改动前一致（测试全绿），但 **IME 修复未生效**，且产生一个**无障碍回退** —— 整页 `aria-live` 已移除而作为替代的 `#page-status` 还没有代码写入，读屏器当时得不到任何播报。

三处改动**已全部干净回退**（`visually-hidden`/`page-results`/`page-toolbar` 残留计数 0，`aria-live` 已还原），typecheck 与测试重新验证通过。工作树回到 Step 5 完成的状态。

Step 6 的完整设计写在 `REVIEW.md` 第 5 节；下列实现和验证取代上述回退时的状态。

## 本轮完成（2026-09-03）

### Step 6 · 工具栏、统计与结果拆分

- `#page-stats` / `#page-toolbar` / `#page-results` 三槽布局，空槽不占 gap；四个无工具栏页面及空记录分支显式清空。
- 工具栏按页面及 Agent ID/名称门控，筛选值不进入签名；顶部动作按页面保留节点。
- 搜索使用只绑定一次的 `addEventListener`：组合中不筛选，`compositionend` 后应用完整文本。浏览器首轮测试发现 `oncompositionend` 属性写法没有生效，已修正。
- 整页移除 live region，独立 `#page-status` 只写改变后的摘要。

### Step 7 · 文案、统计与工作区冲突

- “Session”统一为“会话”，“移除根目录”统一为“删除工作区”，同步更新文案测试；legacy 标志使用徽章，保留用户命名。
- 删除两个刷新成功 toast，同时加入按钮 busy 状态；保留失败提示。运行卡片不再编造“运行中 / 等待最新进度”。
- RunStore 在分页前计算 `stats.active/completed/failed`，与 `total` 共用全部匹配记录；新增字段保持现有 API 兼容。列表仍最多载入 200 条，并明确筛选作用范围。
- 工作区列表和删除动作预检 ACP 配置依赖；服务端在变更前用真实 WorkspacePolicy 校验，冲突返回 409 和具体 Agent，配置保持不变。覆盖子目录及剩余父根仍可包含该目录的场景。

### Step 8 · 键盘、焦点与播报

- 导航补 `aria-current`；抽屉使用标题关联、Tab 循环、焦点归还及背景滚动锁定。
- 对话框外的 body 子节点（包括菜单）设置 inert 并在关闭后恢复；通知容器临时移入抽屉，普通提示和错误分别使用 polite / assertive 容器。
- 历史表格和当前运行卡片均提供真实详情按钮，保留表格行语义。
- 密钥菜单支持 ArrowUp/Down、Home/End、Escape、Tab 和 roving tabindex，关闭后归还锚点焦点。
- 复制降级路径的临时 textarea 放在当前抽屉内部，避免被新增焦点陷阱拦截。

### Step 9 · 加载、异步反馈与重渲染

- `Intl.DateTimeFormat` 提到模块级；启动、登录后载入和运行详情都有可见加载状态。
- 刷新、初始化、登录、运行参数和抽屉提交使用 busy 状态并抑制重复提交；抽屉外置 footer 提交按钮已纳入。
- 详情请求及保存回调带抽屉版本检查：关闭后迟到的详情不会重开抽屉，旧保存不会替换新抽屉的未保存内容。确认操作仍保持“先关闭、后 await”。
- 相同结果 HTML 跳过 DOM 替换；活动任务耗时每轮重新计算，变动时仍更新。结果变化时尽量恢复当前操作按钮的焦点。

### 本轮验证与工程补齐

- Step 6、7、8、9 后分别通过 typecheck 和 Node 全量测试；新增全量统计与工作区冲突两项回归测试。
- 11 项 Playwright 测试覆盖组合输入期间结果区确实变化、焦点/选区/筛选节点保持、页面清空、播报去重、键盘菜单、抽屉焦点、迟到请求、重复提交、保存竞态、启动加载和复制降级路径。
- 已目视检查浅色运行页、深色密钥页及 390px 工作区页；两主题各页面浏览器巡检无 JS 异常。截图保存在被 Git 忽略的 `test-results/` 中。
- CI 增加 Chromium 浏览器测试和 `git diff --exit-code -- src/webui`；README 与 package 描述同步到当前拓扑和导航，PUBLISH 移除过时 0.2.4 状态。

---

## 后续后端修复（2026-09-03）

### A2A P0-2 · 认证只发送到配置的源

- SDK 将旧版 Card 的 `url/additionalInterfaces` 归一后，逐个校验 `supportedInterfaces` 与配置地址同源；拒绝非 HTTP(S)、内嵌凭据和 fragment。
- 共享 fetch 在附加凭据前再次检查实际 URL，并强制 `redirect: 'error'`，覆盖 Card 发现、JSON-RPC、HTTP+JSON 及 SDK 派生路径。
- 修复前双 HTTP 服务复现外域收到自定义认证请求；修复后外域请求数为 0。同源两种传输、Bearer/自定义 Header、v1/旧版 Card 均通过真实 HTTP 回归。
- 已完成独立补丁复核；README 明确最终 URL 和同源要求。

### 健壮性 P1-A/B/E · 超时、清理和取消

- ACP 初始化与新建会话共享 30 秒期限，失败或超时回收子进程；迟到握手结果检查 disposed，重复 start 不销毁已有连接。
- 连接关闭异常不会跳过进程和输入目录清理；定时清理按会话加锁、逐项捕获并删除，单个失败不阻断其余会话。Server 运行期 error 触发统一、幂等关闭。
- A2A 待输入回复接受后立即释放锁，等待旧流结束再续发；旧流尾部状态不会重新打开输入请求。取消后排队回复不会继续。
- ACP/A2A 取消都清除 runtime 引用、pending 与附件；后续 message/resolve 在创建工作前返回 409，避免错误 202。
- 9 项生命周期测试覆盖真实握手子进程、清理异常、取消后拒绝消息、旧流暂停时回复与取消、Server error。已完成独立复核。

### 本轮验证

- Linux Node v22.22.1：`npm ci --ignore-scripts`、typecheck、Node 59/59、build、Chromium 11/11 通过；原先受 Windows 限制的符号链接检查已实测。
- Windows：typecheck、Node 52 通过 / 7 平台跳过、build、Chromium 11/11 通过。
- `npm pack --dry-run --json --ignore-scripts`：64 文件、90,760 字节，无 src/、独立 CSS、测试或本地凭据。`git diff --check` 通过。
- Linux 浏览器首次因缺少 `libnspr4.so` 无法启动；使用 Playwright 官方 `install-deps chromium` 补齐系统库后 11/11 通过。Linux 与 Windows 两份生成物 SHA-256 一致，重复生成无漂移。

---

## 本地部署与布局验收（2026-09-03）

- 独立测试实例：`http://127.0.0.1:18789/ui/`；配置和示例工作区位于 `.local-preview/`，该目录已被 Git 忽略，登录信息保存在 `.local-preview/login.json`。
- 报告：`http://127.0.0.1:18790/report/index.html`，文件在 `test-results/layout-audit/index.html`。共 139 张有效截图，另有修复前对照；截图、报告和检查脚本均为本地验收产物，不进入 npm 包。
- 6 个主页面覆盖 1440×1000、768×1024、390×844，浅色/深色；初始化、登录、空状态、菜单、全部主要抽屉、表单错误和提交流程均已截图。测试另覆盖 320px 宽和 650px 高视口。
- 页面使用真实构建与真实网关 API；示例 A2A 只访问本机 fixture，部分运行记录通过 RunStore 注入以覆盖状态，没有外部 AI 调用。
- 实测创建/编辑/删除智能体、工作区添加/删除、密钥创建/显示/复制/启停/重命名/授权/轮换/删除、运行参数保存、密码错误/修改/重新登录/退出；侧栏退出登录与设置页统一保存均已覆盖。

修复了 7 类问题：

1. 长任务文本把手机运行卡片撑至约 1563px：网格收缩、长标识换行、状态徽章保留宽度。
2. 密钥表格在平板/手机重叠且操作被裁掉：窄屏改为带字段标签的卡片行，保留完整操作和可访问表头。
3. 授权列表长名称挤压相邻选项：按内容高度排版、名称换行，复选框与协议分列。
4. 抽屉 `100vw` 与稳定滚动条槽冲突造成左侧裁切，复用滚动位置又隐藏首项标签：使用可用视口宽度，打开复位滚动并禁止焦点自动改动滚动位置；收紧移动端启用字段的空白。
5. 历史/智能体表格长名称被挤成竖排：稳定列宽、名称省略，保留局部横向滚动，并截图右侧按钮。
6. 长表单服务端错误藏在滚动区下方：错误出现后滚动到提示，并通过 alert 播报。
7. 成功通知遮挡底部按钮：通知参与抽屉布局，堆叠限高并展示最新提示，连续提示不会挤掉表单和操作区。
8. 设置页内容偏左且依赖卡片分组：移除运行参数、外观、账户外围卡片，使用 820px 居中容器、Section、Divider 和更宽的统一输入控件；密码字段与运行参数共用顶部“保存更改”，退出登录拆到侧栏独立入口。
9. 移动端长工作区路径撑宽列表：收紧列表内容的最小宽度并允许路径与使用者说明断行。

最终结果：布局探针 124 场景 / 0 问题，真实提交流程 15 张 / 0 问题，浏览器异常 0；139 张截图已重建，设置页和移动端工作区均有专项回归。自动化回归共 19 项，Windows 全部通过。Linux Node 59/59、类型检查、构建、包内容及 `git diff --check` 通过。

Windows Node 全量当前为 52 通过 / 0 失败 / 7 跳过；跳过项只要求 POSIX 进程回收能力，相关测试子进程已清理。没有修改生产进程管理代码或跳过可运行断言。项目部署目标仍是 Linux，本次 Windows 实例用于前端验收。未验证真实软键盘、操作系统输入法及读屏软件。

---

## 后续待办

| 步 | 内容 | 备注 |
|---|---|---|
| 验证 | Linux CI | ✅ GitHub Actions Node 20、浏览器与生成物门禁均已通过 |
| 安全 | 六项 P1 | 首启抢占、Host 白名单、探测放大、SSE 背压、永久授权、workspace scope |
| 健壮性 | P1-C / P1-D | 流式输出与持久化放大、A2A 请求和任务超时语义 |
| 工程 | 整理提交 | 当前改动均未提交；生成物需与源文件一起提交 |
| 发布 | 版本与 npm | ✅ `nexus-agentd@0.2.6` 已发布，npm `latest` 指向 `0.2.6`；见 PUBLISH.md |

**未修项**：6 条安全 P1、一批 P2，以及健壮性 P1-C/D。**A2A P0-2 与健壮性 P1-A/B/E 已修复**，清单和边界见 `REVIEW.md` 第 3–4 节。

---

## 提交建议

建议按以下逻辑单元整理提交（Step 0 必须先于 Step 2）：

1. **Step 0 + 2 + 3** —— 构建管线与令牌（零/极小视觉变化）
2. **Step 1** —— MEDIA 文件读取边界 + 文档
3. **Step 4 + 5** —— 颜色 a11y + 信息架构（有可见变化，适合一起评审）

Step 6 建议独立提交；Step 7–9 可按文案/API、键盘交互、异步反馈和浏览器测试整理。本轮 A2A 认证边界及会话生命周期各为独立提交单元，均需带对应测试与文档。上述单元已实现，尚未创建提交；后端剩余待办另见前节。
`REVIEW.md` / `PROGRESS.md` 目前是**未跟踪文件**，可自行决定提交、移到 `docs/` 还是删掉。

## 复核命令

```bash
cd D:/lumia/Desktop/claude_workspace/Nexus/nexus-gateway
npm run typecheck
npx tsx --test test/*.test.ts        # Linux 59/59；Windows 进程回收限制见本轮验收
npx playwright install chromium
npm run test:webui -- --output=test-results/playwright-regression # 19/19；保留 layout-audit 截图
npm run build && npm pack --dry-run --json --ignore-scripts
git ls-files --eol src/webui/        # 预期全部 w/lf
git diff --stat                      # 复核改动范围

# 端到端手工验证（浅色/暗色各看一遍运行记录页与密钥页）
node dist/cli.js --config /tmp/check/nexus-agentd.json --port 8799
# 浏览器开 http://127.0.0.1:8799/ui/ ，走完 setup → login
```
