# Nexus Gateway 远程部署指南

## 方法 1: 手动部署（推荐）

### 在本地 Windows 机器上：

1. 打包项目：
```bash
cd "D:\lumia\Desktop\claude_workspace\Nexus\nexus-gateway"
tar -czf nexus-gateway.tar.gz dist/ package.json package-lock.json README.md LICENSE nexus-agentd.example.json
```

2. 使用 WinSCP 或 scp 上传到远程服务器：
```bash
# 使用 scp（会提示输入密码: lumia）
scp nexus-gateway.tar.gz lumia@10.1.2.40:/tmp/
```

### 在远程服务器 (10.1.2.40) 上：

通过 SSH 登录：
```bash
ssh lumia@10.1.2.40
# 密码: lumia
```

然后执行：
```bash
# 创建目录
mkdir -p ~/nexus-gateway
cd ~/nexus-gateway

# 解压文件
tar -xzf /tmp/nexus-gateway.tar.gz

# 检查 Node.js 版本（需要 >= 20）
node --version

# 如果没有 Node.js 或版本过低，安装 Node.js 20+
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
# sudo apt-get install -y nodejs

# 安装依赖
npm install --production

# 创建初始配置（可选，首次启动会自动创建）
cp nexus-agentd.example.json nexus-agentd.json

# 启动服务
node dist/cli.js

# 或者使用 nohup 后台运行
nohup node dist/cli.js > nexus.log 2>&1 &
```

### 访问 WebUI

浏览器打开：
- http://10.1.2.40:8787/

首次访问会提示设置控制台密码（至少 12 位）

---

## 方法 2: 使用 NPM 全局安装

```bash
# 在远程服务器上
npm install -g D:/lumia/Desktop/claude_workspace/Nexus/nexus-gateway

# 启动
nexus-agentd --host 0.0.0.0 --port 8787
```

---

## 方法 3: 使用 Docker（如果可用）

创建 Dockerfile：
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY dist ./dist
EXPOSE 8787
CMD ["node", "dist/cli.js"]
```

构建并运行：
```bash
docker build -t nexus-gateway .
docker run -d -p 8787:8787 -v /data/repos:/data/repos nexus-gateway
```

---

## 故障排查

1. **端口被占用**：
```bash
lsof -i :8787
# 或
netstat -tlnp | grep 8787
```

2. **权限问题**：
```bash
sudo chown -R lumia:lumia ~/nexus-gateway
```

3. **查看日志**：
```bash
tail -f ~/nexus-gateway/nexus.log
```

4. **防火墙设置**：
```bash
# 如果需要外部访问
sudo ufw allow 8787/tcp
# 或
sudo firewall-cmd --permanent --add-port=8787/tcp
sudo firewall-cmd --reload
```
