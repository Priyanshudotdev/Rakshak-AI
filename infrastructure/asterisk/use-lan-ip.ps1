# Re-points Asterisk's advertised media address at the host's CURRENT LAN IP
# and restarts the container. Run after any WiFi change. Usage:
#   .\use-lan-ip.ps1                  # auto-detect Wi-Fi IPv4
#   .\use-lan-ip.ps1 -Ip 192.168.1.52 # explicit address
# Why raw IP and not a hostname: Android Linphones cannot resolve mDNS
# (.local), so SDP must carry a numeric address the phones can send RTP to.
param([string]$Ip = "")

$ErrorActionPreference = "Stop"
if (-not $Ip) {
  $Ip = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -like "*Wi-Fi*" } |
    ForEach-Object { $_.IPAddress } |
    Where-Object { $_ -notlike "169.254.*" } |
    Select-Object -First 1
}
if (-not $Ip) { throw "No Wi-Fi IPv4 address found - connect to Wi-Fi first." }

$conf = Join-Path $PSScriptRoot "pjsip.conf"
$lines = Get-Content -LiteralPath $conf
$hit = $false
$lines = foreach ($line in $lines) {
  if ($line -match "^external_media_address\s*=") {
    $hit = $true
    "external_media_address = $Ip"
  } else {
    $line
  }
}
if (-not $hit) { throw "external_media_address line not found in pjsip.conf" }
Set-Content -LiteralPath $conf -Value $lines
Write-Output "media address -> $Ip"

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$override = "C:\Users\priya\AppData\Local\Temp\opencode\compose.ports.yml"
Set-Location -LiteralPath $repo
docker compose -f "docker-compose.yml" -f $override up -d --force-recreate asterisk | Select-Object -Last 1
Write-Output "asterisk restarted - re-register both Linphones, then dial."
