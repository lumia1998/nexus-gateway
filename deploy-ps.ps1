# Configure your server details here
$remoteHost = "your-server-ip"
$remoteUser = "your-username"
$password = "your-password"
$localFile = "nexus-gateway.tar.gz"
$remoteDir = "/home/$remoteUser/nexus-gateway"

Write-Host "=== Nexus Gateway Deployment via PowerShell ===" -ForegroundColor Cyan
Write-Host "Target: $remoteUser@$remoteHost" -ForegroundColor Yellow
Write-Host ""
Write-Host "Please configure server details at the top of this script" -ForegroundColor Red

# Convert password to secure string
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential ($remoteUser, $securePassword)

# Try using plink (PuTTY) if available
$plinkPath = "C:\Program Files\PuTTY\plink.exe"
$pscpPath = "C:\Program Files\PuTTY\pscp.exe"

if (Test-Path $plinkPath) {
    Write-Host "`nUsing PuTTY tools..." -ForegroundColor Green

    # Copy file using pscp
    Write-Host "`nStep 1: Copying file to remote server..."
    $pscpArgs = "-pw $password $localFile ${remoteUser}@${remoteHost}:/tmp/"
    Start-Process -FilePath $pscpPath -ArgumentList $pscpArgs -Wait -NoNewWindow

    # Execute remote commands
    Write-Host "`nStep 2: Installing on remote server..."
    $commands = @"
mkdir -p $remoteDir &&
cd $remoteDir &&
tar -xzf /tmp/nexus-gateway.tar.gz &&
npm install --production &&
rm /tmp/nexus-gateway.tar.gz &&
echo 'Installation complete!' &&
echo 'To start: cd ~/nexus-gateway && node dist/cli.js'
"@

    $plinkArgs = "-pw $password ${remoteUser}@${remoteHost} `"$commands`""
    Start-Process -FilePath $plinkPath -ArgumentList $plinkArgs -Wait -NoNewWindow

    Write-Host "`n=== Deployment Complete ===" -ForegroundColor Green
    Write-Host "Access WebUI at: http://10.1.2.40:8787/" -ForegroundColor Cyan
} else {
    Write-Host "`nPuTTY not found. Please install PuTTY or use manual deployment." -ForegroundColor Red
    Write-Host "See deploy-manual.md for manual deployment instructions." -ForegroundColor Yellow
}
