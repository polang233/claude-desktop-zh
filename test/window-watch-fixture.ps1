param([string]$Watcher,[string]$Scratch,[switch]$ExistingProcess)
$ErrorActionPreference='Stop'
# Replace only desktop I/O. Exercise the shipped polling loop with a deterministic clock.
class RuntimeConsoleBridge {
  static [int] $Round
  static [long[]] WindowHandles([int]$pidValue) {
    if ([RuntimeConsoleBridge]::Round -in @(0,1,4)) { return @(101) }
    return @(101,202)
  }
  static [string] WindowKind([long]$window,[int]$pidValue,[long]$main) {
    if ($window -eq 101) { return 'main' }
    return 'setup'
  }
  static [bool] MaySchedule([long]$window,[int]$pidValue,[string]$kind,[bool]$activate) { return $true }
}
function Get-Process {
  param($Name,$ErrorAction)
  $start=[datetime]'2026-01-01'
  if ([RuntimeConsoleBridge]::Round -ge 6) { $start=$start.AddSeconds(1) }
  [pscustomobject]@{Id=42;StartTime=$start;MainWindowHandle=[IntPtr]101;Path='fixture'}
}
function Start-Sleep { param($Seconds) [RuntimeConsoleBridge]::Round++ }
function Clear-SetupNotice {}
function Test-Owner { return [RuntimeConsoleBridge]::Round -lt 8 }
function Invoke-Adapter {
  param($watchPid,$watchStart,$window,$kind)
  $round=[RuntimeConsoleBridge]::Round
  $state=switch ($round) { 0 {'FocusChanged'} 2 {'FocusChangedBeforeExecute'} default {'Applied'} }
  $events.Add(('{0}/{1}/{2}/{3}' -f $round,$window,$kind,$state))
  return @{applicationPid=$watchPid;applicationStartTicks=$watchStart;state=$state;scriptSubmitted=($state -eq 'Applied')}
}
$seen=[Collections.Generic.HashSet[string]]::new()
$events=[Collections.Generic.List[string]]::new()
$before=$SkipClaudeStartedThrough=0
if ($ExistingProcess) { $SkipClaudeStartedThrough=([datetime]'2026-01-01').ToUniversalTime().Ticks }
$bundle=@{sourceExecutable='fixture'}
$report=@{stopFile=(Join-Path $Scratch 'absent')}
$setupReady=$ActivateClaude=$true
$deadline=(Get-Date).AddMinutes(1)
$ast=[Management.Automation.Language.Parser]::ParseFile($Watcher,[ref]$null,[ref]$null)
$loop=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.WhileStatementAst] -and $n.Condition.Extent.Text.StartsWith('$setupReady -and')},$true))
if ($loop.Count -ne 1) { throw 'Expected one watcher polling loop.' }
& ([scriptblock]::Create($loop[0].Extent.Text)) | Out-Null
ConvertTo-Json -InputObject $events -Compress
