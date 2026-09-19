# Autonomous opencode loop — Windows PowerShell
# Resumes one session forever until you stop it.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/autonomous-loop.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/autonomous-loop.ps1 -SessionId ses_XXXX -MaxIterations 50 -SleepSeconds 5
# Stop: Ctrl+C, or `New-Item AUTONOMOUS.STOP` from another terminal.

param(
  [string]$SessionId = "ses_f567fed93ffeUmx0yds8Wt0GjE",
  [int]$MaxIterations = 0,   # 0 = infinite
  [int]$SleepSeconds = 5
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$StopFile = Join-Path $Root "AUTONOMOUS.STOP"
$PromptFile = Join-Path $Root "AUTONOMOUS.md"
$LogDir = Join-Path $Root "logs/autonomous"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $PromptFile)) { throw "Missing $PromptFile" }

# Preflight: opencode must exist, session must exist
opencode session list -n 50 --format json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "opencode CLI not working. Is opencode installed and logged in?" }

Write-Host "=== Autonomous loop ===" -ForegroundColor Cyan
Write-Host " session : $SessionId"
Write-Host " root    : $Root"
Write-Host " stop    : create file AUTONOMOUS.STOP or press Ctrl+C"
Write-Host " logs    : $LogDir"
Write-Host ""

$i = 0
while ($true) {
  $i++
  if ((Test-Path $StopFile)) {
    Write-Host "STOP file found ($StopFile). Exiting cleanly after $i iterations." -ForegroundColor Yellow
    break
  }
  if ($MaxIterations -gt 0 -and $i -gt $MaxIterations) {
    Write-Host "Reached MaxIterations=$MaxIterations. Exiting." -ForegroundColor Yellow
    break
  }

  $iterLabel = if ($MaxIterations -gt 0) { "ITERATION $i of $MaxIterations" } else { "ITERATION $i (infinite, Ctrl+C or AUTONOMOUS.STOP to stop)" }
  $logFile = Join-Path $LogDir ("iter-{0:0000}-{1:yyyyMMdd-HHmmss}.log" -f $i, (Get-Date))
  Write-Host "`n--- $iterLabel ---" -ForegroundColor Green
  Write-Host " log: $logFile"

  $prompt = @"
$iterLabel — session $SessionId.
Read AUTONOMOUS.md and TODO_AUTONOMOUS.md in project root and execute EXACTLY ONE iteration of the Plan->Code->Test->Refine loop (pick top unchecked task, implement最小 fix, run typecheck + relevant vitest, update TODO_AUTONOMOUS.md, output per-iteration contract). If AUTONOMOUS.STOP exists, summarize and exit. Do not ask questions. Do not stop early.
"@

  # --auto = auto-approve non-denied permissions (dangerous by design for autonomy).
  # The prompt file itself constrains scope (no legacy/, no .env, no push).
  opencode run -s $SessionId --auto "$prompt" 2>&1 | Tee-Object -FilePath $logFile
  $code = $LASTEXITCODE
  Write-Host " exit code: $code" -ForegroundColor DarkGray

  if ($code -ne 0) {
    Write-Host " opencode exited non-zero. Sleeping $SleepSeconds s then retrying (log above has details)..." -ForegroundColor Yellow
  } else {
    Write-Host " iteration done. Sleeping $SleepSeconds s..." -ForegroundColor DarkGray
  }
  Start-Sleep -Seconds $SleepSeconds
}
