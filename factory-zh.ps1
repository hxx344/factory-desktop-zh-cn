param(
    [ValidateSet('install', 'status', 'restore')][string]$Action = 'install',
    [string]$InstallDir
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $taskNode = Get-Command node.exe -ErrorAction SilentlyContinue
    $taskNodePath = if ($taskNode) { $taskNode.Source } else { $null }
    if ($taskNodePath) {
        $taskMajor = [int]((& $taskNodePath --version).TrimStart('v').Split('.')[0])
        if ($taskMajor -lt 22) { $taskNodePath = $null }
    }
    if (-not $taskNodePath) {
        $taskArch = if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $taskHashes = @{
            x64 = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5'
            arm64 = '49a54c103f4919ce64199a043ef5cd309507de491d718085edee089cd8e87543'
        }
        $taskRuntime = Join-Path $PSScriptRoot '.runtime'
        $taskNodePath = Join-Path $taskRuntime "node-v24.15.0-$taskArch.exe"
        if (-not (Test-Path -LiteralPath $taskRuntime)) { New-Item -ItemType Directory -Path $taskRuntime | Out-Null }
        if (-not (Test-Path -LiteralPath $taskNodePath)) {
            Write-Host 'Downloading the pinned Node.js runtime from nodejs.org (first run only)...'
            $taskDownload = "$taskNodePath.download"
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v24.15.0/win-$taskArch/node.exe" -OutFile $taskDownload
            if ((Get-FileHash -LiteralPath $taskDownload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskHashes[$taskArch]) {
                Remove-Item -LiteralPath $taskDownload
                throw 'Node.js checksum mismatch.'
            }
            Move-Item -LiteralPath $taskDownload -Destination $taskNodePath
        }
        if ((Get-FileHash -LiteralPath $taskNodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskHashes[$taskArch]) { throw 'Cached Node.js checksum mismatch.' }
    }
    $taskArguments = @((Join-Path $PSScriptRoot 'tools\cli.mjs'), $Action)
    if ($InstallDir) { $taskArguments += $InstallDir }
    & $taskNodePath @taskArguments
    exit $LASTEXITCODE
} catch {
    Write-Error $_
    exit 1
}
