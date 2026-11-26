<#
.SYNOPSIS
  Runs waves until no planned slice is left in one repo, then the feedback loop.

.DESCRIPTION
  Each step is a fresh headless `claude -p` session, so every wave starts with an empty
  context (a session cannot /compact itself; a new one is the same thing, done cleanly):
    1. read plan.md on origin/main; stop if no row is "planned"
    2. `/run-all-waves wave <n>`        one wave of run-wave, unattended
    3. `/run-all-waves housekeeping <n>` index pass, park, clean plan.md, archive-docs
    4. back to 1. Two rounds in a row with no progress (planned list unchanged and no PR merged)
       stop the loop.
  When the waves end normally (no planned slice left, or the no-progress stop), ONE `/plan-cleanup all` session runs
  first (branch chore/plan-cleanup-<yyyymmdd-hhmm>, not slice progress); an error, disk-low, fast-failure or stop-file end skips it.
  Then ONE `/feedback-loop` over every wave and housekeeping session of the run, the session that started
  the run and any earlier night's sessions no loop audited. It runs even when the wave loop failed.
  (User, 2026-11-01: per-round loops took 4.5 of 11 hours; one loop at the end.) Creating
  <run folder>\run-all-waves.stop stops the loop before the next wave (the current round's housekeeping
  and the last feedback loop still run).
  Nobody answers prompts at night: every session gets --permission-prompts none, so anything that
  would ask is denied and the session records it instead of hanging.
  There is no wall-clock cap on wave and housekeeping sessions; a feedback-loop session is killed after
  -FeedbackLoopMaxMinutes (30) and does not start while the session that started the run still has its own subagents running.
  A watchdog checks every -WatchdogSeconds: a session whose transcript,
  log and process tree show no activity for -IdleChecksLimit checks in a row is killed and the run goes on.

.EXAMPLE
  pwsh -File run-all-waves.ps1 -Repo D:\my-app -PermissionMode auto
#>
param(
  # No default and not Mandatory: a trailing path glued onto `pwsh -Command` once ran this with no parameters (2026-11-06).
  [string]$Repo,
  [string]$PermissionMode,
  [string]$Model,
  [int]$NoProgressLimit = 2,
  [string]$ClaudeCommand = 'claude',
  [int]$WatchdogSeconds = 600,
  [int]$IdleChecksLimit = 3,
  [int]$FastFailureSeconds = 120,
  [string]$GhCommand = 'gh',
  # Hard wall-clock cap of every feedback-loop session (user, 2026-11-01: never more than 30 minutes).
  [double]$FeedbackLoopMaxMinutes = 30,
  # The loop does not start while the interactive session that started the run still has its own subagents in flight
  # (main-busy.mjs); its check timer alone does not count. Checked every -StarterCheckSeconds, for at most this long.
  [double]$StarterWaitMaxMinutes = 240,
  [int]$StarterCheckSeconds = 60,
  # A starter transcript not written for this long is a dead or idle session, not a busy one.
  [double]$StarterFreshMinutes = 30,
  # While a session runs, a starter with no assistant entry for this long is recorded as status.json starterSilentSince
  # (starter-silent.mjs; read-only, never kills anything). Checked at every watchdog tick.
  [double]$StarterSilentMinutes = 25,
  [string]$ProjectsDir = (Join-Path $HOME '.claude\projects'),
  # The interactive session that launched the run (start-detached.ps1 records it at launch). A restart after a dead
  # driver keeps the earlier night's value if it has one.
  [string]$StarterSessionId,
  # Merges of this run carry [skip ci]; batch-release.mjs starts the workflows they skipped, once per -BatchReleaseHours
  # (after a wave) and once on the way out. The final one is watched for at most -BatchWatchMaxMinutes.
  [string]$BatchReleaseScript = (Join-Path $PSScriptRoot '..\run-wave\batch-release.mjs'),
  [double]$BatchReleaseHours = 6,
  [int]$BatchWatchMaxMinutes = 240,
  # Slice 31: after a batched release that went live, and once before the feedback loop, a headless "live checks" session runs the
  # open unverified.md lines tagged chrome, session, phone or cloud (live-checks.mjs --count/--todo). Hard cap per session.
  [string]$LiveChecksScript = (Join-Path $PSScriptRoot 'live-checks.mjs'),
  [double]$LiveChecksMaxMinutes = 60,
  # On the way out the driver deletes leftover app builds (tmp*.apk copies and other packages) older than
  # -TempBuildMinAgeMinutes from the top of this folder (2026-11-07: 124.5 GB of them filled C: mid-run).
  [string]$TempBuildsDir = [IO.Path]::GetTempPath(),
  [double]$TempBuildMinAgeMinutes = 120,
  # The node cleanup is killed after this long, so a hung disk cannot keep the lock or the final status write.
  [int]$TempCleanupTimeoutSeconds = 120,
  # clean-stale.mjs: after every wave it deletes the wave's `_builds` entries; on the way out it deletes cached builds, git
  # worktrees, leftover worktree-folder entries and temp entries untouched for -StaleCleanupHours (2026-11-08: D: hit 0 bytes
  # with 35 GB of cache entries from 10 days earlier). Killed after -StaleCleanupTimeoutSeconds; results in status.json.
  # Keep this above HOLDERS_TIMEOUT_MS in clean-stale.mjs (480 s, the cap on its holder check); a test enforces it.
  [string]$StaleCleanupScript = (Join-Path $PSScriptRoot 'clean-stale.mjs'),
  [double]$StaleCleanupHours = 24,
  [int]$StaleCleanupTimeoutSeconds = 900,
  # Before every wave the driver cleans the temp builds, then stops with a stopReason when the temp or worktree drive
  # has less than its need free (2026-11-07: a wave claimed four slices with C: at 0 GB). -DiskFreeScript is the
  # reader (disk-free.mjs: JSON on stdout, exit 1 when low); tests pass a fake.
  # Slice 317 item 2: per drive. The temp drive (C:) holds %TEMP% (Maestro's tmp*.apk copies; the cleanup above keeps it down), the worktree drive (D:) holds
  # the worktrees, the build cache and each app build's obj folders: a wave of four app builds was estimated at about 24 GB there (2026-11-08 session; an
  # estimate, not a measurement: the disk-free line the driver logs before each wave is the data to refine it from).
  [string]$DiskFreeScript = (Join-Path $PSScriptRoot 'disk-free.mjs'),
  # -MinFreeGb is the pre-Slice-317 name of the one threshold; it still works and sets the stop threshold of both drives (below, after the param block).
  [double]$MinFreeGb = -1,
  [double]$MinFreeGbTemp = 5,
  # Stop thresholds are per drive; the worktree drive stops at 5 GB as before. The 24 GB figure is only a printed estimate (never a stop: a running night is not stopped by a guess).
  [double]$MinFreeGbWorktrees = 5,
  [double]$EstimateGbWorktrees = 24,
  # Slice 393 item 5: under this much free memory the status records a snapshot of the biggest processes (status.json lowMemory). 8 = the desktop VM's minimum (Invoke-DesktopTest.ps1 -MinFreeMemoryGB).
  [double]$LowMemoryGb = 8,
  # Slice 08: each wave prompt carries every planned slice's placement (placement.mjs, run on the slice file as it is on
  # origin/main). No script can read the weekly usage, so the usage stop is a fixed number of cloud slices per night:
  # the wave session sends no more than the cap's remainder to the cloud. 0 turns cloud placement off. The count is the slice numbers
  # the wave ledger showed as cloud, only ever added to (cloudSlices and cloudSlicesUsed in status.json).
  [int]$MaxCloudSlices = 4,
  [string]$PlacementScript = (Join-Path $PSScriptRoot '..\run-wave\placement.mjs')
)

$ErrorActionPreference = 'Stop'
if ($MinFreeGb -ge 0) { $MinFreeGbTemp = $MinFreeGb; $MinFreeGbWorktrees = $MinFreeGb }
$UsageExit = 2
if (-not $Repo) {
  [Console]::Error.WriteLine('run-all-waves: pass -Repo <primary checkout>; refusing to default to the current folder')
  exit $UsageExit
}
# Fails closed: if git cannot answer (not a repo, missing path), refuse. 'Continue' keeps Windows PowerShell 5.1 from
# throwing on git's stderr; the answer is judged by $LASTEXITCODE. No --path-format, so old git works; relative paths
# are resolved against -Repo.
function Get-RepoGitDirs {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(git -C $Repo rev-parse --git-dir --git-common-dir 2>&1 | Where-Object { $_ -is [string] }) } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0 -or $lines.Count -ne 2) { return $null }
  return @($lines | ForEach-Object {
    $dir = if ([System.IO.Path]::IsPathRooted($_)) { $_ } else { Join-Path $Repo $_ }
    ([System.IO.Path]::GetFullPath($dir) -replace '\\', '/').TrimEnd('/')
  })
}
$repoDirs = Get-RepoGitDirs
if (-not $repoDirs) {
  [Console]::Error.WriteLine("run-all-waves: -Repo is not a git repository (or git failed): $Repo")
  exit $UsageExit
}
if ($repoDirs[0] -ne $repoDirs[1]) {
  [Console]::Error.WriteLine("run-all-waves: -Repo must be the primary checkout, not a linked worktree: $Repo")
  exit $UsageExit
}
$SkillDir = $PSScriptRoot
$RemainingScript = Join-Path $SkillDir 'remaining-slices.mjs'
$MainBusyScript = Join-Path $SkillDir 'main-busy.mjs'
$StarterSilentScript = Join-Path $SkillDir 'starter-silent.mjs'
$CleanTempBuildsScript = Join-Path $SkillDir 'clean-temp-builds.mjs'
$StartedAt = Get-Date
$NoTableExit = 2
$LockWriteGraceSeconds = 10
$PermissionWarning = 'Permission allow rule'
$NoModeWarning = 'run-all-waves warning: no -PermissionMode given; edits and Bash will be denied unless your default permission mode allows them.'
# The driver's own housekeeping and feedback branches: their merged PRs are not slice progress.
$HousekeepingBranch = '^chore/(docs-index|feedback-loop|plan-cleanup)'
# A descendant that only waits: not a sign the session is working.
$PlainTimerName = '^(sleep|timeout|conhost)(\.exe)?$'
$PlainTimerCommand = '\b(sleep|timeout|Start-Sleep)\b'

# One timestamped line in the driver trace file (driver-<night>.trace.log), so a silent death leaves a trace
# (2026-10-31: two empty logs). It is NOT the file the launcher redirects stdout into: that redirect holds its
# file open without sharing, so appending to it fails. Never throws: a log that cannot be written must not stop the run.
function Write-DriverLog([string]$message) {
  if (-not $script:DriverLogPath) { return }
  try {
    New-Item -ItemType Directory -Force (Split-Path $script:DriverLogPath -Parent) | Out-Null
    Add-Content -Path $script:DriverLogPath -Value ('{0} {1}' -f (Get-Date).ToString('o'), $message) -ErrorAction Stop
  } catch { [Console]::Error.WriteLine("driver trace log write failed ($script:DriverLogPath): $($_.Exception.Message)") }
}

function Resolve-Paths {
  $root = (git -C $Repo rev-parse --show-toplevel).Trim() -replace '/', '\'
  $name = Split-Path $root -Leaf
  $worktrees = Join-Path (Split-Path $root -Parent) "$name-worktrees"
  $runDir = Join-Path $worktrees 'run-all-waves'
  return [pscustomobject]@{
    Root = $root; Worktrees = $worktrees; RunDir = $runDir
    Night = Join-Path $runDir ($StartedAt.ToString('yyyy-MM-dd-HHmm'))
    Lock = Join-Path $runDir 'run-all-waves.lock'
    Stop = Join-Path $runDir 'run-all-waves.stop'
    Status = Join-Path (Join-Path $runDir ($StartedAt.ToString('yyyy-MM-dd-HHmm'))) 'status.json'
  }
}

# A lock is stale when its pid is gone, is not a pwsh, or started after the lock was written (a recycled pid).
function Test-LockHolderAlive($paths) {
  $holder = 0
  $info = Get-Item $paths.Lock -ErrorAction SilentlyContinue
  if (-not $info) { return $false }
  $raw = "$(Get-Content $paths.Lock -Raw -ErrorAction SilentlyContinue)".Trim()
  # Created but not yet written by the launch that owns it.
  if (-not $raw) { return ((Get-Date) - $info.LastWriteTime).TotalSeconds -lt $LockWriteGraceSeconds }
  if (-not [int]::TryParse($raw, [ref]$holder)) { return $false }
  $process = Get-Process -Id $holder -ErrorAction SilentlyContinue
  if (-not ($process -and $process.ProcessName -match 'pwsh|powershell')) { return $false }
  return $process.StartTime -le $info.LastWriteTime
}

# CreateNew is atomic: of two launches, only one creates the file.
function New-LockFile($paths) {
  $stream = [System.IO.File]::Open($paths.Lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
  try {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes("$PID")
    $stream.Write($bytes, 0, $bytes.Length)
  } finally { $stream.Dispose() }
}

function Enter-Lock($paths) {
  New-Item -ItemType Directory -Force $paths.RunDir | Out-Null
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    try { New-LockFile $paths; return } catch [System.IO.IOException] {
      if (Test-LockHolderAlive $paths) { throw "run-all-waves already running in this repo (lock $($paths.Lock))" }
      Remove-Item $paths.Lock -ErrorAction SilentlyContinue
    }
  }
  throw "run-all-waves could not take the lock $($paths.Lock)"
}

# Only after the lock is ours: a second launch must not touch the first run's folder or pre-flight.
function Initialize-Night($paths) {
  New-Item -ItemType Directory -Force $paths.Night | Out-Null
  # The start session writes the phone pre-flight before the night folder exists; it belongs to this night.
  # A restart after a dead driver also carries the dead night's parked.md (SKILL.md, The driver died).
  foreach ($name in 'preflight.md', 'parked.md') {
    $carried = Join-Path $paths.RunDir $name
    if (Test-Path $carried) { Move-Item $carried (Join-Path $paths.Night $name) }
  }
  # A stop file older than this run is left over from an earlier night.
  if ((Test-Path $paths.Stop) -and ((Get-Item $paths.Stop).LastWriteTime -lt $StartedAt)) { Remove-Item $paths.Stop }
}

# A night folder name: yyyy-MM-dd-HHmm.
$NightFolderPattern = '^\d{4}-\d{2}-\d{2}-\d{4}$'
$NightFolderFormat = 'yyyy-MM-dd-HHmm'
# Sessions are carried only from nights whose folder is at most this many hours old; older ones are given up.
$CarryMaxAgeHours = 48

function Test-NightRecent([string]$folderName) {
  $started = [datetime]::ParseExact($folderName, $NightFolderFormat, [cultureinfo]::InvariantCulture)
  return ($StartedAt - $started).TotalHours -le $CarryMaxAgeHours
}

# True when the earlier night's own final feedback loop finished (exit 0), so nothing of it is left to audit.
function Test-FinalLoopComplete($earlier) {
  $final = @($earlier.sessions | Where-Object { $_.label -eq 'feedback-loop' -and $_.endedAt -and $_.exitCode -eq 0 -and -not $_.killedIdle -and -not $_.killedTimeout })
  return $final.Count -gt 0
}

function Read-NightStatus([string]$folder) {
  try { return Get-Content (Join-Path $folder 'status.json') -Raw | ConvertFrom-Json } catch { return $null }
}

# Sessions of every earlier night (a dead driver, SKILL.md "The driver died") whose final loop did not finish and
# that no night's loop audited, plus what those nights still carried. Each is { sessionId, night } so the loop can
# find its transcript; a session id appears once.
function Get-CarriedUnaudited($paths) {
  $current = Split-Path $paths.Night -Leaf
  $nights = @(Get-ChildItem $paths.RunDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $NightFolderPattern -and $_.Name -lt $current -and (Test-NightRecent $_.Name) -and (Test-Path (Join-Path $_.FullName 'status.json')) } |
    Sort-Object Name -Descending |
    ForEach-Object { [pscustomobject]@{ dir = $_.FullName; status = (Read-NightStatus $_.FullName) } } |
    Where-Object { $_.status })
  $audited = @($nights | ForEach-Object { @($_.status.audited) })
  $open = @($nights | Where-Object { -not (Test-FinalLoopComplete $_.status) })
  $own = @($open | ForEach-Object { $night = $_.dir; @($_.status.sessions) | ForEach-Object { [pscustomobject]@{ sessionId = $_.sessionId; night = $night } } })
  $carried = @($open | ForEach-Object { @($_.status.carriedUnaudited) | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ sessionId = $_.sessionId; night = $_.night } } })
  return @(($own + $carried) | Where-Object { $_ -and $_.sessionId -notin $audited } | Group-Object sessionId | ForEach-Object { $_.Group[0] })
}

# The final feedback-loop prompt says this once.
$StarterSessionClause = 'Also read the interactive session that started or restarted this run (find it with transcript-digest --list for the repo) and, before the note ships, re-read live state the note asserts (phone connection, host, PR states). '

# The feedback-loop prompt names these next to the new night's own unaudited sessions.
function Get-CarriedNote($state) {
  $carried = @($state.carriedUnaudited | Where-Object { $_ })
  if (-not $carried) { return '' }
  $list = ($carried | ForEach-Object { "$($_.sessionId) (night folder $($_.night))" }) -join ', '
  return "Also unaudited sessions of an earlier night whose driver died, to read by id: $list. "
}

function Get-Remaining($paths) {
  git -C $paths.Root fetch origin --quiet
  if ($LASTEXITCODE -ne 0) { throw "git fetch origin failed (exit $LASTEXITCODE); not working from a stale origin/main" }
  $output = node $RemainingScript $paths.Root 2>&1
  if ($LASTEXITCODE -eq $NoTableExit) { throw "$output" }
  if ($LASTEXITCODE -ne 0) { throw "remaining-slices.mjs failed (exit $LASTEXITCODE): $output" }
  return ($output | ConvertFrom-Json)
}

# Slice PRs merged since a moment count as progress even when housekeeping failed to update plan.md.
# The driver's own docs-index and feedback-loop PRs merge every round and must not count.
function Get-MergedCount($paths, [datetime]$since) {
  try {
    $iso = $since.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Push-Location $paths.Root
    try { $json = & $GhCommand pr list --state merged --search "merged:>=$iso" --json number,headRefName --limit 100 2>$null } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { return 0 }
    return @($json | ConvertFrom-Json | Where-Object { $_.headRefName -notmatch $HousekeepingBranch }).Count
  } catch { return 0 }
}

function Write-Status($paths, $state) {
  $state.updatedAt = (Get-Date).ToString('o')
  $state | ConvertTo-Json -Depth 5 | Set-Content -Path $paths.Status
}

# The sessions run in the primary checkout but edit sibling worktrees, which sit outside their cwd.
function Get-AddDirs($paths) {
  $dirs = @($paths.Worktrees)
  # Skills may be symlinked into a repo or copied into ~/.claude: when the toplevel is the Claude config folder
  # (or contains it) there is no skills repo to add, so only the worktrees folder is used.
  $skills = (git -C $SkillDir rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -eq 0 -and $skills) {
    $skills = ($skills.Trim() -replace '/', '\').TrimEnd('\')
    $configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
    $configDir = ($configDir -replace '/', '\').TrimEnd('\')
    $isConfig = ($configDir -eq $skills) -or $configDir.StartsWith($skills + '\', [StringComparison]::OrdinalIgnoreCase)
    if (-not $isConfig) {
      $dirs += $skills, ((Join-Path (Split-Path $skills -Parent) ((Split-Path $skills -Leaf) + '-worktrees')))
    }
  }
  return @($dirs | Where-Object { Test-Path $_ } | Select-Object -Unique)
}

function Get-ClaudeArgs($paths, [string]$prompt, [string]$sessionId) {
  $cliArgs = @('-p', $prompt)
  # --add-dir takes a list, so each one is followed by another flag.
  foreach ($dir in (Get-AddDirs $paths)) { $cliArgs += @('--add-dir', $dir) }
  $cliArgs += @('--session-id', $sessionId, '--permission-prompts', 'none')
  if ($PermissionMode) { $cliArgs += @('--permission-mode', $PermissionMode) }
  if ($Model) { $cliArgs += @('--model', $Model) }
  return $cliArgs
}

# The session's claude processes (their command line carries its id) and everything below them.
# Returns @{ Roots = ids; Tree = Win32_Process objects of the whole tree }.
function Get-SessionTree([string]$sessionId) {
  $all = @(Get-CimInstance Win32_Process)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $roots = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($p in $all) {
    if ($p.ProcessId -ne $PID -and $p.CommandLine -like "*--session-id $sessionId*") { [void]$ids.Add([int]$p.ProcessId); [void]$roots.Add([int]$p.ProcessId) }
  }
  do {
    $grew = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $grew = $true }
    }
  } while ($grew)
  return @{ Roots = $roots; Tree = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) }) }
}

function Get-ProcessTreeIds([string]$sessionId) {
  return @((Get-SessionTree $sessionId).Tree | ForEach-Object { [int]$_.ProcessId })
}

# A gh --watch, adb, build or device script below the session is work in progress even while the
# transcript and CPU stay flat; only plain timers (sleep, timeout, Start-Sleep) do not count.
function Test-LiveDescendant([string]$sessionId) {
  $session = Get-SessionTree $sessionId
  foreach ($p in $session.Tree) {
    if ($session.Roots.Contains([int]$p.ProcessId)) { continue }
    $isTimer = $p.Name -match $PlainTimerName -or "$($p.CommandLine)" -match $PlainTimerCommand
    if (-not $isTimer) { return $true }
  }
  return $false
}

function Get-TreeCpuSeconds([int[]]$ids) {
  $total = 0.0
  foreach ($id in $ids) {
    try { $total += (Get-Process -Id $id -ErrorAction Stop).TotalProcessorTime.TotalSeconds } catch { }
  }
  return $total
}

# Newest write of the session's transcript (file or folder, subagents included) or of its log.
function Get-LatestWriteTicks([string]$sessionId, [string]$log) {
  $times = @()
  if (Test-Path $log) { $times += (Get-Item $log).LastWriteTime }
  $pattern = Join-Path $HOME ".claude\projects\*\$sessionId*"
  foreach ($item in @(Get-Item $pattern -ErrorAction SilentlyContinue)) {
    $times += $item.LastWriteTime
    if ($item.PSIsContainer) {
      $times += @(Get-ChildItem $item.FullName -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.LastWriteTime })
    }
  }
  if (-not $times) { return 0 }
  return ($times | Sort-Object -Descending | Select-Object -First 1).Ticks
}

function Stop-SessionTree([string]$sessionId) {
  $ids = Get-ProcessTreeIds $sessionId
  [array]::Reverse($ids)
  foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

# Slice 393 item 5: free memory under -LowMemoryGb (the desktop VM's own minimum, 8 GB) writes the lowest reading so far, with the
# biggest processes then, into status.json lowMemory, so the night's status says what held the memory when the VM checks were skipped.
function Save-LowMemory($paths, $state, [double]$freeGb, $top) {
  if (-not $paths -or -not $state -or $freeGb -ge $LowMemoryGb) { return }
  if ($state.lowMemory -and $state.lowMemory.freeGb -le $freeGb) { return }
  $state.lowMemory = [pscustomobject]@{ at = (Get-Date).ToString('o'); freeGb = $freeGb; thresholdGb = $LowMemoryGb; top = @($top) }
  Write-DriverLog "memory: free $freeGb GB is under $LowMemoryGb GB; the snapshot of the top processes is in status.json lowMemory"
  Write-Status $paths $state
}

# Free memory and the five biggest processes, one trace line per watchdog tick, so a low-memory kill
# can be read afterwards instead of guessed (2026-11-01: four timer kills in one evening, cause never measured).
function Write-MemorySample($paths = $null, $state = $null) {
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    $totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    # Claude Code runs as claude.exe or, from an npm install, as node with the claude CLI in its command line.
    $claude = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^claude(\.exe)?$' -or ($_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match '@anthropic-ai[\\/]claude-code') })
    $claudeGb = [math]::Round([double]($claude | Measure-Object WorkingSetSize -Sum).Sum / 1GB, 1)
    $top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 |
      ForEach-Object { '{0}({1} MB)' -f $_.ProcessName, [math]::Round($_.WorkingSet64 / 1MB) }
    Write-DriverLog "memory: free $freeGb GB of $totalGb GB; claude: $($claude.Count) processes, $claudeGb GB; top: $($top -join ', ')"
    Save-LowMemory $paths $state $freeGb $top
  } catch { Write-DriverLog "memory: sample failed: $($_.Exception.Message)" }
}

# Waits for the job; returns 'idle' when the watchdog killed it for being idle, 'timeout' when it passed
# $maxMinutes (0 = no cap) and was killed, else 'ok'.
function Wait-WithWatchdog($job, [string]$sessionId, [string]$log, [double]$maxMinutes = 0, $paths = $null, $state = $null) {
  $idle = 0
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  Write-MemorySample $paths $state
  $ticks = Get-LatestWriteTicks $sessionId $log
  $cpu = Get-TreeCpuSeconds (Get-ProcessTreeIds $sessionId)
  while ($true) {
    $wait = $WatchdogSeconds
    if ($maxMinutes -gt 0) { $wait = [math]::Max(0.1, [math]::Min($WatchdogSeconds, $maxMinutes * 60 - $clock.Elapsed.TotalSeconds)) }
    if (Wait-Job $job -Timeout ([int][math]::Ceiling($wait))) { return 'ok' }
    if ($maxMinutes -gt 0 -and $clock.Elapsed.TotalMinutes -ge $maxMinutes) {
      Write-DriverLog "session passed its $maxMinutes minute cap; killing it"
      Stop-SessionTree $sessionId
      Wait-Job $job -Timeout 60 | Out-Null
      return 'timeout'
    }
    Write-MemorySample $paths $state
    if ($paths -and $state) { Update-StarterSilence $paths $state }
    $newTicks = Get-LatestWriteTicks $sessionId $log
    $newCpu = Get-TreeCpuSeconds (Get-ProcessTreeIds $sessionId)
    $active = $newTicks -gt $ticks -or $newCpu -gt $cpu -or (Test-LiveDescendant $sessionId)
    $idle = if ($active) { 0 } else { $idle + 1 }
    ($ticks, $cpu) = ($newTicks, $newCpu)
    if ($idle -ge $IdleChecksLimit) {
      Stop-SessionTree $sessionId
      Wait-Job $job -Timeout 60 | Out-Null
      return 'idle'
    }
  }
}

# One fresh headless session; its output goes to <night>\<label>.log, its id into the status file.
function Invoke-Session($paths, $state, [string]$label, [string]$prompt, [double]$maxMinutes = 0) {
  $id = [guid]::NewGuid().ToString()
  $log = Join-Path $paths.Night "$label.log"
  $entry = [pscustomobject][ordered]@{ label = $label; sessionId = $id; log = $log; startedAt = (Get-Date).ToString('o')
    exitCode = $null; killedIdle = $false; killedTimeout = $false; endedAt = $null }
  $state.sessions += $entry
  $state.current = $label
  Write-Status $paths $state
  Write-DriverLog "session start: $label id $id"
  $env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'
  if ($state.warning) { Set-Content -Path $log -Value $state.warning } else { Set-Content -Path $log -Value $null -NoNewline }
  $job = Start-ThreadJob -ArgumentList $ClaudeCommand, (Get-ClaudeArgs $paths $prompt $id), $log, $paths.Root -ScriptBlock {
    param($command, $cliArgs, $logFile, $dir)
    Set-Location $dir
    & $command @cliArgs *>> $logFile
    [pscustomobject]@{ SessionResult = $true; ExitCode = $LASTEXITCODE }
  }
  try {
    $outcome = Wait-WithWatchdog $job $id $log $maxMinutes $paths $state
    $entry.killedIdle = $outcome -eq 'idle'
    $entry.killedTimeout = $outcome -eq 'timeout'
    $result = @(Receive-Job $job -ErrorAction SilentlyContinue | Where-Object { $_.SessionResult }) | Select-Object -Last 1
    $entry.exitCode = if ($result) { $result.ExitCode } else { $null }
  } finally { Remove-Job $job -Force -ErrorAction SilentlyContinue }
  $entry.endedAt = (Get-Date).ToString('o')
  Write-Status $paths $state
  Write-DriverLog "session end: $label id $id exit $($entry.exitCode) killedIdle $($entry.killedIdle) killedTimeout $($entry.killedTimeout)"
  return $entry
}

# An instant non-zero exit (auth expired, usage limit, bad flag) means every later session would fail too.
function Get-FastFailure($entry) {
  if ($entry.killedIdle -or $entry.killedTimeout -or $entry.exitCode -eq 0) { return $null }
  if (((Get-Date) - [datetime]$entry.startedAt).TotalSeconds -gt $FastFailureSeconds) { return $null }
  $line = Get-Content $entry.log -ErrorAction SilentlyContinue |
    Where-Object { $_.Trim() -and $_ -notlike "*$PermissionWarning*" -and $_ -ne $NoModeWarning } | Select-Object -First 1
  if ($line) { return "$($entry.label) failed at once (exit $($entry.exitCode)): $line" }
  return "$($entry.label) failed at once (exit $($entry.exitCode)), log empty"
}

function Test-StopRequested($paths, $state) {
  if (-not (Test-Path $paths.Stop)) { return $false }
  $state.stopReason = "stop file $($paths.Stop)"
  Remove-Item $paths.Stop
  return $true
}

function Test-SessionFailed($entry) {
  return [bool]($entry.killedIdle -or $entry.killedTimeout -or $entry.exitCode -ne 0)
}

function Get-WaveFailureNote($entry) {
  if (-not (Test-SessionFailed $entry)) { return '' }
  $how = if ($entry.killedIdle) { 'was killed by the watchdog after sitting idle' } else { "ended with exit code $($entry.exitCode)" }
  return " The wave session ${how}: close the open ledger wave, and park its claimed-but-unmerged slices in parked.md with that reason."
}

$ReleasedPattern = '"released":\s*true'
$BatchScriptInSkills = '~/.claude/skills/run-wave/batch-release.mjs'
# The wave and housekeeping prompts say who owns releases (no double quotes: see SKILL.md, The driver).
# cmd.exe reads these characters in a .cmd shim argument as quoting, redirection or pipes, so prompts never carry them.
$CmdUnsafe = '["<>&|^%]'
# Slice 24: the wave and housekeeping sessions are orchestrators: no board card of their own, each slice reports on its own card (no cmd.exe characters).
$OrchestratorNote = ' This session is an orchestrator: first run node ~/.claude/skills/run-wave/board.mjs report-progress --orchestrator once (it sends nothing and fails open), open no board card for this session, and report each slice on its own slice card as a step tree.'
# Housekeeping builds no slice: it reports no slice card of its own (it may still close slice cards in the index pass).
$HousekeepingOrchestratorNote = ' This session is an orchestrator: first run node ~/.claude/skills/run-wave/board.mjs report-progress --orchestrator once (it sends nothing and fails open), open no board card for this session, and report no slice card of its own (you may still close slice cards in the index pass).'

# $mayWatch: the housekeeping session is also told to watch, so only release is forbidden to it. The path is single-quoted for a space in it.
function Get-DriverOwnsReleasesNote($paths, [bool]$mayWatch = $false) {
  $never = if ($mayWatch) { 'release' } else { 'release or watch' }
  $text = " The driver owns releases: run node $BatchScriptInSkills start '$($paths.Root)' at the wave start and put batch release: yes in every merge brief (docs PRs too), but never run $never."
  return $text -replace $CmdUnsafe, ' '
}

# One batch-release.mjs call; never throws, so a release problem cannot stop the run.
function Invoke-BatchRelease($paths, [string]$command, [string[]]$extra = @()) {
  $output = ''; $code = -1
  try {
    $output = (& node $BatchReleaseScript $command $paths.Root @extra 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $code = $LASTEXITCODE
  } catch { $output = $_.Exception.Message }
  Write-DriverLog "batch-release $command exit ${code}: $output"
  return [pscustomobject]@{ command = $command; exitCode = $code; output = $output; at = (Get-Date).ToString('o') }
}

function Start-BatchRelease($paths, [string[]]$extra = @()) {
  Invoke-BatchRelease $paths 'start' $extra | Out-Null
}

# After a wave and its housekeeping: release when the last release (or the start) is $BatchReleaseHours old.
# The next housekeeping session watches it.
function Invoke-DueRelease($paths, $state, [int]$wave = 0) {
  $due = Invoke-BatchRelease $paths 'due' @('--hours', "$BatchReleaseHours")
  if ($due.exitCode -ne 0) { return }
  $release = Invoke-BatchRelease $paths 'release'
  $state.batchReleases += $release
  $wentLive = $release.output -match $ReleasedPattern
  if ($wentLive) { $state.unwatchedRelease = $true; $state.carriedRelease = $false }
  Start-BatchRelease $paths
  Write-Status $paths $state
  # Slice 31: a release that went live is checked at once (its release call said released: true; the watch comes later).
  if ($wentLive) { Invoke-LiveChecks $paths $state "after-wave-$wave" }
}

# The night's UTC date: a line marked with it is left out of --todo and --count (Slice 31, live-checks.mjs --today).
function Get-LiveChecksToday { return (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }

# The tags a live-checks session runs; chat and owner lines are the owner's (Slice 31, Decision 5).
$LiveCheckTags = 'chrome,session,phone,cloud'

# Open lines the live-checks session would run, read from origin/main after a fetch (not the primary checkout, which can be behind);
# -1 when the counter failed (no session is started then, and the status says so).
function Get-LiveChecksCount($paths) {
  try {
    & git -C $paths.Root fetch origin 2>&1 | Out-Null
    $out = (& node $LiveChecksScript $paths.Root --count $LiveCheckTags --origin --today (Get-LiveChecksToday) 2>&1 | ForEach-Object { "$_" }) -join ' '
    if ($LASTEXITCODE -eq 0 -and $out.Trim() -match '^\d+$') { return [int]$out.Trim() }
  } catch { Write-DriverLog "live-checks count failed: $($_.Exception.Message)" }
  return -1
}

# ok, missing (no .claude/live-checks.local.json: no Chrome checks) or not-ignored (the file would publish private domains);
# the step 9 report names both bad states (Slice 31, Decision 3).
function Get-ChromeConfigState($paths) {
  $rel = '.claude/live-checks.local.json'
  if (-not (Test-Path (Join-Path $paths.Root $rel))) { return 'missing' }
  & git -C $paths.Root check-ignore -q $rel 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { return 'not-ignored' }
  return 'ok'
}

# No double quotes or cmd.exe characters (see $CmdUnsafe); the lines themselves are read by the session through live-checks.mjs.
function Get-LiveChecksPrompt($paths, [string]$reason, [int]$count) {
  $night = Split-Path $paths.Night -Leaf
  $today = Get-LiveChecksToday
  $chromeFile = Join-Path (Join-Path $paths.Root '.claude') 'live-checks.local.json'
  $notLive = if ($reason -eq 'final') { "a line whose release is still not success now is marked (live check $today`: release not live)" } else { 'write no marker for it (a later session of tonight retries it)' }
  $text = "Live checks ($reason), unattended, in $($paths.Root); night folder $($paths.Night). Phase: not implementation. Tonight is $today (UTC). " +
    "First read the release: the dispatched runs are listed in $(Join-Path $paths.Worktrees 'batch-release.json'); read each run's conclusion with gh run list. A line whose release is not success yet is not reached: skip it this session and never test the old build; $notLive. " +
    "List your work with: node '$LiveChecksScript' '$($paths.Root)' --todo $LiveCheckTags --origin --today $today ($count open lines). A listed line that says failed before and names a slice is updated in that slice (add the new result to its follow-ups), never filed as a new slice. " +
    'Run every listed line yourself, in a worktree on a branch chore/docs-index-live-checks-' + $night + '-' + $reason + ': [chrome] in Chrome on the live site, only on a domain named in the repo file ' + $chromeFile + ' (read it by that absolute path; the file is not in your worktree; a missing file means no Chrome checks: say so in one line, never guess a domain); [session] in a real Claude Code session with its hooks, plugin and MCP tools; [phone] through the device-test agent with the device lease, on the test phone first, then the emulator, and a web page is opened in the phone browser (never ask the owner for the phone); [cloud] in a Claude Code cloud session. ' +
    'A pass: remove its line from docs/plan/unverified.md and update the count line by running node ~/.claude/skills/run-wave/count-unverified.mjs on your own worktree folder with --write (never on ' + $paths.Root + '). ' +
    "A line that did not pass keeps one marker at its end, (live check $today`: RESULT), RESULT being one of: unreachable: WHY, release not live, failed, Slice N (or failed, follow-up in Slice N); a new marker replaces the old one on that line. A failure also needs a planned slice (or an item in the slice follow-ups); the marker names it. A marker dated tonight leaves the line out of tonight's lists, an older one is ignored so the line is tried again. " +
    'One docs PR for all of it, merged when green. Never fix a bug during the run. Never run release or watch. ' +
    "You have $LiveChecksMaxMinutes minutes; at $([math]::Max(0, $LiveChecksMaxMinutes - 5)) minutes stop, ship what is done and record in the PR where you got to."
  return $text -replace $CmdUnsafe, ' '
}

# One live-checks session. Never throws and never stops the run: a failed or killed session is logged and listed in the status.
function Invoke-LiveChecks($paths, $state, [string]$reason) {
  try {
    $count = Get-LiveChecksCount $paths
    if ($count -lt 0) { Write-DriverLog "live checks ($reason): count failed, no session"; $state.liveChecks = @($state.liveChecks) + [pscustomobject]@{ reason = $reason; openLines = -1; skipped = 'count failed: no session' }; return }
    if ($count -eq 0) { Write-DriverLog "live checks ($reason): no open chrome, session, phone or cloud lines; skipped"; return }
    $chromeConfig = Get-ChromeConfigState $paths
    if ($chromeConfig -ne 'ok') { Write-DriverLog "live checks ($reason): .claude/live-checks.local.json $chromeConfig; no Chrome checks" }
    $entry = Invoke-Session $paths $state "live-checks-$reason" (Get-LiveChecksPrompt $paths $reason $count) $LiveChecksMaxMinutes
    $state.liveChecks = @($state.liveChecks) + [pscustomobject]@{ reason = $reason; openLines = $count; chromeConfig = $chromeConfig; exitCode = $entry.exitCode; killedIdle = $entry.killedIdle; killedTimeout = $entry.killedTimeout }
    Write-DriverLog "live checks ($reason): $count open lines, exit $($entry.exitCode), timeout $($entry.killedTimeout)"
    # A fast failure is only logged here and kept in the liveChecks entry: a failed live-checks session never stops the night (Decision 2).
    $failure = Get-FastFailure $entry
    if ($failure) { Write-DriverLog "live checks ($reason): fast failure, night continues: $failure"; $state.liveChecks[-1] | Add-Member -NotePropertyName fastFailure -NotePropertyValue "$failure" -Force }
    if (Test-Path $paths.Night) { Write-Status $paths $state }
  } catch { Write-DriverLog "live checks ($reason) error: $($_.Exception.Message)" }
}

# Once, on the way out (normal end, stop file, crash): release what the run merged and watch every run to its conclusion.
# --clear-failed: the failure is reported to the feedback loop (prompt below) and does not come back on the next run's watch.
function Invoke-FinalRelease($paths, $state, [bool]$watchRuns = $true) {
  if ($state.finalRelease) { return }
  $release = Invoke-BatchRelease $paths 'release'
  if (-not $watchRuns) {
    # Stop file, crash or abort: the lock must not be held for hours. The runs stay in the state file; the next run's first housekeeping watches them.
    $state.unwatchedRelease = $true
    $state.finalRelease = [pscustomobject]@{ release = $release; watch = [pscustomobject]@{ command = 'watch'; exitCode = $null; output = 'not watched: the run was stopped; the next run first housekeeping watches it'; at = (Get-Date).ToString('o') }; watched = $false }
    if (Test-Path $paths.Night) { Write-Status $paths $state }
    return
  }
  # Always watch: the state file lists every dispatched run nobody watched yet (an earlier housekeeping may have died); no runs is a no-op.
  $state.current = 'watching-final-release'
  if (Test-Path $paths.Night) { Write-Status $paths $state }
  $watch = Invoke-BatchRelease $paths 'watch' @('--max-minutes', "$BatchWatchMaxMinutes", '--clear-failed')
  $state.unwatchedRelease = $false
  $state.finalRelease = [pscustomobject]@{ release = $release; watch = $watch; watched = $true }
  if (Test-Path $paths.Night) { Write-Status $paths $state }
}

# Runs an earlier run dispatched but never watched (stop file, crash, post-loop release) wait in the state file: this run's first housekeeping watches them.
function Set-CarriedUnwatchedRuns($paths, $state) {
  try {
    $file = Join-Path $paths.Worktrees 'batch-release.json'
    if (-not (Test-Path $file)) { return }
    $saved = Get-Content -Raw $file | ConvertFrom-Json
    if (@($saved.runs).Count -gt 0) { $state.unwatchedRelease = $true; $state.carriedRelease = $true }
  } catch { Write-DriverLog "carried runs check failed: $($_.Exception.Message)" }
}

function Get-ReleaseWatchNote($paths, $state) {
  if (-not $state.unwatchedRelease) { return '' }
  $state.unwatchedRelease = $false
  # Runs an earlier run left in the state file were not dispatched by this run's previous wave (Slice 09, finding 6).
  $origin = if ($state.carriedRelease) { 'carried from an earlier run' } else { 'dispatched after the previous wave' }
  $state.carriedRelease = $false
  $text = " A batched release was $origin`: watch it with node $BatchScriptInSkills watch '$($paths.Root)' --max-minutes $BatchWatchMaxMinutes, report each conclusion, and turn a failure into a fix item under Outstanding work in the index PR."
  return $text -replace $CmdUnsafe, ' '
}

# The feedback loop runs after the final release, so its own merges carry the skip marker too: one more release, no watch
# (the runs stay in the state file for the next run's watch). It says "nothing merged" itself when the loop merged nothing.
function Invoke-LoopRelease($paths, $state) {
  if (-not $state.finalRelease -or $state.loopRelease) { return }
  $state.loopRelease = Invoke-BatchRelease $paths 'release'
  if (Test-Path $paths.Night) { Write-Status $paths $state }
}

# Release output is bounded so the whole prompt stays under the ~8191-character .cmd shim limit (the full text is in the driver log).
$ReleaseOutputMaxChars = 700
function Get-BoundedOutput([string]$text) {
  if ($text.Length -le $ReleaseOutputMaxChars) { return $text }
  return $text.Substring(0, $ReleaseOutputMaxChars) + ' ...(cut, see the driver log)'
}

function Get-ReleaseLoopNote($state) {
  $final = $state.finalRelease
  if (-not $final) { return '' }
  $watched = if ($final.watched -eq $false) { "watch skipped: $(Get-BoundedOutput $final.watch.output)" } else { "watch exit $($final.watch.exitCode): $(Get-BoundedOutput $final.watch.output)" }
  $text = "Every merge you make carries batch release: yes in its ship-branch brief; the driver releases once more after you end, so never run release or watch yourself. Batched release at the end of the run: release exit $($final.release.exitCode): $(Get-BoundedOutput $final.release.output); $watched. Audit a failed or broken conclusion as a finding. "
  return (($text -replace '\r?\n', ' / ') -replace $CmdUnsafe, ' ')
}

# Slice 08. The wave ledger lines of waves after the one that was highest when the run started, read for cloud use.
function Get-LedgerLines($paths) {
  $ledger = Join-Path $paths.Worktrees 'wave-ledger.md'
  if (-not (Test-Path $ledger)) { return @() }
  return @(Get-Content $ledger -ErrorAction Stop)
}

function Get-LedgerWaveAtStart($paths) {
  try {
    $numbers = @(Get-LedgerLines $paths | ForEach-Object { if ($_ -match '^##\s+Wave\s+(\d+)') { [int]$Matches[1] } })
    if ($numbers.Count -eq 0) { return 0 }
    return ($numbers | Measure-Object -Maximum).Maximum
  } catch { return 0 }
}

# The tokens run-wave writes on a slice line that used a cloud session (run-wave SKILL.md section 3): a bare "cloud: " in
# a reason text does not count.
$CloudLineMarker = 'stage: cloud running|\bcloud: (pushed|failed)\b'

# The slice numbers of cloud slices in waves after state.ledgerWaveAtStart, added to state.cloudSlices and never removed:
# the wave session rewrites a line at every milestone and drops the marker, so a recount alone would lose the spend.
# Unreadable ledger: list unchanged.
function Update-CloudSlicesUsed($paths, $state) {
  try {
    $wave = 0; $seen = @($state.cloudSlices | Where-Object { $_ } | ForEach-Object { "$_".TrimStart('0') } | Select-Object -Unique)
    foreach ($line in (Get-LedgerLines $paths)) {
      if ($line -match '^##\s+Wave\s+(\d+)') { $wave = [int]$Matches[1]; continue }
      if ($wave -le $state.ledgerWaveAtStart -or $line -notmatch $CloudLineMarker -or $line -notmatch 'Slice\s+0*(\d+)') { continue }
      $number = $Matches[1].TrimStart('0')
      if ($number -notin $seen) { $seen += $number }
    }
    $state.cloudSlices = @($seen)
    $state.cloudSlicesUsed = @($seen).Count
  } catch { Write-DriverLog "cloud count: ledger unreadable, count stays $($state.cloudSlicesUsed): $($_.Exception.Message)" }
}

# A restarted driver (the earlier one died before its final loop finished) carries that night's cloud slices, so the
# nightly cap is not spent twice. Only a night whose driver died counts: its status.json current is not done, failed or
# stopped and it has no stopReason (a night that ended with an incomplete final loop already finished its waves).
function Get-CarriedCloudNight($paths) {
  $current = Split-Path $paths.Night -Leaf
  $nights = @(Get-ChildItem $paths.RunDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $NightFolderPattern -and $_.Name -lt $current -and (Test-NightRecent $_.Name) } |
    Sort-Object Name -Descending | ForEach-Object { Read-NightStatus $_.FullName } |
    Where-Object { $_ -and (@('done', 'failed', 'stopped') -notcontains "$($_.current)") -and -not $_.stopReason })
  if ($nights.Count -gt 0) { return $nights[0] }
  return $null
}

# The slice file as it is on origin/main, written into the night folder; $null when there is none.
function Export-SliceFile($paths, [string]$slice) {
  $key = $slice.Trim().TrimStart('0')
  if (-not $key) { return $null }
  $files = @(git -C $paths.Root ls-tree --name-only origin/main docs/plan/slices/ 2>$null)
  $match = $files | Where-Object { (Split-Path $_ -Leaf) -match '^0*([^-]+)-' -and $Matches[1] -ieq $key } | Select-Object -First 1
  if (-not $match) { return $null }
  $target = Join-Path $paths.Night "placement-$key.md"
  $text = $null
  try { $text = Read-GitShowUtf8 $paths.Root "origin/main:$match" } catch { Write-DriverLog "placement: slice $slice left local, git show failed: $($_.Exception.Message)"; return $null }
  if ($null -eq $text) { Write-DriverLog "placement: slice $slice left local, git show of $match failed"; return $null }
  [System.IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($false)))
  return $target
}

# git show output decoded as UTF-8 (not the console code page); $null when git fails. The copy is written without a BOM.
function Read-GitShowUtf8([string]$root, [string]$spec) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = 'git'
  $info.Arguments = "-C `"$root`" show `"$spec`""
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $process = [System.Diagnostics.Process]::Start($info)
  $text = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { return $null }
  return $text
}

# 'cloud' or 'local' for one slice; any failure of the script or the lookup is local, never a stop.
function Get-SlicePlacement($paths, [string]$slice) {
  try {
    $file = Export-SliceFile $paths $slice
    if (-not $file) { return 'local' }
    $output = node $PlacementScript $file 2>&1
    if ($LASTEXITCODE -eq 0 -and "$output" -match '^\s*(cloud|local)\b') { return $Matches[1] }
  } catch { Write-DriverLog "placement of slice ${slice} failed: $($_.Exception.Message)" }
  return 'local'
}

# One line for the wave prompt, e.g. `Placement: 07 local, 08 cloud. Cloud slices left tonight: 3 of 4.` Cloud slices past the
# placement is as placement.mjs gives it; the wave session sends at most the slices left to the cloud (it picks which of the
# wave's slices) and builds the rest locally. It uses this line instead of running placement.mjs itself.
function Get-PlacementNote($paths, $state, $before) {
  if ($MaxCloudSlices -le 0) { return ' Placement: every slice local (cloud placement is off tonight).' }
  $left = [math]::Max(0, $MaxCloudSlices - [int]$state.cloudSlicesUsed)
  if ($left -le 0) { return " Placement: every slice local (the nightly cloud cap of $MaxCloudSlices is used up)." }
  $items = @()
  foreach ($slice in @($before.planned)) {
    $placement = Get-SlicePlacement $paths "$slice"
    $items += "$slice $placement"
    Write-DriverLog "placement: slice $slice $placement"
  }
  $text = " Placement: $($items -join ', '). Cloud slices left tonight: $left of $MaxCloudSlices; send at most $left cloud slices to the cloud and build the rest locally."
  return $text -replace $CmdUnsafe, ' '
}

function Invoke-WaveAndHousekeeping($paths, $state, [int]$wave, $before) {
  $context = "Repo $($paths.Root). Night folder $($paths.Night). Planned on origin/main: $($before.planned -join ', '). A brief that names a slice it does not work on (an earlier or finished slice) carries the line ``plan-not-needed: 900`` in its first draft (digits only, written with the real number of the slice it names, never copied from this example; for several slices one line with commas: ``plan-not-needed: 900, 901``), or brief-plan-guard denies it."
  $placementNote = Get-PlacementNote $paths $state $before
  $waveEntry = Invoke-Session $paths $state "wave-$wave" "/run-all-waves wave $wave. $context$placementNote$(Get-DriverOwnsReleasesNote $paths)$OrchestratorNote"
  $failure = Get-FastFailure $waveEntry
  if ($failure) { $state.stopReason = $failure; $state.fastFailure = $true; return }
  # Housekeeping runs even after a stop request: it makes the wave's result visible in plan.md.
  $note = Get-WaveFailureNote $waveEntry
  $housekeepingPrompt = "/run-all-waves housekeeping $wave. $context$note$($watchNote = Get-ReleaseWatchNote $paths $state)$(Get-DriverOwnsReleasesNote $paths ([bool]$watchNote))$watchNote$HousekeepingOrchestratorNote"
  $housekeeping = Invoke-Session $paths $state "housekeeping-$wave" $housekeepingPrompt
  $failure = Get-FastFailure $housekeeping
  if ($failure) { $state.stopReason = $failure; $state.fastFailure = $true; return }
  if (-not (Test-SessionFailed $housekeeping)) { return }
  # A stale plan.md makes the next wave retry failed slices: try housekeeping once more at once.
  $retry = Invoke-Session $paths $state "housekeeping-$wave-retry" $housekeepingPrompt
  $failure = Get-FastFailure $retry
  if ($failure) { $state.stopReason = $failure; $state.fastFailure = $true; return }
  if (Test-SessionFailed $retry) { $state.stopReason = "housekeeping-$wave failed twice (killed or non-zero exit); plan.md may be stale" }
}

function Invoke-Waves($paths, $state) {
  $wave = 0; $stalled = 0
  while ($true) {
    if (Test-StopRequested $paths $state) { return }
    Write-DriverLog "phase: round $($wave + 1) preflight"
    $lowDisk = Get-LowDiskReason $paths $state
    if ($lowDisk) { $state.stopReason = $lowDisk; return }
    $roundStart = Get-Date
    $before = Get-Remaining $paths
    $state.remaining = $before.planned
    if (-not $before.planned) { $state.stopReason = 'no planned slices left'; return }
    $wave++
    Invoke-WaveAndHousekeeping $paths $state $wave $before
    Update-CloudSlicesUsed $paths $state
    Write-DriverLog "cloud slices used tonight: $($state.cloudSlicesUsed) of $MaxCloudSlices"
    # After every wave too, not only on the way out: one run's emulator installs left 16 GB of
    # tmp*.apk in 8 hours (2026-11-07-1412), and a long night can fill the disk before the driver ends.
    if ($state.stopReason) { return }
    Invoke-TempBuildCleanup $state
    $state.tempCleanupWaves = @($state.tempCleanupWaves) + @($state.tempCleanup)
    Invoke-WaveStaleCleanup $paths $state
    Invoke-DueRelease $paths $state $wave
    $after = Get-Remaining $paths
    $moved = ($after.planned -join ',') -ne ($before.planned -join ',') -or (Get-MergedCount $paths $roundStart) -gt 0
    $stalled = if ($moved) { 0 } else { $stalled + 1 }
    if ($stalled -ge $NoProgressLimit) {
      $state.stopReason = "no progress in $stalled rounds; still planned: $($after.planned -join ', ')"
      return
    }
  }
}

# The starter session id an earlier night of a dead driver recorded (its final loop did not finish); $null when none.
function Get-CarriedStarter($paths) {
  $current = Split-Path $paths.Night -Leaf
  $nights = @(Get-ChildItem $paths.RunDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $NightFolderPattern -and $_.Name -lt $current -and (Test-NightRecent $_.Name) } |
    Sort-Object Name -Descending | ForEach-Object { Read-NightStatus $_.FullName } |
    Where-Object { $_ -and $_.starterSessionId -and -not (Test-FinalLoopComplete $_) })
  if ($nights.Count -gt 0) { return $nights[0].starterSessionId }
  return $null
}

# The transcript of state.starterSessionId only; $null when none is recorded or its file is missing (no fallback).
function Get-RecordedStarterTranscript($paths, $state) {
  if (-not $state.starterSessionId) { return $null }
  $folder = Join-Path $ProjectsDir ([regex]::Replace($paths.Root, '[^a-zA-Z0-9]', '-'))
  $recorded = Join-Path $folder "$($state.starterSessionId).jsonl"
  if (Test-Path $recorded) { return (Get-Item $recorded) }
  return $null
}

# The interactive session that launched the run: the transcript recorded in state.starterSessionId. Without a
# recorded one (or its file), the newest transcript of the repo's project folder that is not one of this run's
# own sessions. $null when there is none. $script:StarterSource says which was used.
function Get-StarterTranscript($paths, $state) {
  $folder = Join-Path $ProjectsDir ([regex]::Replace($paths.Root, '[^a-zA-Z0-9]', '-'))
  if (-not (Test-Path $folder)) { return $null }
  $recorded = Get-RecordedStarterTranscript $paths $state
  if ($recorded) { $script:StarterSource = 'recorded'; return $recorded }
  $script:StarterSource = 'newest transcript (no recorded starter)'
  $own =@($state.sessions | ForEach-Object { $_.sessionId }) + @($state.carriedUnaudited | Where-Object { $_ } | ForEach-Object { $_.sessionId })
  return Get-ChildItem $folder -Filter *.jsonl -File -ErrorAction SilentlyContinue |
    Where-Object { $own -notcontains $_.BaseName } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# Records state.starterSilentSince (the time of the starter's last assistant entry) while the recorded starter session has had
# no assistant entry for -StarterSilentMinutes, and clears it when it speaks again. Read-only: never kills or restarts.
function Update-StarterSilence($paths, $state) {
  try {
    $starter = Get-RecordedStarterTranscript $paths $state
    if (-not $starter) { return }
    $verdict = & node $StarterSilentScript $starter.FullName $StarterSilentMinutes | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $null -eq $verdict) { Write-DriverLog "starter-silent gave no verdict for $($starter.BaseName); keeping the previous value"; return }
    $since = if ($verdict.silent) { $verdict.lastAssistantAt } else { $null }
    if ($since -eq $state.starterSilentSince) { return }
    $state.starterSilentSince = $since
    Write-DriverLog $(if ($since) { "starter session $($starter.BaseName) silent since $since (no assistant entry for over $StarterSilentMinutes minutes)" } else { "starter session $($starter.BaseName) spoke again" })
    Write-Status $paths $state
  } catch { Write-DriverLog "starter-silent failed: $($_.Exception.Message)" }
}

# {busy, pending[]} for a transcript, from main-busy.mjs; not busy when it cannot be read.
function Get-MainBusy([string]$transcript) {
  try { return (& node $MainBusyScript $transcript | ConvertFrom-Json) } catch { Write-DriverLog "main-busy failed: $($_.Exception.Message)" }
  return [pscustomobject]@{ busy = $false; pending = @() }
}

# Waits while the main session has subagents in flight. Returns $true to go on, $false when the ceiling passed
# (status.json skippedFeedbackLoop says why). No starter session found: no wait.
function Stop-Waiting($paths, $state, [string]$current = 'feedback-loop') {
  if ($state.waitingForMain) {
    $state.waitingForMain = $null
    $state.current = $current
    Write-Status $paths $state
  }
  return $true
}

function Wait-ForMainSession($paths, $state) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $since = (Get-Date).ToString('o')
  $logged = $false
  while ($true) {
    $starter = Get-StarterTranscript $paths $state
    if ($starter -and -not $logged) { Write-DriverLog "feedback loop: starter transcript $($starter.BaseName) ($script:StarterSource)"; $logged = $true }
    if (-not $starter) { Write-DriverLog 'feedback loop: no starter session found; not waiting'; return (Stop-Waiting $paths $state) }
    if ($starter.LastWriteTime -lt (Get-Date).AddMinutes(-$StarterFreshMinutes)) {
      Write-DriverLog "feedback loop: newest transcript $($starter.BaseName) not written for $StarterFreshMinutes minutes; not waiting"
      return (Stop-Waiting $paths $state)
    }
    $busy = Get-MainBusy $starter.FullName
    if (-not $busy.busy) { Write-DriverLog "feedback loop: main session $($starter.BaseName) has no subagents in flight"; return (Stop-Waiting $paths $state) }
    $pending = @($busy.pending) -join ' | '
    if ($clock.Elapsed.TotalMinutes -ge $StarterWaitMaxMinutes) {
      $state.skippedFeedbackLoop = "main session $($starter.BaseName) still had subagents running after $StarterWaitMaxMinutes minutes: $pending"
      Write-DriverLog "feedback loop skipped: $($state.skippedFeedbackLoop)"
      Stop-Waiting $paths $state 'skipped-feedback-loop' | Out-Null
      return $false
    }
    Write-DriverLog "feedback loop waiting: main session $($starter.BaseName) has $(@($busy.pending).Count) subagent(s) in flight: $pending"
    $state.current = 'waiting-for-main-session'
    $state.waitingForMain = [pscustomobject]@{ since = $since; pending = @($busy.pending) }
    Write-Status $paths $state
    Start-Sleep -Seconds $StarterCheckSeconds
    if (Test-StopRequested $paths $state) { Write-DriverLog 'feedback loop: stop file during the wait'; Stop-Waiting $paths $state 'stopped' | Out-Null; return $false }
  }
}

# Deletes old leftover app builds from the temp folder. Never stops the run; the result goes into status.json.
function Test-TempBuildsDirIsRoot {
  $full = [IO.Path]::GetFullPath($TempBuildsDir)
  return $full -eq [IO.Path]::GetPathRoot($full)
}

# Never ends in a separator: a trailing backslash before the closing quote would swallow it. Roots are refused before this.
function Get-TempBuildsArgument {
  return [IO.Path]::GetFullPath($TempBuildsDir).TrimEnd('\', '/')
}

# Runs the node cleanup for at most -TempCleanupTimeoutSeconds; returns exit code and stdout, or timedOut.
function Invoke-TempCleanupProcess {
  return Invoke-NodeCleanupProcess @("`"$CleanTempBuildsScript`"", "`"$(Get-TempBuildsArgument)`"", '--min-age-minutes', "$TempBuildMinAgeMinutes") $TempCleanupTimeoutSeconds
}

# Kills a process and its children (taskkill /T /F): node's pwsh holder-check child must not outlive a timeout.
function Stop-ProcessTree([int]$processId) {
  try {
    Start-Process taskkill -ArgumentList '/T', '/F', '/PID', "$processId" -Wait -WindowStyle Hidden -ErrorAction Stop
  } catch {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

# Runs node with the given arguments for at most $timeoutSeconds; returns exit code and stdout, or timedOut.
function Invoke-NodeCleanupProcess($nodeArgs, [int]$timeoutSeconds) {
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $proc = Start-Process node -ArgumentList $nodeArgs -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (-not $proc.WaitForExit($timeoutSeconds * 1000)) {
      Stop-ProcessTree $proc.Id
      return [pscustomobject]@{ timedOut = $true; exitCode = $null; text = '' }
    }
    $proc.WaitForExit()  # the timed overload can leave ExitCode unset and output unflushed
    $text = ("$(Get-Content $outFile -Raw)" + "$(Get-Content $errFile -Raw)").Trim()
    return [pscustomobject]@{ timedOut = $false; exitCode = $proc.ExitCode; text = $text }
  } finally {
    Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue
  }
}

# The node JSON as an object (with the exit code added); text that does not parse stays raw.
function ConvertTo-TempCleanupState($run) {
  if ($run.timedOut) { return 'timeout' }
  try {
    $parsed = $run.text | ConvertFrom-Json -ErrorAction Stop
    $parsed | Add-Member -NotePropertyName exitCode -NotePropertyValue $run.exitCode -Force
    return $parsed
  } catch {
    return "exit $($run.exitCode): $($run.text)"
  }
}

function Invoke-TempBuildCleanup($state) {
  if (Test-TempBuildsDirIsRoot) {
    $state.tempCleanup = [pscustomobject]@{ dir = $TempBuildsDir; error = 'refusing to clean a drive or filesystem root'; exitCode = $null }
    Write-DriverLog "temp build cleanup refused: $TempBuildsDir is a drive root"
    return
  }
  try {
    $run = Invoke-TempCleanupProcess
    $state.tempCleanup = ConvertTo-TempCleanupState $run
    Write-DriverLog "temp build cleanup exit $($run.exitCode) timedOut $($run.timedOut): $($run.text)"
  } catch {
    $state.tempCleanup = "error: $($_.Exception.Message)"
    Write-DriverLog "temp build cleanup error: $($_.Exception.Message)"
  }
}

# After a wave: deletes the `_builds` entries of the wave's worktrees (clean-stale.mjs --wave --ledger: the slice numbers
# of the highest wave in wave-ledger.md decide which worktrees belong to the wave; held builds stay). Never stops the run.
function Invoke-WaveStaleCleanup($paths, $state) {
  try {
    $run = Invoke-NodeCleanupProcess @("`"$StaleCleanupScript`"", '--wave', "`"$($paths.Worktrees)`"", '--ledger') $StaleCleanupTimeoutSeconds
    $state.waveCleanups = @($state.waveCleanups) + @(ConvertTo-TempCleanupState $run)
    Write-DriverLog "wave stale cleanup exit $($run.exitCode) timedOut $($run.timedOut): $($run.text)"
  } catch {
    $state.waveCleanups = @($state.waveCleanups) + @("error: $($_.Exception.Message)")
    Write-DriverLog "wave stale cleanup error: $($_.Exception.Message)"
  }
}

# On the way out: deletes cached builds, git worktrees, worktree-folder leftovers and temp entries older than
# -StaleCleanupHours (clean-stale.mjs --stale). Never stops the run; the result goes into status.json.
function Invoke-StaleCleanup($paths, $state) {
  if (Test-TempBuildsDirIsRoot) { $state.staleCleanup = 'refused: temp dir is a drive root'; return }
  try {
    $run = Invoke-NodeCleanupProcess @("`"$StaleCleanupScript`"", '--stale', "`"$($paths.Worktrees)`"", '--temp', "`"$(Get-TempBuildsArgument)`"", '--hours', "$StaleCleanupHours") $StaleCleanupTimeoutSeconds
    $state.staleCleanup = ConvertTo-TempCleanupState $run
    Write-DriverLog "stale cleanup exit $($run.exitCode) timedOut $($run.timedOut): $($run.text)"
  } catch {
    $state.staleCleanup = "error: $($_.Exception.Message)"
    Write-DriverLog "stale cleanup error: $($_.Exception.Message)"
  }
}

# Reads the free space of the temp and worktree drives: exit code 0 = enough, else low or unreadable.
function Read-DiskFree($paths) {
  # Windows PowerShell 5.1 turns a native stderr line into a terminating error under 'Stop'.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # "<folder>=<need GB>": disk-free.mjs prints freeGb and needGb for each folder, so the need sits next to the free space in the log and in status.json.
  try { $text = (node $DiskFreeScript "$(Get-TempBuildsArgument)=$MinFreeGbTemp" "$($paths.Worktrees)=$MinFreeGbWorktrees" 2>&1 | Out-String).Trim(); $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $previous }
  return [pscustomobject]@{ code = $code; text = $text }
}

# "C:\x 0.4 GB free, needs 5 GB; ..." for the folders under their need (an unreadable one included), so the reader of the stop reason sees the short drive.
function Get-LowDriveSummary([string]$json) {
  try {
    $low = @(($json | ConvertFrom-Json).folders | Where-Object { $null -eq $_.freeGb -or $_.freeGb -lt $_.needGb } |
      ForEach-Object { "$($_.path): $(if ($null -eq $_.freeGb) { 'unreadable' } else { "$($_.freeGb) GB free" }), needs $($_.needGb) GB" })
    if ($low) { return $low -join '; ' }
  } catch { Write-DriverLog "disk-free output was not JSON: $($_.Exception.Message)" }
  return "a drive is under its need ($MinFreeGbTemp GB temp, $MinFreeGbWorktrees GB worktrees)"
}

# Only a printed estimate: when the worktree drive has under -EstimateGbWorktrees free, log and record freeGb next to needGb; the night goes on.
function Write-DiskEstimateWarning([string]$json, $state) {
  $state.diskEstimate = $null
  try {
    $entry = @(($json | ConvertFrom-Json).folders)[-1]
    if ($null -ne $entry.freeGb -and $entry.freeGb -lt $EstimateGbWorktrees) {
      $state.diskEstimate = "worktree drive $($entry.path): freeGb $($entry.freeGb), needGb $EstimateGbWorktrees (estimate for a wave of four app builds, not a stop)"
      Write-DriverLog "disk estimate warning: $($state.diskEstimate)"
    }
  } catch { Write-DriverLog "disk estimate check skipped: $($_.Exception.Message)" }
}

# Returns a stop reason when a drive has under its need (-MinFreeGbTemp / -MinFreeGbWorktrees) free even after the temp build cleanup (or the reader fails:
# an unreadable disk is not a safe place to claim slices), else $null. The cleanup runs only when the first read is low.
function Get-LowDiskReason($paths, $state) {
  try {
    $read = Read-DiskFree $paths
    if ($read.code -ne 0) { Invoke-TempBuildCleanup $state; $read = Read-DiskFree $paths }
    $state.diskFree = $read.text
    Write-DriverLog "disk free check exit $($read.code): $($read.text)"
    if ($read.code -eq 0) { Write-DiskEstimateWarning $read.text $state; return $null }
    if ($read.code -ne 1) { return "disk space check failed: disk-free exit $($read.code) (the reader did not run properly, not a low drive): $($read.text)" }
    return "disk space low: $(Get-LowDriveSummary $read.text) (disk-free exit $($read.code)): $($read.text)"
  } catch { return "disk space check failed: $($_.Exception.Message)" }
}

# How the newest earlier night ended, in one sentence, so a vanished driver is explained by the next one
# (2026-11-07: a driver died 5 s into its final-release watch and no log said why). A status that is not
# done/failed/stopped with its pid gone means the process was killed before its finally block ran.
function Get-PreviousEndReason($paths) {
  $current = Split-Path $paths.Night -Leaf
  $previous = @(Get-ChildItem $paths.RunDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $NightFolderPattern -and $_.Name -lt $current -and (Test-Path (Join-Path $_.FullName 'status.json')) } |
    Sort-Object Name -Descending | Select-Object -First 1)
  if (-not $previous) { return $null }
  $status = Read-NightStatus $previous[0].FullName
  if (-not $status) { return "previous night $($previous[0].Name): status.json unreadable" }
  # A pwsh that started after status.json was last written cannot be that driver: its pid was reused (it wrote the file while running).
  $lastWrite = (Get-Item (Join-Path $previous[0].FullName 'status.json')).LastWriteTime
  $alive = [bool](Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match 'pwsh|powershell' -and $_.StartTime -le $lastWrite })
  # 'died' is only read here: drivers before Slice 317 wrote it, and their status.json files remain.
  $ended = @('done', 'failed', 'stopped', 'died') -contains "$($status.current)"
  if (-not $ended -and $alive) { return "previous night $($previous[0].Name): driver pid $($status.pid) still running (current $($status.current))" }
  if (-not $ended) { return "previous night $($previous[0].Name): driver pid $($status.pid) is gone and wrote no end status; it was killed (not by an error) while current was $($status.current); stopReason $($status.stopReason)" }
  return "previous night $($previous[0].Name) ended: current $($status.current); stopReason $($status.stopReason)"
}

function Invoke-FeedbackLoop($paths, $state) {
  if (-not (Wait-ForMainSession $paths $state)) { return }
  $night = Split-Path $paths.Night -Leaf
  $budget = "You have $FeedbackLoopMaxMinutes minutes in total; at $([math]::Max(0, $FeedbackLoopMaxMinutes - 5)) minutes stop starting new passes and ship the note with what is left listed as open findings. "
  $ids = ($state.sessions | ForEach-Object { $_.sessionId }) -join ', '
  $sessions = if ($ids) { "Read these sessions, by id: every wave, housekeeping and plan-cleanup session of this run: $ids. " } else { 'This run started no wave or housekeeping session. ' }
  $prompt = "/feedback-loop Unattended, once at the end of all waves of a run-all-waves run in $($paths.Root). " +
    'Phase: not implementation. Tooling fixes are still done. A product finding becomes a slice with status `planned`, never parked for a review the owner did not ask for, so the next run builds it. ' +
    $sessions + $StarterSessionClause + (Get-CarriedNote $state) + $budget + "Night folder $($paths.Night). " +
    'A wave or housekeeping session in the list may have died mid-work: check its work. ' +
    "Name the note docs/plan/notes/$night-feedback-loop.md. Every PR you open in this repo uses a branch starting chore/feedback-loop-$night (other PRs count as slice progress). " +
    (Get-ReleaseLoopNote $state) +
    'In your docs PR, move every plan.md row whose status starts with `parked:` back to `planned` (keep the park reason as a note line in its slice file), except rows whose park reason contains the words `interactive session` (a night would only park them again; those words alone decide, a reason that only names the user still goes back), so the next night retries the rest (user answer 2026-11-01). ' +
    'List an item under Waiting on the user only if the answer changes what happens next and no one else can settle it, and name what it blocks; record an obvious product choice a wave already took as a decision instead, and drop a question about a past event that later merges or runs made moot. ' +
    'Nobody can answer: put every user decision in the note under `Waiting on the user`, never ask.'
  $entry = Invoke-Session $paths $state 'feedback-loop' $prompt $FeedbackLoopMaxMinutes
  if (Test-SessionFailed $entry) { return }
  $state.audited += @($state.sessions | ForEach-Object { $_.sessionId }) + @($state.carriedUnaudited | Where-Object { $_ } | ForEach-Object { $_.sessionId })
  $state.carriedUnaudited = @()
}

# The plan-cleanup session runs only when the waves ended normally: no planned slice left, or the no-progress stop.
# An error, disk-low, fast-failure or stop-file end skips it (the feedback loop still runs).
function Test-PlanCleanupWanted($state) {
  if ($state.fastFailure) { return $false }
  return "$($state.stopReason)" -match '^(no planned slices left|no progress in )'
}

# One plan-cleanup session at the end of all waves, before the feedback loop (user, 2026-11-25). No wall-clock cap, like housekeeping.
# Never throws and never stops the run: a failed session is logged and the feedback loop still runs.
function Invoke-PlanCleanup($paths, $state) {
  try {
    # The target is the literal first argument `all`; the skill reads any other wording as narrowing the targets. The branch name is the skill's own.
    $prompt = "/plan-cleanup all - Unattended, once at the end of all waves of a run-all-waves run in $($paths.Root). " +
      'Merge the docs PR when green. ' + (Get-ReleaseLoopNote $state) +
      'Nobody can answer: never ask; record every user decision in the plan''s Outstanding work, as the skill does.'
    $entry = Invoke-Session $paths $state 'plan-cleanup' $prompt
    Write-DriverLog "plan cleanup: exit $($entry.exitCode)"
    if (Test-SessionFailed $entry) { Write-DriverLog 'plan cleanup: session failed, night continues' }
  } catch { Write-DriverLog "plan cleanup error: $($_.Exception.Message)" }
}

$paths = Resolve-Paths
Enter-Lock $paths
$script:DriverLogPath = Join-Path $paths.RunDir "driver-$(Split-Path $paths.Night -Leaf).trace.log"
Write-DriverLog "driver start: pid $PID repo $($paths.Root) night $(Split-Path $paths.Night -Leaf)"
$state = [pscustomobject]@{ repo = $paths.Root; night = $paths.Night; pid = $PID; current = $null;
  remaining = @(); stopReason = $null; warning = $null; sessions = @(); audited = @(); carriedUnaudited = @(); fastFailure = $false; skippedFeedbackLoop = $null; waitingForMain = $null; starterSilentSince = $null; starterSessionId = $null; lowMemory = $null; batchReleases = @(); liveChecks = @(); unwatchedRelease = $false; carriedRelease = $false; finalRelease = $null; loopRelease = $null; tempCleanup = $null; tempCleanupWaves = @(); waveCleanups = @(); staleCleanup = $null; diskFree = $null; diskEstimate = $null; previousEnd = $null; ledgerWaveAtStart = 0; cloudSlices = @(); cloudSlicesUsed = 0; updatedAt = $null }
if (-not $PermissionMode) { $state.warning = $NoModeWarning }
$failure = $null
# A failed wave loop still gets the one feedback loop: the night's sessions are what it audits.
try {
  Initialize-Night $paths
  $state.ledgerWaveAtStart = Get-LedgerWaveAtStart $paths
  $carriedNight = Get-CarriedCloudNight $paths
  if ($carriedNight) {
    # The earlier night's baseline, so the killed wave's ledger lines are counted by the first recount below.
    if ($null -ne $carriedNight.ledgerWaveAtStart) { $state.ledgerWaveAtStart = [int]$carriedNight.ledgerWaveAtStart }
    $state.cloudSlices = @(@($carriedNight.cloudSlices) | Where-Object { $_ } | ForEach-Object { "$_".TrimStart('0') } | Select-Object -Unique)
  }
  Update-CloudSlicesUsed $paths $state
  $state.previousEnd = Get-PreviousEndReason $paths
  Write-DriverLog "phase: previous end: $($state.previousEnd)"
  Write-Host "run-all-waves: $($state.previousEnd)"
  $carriedStarter = Get-CarriedStarter $paths
  $state.starterSessionId = if ($carriedStarter) { $carriedStarter } elseif ($StarterSessionId) { $StarterSessionId } else { $null }
  $state.carriedUnaudited = @(Get-CarriedUnaudited $paths)
  Write-DriverLog "carried unaudited sessions: $(@($state.carriedUnaudited).Count)"
  Start-BatchRelease $paths @('--run-start')
  Set-CarriedUnwatchedRuns $paths $state
  try { Invoke-Waves $paths $state }
  catch { $state.stopReason = "error: $($_.Exception.Message)"; Write-DriverLog "wave loop error: $($_.Exception.Message)" }
  Write-DriverLog "stop: $($state.stopReason)"
  Write-DriverLog 'phase: final release'
  Invoke-FinalRelease $paths $state (-not ($state.stopReason -match '^stop file'))
  # Slice 31: once at the end of the night, before the feedback loop (not after a stop file or a fast failure: nothing is known to be up).
  if (-not ($state.stopReason -match '^stop file') -and -not $state.fastFailure) { Write-DriverLog 'phase: live checks'; Invoke-LiveChecks $paths $state 'final' }
  if (Test-PlanCleanupWanted $state) { Write-DriverLog 'phase: plan cleanup'; Invoke-PlanCleanup $paths $state }
  else { Write-DriverLog "plan cleanup skipped: the waves did not end normally ($($state.stopReason))" }
  Write-DriverLog 'phase: feedback loop'
  Invoke-FeedbackLoop $paths $state
  Write-DriverLog 'phase: loop release'
  Invoke-LoopRelease $paths $state
  $state.current = 'done'
} catch {
  $failure = $_.Exception.Message
  $state.current = 'failed'
  $state.stopReason = "$($state.stopReason); feedback loop error: $failure"
  throw
} finally {
  # Neither the normal end nor the catch above ran (a stop signal, an exit): say so instead of leaving the last phase name.
  if (@('done', 'failed', 'stopped') -notcontains "$($state.current)") {
    # A stop-file exit is clean: current becomes 'stopped' (an ended state), so the next run does not report it as killed.
    if ("$($state.stopReason)" -match '^stop file') {
      $state.current = 'stopped'
    } else {
      # Slice 317 item 7: no 'died' branch. The catch above sets 'failed' for every exception, so this block is reached only without one (a stop signal, an exit): that is not a driver death.
      # A driver killed before this block runs writes nothing; the next night's Get-PreviousEndReason names it as killed.
      $early = "driver ended early without an error while current was $($state.current)"
      $state.stopReason = if ($state.stopReason) { "$($state.stopReason); $early" } else { $early }
      $state.current = 'stopped'
    }
  }
  # A crash or a stop before the normal end: the merges of this run still get their one release.
  try { Invoke-FinalRelease $paths $state $false; Invoke-LoopRelease $paths $state } catch { Write-DriverLog "final release error: $($_.Exception.Message)" }
  if (Test-Path $paths.Night) { Write-Status $paths $state }
  Write-DriverLog "driver finally: current $($state.current) error $failure"
  Remove-Item $paths.Lock -ErrorAction SilentlyContinue
  # After the lock is gone, on purpose (review item 9, kept): a kill during the cleanup leaves no stale lock, and the
  # status is already on disk. The cleanup only removes things idle for 24 h and holder-checked, so a driver started
  # meanwhile is safe from it.
  Invoke-TempBuildCleanup $state
  Invoke-StaleCleanup $paths $state
  if (Test-Path $paths.Night) { Write-Status $paths $state }
}
