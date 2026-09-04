# NPM 发布记录

更新：2026-09-04。实施进度见 [PROGRESS.md](./PROGRESS.md)，评审与后续风险见 [REVIEW.md](./REVIEW.md)。

## 当前状态

- package.json、package-lock、CHANGELOG 与 Git Tag 已同步为 **0.2.6**。
- Step 0–9、A2A P0-2 和健壮性 P1-A/B/E 已提交并推送；发布 Tag 为 `v0.2.6`。
- `nexus-agentd@0.2.6` 已发布到 npm，公开 Registry 回读确认 `latest` 指向 `0.2.6`。
- 本地验证：类型检查、Linux Node 59/59（0 跳过）、Windows Node 52/0/7、Windows Chromium 19/19、构建与打包检查。真实本地实例另完成 139 张截图验收与 9 类布局修复（含设置页重构和移动端工作区长文本修复）。
- Windows Node 的 7 个跳过项只要求 POSIX 进程回收能力；项目部署目标仍为 Linux。详见 PROGRESS.md。
- Linux 实测环境是 WSL2 Ubuntu / Node v22.22.1，已补齐 Playwright Chromium 系统依赖。GitHub Actions 使用 Node 20，发布提交与状态提交的浏览器、测试及生成物漂移检查均已通过。
- REVIEW.md 中仍有 6 条安全 P1、健壮性 P1-C/D 及 P2 待办，作为后续版本工作继续处理。

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

已执行：

1. 选定新的发布版本，更新 package.json、package-lock.json 和 CHANGELOG。
2. 提交本轮改动，推送 `main` 和 `v0.2.6` Tag（提交 `fe86c71`）。
3. 再次构建、检查包内容，然后执行 `npm publish --access public`；构建和打包检查通过，包为 64 个文件 / 92.1 kB。

4. 使用 `lumia.wang` npm 账户发布 `nexus-agentd@0.2.6`。
5. 公开执行 `npm view nexus-agentd@0.2.6 version dist-tags --json`，确认版本为 `0.2.6`、`latest` 为 `0.2.6`。
