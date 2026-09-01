# NPM 发布指南

## 前提条件

1. 确保已登录 NPM：
```bash
npm login
# 或使用 access token
npm login --auth-type=legacy
```

2. 验证登录状态：
```bash
npm whoami
```

3. 检查包名是否可用（首次发布）：
```bash
npm search nexus-agentd
```

## 发布步骤

### 1. 更新版本号

已在 `package.json` 中更新为 `0.2.4`

### 2. 更新 CHANGELOG

已添加 v0.2.4 的更新日志

### 3. 构建项目

```bash
npm run build
```

### 4. 本地测试

```bash
# 测试打包内容
npm pack --dry-run

# 或实际打包查看
npm pack
```

### 5. 发布到 NPM

```bash
npm publish
```

### 6. 验证发布

```bash
npm view nexus-agentd
npm view nexus-agentd@0.2.4
```

## 如果包名被占用

如果 `nexus-agentd` 包名已被占用，可以：

1. 使用 scoped 包名：
```json
{
  "name": "@lumia1998/nexus-agentd"
}
```

2. 或选择其他包名：
```json
{
  "name": "agent-nexus-gateway"
}
```

## 发布到私有 Registry

如果使用私有 npm registry：

```bash
npm config set registry https://your-registry.com
npm publish
```

## 当前状态

- ✅ Git 已推送到 GitHub (v0.2.4)
- ✅ Git Tag 已创建 (v0.2.4)
- ⏳ NPM 发布需要登录后手动执行

## 快速发布命令

```bash
# 1. 登录 NPM
npm login

# 2. 发布
cd "D:\lumia\Desktop\claude_workspace\Nexus\nexus-gateway"
npm publish

# 3. 验证
npm view nexus-agentd@0.2.4
```
