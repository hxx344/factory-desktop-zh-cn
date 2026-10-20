[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -ne 'Windows_NT') { throw 'This script requires native Windows; WSL is not supported.' }
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-NoLinks([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked path: $current" }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Test-Within([string]$Path, [string]$Parent) {
    $base = [IO.Path]::GetFullPath($Parent).TrimEnd([char[]]'\/')
    $candidate = [IO.Path]::GetFullPath($Path)
    return $candidate.Equals($base, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-Package([string]$Path, [long]$Size, [string]$Sha1) {
    Assert-NoLinks $Path
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or $item.Length -ne $Size) { throw "Package size mismatch; preserved existing file: $Path" }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash -ne $Sha1) { throw "Package SHA1 mismatch; preserved existing file: $Path" }
}

function Assert-Client([string]$Root, $Profile) {
    Assert-NoLinks $Root
    $exe = Join-Path $Root 'factory-desktop.exe'
    $asar = Join-Path $Root 'resources/app.asar'
    Assert-NoLinks $exe
    Assert-NoLinks $asar
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $Profile.exeSha256) { throw "Original EXE SHA256 mismatch: $exe" }
    if ((Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash -ne $Profile.asarSha256) { throw "Original ASAR SHA256 mismatch: $asar" }
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status.ToString() -ne 'Valid') { throw "Official EXE signature is not Valid: $($signature.Status); $($signature.StatusMessage)" }
    return @{ status = $signature.Status.ToString(); signer = $signature.SignerCertificate.Subject }
}

$profilePath = Join-Path $PSScriptRoot "../profiles/$Version.json"
if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { throw "No supported profile for Factory $Version" }
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
if ($profile.version -ne $Version -or $profile.platform -ne 'win32' -or $profile.arch -ne 'x64') { throw 'Profile version or platform mismatch.' }
$cacheRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
Assert-NoLinks $cacheRoot
if ($cacheRoot.TrimEnd([char[]]'\/') -eq [IO.Path]::GetPathRoot($cacheRoot).TrimEnd([char[]]'\/')) { throw 'Destination cannot be a filesystem root.' }
foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }) {
    if (Test-Within $cacheRoot (Join-Path $base 'Factory')) { throw 'Destination must be isolated from the real Factory installation.' }
}
[void][IO.Directory]::CreateDirectory($cacheRoot)
$fileName = "Factory-$Version-full.nupkg"
$baseUrl = "https://downloads.factory.ai/factory-desktop/releases/$Version/win32/x64"
$feedUrl = "$baseUrl/RELEASES"
$feed = (Invoke-WebRequest -Uri $feedUrl -UseBasicParsing).Content
if ($feed -is [byte[]]) { $feed = [Text.Encoding]::UTF8.GetString($feed) }
$entries = @($feed -split '\r?\n' | ForEach-Object {
    $line = $_.Trim().TrimStart([char]0xFEFF)
    if ($line -match '^([A-Fa-f0-9]{40})\s+(\S+)\s+(\d+)\s*$' -and $Matches[2] -ceq $fileName) {
        @{ sha1 = $Matches[1].ToUpperInvariant(); fileName = $Matches[2]; size = [long]$Matches[3] }
    }
})
if ($entries.Count -ne 1 -or $entries[0].size -le 0) { throw "Official RELEASES must contain exactly one $fileName entry." }
$entry = $entries[0]
$packagePath = Join-Path $cacheRoot $fileName
$downloaded = $false
if (Test-Path -LiteralPath $packagePath) {
    Assert-Package $packagePath $entry.size $entry.sha1
} else {
    $temporaryPackage = Join-Path $cacheRoot ('.download-' + [guid]::NewGuid().ToString('N') + '.tmp')
    Invoke-WebRequest -Uri "$baseUrl/$fileName" -OutFile $temporaryPackage -UseBasicParsing
    Assert-Package $temporaryPackage $entry.size $entry.sha1
    # Same-directory rename never replaces an unknown cached file.
    [IO.File]::Move($temporaryPackage, $packagePath)
    $downloaded = $true
}

$appPath = Join-Path $cacheRoot "app-$Version"
$clientRoot = Join-Path $appPath 'lib/net45'
$markerPath = Join-Path $appPath '.factory-cloud-client.json'
$extracted = $false
if (Test-Path -LiteralPath $appPath) {
    Assert-NoLinks $appPath
    Assert-NoLinks $markerPath
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw "Unknown extraction directory preserved: $appPath" }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($marker.format -ne 'factory-cloud-client-cache-v1' -or $marker.version -ne $Version -or $marker.root -ne $clientRoot -or $marker.fileName -ne $fileName -or $marker.sha1 -ne $entry.sha1 -or $marker.size -ne $entry.size -or $marker.exeSha256 -ne $profile.exeSha256 -or $marker.asarSha256 -ne $profile.asarSha256) { throw "Extraction marker mismatch; preserved directory: $appPath" }
    $signature = Assert-Client $clientRoot $profile
} else {
    $staging = Join-Path $cacheRoot ('.extract-' + [guid]::NewGuid().ToString('N'))
    if (-not (Test-Within $staging $cacheRoot) -or -not (Test-Within $appPath $cacheRoot)) { throw 'Extraction paths escaped cache root.' }
    # .NET rejects traversing ZIP entries; never execute Setup or register the client.
    [IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $staging)
    Assert-NoLinks $staging
    Assert-NoLinks $cacheRoot
    if (-not (Test-Within $staging $cacheRoot) -or -not (Test-Within $appPath $cacheRoot)) { throw 'Refusing extraction move outside cache root.' }
    # Windows antivirus can briefly hold newly extracted files. Retry only the
    # same verified rename, never replace a directory that appeared meanwhile.
    for ($attempt = 0; ; $attempt++) {
        try { [IO.Directory]::Move($staging, $appPath); break }
        catch {
            $cause = $_.Exception.InnerException
            if ($attempt -ge 5 -or (Test-Path -LiteralPath $appPath) -or ($cause -isnot [IO.IOException] -and $cause -isnot [UnauthorizedAccessException])) { throw }
            Start-Sleep -Milliseconds (200 * [Math]::Pow(2, $attempt))
            Assert-NoLinks $staging
            Assert-NoLinks $cacheRoot
        }
    }
    # Publish a reusable cache marker only after all checks pass.
    $signature = Assert-Client $clientRoot $profile
    $marker = [ordered]@{
        format = 'factory-cloud-client-cache-v1'; version = $Version; root = $clientRoot
        fileName = $fileName; sha1 = $entry.sha1; size = $entry.size
        exeSha256 = $profile.exeSha256; asarSha256 = $profile.asarSha256
    }
    [IO.File]::WriteAllText($markerPath, ($marker | ConvertTo-Json) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $extracted = $true
}

[ordered]@{
    version = $Version; root = $clientRoot; packagePath = $packagePath
    downloaded = $downloaded; extracted = $extracted; feedUrl = $feedUrl
    sha1 = $entry.sha1; size = $entry.size; signature = $signature
    exeSha256 = $profile.exeSha256; asarSha256 = $profile.asarSha256
} | ConvertTo-Json -Depth 5
