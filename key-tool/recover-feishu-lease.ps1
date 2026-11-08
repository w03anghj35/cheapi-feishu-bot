param([Parameter(Mandatory=$true)][string]$LockPath)
$ErrorActionPreference = 'Stop'
# This helper only handles the connection lease. It never reads credentials or
# business journals. An exclusive Windows handle prevents rename/write/recovery
# races, including contenders running the older Node-only implementation.
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FeishuLeaseRecovery {
  [StructLayout(LayoutKind.Sequential)]
  private struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref Disposition info, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  public static FileStream OpenExclusive(string file) {
    // GENERIC_READ | DELETE; no sharing. DELETE access is required for disposition.
    var handle = CreateFileW(file, 0x80010000, 0, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new IOException("lease unavailable"); }
    try { return new FileStream(handle, FileAccess.Read); }
    catch { handle.Dispose(); throw; }
  }
  public static bool OwnerAbsent(int pid) {
    try { using (var process = Process.GetProcessById(pid)) { return process.HasExited; } }
    catch (ArgumentException) { return true; }
    // Permission/system errors must propagate; never infer that a process is gone.
  }
  public static void RemoveOpenedFile(FileStream stream) {
    var info = new Disposition { DeleteFile = true };
    if (!SetFileInformationByHandle(stream.SafeFileHandle, 4, ref info, (uint)Marshal.SizeOf(info)))
      throw new IOException("lease disposition failed");
  }
}
'@
  $resolvedLock = [IO.Path]::GetFullPath($LockPath)
  if ([IO.Path]::GetFileName($resolvedLock) -ne 'feishu-connection.lock') { throw 'unexpected lease name' }
  $leaseStream = $null
  try {
    $leaseStream = [FeishuLeaseRecovery]::OpenExclusive($resolvedLock)
    if ($leaseStream.Length -lt 1 -or $leaseStream.Length -gt 4096) { throw 'invalid lease size' }
    $bytes = New-Object byte[] ([int]$leaseStream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $leaseStream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -le 0) { throw 'short read' }
      $offset += $count
    }
    $record = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if ($record.pid -isnot [long] -and $record.pid -isnot [int]) { throw 'invalid pid' }
    if ($record.pid -le 0 -or $record.pid -gt [int]::MaxValue -or
        $record.token -isnot [string] -or $record.token -notmatch '^[0-9a-f-]{36}$') { throw 'invalid lease' }
    if (-not [FeishuLeaseRecovery]::OwnerAbsent([int]$record.pid)) { throw 'owner alive' }
    $archivePath = $resolvedLock + '.recovered-' + [Guid]::NewGuid().ToString('N') + '.bak'
    $archiveStream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $archiveStream.Write($bytes, 0, $bytes.Length); $archiveStream.Flush($true) }
    finally { $archiveStream.Dispose() }
    if (-not [FeishuLeaseRecovery]::OwnerAbsent([int]$record.pid)) { throw 'owner changed' }
    [FeishuLeaseRecovery]::RemoveOpenedFile($leaseStream)
  } finally { if ($null -ne $leaseStream) { $leaseStream.Dispose() } }
  [Console]::Out.Write('recovered')
  exit 0
} catch {
  # No path, lock token, command line or raw native exception in diagnostics.
  [Console]::Out.Write('protected')
  exit 1
}
