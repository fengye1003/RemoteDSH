# build.ps1 - build the x86 (Windows 7 compatible) RemoteDSH agent.
#
# Pure ASCII on purpose: Windows PowerShell 5.1 decodes a BOM-less UTF-8 .ps1 as
# GBK, and non-ASCII comments then corrupt the script in ways that blame the
# wrong line.
[CmdletBinding()]
param(
    [string]$Toolchain = 'C:\mingw32\bin',
    [switch]$KeepLog
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$gpp = Join-Path $Toolchain 'g++.exe'
$objdump = Join-Path $Toolchain 'objdump.exe'
if (-not (Test-Path -LiteralPath $gpp)) { throw "g++ not found at $gpp (pass -Toolchain)" }

$out = Join-Path $here 'rdsh32.exe'
$src = Join-Path $here 'rdsh32.cpp'
$log = Join-Path $here '_build.log'

Write-Host "building $out" -ForegroundColor Cyan
# -municode           : wmain + wide argv (Chinese paths on the command line)
# -static             : no libstdc++/libgcc DLLs to ship
# -m32 is implicit    : the i686 toolchain produces a 32-bit exe, which WoW64 runs
#                       on 64-bit Windows too -- one binary for every Windows.
# --no-insert-timestamp: rebuilds become byte-identical, which matters because the
#                       downloader pins this file's SHA256.
$cppArgs = @('-std=c++17', '-O2', '-municode', '-static', '-static-libgcc', '-static-libstdc++',
             '-Wall', '-Wextra', '-Wno-unused-parameter', '-Wl,--no-insert-timestamp',
             '-o', $out, $src, '-lws2_32', '-ladvapi32')
& $gpp @cppArgs 2>&1 | Tee-Object -FilePath $log
if (-not (Test-Path -LiteralPath $out)) { throw "build failed; see $log" }

# The compatibility promise is "nothing but OS DLLs", so verify it every build.
$imports = & $objdump -p $out | Select-String -Pattern 'DLL Name:' | ForEach-Object { ($_.Line -split ':')[1].Trim() }
Write-Host ("imports: " + ($imports -join ', ')) -ForegroundColor Cyan
$allowed = @('ADVAPI32.dll', 'KERNEL32.dll', 'msvcrt.dll', 'WS2_32.dll', 'USER32.dll', 'SHELL32.dll', 'OLE32.dll')
$unexpected = $imports | Where-Object { $allowed -notcontains $_ }
if ($unexpected) { throw "unexpected imports (would break old Windows): $($unexpected -join ', ')" }

& $out --selftest
$hash = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item -LiteralPath $out).Length
Write-Host ""
Write-Host "ok: $out" -ForegroundColor Green
Write-Host ("  size   : {0} bytes" -f $size)
Write-Host ("  sha256 : {0}" -f $hash)
Write-Host "  put sha256 into getdshhelp.bat before uploading"
if (-not $KeepLog) { Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue }
