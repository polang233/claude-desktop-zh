param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("install", "uninstall", "recover")]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [ValidateSet("zh-CN", "zh-TW")]
    [string]$Language,

    [Parameter(Mandatory = $true)]
    [string]$ClaudePath,

    [Parameter(Mandatory = $true)]
    [string]$ResultFile,

    [string]$BackupDirectory = ""
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-Result {
    param([hashtable]$Value)
    $Value["schema"] = 1
    $json = $Value | ConvertTo-Json -Compress -Depth 4
    [IO.File]::WriteAllText($ResultFile, $json, $Utf8NoBom)
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-SourceWritable {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $false
    }
    try {
        $probe = Join-Path $Path (".magpie-write-test-" + [guid]::NewGuid().ToString("N"))
        [IO.Directory]::CreateDirectory($probe) | Out-Null
        [IO.Directory]::Delete($probe)
        return $true
    }
    catch {
        return $false
    }
}

function Test-FileWritable {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $true
    }
    try {
        $stream = [IO.File]::Open($Path, "Open", "ReadWrite", "Read")
        $stream.Dispose()
        return $true
    }
    catch {
        return $false
    }
}

$program = if ($Action -eq "recover") {
    Join-Path $PSScriptRoot "recover_third_party.ps1"
}
else {
    Join-Path $PSScriptRoot "install_windows.ps1"
}
if (-not (Test-Path -LiteralPath $program -PathType Leaf)) {
    Write-Result @{ action = $Action; exitCode = 1; message = "program-missing" }
    exit 1
}

$source = [IO.Path]::GetFullPath($ClaudePath)
if ($source.Contains('"')) {
    Write-Result @{ action = $Action; exitCode = 1; message = "invalid-source-path" }
    exit 1
}

$powerShell = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) {
    $powerShell = "powershell.exe"
}

$resources = Join-Path $source "resources"
if (-not (Test-Path -LiteralPath $resources -PathType Container)) {
    $resources = Join-Path $source "app\resources"
}
$writable = (Test-SourceWritable $source) -and (Test-SourceWritable $resources) -and
    (Test-FileWritable (Join-Path $source "claude.exe")) -and
    (Test-FileWritable (Join-Path $resources "app.asar")) -and
    (Test-FileWritable (Join-Path $resources "ion-dist.asar"))

if (-not (Test-Administrator) -and ($Action -eq "recover" -or -not $writable)) {
    try {
        $arguments = @(
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            ('"' + $PSCommandPath + '"'),
            "-Action",
            $Action,
            "-Language",
            $Language,
            "-ClaudePath",
            ('"' + $source + '"'),
            "-ResultFile",
            ('"' + $ResultFile + '"')
        )
        if ($BackupDirectory) {
            $arguments += @("-BackupDirectory", ('"' + $BackupDirectory + '"'))
        }
        $arguments = $arguments -join " "
        $child = Start-Process -FilePath $powerShell -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
        exit [int]$child.ExitCode
    }
    catch {
        Write-Result @{ action = $Action; exitCode = 1223; cancelled = $true; message = "elevation-cancelled" }
        exit 1223
    }
}

$logDirectory = Split-Path -Parent $ResultFile
$stdoutPath = Join-Path $logDirectory ("third-party-" + $Action + "-stdout.log")
$stderrPath = Join-Path $logDirectory ("third-party-" + $Action + "-stderr.log")
$reportPath = Join-Path $logDirectory "third-party-recover-report.json"
$env:CLAUDE_ZH_SKIP_UPDATE_CHECK = "1"

if ($Action -eq "recover") {
    if (Test-Path -LiteralPath $reportPath) {
        Remove-Item -LiteralPath $reportPath -Force
    }
    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ('"' + $program + '"'),
        "-ClaudePath",
        ('"' + $source + '"'),
        "-BackupDirectory",
        ('"' + $BackupDirectory + '"'),
        "-ReportFile",
        ('"' + $reportPath + '"')
    ) -join " "
}
else {
    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ('"' + $program + '"'),
        $Action,
        $Language,
        "-ClaudePath",
        ('"' + $source + '"'),
        "-AllowTakeOwnership"
    ) -join " "
}

try {
    $child = Start-Process -FilePath $powerShell -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $code = [int]$child.ExitCode
    Write-Result @{
        action = $Action
        language = $Language
        exitCode = $code
        log = $stdoutPath
        errorLog = $stderrPath
        report = if ($Action -eq "recover") { $reportPath } else { $null }
    }
    exit $code
}
catch {
    Write-Result @{ action = $Action; language = $Language; exitCode = 1; message = "installer-launch-failed" }
    exit 1
}
