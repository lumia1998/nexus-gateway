@echo off
setlocal
rem Windows entry point for the same SSH-key deployment flow as deploy-remote.sh.
rem Set NEXUS_REMOTE_HOST, NEXUS_REMOTE_USER and NEXUS_SSH_KEY before calling.

set "SCRIPT_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%deploy-ps.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo Deployment failed with exit code %EXIT_CODE%.
)
exit /b %EXIT_CODE%
