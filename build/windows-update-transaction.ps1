param(
    [Parameter(Mandatory=$true)][ValidateSet('prepare','restore','rollback','consolidate')][string]$Phase,
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [Parameter(Mandatory=$true)][string]$UninstallerName,
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$AppId,
    [string]$RegisteredInstallDir = '',
    [string]$RegistryKey = '',
    [string]$UninstallRegistryKey = '',
    [ValidateSet('CurrentUser','LocalMachine')][string]$RegistryHive = 'CurrentUser',
    [ValidateSet('Registry64','Registry32')][string]$RegistryView = 'Registry64'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$frameworkSystem = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'System.dll'
[Environment]::CurrentDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
# NSIS 插件目录也有原生 System.dll，不能让 CodeDom 按当前目录解析 .NET 引用。
Add-Type -ReferencedAssemblies $frameworkSystem -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SanrenjzUpdateNative {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool MoveFileEx(string source, string target, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool DeleteFile(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool RemoveDirectory(string name);
}
'@
$utf8 = New-Object System.Text.UTF8Encoding($false)
$install = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$parent = [IO.Path]::GetDirectoryName($install)
if (!$parent -or $install -eq [IO.Path]::GetPathRoot($install).TrimEnd('\')) { throw 'Invalid installation root' }
Set-Location -LiteralPath ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory())
if ([IO.Path]::GetFileName($UninstallerName) -ne $UninstallerName -or !$UninstallerName.EndsWith('.exe')) { throw 'Invalid uninstaller name' }
$backup = $install + '.sanrenjz-update-backup'
$active = Join-Path $backup 'active'
$oldApp = Join-Path $active 'app'
$stateFile = Join-Path $active 'state.json'
$logFile = Join-Path $backup 'transaction.log'
$persistent = @('plugins','python-plugins','plugin-configs','runtime','plugin_runtime')
$script:state = $null

function Extended([string]$path) {
    if ($path.StartsWith('\\?\')) { return $path }
    if ($path.StartsWith('\\')) { return '\\?\UNC\' + $path.Substring(2) }
    return '\\?\' + $path
}
function Exists([string]$path) { return [IO.File]::Exists((Extended $path)) -or [IO.Directory]::Exists((Extended $path)) }
function FileDigest([string]$path) {
    $stream=[IO.File]::OpenRead((Extended $path))
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function EnsureDir([string]$path) { [void][IO.Directory]::CreateDirectory((Extended $path)) }
function AssertPlain([string]$path) {
    if ((Exists $path) -and (([IO.File]::GetAttributes((Extended $path)) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Directory link is not supported: $path" }
}
function Log([string]$message) {
    EnsureDir $backup
    [IO.File]::AppendAllText((Extended $logFile), ((Get-Date -Format o) + ' ' + $message + "`r`n"), $utf8)
}
function SaveState {
    EnsureDir $active
    $temporary = $stateFile + '.tmp'
    [IO.File]::WriteAllText((Extended $temporary), ($script:state | ConvertTo-Json -Depth 12), $utf8)
    if (!( [SanrenjzUpdateNative]::MoveFileEx((Extended $temporary), (Extended $stateFile), 9))) { throw 'Cannot persist update state' }
}
function MoveSafe([string]$from, [string]$to) {
    if (Exists $to) { throw "Destination already exists: $to" }
    EnsureDir ([IO.Path]::GetDirectoryName($to))
    if (![SanrenjzUpdateNative]::MoveFileEx((Extended $from), (Extended $to), 8)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "Cannot move directory/file (Win32 $code): $from -> $to"
    }
}
function RemoveSafe([string]$path) {
    if (!(Exists $path)) { return }
    $attributes = [IO.File]::GetAttributes((Extended $path))
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries((Extended $path))) { RemoveSafe $entry }
        }
        [IO.File]::SetAttributes((Extended $path), [IO.FileAttributes]::Directory)
        if (![SanrenjzUpdateNative]::RemoveDirectory((Extended $path))) { throw "Cannot remove directory: $path" }
    } else {
        [IO.File]::SetAttributes((Extended $path), [IO.FileAttributes]::Normal)
        if (![SanrenjzUpdateNative]::DeleteFile((Extended $path))) { throw "Cannot remove file: $path" }
    }
}
function CleanupCommitted {
    if (!(Exists $active)) { return }
    # 提交标记最后删除；清理中断后仍能识别为已提交，不会重新暂存当前应用。
    foreach ($entry in @([IO.Directory]::EnumerateFileSystemEntries((Extended $active)))) {
        $name=[IO.Path]::GetFileName($entry)
        if ($name -in @('state.json','state.json.tmp')) { continue }
        if ($name -notin @('app','temp')) { throw "Unknown transaction material retained: $name" }
        RemoveSafe $entry
    }
    RemoveSafe ($stateFile + '.tmp')
    RemoveSafe $stateFile
    if (![SanrenjzUpdateNative]::RemoveDirectory((Extended $active))) { throw 'Cannot remove empty completed transaction directory' }
}
function RegistryLocations {
    if (!$RegistryKey -and !$UninstallRegistryKey) { return @() }
    if ($RegistryKey -notmatch '^Software\\([a-fA-F0-9-]{36})$') { throw 'Invalid product registry key' }
    $guid = $Matches[1]
    if ($UninstallRegistryKey -ine ('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $guid)) { throw 'Registry keys do not identify the same product' }
    $items = @()
    foreach ($key in @($RegistryKey,$UninstallRegistryKey)) { $items += [pscustomobject]@{ Hive=$RegistryHive; View=$RegistryView; Key=$key } }
    return $items
}
function SnapshotRegistry {
    $result = @()
    foreach ($location in @(RegistryLocations)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$($location.Hive), [Microsoft.Win32.RegistryView]::$($location.View))
        try {
            $key = $base.OpenSubKey($location.Key, $false)
            if ($null -eq $key) { $result += [pscustomobject]@{ Hive=$location.Hive; View=$location.View; Key=$location.Key; Exists=$false; Values=@() }; continue }
            try {
                $values = @()
                foreach ($name in $key.GetValueNames()) { $values += [pscustomobject]@{ Name=$name; Kind=$key.GetValueKind($name).ToString(); Value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } }
                $result += [pscustomobject]@{ Hive=$location.Hive; View=$location.View; Key=$location.Key; Exists=$true; Values=$values }
            } finally { $key.Dispose() }
        } finally { $base.Dispose() }
    }
    return $result
}
function RestoreRegistry {
    $allowed = @(RegistryLocations | ForEach-Object { $_.Hive + '/' + $_.View + '/' + $_.Key })
    foreach ($location in @($script:state.Registry)) {
        if (($location.Hive + '/' + $location.View + '/' + $location.Key) -notin $allowed) { throw 'Registry snapshot is outside this product' }
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$($location.Hive), [Microsoft.Win32.RegistryView]::$($location.View))
        try {
            if (!$location.Exists) {
                $current = $base.OpenSubKey($location.Key,$false)
                if ($null -eq $current) { continue }
                try {
                    if ($location.Key -eq $RegistryKey) { $owned = $current.GetValue('InstallLocation','').TrimEnd('\') -ieq $install }
                    else { $owned = $current.GetValue('DisplayVersion','') -eq $script:state.Version -and $current.GetValue('UninstallString','').Contains($install + '\') }
                } finally { $current.Dispose() }
                if (!$owned) { throw 'Cannot remove a registry key created by another installation' }
                $base.DeleteSubKeyTree($location.Key,$false)
                continue
            }
            $key = $base.CreateSubKey($location.Key)
            try {
                $originalNames=@($location.Values | ForEach-Object { $_.Name })
                foreach ($name in $key.GetValueNames()) { if ($name -notin $originalNames) { $key.DeleteValue($name,$false) } }
                foreach ($value in @($location.Values)) {
                    $restoredValue = switch ($value.Kind) {
                        MultiString { ,([string[]]$value.Value) }
                        Binary { ,([byte[]]$value.Value) }
                        DWord { [int]$value.Value }
                        QWord { [long]$value.Value }
                        default { $value.Value }
                    }
                    $key.SetValue($value.Name, $restoredValue, [Microsoft.Win32.RegistryValueKind]::$($value.Kind))
                }
            }
            finally { $key.Dispose() }
        } finally { $base.Dispose() }
    }
}
function ConsolidateLegacy {
    $legacy = Join-Path $backup 'legacy'
    AssertPlain $legacy
    EnsureDir $legacy
    $importFile = Join-Path $legacy 'import.json'
    $fixed = Join-Path $legacy 'from-fixed-backup'
    $prefix = [IO.Path]::GetFileName($backup) + '.previous-'
    if (Exists $importFile) {
        AssertPlain $importFile
        $plan=[IO.File]::ReadAllText((Extended $importFile),$utf8) | ConvertFrom-Json
        if ($plan.InstallDir -ine $install -or $plan.AppId -ne $AppId) { throw 'Legacy import belongs to another installation' }
    } else {
        $names=@([IO.Directory]::EnumerateFileSystemEntries((Extended $backup)) | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object { $_ -in $persistent -or $_ -like 'backup-*.log' -or $_ -like 'restore-*.log' })
        $previous=@([IO.Directory]::EnumerateDirectories((Extended $parent)) | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object { $_.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) })
        $batch=1
        while (Exists $fixed) { $batch++; $fixed=Join-Path $legacy ('from-fixed-backup-' + $batch) }
        $plan=[pscustomobject]@{ InstallDir=$install; AppId=$AppId; Batch=$fixed; Names=$names; Previous=$previous }
        [IO.File]::WriteAllText((Extended ($importFile + '.tmp')),($plan | ConvertTo-Json -Depth 6),$utf8)
        if (![SanrenjzUpdateNative]::MoveFileEx((Extended ($importFile + '.tmp')),(Extended $importFile),9)) { throw 'Cannot persist legacy import plan' }
    }
    if (![IO.Path]::GetFullPath($plan.Batch).StartsWith(([IO.Path]::GetFullPath($legacy) + '\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid legacy batch' }
    foreach ($name in @($plan.Names) + @($plan.Previous)) {
        if ([IO.Path]::GetFileName($name) -ne $name -or $name -in @('.','..','')) { throw 'Invalid legacy import entry' }
        if ($name -in @($plan.Names)) {
            if ($name -notin $persistent -and $name -notlike 'backup-*.log' -and $name -notlike 'restore-*.log') { throw 'Unexpected fixed backup entry' }
            $from=Join-Path $backup $name; $to=Join-Path $plan.Batch $name
        } else {
            if (!$name.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected previous backup entry' }
            $from=Join-Path $parent $name; $to=Join-Path $legacy $name
        }
        AssertPlain $from; AssertPlain $to
        if ((Exists $from) -and !(Exists $to)) { MoveSafe $from $to }
        elseif (!(Exists $from) -and (Exists $to)) { continue }
        else { throw "Conflicting legacy backup entry: $name" }
    }
    if (@($plan.Names).Count -gt 0) { return $plan.Batch }
    return ''
}
function FillMissingLegacy {
    # 只补回最近一次失败前完整备份中的缺少项，现有文件和旧历史均不覆盖。
    if (!$script:state.RecoverySource -or $script:state.LegacyRecovered) { return }
    $legacyRoot=[IO.Path]::GetFullPath((Join-Path $backup 'legacy')) + '\'
    if (![IO.Path]::GetFullPath($script:state.RecoverySource).StartsWith($legacyRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid legacy recovery source' }
    foreach ($name in $persistent) {
        $from = Join-Path $script:state.RecoverySource $name
        if (!(Exists $from)) { continue }
        AssertPlain $from
        $to = Join-Path $oldApp $name
        & "$env:WINDIR\System32\robocopy.exe" $from $to /E /XC /XN /XO /SL /SJ /R:1 /W:1 /NP /NFL /NDL "/UNILOG+:$(Join-Path $backup 'legacy-recovery.log')" | Out-Null
        if ($LASTEXITCODE -lt 0 -or $LASTEXITCODE -ge 8) { throw "Cannot recover missing legacy files: $name ($LASTEXITCODE)" }
    }
    $script:state.LegacyRecovered=$true; SaveState
}
function Prepare {
    if ($RegisteredInstallDir -and [IO.Path]::GetFullPath($RegisteredInstallDir).TrimEnd('\') -ine $install) { throw 'Upgrade must keep the registered installation directory' }
    if ($RegistryKey) {
        $otherHive = if ($RegistryHive -eq 'CurrentUser') { 'LocalMachine' } else { 'CurrentUser' }
        $other = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$otherHive, [Microsoft.Win32.RegistryView]::$RegistryView)
        try { $otherKey = $other.OpenSubKey($RegistryKey,$false); if ($null -ne $otherKey) { $otherKey.Dispose(); throw 'Another installation scope exists; no files have been staged' } }
        finally { $other.Dispose() }
    }
    if ($null -eq $script:state) {
        $registry=@(SnapshotRegistry)
        if ((Exists $install) -and @([IO.Directory]::EnumerateFileSystemEntries((Extended $install))).Count -gt 0 -and @($registry | Where-Object { $_.Exists }).Count -eq 0) {
            $mainName=$UninstallerName -replace '^Uninstall ',''
            if (!(Exists (Join-Path $install $UninstallerName)) -or !(Exists (Join-Path $install $mainName)) -or ![IO.Directory]::Exists((Extended (Join-Path $install 'resources')))) {
                throw 'Non-empty installation directory does not identify this application'
            }
        }
        $recoverySource=ConsolidateLegacy
        $script:state = [pscustomobject]@{ Protocol=1; InstallDir=$install; AppId=$AppId; Version=$Version; Stage='created'; Moves=@(); Registry=$registry; RecoveryTarget=''; RecoverySource=$recoverySource; LegacyRecovered=$false }
        SaveState
    }
    # 导入计划只在本次事务持久化后撤销，收纳中断时继续同一批次。
    RemoveSafe (Join-Path $backup 'legacy\import.json')
    if ($script:state.Stage -eq 'committed') { CleanupCommitted; $script:state=$null; Prepare; return }
    if ($script:state.Stage -in @('restoring','rollingBack','originalRestoring')) { Rollback }
    if ($script:state.Stage -eq 'rolledBack') { $script:state.Stage='created'; $script:state.Moves=@(); $script:state.RecoveryTarget=''; $script:state.Version=$Version; $script:state.Registry=@(SnapshotRegistry); SaveState }
    if ($script:state.Stage -eq 'created') {
        # 整目录同盘移动，旧卸载器不再接触用户深层目录，也不复制整套缓存。
        if (Exists $oldApp) {
            if (Exists $install) { throw 'Ambiguous staging state; both old and current directories exist' }
        } elseif (Exists $install) {
            AssertPlain $install
            MoveSafe $install $oldApp
        } else { EnsureDir $oldApp }
        $script:state.Stage='staged'; SaveState
    }
    if ($script:state.Stage -ne 'staged') { throw 'An interrupted restore must be rolled back before retrying' }
    if (Exists $install) { PreservePartialRoot }
    FillMissingLegacy
    EnsureDir $install
    $originalUninstaller = Join-Path $oldApp $UninstallerName
    if (Exists $originalUninstaller) {
        [IO.File]::Copy((Extended $originalUninstaller), (Extended (Join-Path $install $UninstallerName)), $true)
    } elseif (@($script:state.Registry | Where-Object { $_.Exists }).Count -gt 0) { throw 'Registered old uninstaller is missing; recovery materials retained' }
    EnsureDir (Join-Path $active 'temp')
    Log 'Prepared old installation in the fixed transaction directory'
}
function PreservePartialRoot {
    # 空壳可直接移除；其他失败载荷集中保留，不能把未知文件当缓存删除。
    $entries = @([IO.Directory]::EnumerateFileSystemEntries((Extended $install)))
    $stub = Join-Path $install $UninstallerName
    $oldStub = Join-Path $oldApp $UninstallerName
    if ($entries.Count -eq 0) { RemoveSafe $install; return }
    if ($entries.Count -eq 1 -and [IO.Path]::GetFileName($entries[0]) -eq $UninstallerName -and (Exists $oldStub)) {
        if ((FileDigest $stub) -eq (FileDigest $oldStub)) { RemoveSafe $install; return }
    }
    if ($script:state.RecoveryTarget -and (Exists $script:state.RecoveryTarget)) { $script:state.RecoveryTarget=''; SaveState }
    if (!$script:state.RecoveryTarget) {
        $recovery = Join-Path $backup 'recovery'
        EnsureDir $recovery
        $script:state.RecoveryTarget=Join-Path $recovery ('interrupted-' + [Guid]::NewGuid().ToString('N'))
        SaveState
    }
    MoveSafe $install $script:state.RecoveryTarget
    $script:state.RecoveryTarget=''; SaveState
}
function Restore {
    if ($null -eq $script:state) { throw 'No prepared update transaction' }
    if ($script:state.Stage -eq 'committed') { CleanupCommitted; return }
    if ($script:state.Stage -notin @('staged','restoring')) { throw 'Update transaction is not ready to restore' }
    EnsureDir $install
    if ($script:state.Stage -eq 'staged') {
        $moves = @()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries((Extended $oldApp))) {
            $name = [IO.Path]::GetFileName($entry)
            $target = Join-Path $install $name
            if ($name -in $persistent) {
                if (Exists $target) { throw "New payload conflicts with preserved data: $name" }
                $moves += $name
            } elseif (!(Exists $target)) { $moves += $name }
        }
        $script:state.Moves=$moves; $script:state.Stage='restoring'; SaveState
    }
    foreach ($name in @($script:state.Moves)) {
        if ([IO.Path]::GetFileName($name) -ne $name -or $name -in @('.','..','') -or [IO.Path]::IsPathRooted($name)) { throw 'Invalid recovery journal entry' }
        $from = Join-Path $oldApp $name; $to = Join-Path $install $name
        if ((Exists $from) -and !(Exists $to)) { MoveSafe $from $to }
        elseif (!(Exists $from) -and (Exists $to)) { continue }
        else { throw "Conflicting or missing recovery entry: $name" }
    }
    $script:state.Stage='committed'; SaveState
    Log 'New payload installed; preserved data restored successfully'
    CleanupCommitted
}
function Rollback {
    if ($null -eq $script:state) { return }
    if ($script:state.Stage -eq 'committed') { CleanupCommitted; return }
    if ($script:state.Stage -eq 'created' -and !(Exists $oldApp)) { $script:state.Stage='rolledBack'; SaveState; return }
    if ($script:state.Stage -eq 'rolledBack') { return }
    if ($script:state.Stage -eq 'originalRestoring') {
        if ((Exists $oldApp) -and !(Exists $install)) { MoveSafe $oldApp $install }
        elseif (!(Exists $oldApp) -and (Exists $install)) { }
        else { throw 'Ambiguous original-directory recovery state' }
        RestoreRegistry
        $script:state.Stage='rolledBack'; SaveState
        Log 'Original installation restored; the same transaction can be retried'
        return
    }
    $script:state.Stage='rollingBack'; SaveState
    foreach ($name in @($script:state.Moves)) {
        if ([IO.Path]::GetFileName($name) -ne $name -or $name -in @('.','..','') -or [IO.Path]::IsPathRooted($name)) { throw 'Invalid recovery journal entry' }
        $from=Join-Path $install $name; $to=Join-Path $oldApp $name
        if (!(Exists $to) -and (Exists $from)) { MoveSafe $from $to }
        elseif ((Exists $to) -and !(Exists $from)) { continue }
        else { throw "Cannot safely roll back data entry: $name" }
    }
    if (!(Exists $oldApp)) { throw 'Original installation is missing' }
    if (Exists $install) { PreservePartialRoot }
    $script:state.Stage='originalRestoring'; SaveState
    Rollback
}

try {
    AssertPlain $backup; EnsureDir $backup; AssertPlain $active
    if ([IO.File]::Exists((Extended $stateFile))) {
        AssertPlain $stateFile
        $script:state = [IO.File]::ReadAllText((Extended $stateFile),$utf8) | ConvertFrom-Json
        if ($script:state.Protocol -ne 1 -or $script:state.InstallDir -ine $install -or $script:state.AppId -ne $AppId) { throw 'Transaction belongs to another installation' }
        if ($Phase -ne 'rollback' -and $script:state.Version -ne $Version -and $script:state.Stage -notin @('rolledBack','committed')) { throw 'Finish or recover the existing update before changing versions' }
    }
    switch ($Phase) {
        prepare { Prepare }
        restore { Restore }
        rollback { Rollback }
        consolidate { [void](ConsolidateLegacy); Log 'Legacy backups consolidated without moving the installation' }
    }
    exit 0
} catch {
    try { Log ($Phase + ': ' + $_.Exception.Message) } catch { }
    [Console]::Error.WriteLine('Update transaction failed. Recovery materials and details: ' + $logFile)
    exit 1
}
