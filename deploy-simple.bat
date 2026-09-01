@echo off
REM Configure your server details here
set SERVER_HOST=your-server-ip
set SERVER_USER=your-username
set SERVER_PASS=your-password

echo ================================================================
echo Nexus Gateway 部署工具
echo ================================================================
echo.
echo 目标服务器: %SERVER_HOST%
echo 用户: %SERVER_USER%
echo.
echo 请在脚本顶部配置你的服务器信息
echo.
echo 步骤 1/3: 上传文件到服务器...
echo 提示: 如果询问是否信任主机，请输入 y 并回车
echo.
pause

"C:\Program Files\PuTTY\pscp.exe" -batch -pw %SERVER_PASS% nexus-gateway.tar.gz %SERVER_USER%@%SERVER_HOST%:/tmp/

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 上传失败！请检查网络连接和服务器是否可访问。
    pause
    exit /b 1
)

echo.
echo 步骤 2/3: 在服务器上解压和安装...
echo.

"C:\Program Files\PuTTY\plink.exe" -batch -pw %SERVER_PASS% %SERVER_USER%@%SERVER_HOST% "mkdir -p ~/nexus-gateway && cd ~/nexus-gateway && tar -xzf /tmp/nexus-gateway.tar.gz && npm install --production && rm /tmp/nexus-gateway.tar.gz && echo 'Installation completed successfully!'"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 安装失败！请检查错误信息。
    pause
    exit /b 1
)

echo.
echo 步骤 3/3: 启动服务...
echo.

"C:\Program Files\PuTTY\plink.exe" -batch -pw %SERVER_PASS% %SERVER_USER%@%SERVER_HOST% "cd ~/nexus-gateway && nohup node dist/cli.js > nexus.log 2>&1 & sleep 2 && echo 'Service started!'"

echo.
echo ================================================================
echo 部署完成！
echo ================================================================
echo.
echo WebUI 访问地址: http://%SERVER_HOST%:8787/
echo.
echo 首次访问需要设置控制台密码（至少 12 位）
echo.
echo 查看日志: ssh %SERVER_USER%@%SERVER_HOST% "tail -f ~/nexus-gateway/nexus.log"
echo 停止服务: ssh %SERVER_USER%@%SERVER_HOST% "pkill -f 'node dist/cli.js'"
echo.
pause
