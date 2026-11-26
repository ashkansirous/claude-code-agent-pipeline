<#
.SYNOPSIS
  Names the processes that hold a folder that will not delete ("Permission denied" on a worktree, Slice 307).
.DESCRIPTION
  A worktree removal that fails with "Permission denied" never says who holds the folder (five times by
  2026-11-01). This lists, one line per process, `<pid><TAB><name><TAB><reason>`:
    open file    the Windows Restart Manager reports the process has a file under the folder open
    command line the process was started with the folder's path in its command line (a build server, a watcher)
    program      the process runs a program that lives under the folder
  Exit 0 and a note when none is found, 1 when holders were found, 2 on a bad path, 3 when none was found but the
  check was partial (over -MaxFiles files, or Restart Manager failed). It stops nothing. The script's own process
  and the shells that launched it are never named.
  A shell whose current directory is inside the folder holds it too, but Windows gives no way to read another
  process's current directory: when no holder is listed, look for shells and background timers started while
  the session was inside the folder (~/.claude/CLAUDE.md, "Work in a worktree").
    pwsh -NoProfile -File folder-holders.ps1 -Path D:\my-app-worktrees\s233
  With -ListFile <file> (one folder per line) it checks them all in one process and prints one
  `HOLD<TAB><exit code><TAB><path>` line per folder, exit 0 (clean-stale.mjs uses it).
#>
param(
  [string[]]$Path,
  [string]$ListFile,
  [int]$MaxFiles = 200000,
  [ValidateRange(1, [int]::MaxValue)][int]$BatchSize = 1000
)
$ErrorActionPreference = 'Stop'
$script:Partial = $false

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FolderHoldersRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, RM_UNIQUE_PROCESS[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);

  const int ErrorMoreData = 234;

  public static int[] Holders(string[] files) {
    uint handle;
    var key = new StringBuilder(33);
    if (RmStartSession(out handle, 0, key) != 0) throw new InvalidOperationException("RmStartSession failed");
    try {
      if (RmRegisterResources(handle, (uint)files.Length, files, 0, null, 0, null) != 0) throw new InvalidOperationException("RmRegisterResources failed");
      uint needed = 0, count = 0, reasons = 0;
      int result = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result == 0) return new int[0];
      if (result != ErrorMoreData) throw new InvalidOperationException("RmGetList failed: " + result);
      var info = new RM_PROCESS_INFO[needed];
      count = needed;
      result = RmGetList(handle, out needed, ref count, info, ref reasons);
      if (result != 0) throw new InvalidOperationException("RmGetList (second call) failed: " + result);
      var ids = new List<int>();
      for (int i = 0; i < count; i++) ids.Add(info[i].Process.dwProcessId);
      return ids.ToArray();
    } finally {
      RmEndSession(handle);
    }
  }
}
'@

function Get-FolderFiles([string]$folder, [int]$limit) {
  return @(Get-ChildItem -LiteralPath $folder -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object -First $limit -ExpandProperty FullName)
}

# Every file is checked, in batches (Restart Manager takes a bounded list per session). Only past $limit files does it
# stop, and then $script:Partial says so: "no holder" must never be read as a full check.
function Get-OpenFileHolders([string]$folder, [int]$limit) {
  $files = @(Get-FolderFiles $folder ($limit + 1))
  if ($files.Count -gt $limit) { $script:Partial = $true; $files = @($files | Select-Object -First $limit) }
  $ids = @()
  for ($at = 0; $at -lt $files.Count; $at += $BatchSize) {
    $last = [Math]::Min($at + $BatchSize, $files.Count) - 1
    try {
      $ids += @([FolderHoldersRestartManager]::Holders([string[]]$files[$at..$last]))
    } catch {
      [Console]::Error.WriteLine("folder-holders: Restart Manager failed for files $at-$last ($($_.Exception.Message)); those files not checked")
      $script:Partial = $true
    }
  }
  return @($ids | Select-Object -Unique)
}

# The pids of this script's own process and of every process that launched it (the shell carries the path in its command line).
function Get-OwnChain([object[]]$processes) {
  $parents = @{}
  foreach ($process in $processes) { $parents[[int]$process.ProcessId] = [int]$process.ParentProcessId }
  $chain = @{}
  for ($id = $PID; $id -and -not $chain.ContainsKey($id); $id = $parents[$id]) { $chain[$id] = $true }
  return $chain
}

# The folder named in a command line as a whole path: followed by a separator, a quote, whitespace or the end.
function Test-NamesFolder([string]$commandLine, [string]$folder) {
  if (-not $commandLine) { return $false }
  $pattern = [regex]::Escape($folder) + '(?=$|[\\/"''\s])'
  return [regex]::IsMatch($commandLine.Replace('/', '\'), $pattern, 'IgnoreCase')
}

# One entry per process: pid, name and the reasons it was named.
function Add-Holder([hashtable]$found, [int]$processId, [string]$name, [string]$reason) {
  if ($processId -eq $PID) { return }
  if (-not $found.ContainsKey($processId)) { $found[$processId] = @{ Name = $name; Reasons = @() } }
  if ($found[$processId].Reasons -notcontains $reason) { $found[$processId].Reasons += $reason }
}

function Get-NameOf([int]$processId) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) { return $process.ProcessName }
  return '?'
}

function Test-Under([string]$candidate, [string]$folder) {
  if (-not $candidate) { return $false }
  return $candidate.StartsWith($folder.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

# Checks one folder: writes the report lines and sets $script:Code (0 none, 1 held, 2 bad path, 3 partial).
function Test-OneFolder([string]$target, [object[]]$processes, [hashtable]$own) {
  $script:Partial = $false
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    [Console]::Error.WriteLine("folder-holders: not a folder: $target")
    $script:Code = 2
    return
  }
  $folder = (Resolve-Path -LiteralPath $target).ProviderPath.TrimEnd('\')
  $found = @{}
  foreach ($holder in (Get-OpenFileHolders $folder $MaxFiles)) { Add-Holder $found $holder (Get-NameOf $holder) 'open file' }
  foreach ($process in $processes) {
    if ($own.ContainsKey([int]$process.ProcessId)) { continue }
    if (Test-NamesFolder $process.CommandLine $folder) { Add-Holder $found ([int]$process.ProcessId) $process.Name 'command line' }
    if (Test-Under $process.ExecutablePath $folder) { Add-Holder $found ([int]$process.ProcessId) $process.Name 'program' }
  }
  if ($found.Count -eq 0) {
    if ($script:Partial) {
      Write-Output "no process found holding $folder, but the check was PARTIAL (more than $MaxFiles files, or Restart Manager failed): this does not clear the folder"
      $script:Code = 3
      return
    }
    Write-Output "no process found holding $folder (a shell whose current directory is inside it cannot be seen from here)"
    $script:Code = 0
    return
  }
  if ($script:Partial) { [Console]::Error.WriteLine('folder-holders: the open-file check was PARTIAL; more holders may exist') }
  foreach ($id in ($found.Keys | Sort-Object)) { Write-Output ("{0}`t{1}`t{2}" -f $id, $found[$id].Name, ($found[$id].Reasons -join ', ')) }
  $script:Code = 1
}

if ($ListFile) { $Path = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ }) }
if (-not $Path) {
  [Console]::Error.WriteLine('folder-holders: give -Path <folder> or -ListFile <file with one folder per line>')
  exit 2
}
$processes = @(Get-CimInstance Win32_Process)
$own = Get-OwnChain $processes
# -ListFile (the cleanup checks all its candidates in one process): one `HOLD<TAB><exit code><TAB><path>` line per
# folder, printed as soon as that folder is checked, so a caller that times out still has the folders done so far. Exit 0.
if ($ListFile) {
  foreach ($target in $Path) {
    $null = Test-OneFolder $target $processes $own
    Write-Output ("HOLD`t{0}`t{1}" -f $script:Code, $target)
  }
  exit 0
}
Test-OneFolder $Path[0] $processes $own
exit $script:Code
