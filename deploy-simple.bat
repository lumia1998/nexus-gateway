@echo off
echo ================================================================
echo Nexus Gateway 部署工具
echo ================================================================
echo.
echo 目标服务器: 10.1.2.40
echo 用户: lumia
echo 密码: lumia
echo.
echo 步骤 1/3: 上传文件到服务器...
echo 提示: 如果询问是否信任主机，请输入 y 并回车
echo       然后会提示输入密码，请输入: lumia
echo.
pause

"C:\Program Files\PuTTY\pscp.exe" -batch -pw lumia nexus-gateway.tar.gz lumia@10.1.2.40:/tmp/

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 上传失败！请检查网络连接和服务器是否可访问。
    pause
    exit /b 1
)

echo.
echo 步骤 2/3: 在服务器上解压和安装...
echo.

"C:\Program Files\PuTTY\plink.exe" -batch -pw lumia lumia@10.1.2.40 "mkdir -p ~/nexus-gateway && cd ~/nexus-gateway && tar -xzf /tmp/nexus-gateway.tar.gz && npm install --production && rm /tmp/nexus-gateway.tar.gz && echo 'Installation completed successfully!'"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 安装失败！请检查错误信息。
    pause
    exit /b 1
)

echo.
echo 步骤 3/3: 启动服务...
echo.

"C:\Program Files\PuTTY\plink.exe" -batch -pw lumia lumia@10.1.2.40 "cd ~/nexus-gateway && nohup node dist/cli.js > nexus.log 2>&1 & sleep 2 && echo 'Service started!'"

echo.
echo ================================================================
echo 部署完成！
echo ================================================================
echo.
echo WebUI 访问地址: http://10.1.2.40:8787/
echo.
echo 首次访问需要设置控制台密码（至少 12 位）
echo.
echo 查看日志: ssh lumia@10.1.2.40 "tail -f ~/nexus-gateway/nexus.log"
echo 停止服务: ssh lumia@10.1.2.40 "pkill -f 'node dist/cli.js'"
echo.
pause
