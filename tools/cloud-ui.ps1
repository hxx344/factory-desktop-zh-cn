param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory = $true)][string]$Report
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $Root).Path
$taskExe = Join-Path $taskRoot 'factory-desktop.exe'
$taskRealInstall = Join-Path $env:LOCALAPPDATA 'Factory'
if ($taskRoot.StartsWith($taskRealInstall, [StringComparison]::OrdinalIgnoreCase) -or $taskRoot -match '(?i)\\Program Files(?: \(x86\))?\\') { throw 'UI acceptance requires an isolated client copy.' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.factory-zh-cn/receipt.json'))) { throw 'Run cloud-native.mjs before UI acceptance.' }
$taskReportPath = [IO.Path]::GetFullPath($Report)
$taskQaDirectory = Join-Path (Split-Path -Parent $taskReportPath) ('ui-' + $Version + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskQaDirectory -Force | Out-Null
$taskSession = 'factory-cloud-' + [Guid]::NewGuid().ToString('N')
$taskProcess = $null
$taskStarted = Get-Date
$taskResult = [ordered]@{ clientVersion = $Version; root = $taskRoot; startedAt = $taskStarted.ToUniversalTime().ToString('o'); status = 'running'; realAccountSignedIn = $false; wslUsed = $false }

function Invoke-QaCli {
    param([string[]]$Arguments)
    $taskCliOutput = & npx --yes --package '@playwright/cli@0.1.22' playwright-cli ('-s=' + $taskSession) @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $taskCliOutput -match '(?m)^### Error') { throw ('Playwright acceptance failed: ' + $taskCliOutput) }
    return $taskCliOutput
}

function Invoke-QaJson {
    param([string]$Code)
    $taskCliOutput = Invoke-QaCli -Arguments @('eval', $Code)
    $taskMatch = [regex]::Match($taskCliOutput, '(?s)### Result\s*(?<json>.*?)\s*### Ran Playwright code')
    if (-not $taskMatch.Success) { throw ('Missing structured browser result: ' + $taskCliOutput) }
    return ($taskMatch.Groups['json'].Value | ConvertFrom-Json)
}

function Start-QaFactory {
    $taskEnvironment = @{}
    foreach ($taskKey in @('USERPROFILE', 'APPDATA', 'LOCALAPPDATA')) { $taskEnvironment[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
    try {
        $env:USERPROFILE = Join-Path $taskQaDirectory 'home'
        $env:APPDATA = Join-Path $taskQaDirectory 'roaming'
        $env:LOCALAPPDATA = Join-Path $taskQaDirectory 'local'
        foreach ($taskPath in @($env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA)) { New-Item -ItemType Directory -Path $taskPath -Force | Out-Null }
        $taskArguments = @(('--user-data-dir="' + (Join-Path $taskQaDirectory 'profile') + '"'), '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1')
        $script:taskProcess = Start-Process -FilePath $taskExe -ArgumentList $taskArguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $taskQaDirectory 'stderr.log') -RedirectStandardOutput (Join-Path $taskQaDirectory 'stdout.log')
    } finally {
        foreach ($taskKey in $taskEnvironment.Keys) { [Environment]::SetEnvironmentVariable($taskKey, $taskEnvironment[$taskKey], 'Process') }
    }
    $taskPortFile = Join-Path $taskQaDirectory 'profile/DevToolsActivePort'
    $taskDeadline = (Get-Date).AddSeconds(40)
    do {
        if ($taskProcess.HasExited) { throw 'Factory exited before its isolated debug endpoint was ready.' }
        if (Test-Path -LiteralPath $taskPortFile) {
            $taskPort = [int](Get-Content -LiteralPath $taskPortFile -TotalCount 1)
            $taskListener = Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $taskProcess.Id -and $_.LocalAddress -eq '127.0.0.1' }
            if ($taskListener) {
                $script:taskSession = 'factory-cloud-' + [Guid]::NewGuid().ToString('N')
                Invoke-QaCli -Arguments @('attach', ('--cdp=http://127.0.0.1:' + $taskPort)) | Write-Host
                return
            }
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $taskDeadline)
    throw 'The isolated Factory endpoint did not become ready within 40 seconds.'
}

function Close-QaFactory {
    if ($taskProcess -and -not $taskProcess.HasExited) {
        Invoke-QaCli -Arguments @('eval', '() => window.close()') | Write-Host
        $taskProcess.WaitForExit(20000) | Out-Null
        if (-not $taskProcess.HasExited) { throw 'The isolated Factory instance did not exit normally.' }
    }
}

try {
    Start-QaFactory
    Invoke-QaJson -Code 'async () => {await window.electronAPI.i18n.setLocale("en");return await window.electronAPI.i18n.getPreference();}' | Out-Null
    Invoke-QaCli -Arguments @('reload') | Write-Host
    $taskResult.english = Invoke-QaJson -Code '() => {if(document.documentElement.lang!=="en"||!document.body.innerText.includes("Welcome to Factory"))throw Error("English locale was not applied");return {lang:document.documentElement.lang,text:document.body.innerText};}'
    Invoke-QaJson -Code 'async () => {await window.electronAPI.i18n.setLocale("zh-CN");return await window.electronAPI.i18n.getPreference();}' | Out-Null
    Invoke-QaCli -Arguments @('reload') | Write-Host
    $taskResult.chinese = Invoke-QaJson -Code 'async () => {const p=await window.electronAPI.i18n.getPreference();if(document.documentElement.lang!=="zh-CN"||p.savedLocale!=="zh-CN"||!document.body.innerText.includes("欢迎使用 Factory"))throw Error("Chinese locale was not applied");return {lang:document.documentElement.lang,savedLocale:p.savedLocale,text:document.body.innerText};}'
    Close-QaFactory
    Start-QaFactory
    $taskResult.restart = Invoke-QaJson -Code 'async () => {const p=await window.electronAPI.i18n.getPreference();if(document.documentElement.lang!=="zh-CN"||p.savedLocale!=="zh-CN"||!document.body.innerText.includes("欢迎使用 Factory"))throw Error("Saved Chinese preference did not survive restart");if(document.documentElement.scrollWidth>innerWidth)throw Error("Horizontal overflow");const {resources}=await import(new URL("assets/resources-zh-CN.js",location.href));if(!resources.common||!resources.hardcoded)throw Error("Chinese resource module missing");return {lang:document.documentElement.lang,savedLocale:p.savedLocale,horizontalOverflow:false,chineseResourcesLoaded:true,text:document.body.innerText};}'
    $taskScreenshot = Join-Path $taskQaDirectory 'login-zh-CN.png'
    Invoke-QaCli -Arguments @('screenshot', ('--filename=' + $taskScreenshot)) | Write-Host
    $taskResult.screenshot = $taskScreenshot
    Close-QaFactory
    $taskCriticalErrors = @()
    if (Test-Path -LiteralPath '.playwright-cli') {
        $taskLogs = Get-ChildItem -LiteralPath '.playwright-cli' -Filter 'console-*.log' -File | Where-Object LastWriteTime -ge $taskStarted
        foreach ($taskLog in $taskLogs) { $taskCriticalErrors += @(Get-Content -LiteralPath $taskLog.FullName | Where-Object { $_ -match 'TypeError:|ReferenceError:|SyntaxError:|\[PAGEERROR\]' }) }
    }
    if ($taskCriticalErrors.Count) { throw ('Unexpected JavaScript errors: ' + ($taskCriticalErrors -join "`n")) }
    $taskResult.unexpectedJavaScriptErrors = 0
    $taskResult.status = 'passed'
} catch {
    $taskResult.status = 'failed'
    $taskResult.error = $_.Exception.Message
    throw
} finally {
    if ($taskProcess -and -not $taskProcess.HasExited) {
        $taskOwnedProcess = Get-Process -Id $taskProcess.Id -ErrorAction SilentlyContinue
        if ($taskOwnedProcess -and $taskOwnedProcess.Path -eq $taskExe) { Stop-Process -Id $taskProcess.Id -Force }
    }
    $taskResult.completedAt = (Get-Date).ToUniversalTime().ToString('o')
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskReportPath) -Force | Out-Null
    [IO.File]::WriteAllText($taskReportPath, (($taskResult | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
}
