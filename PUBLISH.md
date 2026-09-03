# NPM 发布准备

更新：2026-09-03。实施进度见 [PROGRESS.md](./PROGRESS.md)，评审与后续风险见 [REVIEW.md](./REVIEW.md)。

## 当前状态

- 本地 package.json 版本将升级为 **0.2.6**；发布前会同步 package-lock、CHANGELOG 和 Git Tag。
- Step 0–9、A2A P0-2 和健壮性 P1-A/B/E 已在工作树完成，尚未提交、推送、创建新 Tag 或发布到 npm。
- 原文档中“0.2.4 已准备发布”的状态已过时。此处不代表 npm Registry 的实时状态。
- 本地验证：类型检查、Linux Node 59/59（0 跳过）、Windows Node 52/0/7、Windows Chromium 19/19、构建与打包检查。真实本地实例另完成 139 张截图验收与 9 类布局修复（含设置页重构和移动端工作区长文本修复）。
- Windows Node 的 7 个跳过项只要求 POSIX 进程回收能力；项目部署目标仍为 Linux。详见 PROGRESS.md。
- Linux 实测环境是 WSL2 Ubuntu / Node v22.22.1，已补齐 Playwright Chromium 系统依赖。GitHub Actions 使用 Node 20，已加入浏览器和生成物漂移检查，当前工作树尚未触发远端 CI。
- REVIEW.md 中仍有 6 条安全 P1、健壮性 P1-C/D 及 P2 待办，发布前需继续处理或明确接受这些已知问题。

## 发布前验证

```bash
npm ci
npm run typecheck
npm test
npx playwright install --with-deps chromium  # Linux；Windows 可省略 --with-deps
npm run test:webui -- --output=test-results/playwright-regression
npm run build
npm pack --dry-run --json --ignore-scripts
git diff --check
```

包内应包含 dist、README、配置示例、LICENSE 和 package.json；不得包含 src/、独立 .css、测试截图或本地凭据。
本地 `.local-preview/` 预览配置和 `test-results/layout-audit/` 截图报告已被忽略，不纳入发布。
生成的 src/webui/app/sources.ts 和 src/webui/styles.ts 需要随源文件一起提交。

## 正式发布

以下步骤尚未执行：

1. 选定新的发布版本，更新 package.json、package-lock.json 和 CHANGELOG。
2. 提交本轮改动，确认 Linux CI 通过，再推送对应发布 Tag。
3. 用 `npm whoami` 检查发布账户，未登录时运行 `npm login`。
4. 再次构建、检查包内容，然后执行 `npm publish`。
5. 用 `npm view nexus-agentd@<发布版本>` 验证实际发布结果。

不要直接把当前 0.2.6 工作树当作一个已经完成发布的版本；必须以 Git 提交、Tag 和 npm Registry 验证结果为准。
