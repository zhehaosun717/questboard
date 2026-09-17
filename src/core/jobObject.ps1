# Job Object helper daemon for questboard. Reads one JSON command per stdin line, writes one JSON
# result per stdout line. Handles live inside this process, so jobs stay owned for the daemon's lifetime.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobNative {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32.dll")]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")]
  public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
  [DllImport("kernel32.dll")]
  public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
}
'@

$JOBOBJECT_EXTENDED_LIMIT_INFORMATION = 9
$JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
$JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = 1
$PROCESS_SET_QUOTA = 0x0100
$PROCESS_TERMINATE = 0x0001
$jobs = @{}
$nextId = 1

function Send($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function New-JobObject($name) {
  $job = [JobNative]::CreateJobObject([IntPtr]::Zero, $name)
  if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 0x90 bytes on x64 (Basic 0x40 + IO_COUNTERS 0x30 + 4 SIZE_T 0x20);
  # BasicLimitInformation.LimitFlags sits at offset 0x10.
  $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(0x90)
  for ($i = 0; $i -lt 0x90; $i += 1) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($info, 0x10, $JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
  $ok = [JobNative]::SetInformationJobObject($job, $JOBOBJECT_EXTENDED_LIMIT_INFORMATION, $info, 0x90)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($info)
  if (-not $ok) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); [JobNative]::CloseHandle($job) | Out-Null; throw "SetInformationJobObject failed (win32 $err)" }
  return $job
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.op) {
      'create' {
        $id = "job$nextId"; $nextId += 1
        $jobs[$id] = New-JobObject $cmd.name
        Send @{ ok = $true; seq = $cmd.seq; id = $id }
      }
      'assign' {
        if (-not $jobs.ContainsKey($cmd.id)) { throw "unknown job $($cmd.id)" }
        $proc = [JobNative]::OpenProcess($PROCESS_SET_QUOTA -bor $PROCESS_TERMINATE, $false, [uint32]$cmd.pid)
        if ($proc -eq [IntPtr]::Zero) { throw "OpenProcess failed for pid $($cmd.pid)" }
        try {
          $ok = [JobNative]::AssignProcessToJobObject($jobs[$cmd.id], $proc)
          if (-not $ok) { throw "AssignProcessToJobObject failed for pid $($cmd.pid)" }
        } finally { [JobNative]::CloseHandle($proc) | Out-Null }
        Send @{ ok = $true; seq = $cmd.seq }
      }
      'terminate' {
        if (-not $jobs.ContainsKey($cmd.id)) { throw "unknown job $($cmd.id)" }
        $ok = [JobNative]::TerminateJobObject($jobs[$cmd.id], 1)
        Send @{ ok = $ok; seq = $cmd.seq }
      }
      'count' {
        if (-not $jobs.ContainsKey($cmd.id)) { throw "unknown job $($cmd.id)" }
        $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(0x30)
        try {
          for ($i = 0; $i -lt 0x30; $i += 1) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }
          $ok = [JobNative]::QueryInformationJobObject($jobs[$cmd.id], $JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, $info, 0x30, [IntPtr]::Zero)
          if (-not $ok) { throw 'QueryInformationJobObject failed' }
          # ActiveProcesses offset: 4 LARGE_INTEGERs (0x20) + TotalPageFaultCount (4) + TotalProcesses (4) = 0x28
          $active = [Runtime.InteropServices.Marshal]::ReadInt32($info, 0x28)
        } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
        Send @{ ok = $true; seq = $cmd.seq; active = $active }
      }
      'close' {
        if ($jobs.ContainsKey($cmd.id)) {
          [JobNative]::CloseHandle($jobs[$cmd.id]) | Out-Null
          $jobs.Remove($cmd.id) | Out-Null
        }
        Send @{ ok = $true; seq = $cmd.seq }
      }
      'quit' { Send @{ ok = $true; seq = $cmd.seq }; break }
      default { throw "unknown op $($cmd.op)" }
    }
  } catch {
    Send @{ ok = $false; seq = $cmd.seq; error = $_.Exception.Message }
  }
}