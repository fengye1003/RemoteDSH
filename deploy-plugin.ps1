# Deploy RemoteDSH's controller plugin into the DSH web profile.
#
# The profile mounts plugins by absolute path, so the source tree stays the single
# source of truth and nothing is copied anywhere. This script only writes the
# patch entry (idempotently, with a backup) and tells you what happens next.
#
#   .\deploy-plugin.ps1                                  # use the folder this script is in
#   .\deploy-plugin.ps1 -Source C:\path\to\remote-dsh    # use another checkout
#   .\deploy-plugin.ps1 -Remove                          # unmount
#
# -Source defaults to $PSScriptRoot, so a normal clone needs no arguments at all.
#
# The patch file is what boots the harness, so every edit is backed up first and
# the result is re-parsed before it is kept. -Remove rewrites the file from the
# parsed structure instead of slicing lines, because a line-slicing version of
# this script corrupted the file once already.
#
# Pure ASCII on purpose: Windows PowerShell 5.1 decodes a BOM-less UTF-8 .ps1 as
# GBK, and non-ASCII comments then corrupt the script in ways that blame the
# wrong line.

[CmdletBinding()]
param(
    [string]$Source,
    [string]$ProfilePatch,
    [string]$StateFile,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Source) {
    $root = (Resolve-Path -LiteralPath $Source).Path
} else {
    $root = $PSScriptRoot
}
$pluginPath = Join-Path $root '02-plugin\index.js'
if (-not $StateFile) { $StateFile = Join-Path $root 'data\devices.json' }
if (-not $ProfilePatch) { $ProfilePatch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml' }

if (-not (Test-Path -LiteralPath $pluginPath)) { throw "plugin not found: $pluginPath (pass -Source)" }
if (-not (Test-Path -LiteralPath $ProfilePatch)) { throw "profile patch not found: $ProfilePatch (pass -ProfilePatch)" }

# Find a usable 'yaml' module. DSH is normally started through npx, so the copy
# that matters is whichever _npx tree was installed last; a hardcoded tree hash
# breaks on the next upgrade, so scan instead. $env:DSH_YAML_DIR wins if set.
$yamlCandidates = New-Object System.Collections.ArrayList
if ($env:DSH_YAML_DIR) { [void]$yamlCandidates.Add((Join-Path $env:DSH_YAML_DIR 'dist\index.js')) }
[void]$yamlCandidates.Add((Join-Path $root 'node_modules\yaml\dist\index.js'))
$npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
if (Test-Path -LiteralPath $npxRoot) {
    Get-ChildItem -LiteralPath $npxRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName 'node_modules\yaml\dist\index.js' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { [void]$yamlCandidates.Add($_) }
}
$yamlCandidates = @($yamlCandidates | Where-Object { Test-Path -LiteralPath $_ })
if ($yamlCandidates.Count -eq 0) {
    throw 'yaml module not found; set DSH_YAML_DIR to the installed yaml folder (the one holding dist\index.js)'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$ProfilePatch.bak-$stamp"
Copy-Item -LiteralPath $ProfilePatch -Destination $backup -Force
Write-Host "backed up  -> $backup"

# Edit the document through the YAML parser so the structure can never be sliced
# wrong. Written as a literal here-string and driven entirely by argv, so there is
# no quoting or interpolation to get wrong.
$editScript = Join-Path $env:TEMP "rdsh-patch-edit-$stamp.mjs"
$js = @'
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const file = argv[0];
const mode = argv[1];
const pluginUrl = argv[2];
const stateUrl = argv[3];
const candidates = argv.slice(4);

let YAML = null;
for (const c of candidates) {
  try {
    YAML = await import(pathToFileURL(c).href);
    break;
  } catch (err) {
    /* try the next candidate */
  }
}
if (!YAML) {
  console.error('YAML-MODULE-NOT-FOUND');
  process.exit(4);
}

let doc;
try {
  doc = YAML.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error('PATCH-PARSE-FAILED ' + err.message);
  process.exit(2);
}
if (!Array.isArray(doc)) {
  console.error('PATCH-NOT-ARRAY');
  process.exit(2);
}

const has = doc.some((e) => (e && e.insert ? e.insert : []).some((i) => i && i.id === 'dsh-remote'));

if (mode === 'remove') {
  if (!has) {
    console.log('NOT-MOUNTED');
    process.exit(0);
  }
  const next = doc
    .map((entry) => {
      if (!entry || !entry.insert) return entry;
      const kept = entry.insert.filter((i) => !i || i.id !== 'dsh-remote');
      return kept.length > 0 ? { ...entry, insert: kept } : null;
    })
    .filter(Boolean);
  writeFileSync(file, YAML.stringify(next), 'utf8');
  console.log('REMOVED');
  process.exit(0);
}

if (has) {
  console.log('ALREADY-MOUNTED');
  process.exit(0);
}

doc.push({
  insert: [
    {
      id: 'dsh-remote',
      name: pluginUrl,
      config: {
        attachPath: '/remote/attach',
        panelPath: '/remote/',
        stateFile: stateUrl,
      },
    },
  ],
});

// Refuse to write anything the parser cannot read back.
const out = YAML.stringify(doc);
const check = YAML.parse(out);
if (!Array.isArray(check) || check.length !== doc.length) {
  console.error('SELF-CHECK-FAILED');
  process.exit(3);
}
writeFileSync(file, out, 'utf8');
console.log('MOUNTED');
'@
[System.IO.File]::WriteAllText($editScript, $js, (New-Object System.Text.UTF8Encoding($false)))

$pluginUrl = $pluginPath.Replace('\', '/')
$stateUrl = $StateFile.Replace('\', '/')
$mode = if ($Remove) { 'remove' } else { 'mount' }
$result = & node $editScript $ProfilePatch $mode $pluginUrl $stateUrl @yamlCandidates 2>&1
Write-Host "edit result -> $result"
Remove-Item -LiteralPath $editScript -Force -ErrorAction SilentlyContinue

if ($result -match 'PATCH-PARSE-FAILED|SELF-CHECK-FAILED|PATCH-NOT-ARRAY|YAML-MODULE-NOT-FOUND') {
    Copy-Item -LiteralPath $backup -Destination $ProfilePatch -Force
    throw 'patch edit failed; restored the backup. Nothing was changed.'
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart the harness so the profile patch is loaded.'
Write-Host '  2. The assistant can then pair a device and drive it with the remote tool.'
Write-Host '  3. The device panel lives at /remote/ behind the usual 2FA.'
