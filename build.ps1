# Build rdsh (the RemoteDSH target-side agent).
#
# Why this script exists instead of calling dotnet directly: on this machine the
# .NET TLS stack cannot reach nuget.org (schannel: "no credentials available in
# the security package"), while Node's OpenSSL stack works fine. Routing NuGet
# through the local proxy with an explicit --configfile is what makes a restore
# succeed. See README.md "build notes".
#
#   .\build.ps1                    # slim   -> 03-bin\win-x64        (no Node shipped)
#   .\build.ps1 -Full              # full   -> 03-bin\win-x64-full   (ships a Node runtime)
#   .\build.ps1 -Rid linux-x64     # cross-target (needs the matching runtime pack)
#   .\build.ps1 -Quick             # fast build, no AOT, real line numbers
#
# The full flavor stages a Node runtime in a `node\` folder next to the binary.
# get-node.ps1 downloads it; this script only wires the pieces together.

[CmdletBinding()]
param(
    [string]$Rid = 'win-x64',
    [string]$Configuration = 'Release',
    [switch]$Full,
    [switch]$Quick
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$agentDir = Join-Path $root '01-agent'

# The full flavor gets its own output directory so the two flavors never mix and
# a slim binary can never silently pick up a staged runtime.
$flavor = if ($Full) { 'full' } else { 'slim' }
$outDir = Join-Path $root ("03-bin\" + $(if ($Full) { "$Rid-full" } else { $Rid }))

$proxy = 'http://127.0.0.1:7897'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:HTTP_PROXY = $proxy
$env:HTTPS_PROXY = $proxy

if ($Quick) {
    Write-Host "building ($flavor, Debug, no AOT) -> $outDir"
    $quickArgs = @("$agentDir\rdsh.csproj", '-c', 'Debug', '--configfile', "$root\nuget.proxy.config", '--nologo', '-o', $outDir)
    if ($Full) { $quickArgs += '-p:EmbedNode=true' }
    dotnet build @quickArgs
    exit $LASTEXITCODE
}

Write-Host "publishing $Rid ($flavor, $Configuration, NativeAOT) -> $outDir"
$publishArgs = @(
    "$agentDir\rdsh.csproj",
    '-c', $Configuration,
    '-r', $Rid,
    '--configfile', "$root\nuget.proxy.config",
    '-o', $outDir,
    '--nologo'
)
if ($Full) {
    # Defines EMBED_NODE so the binary can state its own flavor in hello/banner.
    $publishArgs += '-p:EmbedNode=true'
    Write-Host 'flavor full: EMBED_NODE defined; a Node runtime must be staged in node\'
}

dotnet publish @publishArgs
if ($LASTEXITCODE -ne 0) { throw "publish failed with exit code $LASTEXITCODE" }

$exe = Get-ChildItem $outDir -Filter 'rdsh*' -File |
    Where-Object { $_.Extension -in '.exe', '' -and $_.Name -notlike '*.pdb' } |
    Select-Object -First 1

if ($exe) {
    Write-Host ("built {0}  ({1:N2} MB)  flavor={2}" -f $exe.Name, ($exe.Length / 1MB), $flavor)
}

if ($Full) {
    $nodeDir = Join-Path $outDir 'node'
    $nodeExe = Join-Path $nodeDir $(if ($Rid -like 'win-*') { 'node.exe' } else { 'node' })
    if (Test-Path $nodeExe) {
        $total = (Get-ChildItem $outDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
        Write-Host ("staged Node runtime found; full bundle is {0:N1} MB" -f ($total / 1MB))
    } else {
        Write-Warning "full flavor has no staged Node runtime yet: run .\get-node.ps1 -Rid $Rid -OutDir '$outDir' (the node method will report no_node_runtime until then)"
    }
}
