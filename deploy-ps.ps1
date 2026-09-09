[CmdletBinding()]
param(
    [string]$RemoteHost = $(if ($env:NEXUS_REMOTE_HOST) { $env:NEXUS_REMOTE_HOST } else { '' }),
    [string]$RemoteUser = $(if ($env:NEXUS_REMOTE_USER) { $env:NEXUS_REMOTE_USER } else { '' }),
    [string]$RemoteDir = $(if ($env:NEXUS_REMOTE_DIR) { $env:NEXUS_REMOTE_DIR } else { '/opt/nexus-gateway' }),
    [string]$RemoteService = $(if ($env:NEXUS_REMOTE_SERVICE) { $env:NEXUS_REMOTE_SERVICE } else { 'nexus-agentd.service' }),
    [string]$RemoteHealthUrl = $(if ($env:NEXUS_REMOTE_HEALTH_URL) { $env:NEXUS_REMOTE_HEALTH_URL } else { 'http://127.0.0.1:8787/health' }),
    [string]$SshKeyPath = $(if ($env:NEXUS_SSH_KEY) { $env:NEXUS_SSH_KEY } else { '' }),
    [int]$SshPort = $(if ($env:NEXUS_SSH_PORT) { [int]$env:NEXUS_SSH_PORT } else { 22 }),
    [string]$ArtifactPath = $(if ($env:NEXUS_ARTIFACT_PATH) { $env:NEXUS_ARTIFACT_PATH } else { '' }),
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$rootDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$remoteScript = Join-Path $rootDir 'scripts/deploy-remote-install.sh'
if (-not $ArtifactPath) { $ArtifactPath = Join-Path $rootDir 'nexus-gateway.tar.gz' }
elseif (-not [IO.Path]::IsPathRooted($ArtifactPath)) { $ArtifactPath = Join-Path $rootDir $ArtifactPath }
$stage = 'argument validation'

function Stop-Deployment([string]$Message) {
    throw "deployment failed: $Message"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [Parameter(Mandatory = $false)][string]$InputText
    )

    if ($PSBoundParameters.ContainsKey('InputText')) {
        $InputText | & $FilePath @Arguments
    } else {
        & $FilePath @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

function ConvertTo-PosixShellArgument([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function Get-ArtifactSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

Push-Location -LiteralPath $rootDir
try {
    if (-not $RemoteHost) { Stop-Deployment 'set -RemoteHost or NEXUS_REMOTE_HOST' }
    if (-not $RemoteUser) { Stop-Deployment 'set -RemoteUser or NEXUS_REMOTE_USER' }
    if (-not $SshKeyPath) { Stop-Deployment 'set -SshKeyPath or NEXUS_SSH_KEY to an SSH private-key path' }
    if (-not (Test-Path -LiteralPath $SshKeyPath -PathType Leaf)) { Stop-Deployment "SSH private key is missing: $SshKeyPath" }
    if (-not (Test-Path -LiteralPath $remoteScript -PathType Leaf)) { Stop-Deployment "remote installer is missing: $remoteScript" }
    if ($SshPort -lt 1 -or $SshPort -gt 65535) { Stop-Deployment 'SshPort must be between 1 and 65535' }

    $sshCommon = @('-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-i', $SshKeyPath)
    $sshArguments = @($sshCommon + @('-p', [string]$SshPort))
    $scpArguments = @($sshCommon + @('-P', [string]$SshPort))
    $target = "$RemoteUser@$RemoteHost"

    if (-not $SkipBuild) {
        $stage = 'building project'
        Invoke-Checked -FilePath 'npm' -Arguments @('run', 'build')
    }

    $stage = 'creating deployment artifact'
    Invoke-Checked -FilePath 'node' -Arguments @((Join-Path $rootDir 'scripts/package-deploy.mjs'), '--root', $rootDir, '--artifact', $ArtifactPath)
    if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) { Stop-Deployment "deployment artifact was not created: $ArtifactPath" }
    $artifactSha256 = Get-ArtifactSha256 $ArtifactPath

    $stage = 'uploading deployment artifact'
    Invoke-Checked -FilePath 'scp' -Arguments @($scpArguments + @($ArtifactPath, "$target`:/tmp/nexus-gateway.tar.gz"))

    $stage = 'installing release on remote host'
    $remoteArguments = @('/tmp/nexus-gateway.tar.gz', $RemoteDir, $RemoteService, $RemoteHealthUrl, $artifactSha256)
    $remoteCommand = 'bash -s -- ' + (($remoteArguments | ForEach-Object { ConvertTo-PosixShellArgument $_ }) -join ' ')
    $remoteBody = (Get-Content -LiteralPath $remoteScript -Raw -Encoding UTF8).Replace("`r`n", "`n")
    Invoke-Checked -FilePath 'ssh' -Arguments @($sshArguments + @($target, $remoteCommand)) -InputText $remoteBody

    Write-Host "Deployment complete: $RemoteService at $RemoteHealthUrl" -ForegroundColor Green
    exit 0
} catch {
    Write-Error "${stage}: $($_.Exception.Message)"
    exit 1
} finally {
    Pop-Location
}
