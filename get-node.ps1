# Stage a Node runtime for the full flavor of rdsh.
#
# The full flavor looks for `<agent dir>\node\node.exe` (or `node` on unix) and
# prefers it over any node on PATH, so the target machine needs nothing installed.
# This script fetches an official Node build and unpacks just the runtime binary.
#
#   .\get-node.ps1                                   # stage for 03-bin\win-x64-full
#   .\get-node.ps1 -Rid linux-x64 -OutDir <dir>      # stage for another target
#
# Node's licence applies to the staged runtime (MIT); see the archive's LICENSE.

[CmdletBinding()]
param(
    [string]$Rid = 'win-x64',
    [string]$Version = 'v22.20.0',
    [string]$OutDir,
    [string]$Proxy = 'http://127.0.0.1:7897'
)

$ErrorActionPreference = 'Stop'

if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "03-bin\$Rid-full" }
$nodeDir = Join-Path $OutDir 'node'
New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null

# Map the .NET RID onto Node's own platform/arch naming.
$nodePlatform = switch -Wildcard ($Rid) {
    'win-*' { 'win' }
    'linux-*' { 'linux' }
    'osx-*' { 'darwin' }
    default { throw "unsupported RID for a Node runtime: $Rid" }
}
$nodeArch = switch -Wildcard ($Rid) {
    '*-x64' { 'x64' }
    '*-arm64' { 'arm64' }
    default { throw "unsupported architecture for a Node runtime: $Rid" }
}

$isWindowsTarget = $nodePlatform -eq 'win'
$archiveExt = if ($isWindowsTarget) { 'zip' } else { 'tar.xz' }
$folder = "node-$Version-$nodePlatform-$nodeArch"
$url = "https://nodejs.org/dist/$Version/$folder.$archiveExt"

Write-Host "node runtime : $Version ($nodePlatform-$nodeArch)"
Write-Host "source       : $url"
Write-Host "staging to   : $nodeDir"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("rdsh-node-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    $archive = Join-Path $tmp "node.$archiveExt"

    # This machine cannot do TLS from .NET, but curl with an explicit proxy works.
    # If curl is unavailable, fall back to Invoke-WebRequest.
    $downloaded = $false
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L --fail --max-time 600 -x $Proxy -o $archive $url
        $downloaded = ($LASTEXITCODE -eq 0 -and (Test-Path $archive))
    }
    if (-not $downloaded) {
        Write-Host 'curl unavailable or failed; trying Invoke-WebRequest'
        Invoke-WebRequest -Uri $url -OutFile $archive -Proxy $Proxy
    }
    if (-not (Test-Path $archive)) { throw "download failed: $url" }

    if ($archiveExt -eq 'zip') {
        Expand-Archive -Path $archive -DestinationPath $tmp -Force
    } else {
        & tar -xJf $archive -C $tmp
        if ($LASTEXITCODE -ne 0) { throw 'tar failed to unpack the Node archive' }
    }

    $extracted = Join-Path $tmp $folder
    if (-not (Test-Path $extracted)) { throw "unexpected archive layout: $folder not found" }

    $binary = Join-Path $extracted $(if ($isWindowsTarget) { 'node.exe' } else { 'bin/node' })
    if (-not (Test-Path $binary)) { throw "no node binary in the archive at $binary" }

    Copy-Item $binary (Join-Path $nodeDir $(if ($isWindowsTarget) { 'node.exe' } else { 'node' })) -Force

    $license = Join-Path $extracted 'LICENSE'
    if (Test-Path $license) { Copy-Item $license (Join-Path $nodeDir 'LICENSE') -Force }

    $staged = Join-Path $nodeDir $(if ($isWindowsTarget) { 'node.exe' } else { 'node' })
    $size = (Get-Item $staged).Length / 1MB
    Write-Host ("staged {0}  ({1:N1} MB)" -f (Split-Path -Leaf $staged), $size)

    & $staged --version
    if ($LASTEXITCODE -ne 0) { Write-Warning 'the staged runtime did not report a version' }
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
