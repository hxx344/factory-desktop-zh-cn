$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPackage = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$taskDist = Join-Path $taskRoot 'dist'
New-Item -ItemType Directory -Path $taskDist -Force | Out-Null
$taskStage = Join-Path $taskDist ('stage-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskStage | Out-Null
try {
    $taskFiles = @('README.md', 'LICENSE', 'CHANGELOG.md', 'factory-zh.ps1', 'install.cmd', 'restore.cmd', 'status.cmd', 'pack\zh-CN.json', 'profiles\0.201.0.json', 'tools\cli.mjs', 'tools\install.mjs', 'tools\patch.mjs', 'tools\asar.mjs', 'docs\screenshots\login-zh-CN.png')
    foreach ($taskFile in $taskFiles) {
        $taskDestination = Join-Path $taskStage $taskFile
        New-Item -ItemType Directory -Path (Split-Path -Parent $taskDestination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskDestination
    }
    $taskZip = Join-Path $taskDist ("Factory-Desktop-zh-CN-v" + $taskPackage.version + '.zip')
    Compress-Archive -Path (Join-Path $taskStage '*') -DestinationPath $taskZip -Force
    $taskHash = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(($taskZip + '.sha256'), ($taskHash + '  ' + [IO.Path]::GetFileName($taskZip) + "`n"), [Text.Encoding]::ASCII)
    Write-Output $taskZip
    Write-Output $taskHash
} finally {
    $taskResolvedStage = [IO.Path]::GetFullPath($taskStage)
    $taskResolvedDist = [IO.Path]::GetFullPath($taskDist) + [IO.Path]::DirectorySeparatorChar
    if (-not $taskResolvedStage.StartsWith($taskResolvedDist, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove a staging folder outside dist.' }
    Remove-Item -LiteralPath $taskResolvedStage -Recurse -Force
}
