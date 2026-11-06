param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path -LiteralPath $ProjectRoot).Path
$targetPath = Join-Path $projectPath (-join [char[]](0x672c,0x673a,0x6570,0x636e))
if ([IO.Path]::GetDirectoryName($targetPath) -ne $projectPath) { throw 'Invalid local data path' }
if (-not (Test-Path -LiteralPath $targetPath)) { New-Item -ItemType Directory -Path $targetPath | Out-Null }
$target = Get-Item -LiteralPath $targetPath -Force
if (-not $target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe local data directory' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = New-Object Security.AccessControl.DirectorySecurity
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true,$false)
$allowed = @($sid.Value,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique
foreach ($value in $allowed) {
  $identity = New-Object Security.Principal.SecurityIdentifier($value)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $security.AddAccessRule($rule)
}
Set-Acl -LiteralPath $targetPath -AclObject $security
$actual = Get-Acl -LiteralPath $targetPath
if (-not $actual.AreAccessRulesProtected) { throw 'Local data ACL verification failed' }
foreach ($rule in $actual.Access) {
  if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) { throw 'Unexpected local data access rule' }
}
Write-Output 'Local data directory prepared.'
