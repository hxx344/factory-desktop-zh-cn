param([string]$Root = (Split-Path -Parent $PSScriptRoot), [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $Root).Path
$taskArguments = @((Join-Path $PSScriptRoot 'package.mjs'), '--root', $taskRoot)
if ($OutputDirectory) { $taskArguments += @('--output', [IO.Path]::GetFullPath($OutputDirectory)) }
& node @taskArguments
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
