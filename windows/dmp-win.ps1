#Requires -Version 5.1
<#
dmp-win: the only way devmagic-panel changes anything on the Windows side.

The panel runs inside WSL; on Windows it may only run this script, by its
fixed path, with one of the commands below and arguments that match
[a-z0-9./=:-]. The same checks run in the panel before it calls this script,
and again here. No shell: no Invoke-Expression, no cmd /c, no -Command; .NET
calls and programs started with an argument array only.

  status                       read only: hosts block, CA, logon task, WSL, ports, UAC (JSON)
  hosts-sync [name=ip ...]     the devmagic-panel block of Windows' hosts file becomes exactly
                               these lines, one name per line (ip 127.0.0.1 or 127.0.0.2, local
                               names only); none removes the block; a copy is kept first. Admin.
  ca-trust                     trust the panel's local CA from the recorded distro for this user
  ca-untrust                   take it out again, by thumbprint
  autostart-install            the logon task that keeps the distro running, for this user
  autostart-remove             remove it
  wsl-restart                  wsl --shutdown with a time limit; says when only a restart of
                               Windows helps (WSL can hang that way)
  self-install                 copy this script into C:\Program Files\devmagic-panel, where the
                               panel calls it and only admins may change it. Admin.
  self-remove                  remove that folder again (an uninstall). Admin.

Exit codes: 0 done, 1 failed, 2 bad input, 3 UAC declined, 4 WSL not answering.
An admin command run without admin starts this script again elevated for that
one command (Windows asks with UAC) and returns its exit code.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = '',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Arguments = @()
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:DmpCommands = @('status', 'hosts-sync', 'ca-trust', 'ca-untrust', 'autostart-install', 'autostart-remove', 'wsl-restart', 'self-install', 'self-remove')
$script:DmpAdminCommands = @('hosts-sync', 'self-install', 'self-remove')
$script:DmpBegin = '# BEGIN devmagic-panel'
$script:DmpEnd = '# END devmagic-panel'
$script:DmpAddresses = @('127.0.0.1', '127.0.0.2')
$script:DmpTaskName = 'devmagic-panel'
$script:DmpCaSubject = '^CN=devmagic-panel Local CA( \([^)]{1,63}\))?, O=devmagic-panel$'

class DmpInputError : System.Exception {
  DmpInputError([string]$message) : base($message) {}
}

function Write-DmpOk([string]$Text) { [Console]::Out.WriteLine("ok: $Text") }

# --- checks ---

# The same rule as isLocalName (shared/src/actions.ts) and dmp_is_local_name
# (scripts/lib/validate.sh): local.*, www.local.*, *.test or *.localhost, in
# lowercase DNS labels. shared/test/local-names.txt is the one list all three test.
function Test-DmpLocalName([string]$Name) {
  if ($null -eq $Name -or $Name.Length -gt 253) { return $false }
  $label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  if ($Name -cnotmatch "^$label(\.$label)+$") { return $false }
  return $Name.StartsWith('local.', [StringComparison]::Ordinal) -or
    $Name.StartsWith('www.local.', [StringComparison]::Ordinal) -or
    $Name.EndsWith('.test', [StringComparison]::Ordinal) -or
    $Name.EndsWith('.localhost', [StringComparison]::Ordinal)
}

# Every argument, before anything else: only [a-z0-9./=:-], so Windows'
# command-line quoting never matters when this script starts itself elevated.
function Assert-DmpArgument([string]$Value) {
  if ($Value -cnotmatch '^[a-z0-9./=:-]{1,300}$') { throw [DmpInputError]::new("not an argument this script takes: '$Value'") }
}

# name=ip pairs into objects, refusing anything but a local name on an allowed address.
function ConvertFrom-DmpPair([string[]]$Pairs) {
  $seen = @{}
  foreach ($pair in $Pairs) {
    Assert-DmpArgument $pair
    $parts = $pair.Split('=')
    if ($parts.Count -ne 2) { throw [DmpInputError]::new("not name=ip: '$pair'") }
    $name = $parts[0]
    $ip = $parts[1]
    if (-not (Test-DmpLocalName $name)) { throw [DmpInputError]::new("not a local name: '$name' (use local.example.com, *.test or *.localhost)") }
    if ($script:DmpAddresses -notcontains $ip) { throw [DmpInputError]::new("not an address the panel uses: '$ip'") }
    if ($seen.ContainsKey($name)) { throw [DmpInputError]::new("named twice: '$name'") }
    $seen[$name] = $true
    [pscustomobject]@{ Name = $name; Address = $ip }
  }
}

# --- hosts ---

# The hosts file as text, how its lines end and whether it starts with a byte
# order mark, so it is written back the way it was.
function Read-DmpTextFile([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $start = 0
  if ($bom) { $start = 3 }
  $text = [Text.Encoding]::UTF8.GetString($bytes, $start, $bytes.Length - $start)
  $newline = "`n"
  if ($text.Contains("`r`n") -or -not $text.Contains("`n")) { $newline = "`r`n" }
  [pscustomobject]@{ Text = $text; Newline = $newline; Bom = $bom }
}

# The lines of the panel's block, without its markers; nothing when there is
# none. Callers wrap it in @() for an array.
function Get-DmpHostsBlock([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $inside = $false
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in ((Read-DmpTextFile $Path).Text -split "`r?`n")) {
    if ($line.StartsWith($script:DmpBegin, [StringComparison]::Ordinal)) { $inside = $true; continue }
    if ($line.StartsWith($script:DmpEnd, [StringComparison]::Ordinal)) { $inside = $false; continue }
    if ($inside -and $line.Trim()) { $lines.Add($line.Trim()) }
  }
  return $lines.ToArray()
}

# The hosts file with the panel's block replaced by these entries (none: no
# block). Lines outside the block stay exactly as they are.
function Set-DmpHostsBlock([string]$Path, [object[]]$Entries, [string]$BackupDir) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "no hosts file at $Path" }
  if ((Get-Item -LiteralPath $Path).IsReadOnly) { throw "$Path is read-only: clear its read-only attribute, then sync again" }
  $file = Read-DmpTextFile $Path
  $lines = $file.Text -split "`r?`n"
  $begins = @($lines | Where-Object { $_.StartsWith($script:DmpBegin, [StringComparison]::Ordinal) }).Count
  $ends = @($lines | Where-Object { $_.StartsWith($script:DmpEnd, [StringComparison]::Ordinal) }).Count
  if ($begins -gt 1 -or $begins -ne $ends) { throw "$Path has $begins BEGIN and $ends END devmagic-panel lines: fix it by hand first" }

  $kept = New-Object System.Collections.Generic.List[string]
  $inside = $false
  foreach ($line in $lines) {
    if ($line.StartsWith($script:DmpBegin, [StringComparison]::Ordinal)) { $inside = $true; continue }
    if ($line.StartsWith($script:DmpEnd, [StringComparison]::Ordinal)) { $inside = $false; continue }
    if (-not $inside) { $kept.Add($line) }
  }
  while ($kept.Count -gt 0 -and -not $kept[$kept.Count - 1].Trim()) { $kept.RemoveAt($kept.Count - 1) }
  if ($Entries.Count -gt 0) {
    $kept.Add('')
    $kept.Add("$($script:DmpBegin) (managed by the panel in WSL, edit sites there)")
    foreach ($entry in $Entries) { $kept.Add("$($entry.Address) $($entry.Name)") }
    $kept.Add($script:DmpEnd)
  }
  $text = ($kept -join $file.Newline) + $file.Newline

  if ($BackupDir) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $Path -Destination (Join-Path $BackupDir "hosts-$stamp") -Force
  }
  # In place, so the file keeps its permissions.
  [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding($file.Bom)))
}

# --- CA ---

# The panel's CA from its file, refused unless it is that CA: its subject,
# CA:TRUE and the right to sign certificates.
function Get-DmpCaCertificate([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "no CA at ${Path}: is the distro running, with the panel installed?" }
  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $Path
  if ($cert.Subject -cnotmatch $script:DmpCaSubject) { throw "$Path is not the panel's CA: $($cert.Subject)" }
  $basic = $cert.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] }
  if (-not $basic -or -not $basic.CertificateAuthority) { throw "$Path is not a CA certificate (CA:TRUE missing)" }
  $usage = $cert.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509KeyUsageExtension] }
  if (-not $usage -or -not ($usage.KeyUsages -band [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign)) { throw "$Path may not sign certificates (keyCertSign missing)" }
  return $cert
}

function Open-DmpStore([string]$StoreName) {
  $store = New-Object Security.Cryptography.X509Certificates.X509Store -ArgumentList $StoreName, ([Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  return $store
}

# Adds the CA to the current user's store; for Root, Windows itself asks to confirm.
function Add-DmpCaTrust($Certificate, [string]$StoreName = 'Root') {
  $store = Open-DmpStore $StoreName
  try {
    if ($store.Certificates.Find('FindByThumbprint', $Certificate.Thumbprint, $false).Count -gt 0) { return 'already' }
    $store.Add($Certificate)
    if ($store.Certificates.Find('FindByThumbprint', $Certificate.Thumbprint, $false).Count -eq 0) { throw 'not added: the Windows confirmation was declined' }
    return 'added'
  } finally { $store.Close() }
}

# Removes the panel's CAs from the store: the given thumbprint, or, when the
# distro's CA cannot be read any more, every certificate with the panel's subject.
function Remove-DmpCaTrust([string]$Thumbprint, [string]$StoreName = 'Root') {
  $store = Open-DmpStore $StoreName
  try {
    $gone = 0
    foreach ($cert in @($store.Certificates)) {
      if ($cert.Subject -cnotmatch $script:DmpCaSubject) { continue }
      if ($Thumbprint -and $cert.Thumbprint -ne $Thumbprint) { continue }
      $store.Remove($cert)
      $gone++
    }
    return $gone
  } finally { $store.Close() }
}

# --- logon task ---

# The task as XML: at this user's logon, without a window, keep the distro
# running; no time limit, on battery too, one instance.
function New-DmpLogonTaskXml([string]$User, [string]$Distro) {
  if ($Distro -cnotmatch '^[A-Za-z0-9._-]{1,64}$') { throw [DmpInputError]::new("not a distro name: '$Distro'") }
  if ($User -cnotmatch '^[^<>&"]{1,256}$') { throw [DmpInputError]::new("not a user name: '$User'") }
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>devmagic-panel: keeps the $Distro WSL distro running while you are logged in</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$User</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$User</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author"><Exec><Command>%SystemRoot%\System32\conhost.exe</Command><Arguments>--headless wsl.exe -d $Distro --exec sleep infinity</Arguments></Exec></Actions>
</Task>
"@
}

# One command line from an argument array, so the program gets back exactly
# these arguments: Windows hands a program one string, which it splits by the
# usual rules (CommandLineToArgvW): spaces split, "..." groups, \" is a quote,
# and backslashes are literal unless they come before a quote.
function Join-DmpArgumentList([string[]]$ArgumentList) {
  $quoted = foreach ($arg in $ArgumentList) {
    if ($arg -and $arg -notmatch '[\s"]') { $arg; continue }
    $out = New-Object Text.StringBuilder
    [void]$out.Append('"')
    $slashes = 0
    foreach ($c in $arg.ToCharArray()) {
      if ($c -eq '\') { $slashes++; continue }
      if ($c -eq '"') { [void]$out.Append('\', 2 * $slashes + 1); [void]$out.Append('"') }
      else { [void]$out.Append('\', $slashes); [void]$out.Append($c) }
      $slashes = 0
    }
    # Backslashes before the closing quote are doubled, so they stay backslashes.
    [void]$out.Append('\', 2 * $slashes)
    [void]$out.Append('"')
    $out.ToString()
  }
  return ($quoted -join ' ')
}

# A program with an argument array and a time limit; its output and exit code,
# or TimedOut when it did not end in time (WSL can hang, finding H).
function Invoke-DmpProgram([string]$File, [string[]]$ArgumentList, [int]$TimeoutSeconds = 30) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $File
  $info.Arguments = Join-DmpArgumentList $ArgumentList
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.CreateNoWindow = $true
  $info.EnvironmentVariables['WSL_UTF8'] = '1'
  $process = [Diagnostics.Process]::Start($info)
  $out = $process.StandardOutput.ReadToEndAsync()
  $err = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch { Write-Verbose "the program ended as it was stopped: $($_.Exception.Message)" }
    return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = ''; Error = '' }
  }
  [pscustomobject]@{ TimedOut = $false; ExitCode = $process.ExitCode; Output = $out.Result; Error = $err.Result }
}

function Get-DmpSchtasksPath() { Join-Path $env:SystemRoot 'System32\schtasks.exe' }

function Install-DmpLogonTask([string]$User, [string]$Distro) {
  $xml = New-DmpLogonTaskXml -User $User -Distro $Distro
  $file = Join-Path ([IO.Path]::GetTempPath()) ("devmagic-panel-task-{0}.xml" -f ([guid]::NewGuid().ToString('N')))
  try {
    [IO.File]::WriteAllText($file, $xml, [Text.Encoding]::Unicode)
    $result = Invoke-DmpProgram (Get-DmpSchtasksPath) @('/Create', '/TN', $script:DmpTaskName, '/XML', $file, '/F')
    if ($result.TimedOut -or $result.ExitCode -ne 0) { throw "schtasks could not create the task: $($result.Error.Trim())" }
    $run = Invoke-DmpProgram (Get-DmpSchtasksPath) @('/Run', '/TN', $script:DmpTaskName)
    if ($run.TimedOut -or $run.ExitCode -ne 0) { throw "the task was created but did not start: $($run.Error.Trim())" }
  } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}

function Remove-DmpLogonTask() {
  $query = Invoke-DmpProgram (Get-DmpSchtasksPath) @('/Query', '/TN', $script:DmpTaskName)
  if ($query.ExitCode -ne 0) { return 'none' }
  $result = Invoke-DmpProgram (Get-DmpSchtasksPath) @('/Delete', '/TN', $script:DmpTaskName, '/F')
  if ($result.TimedOut -or $result.ExitCode -ne 0) { throw "schtasks could not remove the task: $($result.Error.Trim())" }
  return 'removed'
}

# --- settings ---

# What the Windows installer recorded for this user: the distro the panel runs in.
function Get-DmpDistro() {
  $key = 'HKCU:\Software\devmagic-panel'
  $distro = $null
  if (Test-Path $key) { $distro = (Get-ItemProperty -Path $key -Name Distro -ErrorAction SilentlyContinue).Distro }
  if (-not $distro) { $distro = 'devmagic-panel' }
  if ($distro -cnotmatch '^[A-Za-z0-9._-]{1,64}$') { throw "the recorded distro name is not valid: '$distro'" }
  return $distro
}

# The CA in the distro, through Windows' share for WSL: \\wsl.localhost on
# current Windows, \\wsl$ on older builds (both still work where both exist).
function Get-DmpCaPath([string]$Distro, [string[]]$Shares = @('\\wsl.localhost', '\\wsl$')) {
  $paths = foreach ($share in $Shares) { "$share\$Distro\etc\ssl\localcerts\devmagic-panel-ca\ca.pem" }
  foreach ($path in $paths) { if (Test-Path -LiteralPath $path) { return $path } }
  return $paths[0]
}
function Get-DmpHostsPath() { Join-Path $env:SystemRoot 'System32\drivers\etc\hosts' }
function Get-DmpBackupDir() { Join-Path $env:ProgramData 'devmagic-panel\backups' }
function Get-DmpInstallDir() { Join-Path $env:ProgramFiles 'devmagic-panel' }

# Copies this very script into the install folder: no path from the caller,
# only the file that runs. A copy that is there already and the same is kept.
function Install-DmpSelf([string]$Source, [string]$Folder) {
  $target = Join-Path $Folder 'dmp-win.ps1'
  if ((Test-Path -LiteralPath $target) -and ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash)) { return 'already' }
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  Copy-Item -LiteralPath $Source -Destination $target -Force
  return 'copied'
}

# Removes the install folder, and only a folder named devmagic-panel holding the helper.
function Remove-DmpSelf([string]$Folder) {
  if (-not (Test-Path -LiteralPath $Folder)) { return 'none' }
  if ((Split-Path -Leaf $Folder) -ne 'devmagic-panel' -or -not (Test-Path -LiteralPath (Join-Path $Folder 'dmp-win.ps1'))) { throw "$Folder is not the helper's folder: leaving it as it is" }
  Remove-Item -LiteralPath $Folder -Recurse -Force
  return 'removed'
}

function Test-DmpAdmin() {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# This script again, elevated, for one admin command; its exit code, or 3 when UAC was declined.
function Invoke-DmpElevated([string]$Name, [string[]]$ArgumentList) {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $all = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), $Name) + $ArgumentList
  try {
    $process = Start-Process -FilePath $powershell -ArgumentList $all -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    return $process.ExitCode
  } catch [ComponentModel.Win32Exception] {
    if ($_.Exception.NativeErrorCode -eq 1223) { return 3 }
    throw
  }
}

# --- status ---

# Read only, nothing through WMI: what the Windows side looks like now.
function Get-DmpStatus([string]$Distro) {
  $hosts = Get-DmpHostsPath
  $ca = [ordered]@{ path = (Get-DmpCaPath $Distro); readable = $false; thumbprint = $null; trusted = $false }
  try {
    $cert = Get-DmpCaCertificate $ca.path
    $ca.readable = $true
    $ca.thumbprint = $cert.Thumbprint
    $ca.trusted = @(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }).Count -gt 0
  } catch { $ca.error = $_.Exception.Message }

  $task = Invoke-DmpProgram (Get-DmpSchtasksPath) @('/Query', '/TN', $script:DmpTaskName, '/FO', 'CSV', '/NH') 15
  $wsl = Invoke-DmpProgram (Join-Path $env:SystemRoot 'System32\wsl.exe') @('--list', '--verbose') 30
  $distroState = $null
  if (-not $wsl.TimedOut) {
    foreach ($line in ($wsl.Output -split "`r?`n")) {
      $fields = @($line.Trim().TrimStart('*').Trim() -split '\s+')
      if ($fields.Count -ge 3 -and $fields[0] -eq $Distro) { $distroState = $fields[1] }
    }
  }
  $netstat = Invoke-DmpProgram (Join-Path $env:SystemRoot 'System32\NETSTAT.EXE') @('-ano', '-p', 'TCP') 15
  $listening = @(($netstat.Output -split "`r?`n") | Where-Object { $_ -match '\sLISTENING\s' } | ForEach-Object { ($_.Trim() -split '\s+')[1] } |
      Where-Object { $_ -match ':(80|443|3306)$' })
  $uac = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue

  [ordered]@{
    distro = $Distro
    wsl = [ordered]@{ answering = -not $wsl.TimedOut; distroState = $distroState }
    hosts = [ordered]@{ path = $hosts; block = @(Get-DmpHostsBlock $hosts) }
    ca = $ca
    logonTask = [ordered]@{ installed = (-not $task.TimedOut -and $task.ExitCode -eq 0) }
    ports = $listening
    uac = [ordered]@{ enabled = ($uac -and $uac.EnableLUA -eq 1); promptsAdmins = ($uac -and $uac.ConsentPromptBehaviorAdmin -ne 0) }
  }
}

# --- commands ---

function Invoke-DmpCommand([string]$Name, [string[]]$ArgumentList) {
  if ($script:DmpCommands -notcontains $Name) { throw [DmpInputError]::new("unknown command: '$Name' (one of: $($script:DmpCommands -join ', '))") }
  foreach ($value in $ArgumentList) { Assert-DmpArgument $value }
  if ($Name -ne 'hosts-sync' -and $ArgumentList.Count -gt 0) { throw [DmpInputError]::new("$Name takes no arguments") }

  if ($script:DmpAdminCommands -contains $Name -and -not (Test-DmpAdmin)) {
    # Checked before UAC asks: bad input never reaches the elevated copy.
    if ($Name -eq 'hosts-sync') { ConvertFrom-DmpPair $ArgumentList | Out-Null }
    return (Invoke-DmpElevated $Name $ArgumentList)
  }

  switch ($Name) {
    'status' {
      [Console]::Out.WriteLine((Get-DmpStatus (Get-DmpDistro) | ConvertTo-Json -Depth 5))
    }
    'hosts-sync' {
      $entries = @(ConvertFrom-DmpPair $ArgumentList)
      Set-DmpHostsBlock -Path (Get-DmpHostsPath) -Entries $entries -BackupDir (Get-DmpBackupDir)
      Write-DmpOk "Windows' hosts file has $($entries.Count) name(s) in the devmagic-panel block"
    }
    'ca-trust' {
      $cert = Get-DmpCaCertificate (Get-DmpCaPath (Get-DmpDistro))
      $result = Add-DmpCaTrust $cert
      Write-DmpOk "the panel's CA ($($cert.Thumbprint)) is trusted for this user ($result)"
    }
    'ca-untrust' {
      $thumbprint = $null
      # The distro may be gone (an uninstall): then every certificate with the panel's subject goes.
      try { $thumbprint = (Get-DmpCaCertificate (Get-DmpCaPath (Get-DmpDistro))).Thumbprint } catch { Write-Verbose "no CA to read: $($_.Exception.Message)" }
      $gone = Remove-DmpCaTrust $thumbprint
      Write-DmpOk "$gone certificate(s) of the panel taken out of this user's trusted roots"
    }
    'autostart-install' {
      $distro = Get-DmpDistro
      Install-DmpLogonTask -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -Distro $distro
      Write-DmpOk "the logon task '$($script:DmpTaskName)' keeps $distro running"
    }
    'autostart-remove' {
      Write-DmpOk "the logon task: $(Remove-DmpLogonTask)"
    }
    'wsl-restart' {
      $result = Invoke-DmpProgram (Join-Path $env:SystemRoot 'System32\wsl.exe') @('--shutdown') 90
      if ($result.TimedOut) {
        [Console]::Error.WriteLine('error: WSL is not answering and did not stop within 90 seconds: restart Windows, which is the only way out of this state')
        return 4
      }
      Write-DmpOk 'WSL stopped; the logon task or the next wsl command starts the distro again'
    }
    'self-install' {
      $folder = Get-DmpInstallDir
      Write-DmpOk "the helper in $folder ($(Install-DmpSelf $PSCommandPath $folder))"
    }
    'self-remove' {
      $folder = Get-DmpInstallDir
      Write-DmpOk "the helper's folder $folder ($(Remove-DmpSelf $folder))"
    }
  }
  return 0
}

# Dot-sourced (by the tests), it only defines its functions.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
  exit (Invoke-DmpCommand $Command $Arguments)
} catch [DmpInputError] {
  [Console]::Error.WriteLine("error: $($_.Exception.Message)")
  exit 2
} catch {
  [Console]::Error.WriteLine("error: $($_.Exception.Message)")
  exit 1
}
