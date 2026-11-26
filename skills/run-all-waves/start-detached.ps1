<#
.SYNOPSIS
  Starts run-all-waves.ps1 as a process that no Claude Code session owns, and prints its pid.
.DESCRIPTION
  A driver started as a session's background command is that session's child: when memory runs
  low, Claude Code kills the session's background commands, and the driver and its wave session
  die with them (2026-10-30, ReadTheStupidText, 23:35). This creates the driver through WMI
  (Win32_Process.Create), so its parent is the WMI host, not this shell, and nothing Claude Code
  stops reaches it. Its console output goes to <repo>-worktrees/run-all-waves/driver-<time>.log;
  status.json in the night folder stays the record of the run.
    pwsh -NoProfile -File start-detached.ps1 -Repo D:\my-app [-PermissionMode auto] [-Model <m>]
  -StarterSessionId wins when given (pass the launching session's own CLAUDE_CODE_SESSION_ID); without it the newest
  interactive record of the repo's project folder is used and `claude -p` records are skipped.
  -Command replaces the driver command line (tests use it).
#>
param(
  [Parameter(Mandatory)][string]$Repo,
  [string]$PermissionMode,
  [string]$Model,
  [string]$Command,
  [string]$StarterSessionId,
  [string]$ProjectsDir = (Join-Path $HOME '.claude\projects')
)
$ErrorActionPreference = 'Stop'

# The launching interactive session is writing the newest transcript of the repo's project folder right now.
# A `claude -p` run (a probe, a wave session) writes "entrypoint":"sdk-cli" in its first records; an interactive one writes "cli".
function Test-HeadlessRecord([System.IO.FileInfo]$file) {
  $head = Get-Content $file.FullName -TotalCount 40 -ErrorAction SilentlyContinue
  return [bool]($head -match '"entrypoint":"sdk-cli"')
}

function Get-StarterSessionId([string]$repoRoot) {
  # A session id is letters, digits, "-" and "_" only; anything else (a space, "&", a literal ":CLAUDE_CODE_SESSION_ID" from bash) is
  # never put on the command line: warn and fall back to the folder scan.
  if ($StarterSessionId -match '^[A-Za-z0-9_-]+$') { return $StarterSessionId }
  if ($StarterSessionId) { Write-Warning "ignoring -StarterSessionId '$StarterSessionId': not a session id (letters, digits, - and _ only); using the newest interactive transcript" }
  $folder = Join-Path $ProjectsDir ([regex]::Replace($repoRoot, '[^a-zA-Z0-9]', '-'))
  if (-not (Test-Path $folder)) { return $null }
  $records = @(Get-ChildItem $folder -Filter *.jsonl -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  $newest = $records | Where-Object { -not (Test-HeadlessRecord $_) } | Select-Object -First 1
  if ($newest) { return $newest.BaseName }
  if ($records.Count) { Write-Warning "no starter session recorded: all $($records.Count) transcripts in $folder are headless (entrypoint sdk-cli)" }
  return $null
}

function Get-DriverCommand([string]$repoRoot, [string]$log, [string]$starterId) {
  # $PSHOME is the real install folder; the WindowsApps pwsh alias may not start under WMI.
  $pwsh = Join-Path $PSHOME 'pwsh.exe'
  $driver = Join-Path $PSScriptRoot 'run-all-waves.ps1'
  $line = "`"$pwsh`" -NoProfile -File `"$driver`" -Repo `"$repoRoot`""
  if ($PermissionMode) { $line += " -PermissionMode $PermissionMode" }
  if ($Model) { $line += " -Model $Model" }
  if ($starterId) { $line += " -StarterSessionId $starterId" }
  return "cmd.exe /c `"$line >> `"$log`" 2>&1`""
}

function Start-Detached([string]$commandLine, [string]$directory) {
  # ShowWindow 0 (SW_HIDE): cmd.exe gets a hidden console that every child inherits. Checked so far: a `ping` child opens no
  # window (docs/plan/unverified.md, Slice 17); not checked: other children, or Windows Terminal as the default console host.
  # The launch code at the end warns after every real launch when a window appeared.
  $arguments = @{ CommandLine = $commandLine; CurrentDirectory = $directory }
  try {
    $arguments.ProcessStartupInformation = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  } catch {
    Write-Warning "could not build the hidden start information ($($_.Exception.Message)); starting with a normal console, a window may open"
  }
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments
  if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($result.ReturnValue): $commandLine" }
  return $result.ProcessId
}

# Visible top-level windows of console hosts (a terminal window the launch would open shows up here).
function Get-VisibleConsoleWindowCount {
  $hosts = @('cmd', 'pwsh', 'powershell', 'conhost', 'WindowsTerminal', 'OpenConsole')
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $hosts -contains $_.ProcessName -and $_.MainWindowHandle -ne 0 }).Count
}

# Claude Code names a project folder after the long path of the cwd; a short 8.3 spelling (RUNNER~1) must not change the name.
function Get-LongPath([string]$path) {
  Add-Type -Namespace Win32 -Name LongPath -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern uint GetLongPathName(string shortPath, System.Text.StringBuilder longPath, uint size);'
  $buffer = New-Object System.Text.StringBuilder 32768
  $length = [Win32.LongPath]::GetLongPathName($path, $buffer, $buffer.Capacity)
  if ($length -eq 0) { return $path }
  return $buffer.ToString()
}

$repoRoot = Get-LongPath (Resolve-Path $Repo).Path
$runDir = Join-Path (Split-Path $repoRoot -Parent) "$(Split-Path $repoRoot -Leaf)-worktrees\run-all-waves"
New-Item -ItemType Directory -Force $runDir | Out-Null
$log = Join-Path $runDir ("driver-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd-HHmm'))
$starterId = Get-StarterSessionId $repoRoot
$line = if ($Command) { $Command } else { Get-DriverCommand $repoRoot $log $starterId }
$windowsBefore = Get-VisibleConsoleWindowCount
$processId = Start-Detached $line $repoRoot
# $processId is cmd.exe's; a driver that fails at once (lock held, bad argument) ends it within seconds.
Start-Sleep -Seconds 5
$windowsAfter = Get-VisibleConsoleWindowCount
if ($windowsAfter -gt $windowsBefore) { Write-Warning "a console window appeared during the launch ($windowsBefore visible before, $windowsAfter after): the hidden start did not hide it; report it (docs/plan/unverified.md, Slice 17 F3)" }
if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
  $output = if (Test-Path $log) { Get-Content $log -Raw } else { '(no log)' }
  throw "the driver exited within 5 seconds: $output"
}
Write-Output "started pid $processId; log $log; starter session $(if ($starterId) { $starterId } else { 'none found' })"
