param(
    [Parameter(Mandatory = $true)]
    [string]$ClaudePath,

    [string]$BackupDirectory = "",

    [Parameter(Mandatory = $true)]
    [string]$ReportFile,

    [switch]$Fixture
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$restoreId = [guid]::NewGuid().ToString("N")
$warnings = New-Object System.Collections.Generic.List[string]
$replaced = New-Object System.Collections.Generic.List[object]
$serviceWasRunning = $false

function Write-Report {
    param([hashtable]$Value)
    $Value["schema"] = 1
    $Value["warnings"] = @($warnings)
    [IO.File]::WriteAllText($ReportFile, ($Value | ConvertTo-Json -Compress -Depth 5), $Utf8NoBom)
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Grant-WriteAccess {
    param([string]$Target)
    if (-not (Test-Path -LiteralPath $Target)) {
        return
    }
    $null = & takeown.exe /f $Target /a 2>&1
    $null = & icacls.exe $Target /grant "*S-1-5-32-544:F" /C 2>&1
}

function Get-Sha256 {
    param([string]$Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $sha.Dispose()
    }
}

function Restore-File {
    param(
        [string]$Source,
        [string]$Target,
        [string]$Relative
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Missing backup file: $Relative"
    }
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
        throw "Missing installed file: $Target"
    }
    $sourceHash = Get-Sha256 $Source
    $temporary = $Target + ".magpie-restore-$restoreId.tmp"
    $previous = $Target + ".magpie-restore-$restoreId.old"
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary -Force
        if ((Get-Sha256 $temporary) -ne $sourceHash) {
            throw "Restore copy hash mismatch: $Relative"
        }
        [IO.File]::SetAttributes($temporary, [IO.FileAttributes]::Normal)
        [IO.File]::SetAttributes($Target, [IO.FileAttributes]::Normal)
        [IO.File]::Replace($temporary, $Target, $previous, $true)
        if ((Get-Sha256 $Target) -ne $sourceHash) {
            throw "Restored file hash mismatch: $Relative"
        }
        $replaced.Add([pscustomobject]@{ Target = $Target; Previous = $previous; Relative = $Relative; Sha256 = $sourceHash })
    }
    catch {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Get-UserConfigFiles {
    $paths = New-Object System.Collections.Generic.List[string]
    if ($env:APPDATA) {
        $paths.Add((Join-Path $env:APPDATA "Claude\config.json"))
        $paths.Add((Join-Path $env:APPDATA "Claude-3p\config.json"))
    }
    if ($env:LOCALAPPDATA) {
        $packages = Join-Path $env:LOCALAPPDATA "Packages"
        foreach ($package in @(Get-ChildItem -LiteralPath $packages -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue)) {
            $paths.Add((Join-Path $package.FullName "LocalCache\Roaming\Claude\config.json"))
            $paths.Add((Join-Path $package.FullName "LocalCache\Roaming\Claude-3p\config.json"))
        }
    }
    return @($paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Unique)
}

try {
    if (-not $Fixture -and -not (Test-Administrator)) {
        throw "Administrator rights are required."
    }

    $source = [IO.Path]::GetFullPath($ClaudePath)
    $resources = Join-Path $source "resources"
    if (-not (Test-Path -LiteralPath $resources -PathType Container)) {
        $resources = Join-Path $source "app\resources"
    }
    if (-not (Test-Path -LiteralPath $resources -PathType Container)) {
        throw "Claude resources directory was not found."
    }

    $backupRoot = Join-Path $resources ".zh-cn-backups"
    if ($BackupDirectory) {
        $backup = [IO.Path]::GetFullPath($BackupDirectory)
    }
    else {
        $backup = @(
            Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object {
                    (Test-Path -LiteralPath (Join-Path $_.FullName "app.asar")) -and
                    (Test-Path -LiteralPath (Join-Path $_.FullName "ion-dist.asar")) -and
                    (Test-Path -LiteralPath (Join-Path $_.FullName "_app\Claude.exe"))
                } |
                Sort-Object Name |
                Select-Object -First 1
        )
        if ($backup) {
            $backup = $backup[0].FullName
        }
    }
    if (-not $backup -or -not (Test-Path -LiteralPath $backup -PathType Container)) {
        throw "A complete original backup set was not found."
    }

    if (-not $Fixture) {
        $service = Get-Service -Name "CoworkVMService" -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne "Stopped") {
            $serviceWasRunning = $true
            Stop-Service -Name "CoworkVMService" -Force -ErrorAction Stop
            try { $service.WaitForStatus("Stopped", [timespan]::FromSeconds(20)) }
            catch { throw "Cowork service did not stop." }
        }

        $runningClaude = @(Get-CimInstance Win32_Process -Filter "name='claude.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($source, [StringComparison]::OrdinalIgnoreCase) })
        if ($runningClaude.Count) {
            throw "Claude Desktop is still running."
        }

        $coworkProcesses = @(Get-CimInstance Win32_Process -Filter "name='cowork-svc.exe'" -ErrorAction SilentlyContinue)
        foreach ($process in $coworkProcesses) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
    }

    $appRoot = Split-Path -Parent $resources
    if (-not $Fixture) {
        foreach ($path in @($appRoot, $resources)) {
            Grant-WriteAccess $path
        }
    }

    $files = @(
        @{ Source = (Join-Path $backup "app.asar"); Target = (Join-Path $resources "app.asar"); Relative = "app.asar" },
        @{ Source = (Join-Path $backup "ion-dist.asar"); Target = (Join-Path $resources "ion-dist.asar"); Relative = "ion-dist.asar" },
        @{ Source = (Join-Path $backup "_app\Claude.exe"); Target = (Join-Path $appRoot "claude.exe"); Relative = "Claude.exe" }
    )
    $coworkBackup = Join-Path $backupRoot "init-backup\cowork-svc.exe"
    if (Test-Path -LiteralPath $coworkBackup -PathType Leaf) {
        $files += @{ Source = $coworkBackup; Target = (Join-Path $resources "cowork-svc.exe"); Relative = "cowork-svc.exe" }
    }
    else {
        throw "cowork-svc.exe backup was not found."
    }

    foreach ($file in $files) {
        if (-not $Fixture) {
            Grant-WriteAccess $file.Target
        }
    }
    foreach ($file in $files) {
        Restore-File $file.Source $file.Target $file.Relative
    }

    foreach ($file in $files) {
        if (-not $Fixture -and (Test-Path -LiteralPath $file.Target)) {
            $null = & icacls.exe $file.Target /reset /C 2>&1
        }
    }

    $marker = Join-Path $resources ".zh-cn-asar-extracted"
    $workspace = Join-Path $resources "ion-dist"
    if ((Test-Path -LiteralPath $marker -PathType Leaf) -and (Test-Path -LiteralPath $workspace -PathType Container)) {
        Remove-Item -LiteralPath $workspace -Recurse -Force
        Remove-Item -LiteralPath $marker -Force
    }

    $languageFiles = @(
        (Join-Path $resources "zh-CN.json"),
        (Join-Path $resources "zh-TW.json"),
        (Join-Path $resources "zh-HK.json"),
        (Join-Path $resources "ion-dist\i18n\zh-CN.json"),
        (Join-Path $resources "ion-dist\i18n\zh-TW.json"),
        (Join-Path $resources "ion-dist\i18n\zh-HK.json"),
        (Join-Path $resources "ion-dist\i18n\statsig\zh-CN.json"),
        (Join-Path $resources "ion-dist\i18n\statsig\zh-TW.json"),
        (Join-Path $resources "ion-dist\i18n\statsig\zh-HK.json"),
        (Join-Path $resources "ion-dist\i18n\dynamic\zh-CN.json"),
        (Join-Path $resources "ion-dist\i18n\dynamic\zh-TW.json"),
        (Join-Path $resources "ion-dist\i18n\dynamic\zh-HK.json")
    )
    foreach ($file in $languageFiles) {
        if (Test-Path -LiteralPath $file) {
            Remove-Item -LiteralPath $file -Force
        }
    }
    if (Test-Path -LiteralPath (Join-Path $resources "zh-CN.json")) {
        throw "Chinese language resources could not be removed."
    }

    if (-not $Fixture) {
        foreach ($configPath in Get-UserConfigFiles) {
            try {
                $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
                if (-not $config) {
                    $config = [pscustomobject]@{}
                }
                $config | Add-Member -NotePropertyName "locale" -NotePropertyValue "en-US" -Force
                [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 100), $Utf8NoBom)
            }
            catch {
                $warnings.Add("Could not update locale in $configPath")
            }
        }
    }

    foreach ($item in $replaced) {
        if (Test-Path -LiteralPath $item.Previous) {
            Remove-Item -LiteralPath $item.Previous -Force -ErrorAction SilentlyContinue
        }
    }

    if ($serviceWasRunning) {
        try {
            Start-Service -Name "CoworkVMService" -ErrorAction Stop
        }
        catch {
            $warnings.Add("Cowork service did not restart.")
        }
    }

    Write-Report @{
        exitCode = 0
        source = $source
        backupDirectory = $backup
        restored = @($replaced | ForEach-Object { [pscustomobject]@{ file = $_.Relative; sha256 = $_.Sha256 } })
        coworkServiceStarted = $serviceWasRunning
    }
    exit 0
}
catch {
    for ($index = $replaced.Count - 1; $index -ge 0; $index--) {
        $item = $replaced[$index]
        if (Test-Path -LiteralPath $item.Previous -PathType Leaf) {
            try {
                [IO.File]::Replace($item.Previous, $item.Target, $null, $true)
            }
            catch {
                $warnings.Add("Could not roll back $($item.Relative)")
            }
        }
    }
    if ($serviceWasRunning) {
        try { Start-Service -Name "CoworkVMService" -ErrorAction SilentlyContinue } catch {}
    }
    $message = if ($_.Exception) { $_.Exception.Message } else { "Restore failed." }
    Write-Report @{ exitCode = 1; source = $ClaudePath; error = $message }
    exit 1
}
