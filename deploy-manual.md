# Nexus Gateway 部署与升级

部署入口在仓库根目录：`deploy-remote.sh` 适用于 Bash，`deploy-ps.ps1` 适用于 PowerShell，`deploy-simple.bat` 只是 Windows 转发入口。三者都调用同一份 `scripts/deploy-remote-install.sh`，产物名固定为 `nexus-gateway.tar.gz`。

## 前置准备

远端需要 Linux、Node.js 20 或更高版本、`tar`、`sha256sum`、`curl` 和可用的 `systemd`。部署机需要 `ssh`、`scp`、Node.js 20 和 `tar`。部署只接受 SSH 私钥：不要把密钥口令、远端登录凭据或控制台凭据写入脚本、仓库或命令参数。

先将部署机公钥加入远端账号的 `~/.ssh/authorized_keys`，并确认非交互连接可用：

```bash
ssh -o BatchMode=yes -i ~/.ssh/nexus-deploy deploy@example.com true
```

远端账号需要写入版本目录（默认 `/opt/nexus-gateway`），并能非交互地执行服务管理。可以直接用 root 部署，或给部署账号配置只允许本服务的 `sudo -n systemctl` 规则。`systemctl` 的 sudo 规则至少要覆盖 `daemon-reload`、`restart nexus-agentd.service` 和 `stop nexus-agentd.service`。

## 构建与部署

在提交的工作树中执行构建和打包：

```bash
npm ci
npm run build
node scripts/package-deploy.mjs --artifact nexus-gateway.tar.gz
sha256sum nexus-gateway.tar.gz
```

打包脚本只把 `dist/`、锁文件、示例配置、部署手册、`examples/`、systemd 模板和远端安装器放入白名单；`*.local.json`、`*.local-runs.json` 以及运行历史不会进入包。

Bash 部署入口从环境变量读取目标和私钥，所有外部命令都会检查退出码：

```bash
export NEXUS_REMOTE_HOST=example.com
export NEXUS_REMOTE_USER=deploy
export NEXUS_SSH_KEY="$HOME/.ssh/nexus-deploy"
export NEXUS_REMOTE_DIR=/opt/nexus-gateway
./deploy-remote.sh
```

PowerShell 使用相同的环境变量，也可以传参数：

```powershell
$env:NEXUS_REMOTE_HOST = 'example.com'
$env:NEXUS_REMOTE_USER = 'deploy'
$env:NEXUS_SSH_KEY = 'C:\Users\me\.ssh\nexus-deploy'
.\deploy-ps.ps1
```

Windows 批处理入口直接转发给 PowerShell：

```bat
set NEXUS_REMOTE_HOST=example.com
set NEXUS_REMOTE_USER=deploy
set NEXUS_SSH_KEY=C:\Users\me\.ssh\nexus-deploy
deploy-simple.bat
```

首次运行入口会构建、生成固定名称产物、用 `scp -P` 上传并把 SHA-256 传给远端。远端会校验摘要、拒绝绝对路径和 `..` 成员、在 `releases/<version>` 独立目录执行 `npm ci --omit=dev`，然后原子切换 `current`、重启 systemd 并轮询 `GET /health`。重启或健康检查失败时会切回之前的 `current` 并再次检查；任何阶段失败都以非零退出，不会打印部署成功。

如需复用已经构建的 `dist/`，可设置 `NEXUS_SKIP_BUILD=1`（PowerShell 使用 `-SkipBuild`）。这只跳过本地构建，仍会重新生成并校验部署包。

## systemd 与运行数据

`deploy/nexus-agentd.service` 是模板。首次部署前按目标机器调整 `User`、Node 路径和工作区，然后安装。以下以 Ubuntu、部署账号 `deploy`、服务账号 `nexus` 为例，先确认这些账号和路径适合目标机器：

```bash
id nexus >/dev/null 2>&1 || sudo useradd --system --user-group --home-dir /var/lib/nexus-agentd --shell /usr/sbin/nologin nexus
sudo install -d -o deploy -g deploy -m 0755 /opt/nexus-gateway
sudo install -d -o nexus -g nexus /var/lib/nexus-agentd /var/log/nexus-agentd
sudo install -d -o root -g nexus -m 0750 /etc/nexus-agentd
sudo install -o root -g root -m 0644 deploy/nexus-agentd.service /etc/systemd/system/nexus-agentd.service
sudo systemctl daemon-reload
sudo systemctl enable nexus-agentd.service
```

服务固定从 `/opt/nexus-gateway/current` 启动，配置和运行记录分别放在 `/var/lib/nexus-agentd/nexus-agentd.json` 及其 sidecar 文件中，日志通过 journal 保存。准备配置和工作区目录后再启动第一次部署：

```bash
sudo install -o nexus -g nexus -m 0600 nexus-agentd.example.json /var/lib/nexus-agentd/nexus-agentd.json
sudo install -d -o nexus -g nexus /data/repos /data/repos/project
```

按实际安装情况修改或删除示例 Agent，避免保留示例的私网地址；上述 `project` 目录对应示例 ACP 工作区。模板的 `ProtectHome=true` 会隐藏 `/home` 下的安装和凭据，可将服务账号的 Agent 配置放在 `/var/lib/nexus-agentd`；如需使用其他位置，应同步调整服务访问设置。确认部署切换完成后，检查默认端口 `8787` 和待初始化状态：

```bash
sudo systemctl start nexus-agentd.service
sudo journalctl -u nexus-agentd.service -n 80 --no-pager
curl --fail http://127.0.0.1:8787/health
```

从日志取得一次性 Setup token，在可信网络中打开 `http://<服务器>:8787/ui/` 完成控制台初始化并设置控制台密码。Setup token 只在进程启动日志中出现，不能向不可信人员或公共日志转发。

需要给 ACP/A2A 进程设置代理时，可以在 `/etc/nexus-agentd/nexus-agentd.env` 写入目标环境支持的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，然后重启服务。ACP 子进程还需在本地 Agent 配置的 `inheritEnv` 中显式允许这些变量；A2A 由 Gateway 的 Node 运行时处理，环境变量是否生效取决于所用 Node 版本的代理支持。服务账号的 `PATH` 也要包含已安装的 ACP 入口目录。

## 回滚与排查

健康检查失败时，脚本会返回非零并保留失败版本目录供检查；`current` 会恢复到上一版本。查看服务状态和日志：

```bash
readlink -f /opt/nexus-gateway/current
sudo systemctl status nexus-agentd.service --no-pager
sudo journalctl -u nexus-agentd.service -n 120 --no-pager
```

如果首次部署没有旧版本，健康失败会移除 `current` 链接并停止服务，失败版本仍留在 `releases/`。版本目录不可覆盖；修复后使用新的版本号重新部署，或先检查并移走明确的失败版本目录。不要删除 `/var/lib/nexus-agentd`，那里保存了配置和运行历史；升级只替换版本目录和 `current` 链接。

本地可运行 `bash scripts/deploy-regression-test.sh` 验证安装失败和健康失败回滚。该测试只使用临时目录和 mock `npm`、`curl`、`systemctl`，不会连接服务器。
