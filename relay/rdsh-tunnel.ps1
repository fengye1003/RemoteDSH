# rdsh-tunnel.ps1 - keep a reverse SSH tunnel alive so a public relay on the VPS
# reaches this machine's DSH web server.
#
# WHY: the target machine can only dial OUT. The relay seat
# lives in the local harness on %LocalPort%, which is behind NAT, so the VPS
# listens on 127.0.0.1:%RemotePort% and the public vhost proxies /rdsh/ into it.
#
# Reconnects forever; Ctrl+C (or killing the job) closes the tunnel.
#
# NOTE: reach the relay host over whatever private path works for you (the
# author uses a tailnet address, never the public IP: with a TUN-style proxy
# running, traffic to the public IP gets routed through the proxy and sshd
# drops the connection during key exchange).
#
# PURE ASCII ONLY (Windows PowerShell 5.1 decodes BOM-less UTF-8 as GBK).
[CmdletBinding()]
param(
    [int]$LocalPort = 8088,
    [int]$RemotePort = 18088,
    [string]$HostAddr = 'agent-host.local',
    [string]$SshUser = 'root',
    [int]$SshPort = 22
)
$ErrorActionPreference = 'Continue'
$KeyDir = Join-Path $PSScriptRoot 'keys'
$Key = Join-Path $KeyDir 'dsh-deploy_ed25519'
$Known = Join-Path $KeyDir 'known_hosts'
$Target = '{0}@{1}' -f $SshUser, $HostAddr

$common = @('-i', $Key, '-p', [string]$SshPort,
            '-o', 'StrictHostKeyChecking=no',
            '-o', "UserKnownHostsFile=$Known",
            '-o', 'ConnectTimeout=20',
            '-o', 'ServerAliveInterval=30',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'ExitOnForwardFailure=yes',
            '-N', '-R', "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}", $Target)

Write-Host ("[rdsh-tunnel] VPS 127.0.0.1:{0}  ->  local 127.0.0.1:{1}" -f $RemotePort, $LocalPort) -ForegroundColor Cyan
while ($true) {
    Write-Host ("[rdsh-tunnel] connecting at {0}" -f (Get-Date -Format 'HH:mm:ss'))
    & ssh @common
    Write-Host ("[rdsh-tunnel] tunnel ended (exit {0}); retrying in 5s" -f $LASTEXITCODE) -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
