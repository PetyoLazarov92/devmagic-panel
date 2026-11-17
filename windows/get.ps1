#Requires -Version 5.1
<#
get.ps1: installs devmagic-panel on Windows, inside WSL 2.

The panel runs in a Linux distro as on Ubuntu; this script does what Windows
needs around it, step by step, each with a check first and what to do when it
fails (plan section 4). It runs as you; the steps that need admin ask with UAC
one at a time. Run again, it skips what is in place, so it also repairs.

  powershell -ExecutionPolicy Bypass -File get.ps1                 install, or repair
  powershell -ExecutionPolicy Bypass -File get.ps1 -Release <tgz>  install that release package
  powershell -ExecutionPolicy Bypass -File get.ps1 -Uninstall      remove the Windows side and, when
                                                                   you confirm, the distro
  ... -Uninstall -RemoveDistro [-NoBackup]                         remove the distro too, without a
                                                                   question; -NoBackup skips its copy

Exit codes: 0 done, 1 failed, 10 WSL was just turned on and Windows needs a restart
(then run it again; the Windows setup offers the restart and starts itself again after it).

-Distro picks another name than devmagic-panel (an Ubuntu you have, to install
into it). The helper dmp-win.ps1 must be next to this script.

The Windows setup (installer\devmagic-panel.iss) asks its questions in its own
window and runs this script hidden, showing its output as it comes:
  -Probe          read only: what is in place, as JSON (WSL, the distro, its user,
                  whether a panel password is set), so the setup asks only what it needs
  -Answers <file> its answers, from a file only you can read, deleted once read:
                  linux-user=, linux-password=, panel-password= or keep-panel-password=yes
  -TurnOnWsl [-FirmwareRestart]
                  when virtualization is off: turns WSL on and, with -FirmwareRestart,
                  restarts Windows into its BIOS/UEFI setup, with one UAC prompt, so one
                  restart does both. Exit 0 nothing to do, 10 WSL turned on (restart
                  needed), 11 Windows restarts into the firmware setup in 30 seconds,
                  12 this computer cannot restart into it (restart it yourself)
With -Answers or -Yes nothing opens a window or asks: the Linux user is made as
root, install.sh runs with a sudo rule that is removed again when it ends, and the
panel's setup takes the password on stdin. -Yes alone (a silent update) keeps the
Linux user and the panel password; a fresh install needs the setup's questions.
#>
[CmdletBinding()]
param(
  [string]$Distro = 'devmagic-panel',
  [string]$Release = '',
  [switch]$Uninstall,
  [switch]$Yes,
  [switch]$Probe,
  [string]$Answers = '',
  [switch]$RemoveDistro,
  [switch]$NoBackup,
  [switch]$TurnOnWsl,
  [switch]$FirmwareRestart
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The release this script knows: the Ubuntu image and the WSL it needs. A new
# image is a new release of the panel, with its checksum from Canonical's SHA256SUMS.
$script:Manifest = @{
  ImageUrl    = 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl'
  ImageSha256 = 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'
  MinWsl      = [version]'2.1.5'
  GetShUrl    = 'https://github.com/PetyoLazarov92/devmagic-panel/releases/latest/download/get.sh'
  MinBuild10  = 19045
  MinBuild11  = 22631
}
$script:Here = Split-Path -Parent $PSCommandPath
$script:Helper = Join-Path $script:Here 'dmp-win.ps1'
$script:DataDir = Join-Path $env:LOCALAPPDATA 'devmagic-panel'
$script:SettingsKey = 'HKCU:\Software\devmagic-panel'

# Invoke-DmpProgram, Test-DmpAdmin and the rest come from the helper.
if (-not (Test-Path -LiteralPath $script:Helper)) { throw "dmp-win.ps1 is not next to get.ps1 in $($script:Here)" }
. $script:Helper

# Every run keeps a log in DataDir\logs (what it did, what Windows and WSL said), so a
# problem after the window closed can still be read; a log that cannot be written is skipped.
$script:LogFile = $null
function Write-DmpLog([string]$Text) {
  if (-not $script:LogFile) { return }
  try { [IO.File]::AppendAllText($script:LogFile, ('{0} {1}{2}' -f (Get-Date -Format 'HH:mm:ss'), $Text, [Environment]::NewLine)) } catch { $script:LogFile = $null }
}
function Start-DmpLog([string]$Mode) {
  try {
    $dir = Join-Path $script:DataDir 'logs'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $script:LogFile = Join-Path $dir ('get-{0}-{1}.log' -f $Mode, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Write-DmpLog "get.ps1 $Mode as $([Security.Principal.WindowsIdentity]::GetCurrent().Name), PowerShell $($PSVersionTable.PSVersion), from $PSCommandPath"
  } catch { $script:LogFile = $null }
}

function Write-DmpStep([string]$Text) { [Console]::Out.WriteLine("==> $Text"); Write-DmpLog "==> $Text" }
function Write-DmpWarn([string]$Text) { [Console]::Out.WriteLine("warn: $Text"); Write-DmpLog "warn: $Text" }
# The helper's own, logged too.
function Write-DmpOk([string]$Text) { [Console]::Out.WriteLine("ok: $Text"); Write-DmpLog "ok: $Text" }

# The distro the helper works with, for this user; read back, since a key that is not there
# afterwards sends the helper to the default distro (devmagic-panel).
function Set-DmpSetting([string]$Name, [switch]$Created) {
  # Created: the setup made this distro, so its uninstall may offer to remove it (kept across repairs).
  $before = Get-ItemProperty -Path $script:SettingsKey -ErrorAction SilentlyContinue
  $wasCreated = $before -and ($before.PSObject.Properties.Name -contains 'Created') -and $before.Created -eq 1 -and $before.Distro -eq $Name
  New-Item -Path $script:SettingsKey -Force | Out-Null
  Set-ItemProperty -Path $script:SettingsKey -Name Distro -Value $Name
  if ($Created -or $wasCreated) { Set-ItemProperty -Path $script:SettingsKey -Name Created -Value 1 -Type DWord }
  $saved = (Get-ItemProperty -Path $script:SettingsKey -ErrorAction SilentlyContinue).Distro
  if ($saved -ne $Name) { Write-DmpWarn "the distro name did not stay in $($script:SettingsKey) (reads '$saved'): run this script again" }
  else { Write-DmpLog "settings: Distro = $Name in $($script:SettingsKey)" }
}

function Remove-DmpSetting() {
  Remove-Item -Path $script:SettingsKey -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -Path $script:SettingsKey) { Write-DmpWarn "$($script:SettingsKey) is still there: remove it in regedit if you do not reinstall" }
  else { Write-DmpLog "settings: $($script:SettingsKey) removed" }
}

# --- reading what Windows and WSL say ---

# Windows' build and processor, from the registry and the environment (no WMI).
function Get-DmpWindows() {
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  [pscustomobject]@{
    Build = [int]$cv.CurrentBuild
    Name  = if ([int]$cv.CurrentBuild -ge 22000) { 'Windows 11' } else { 'Windows 10' }
    Arch  = $env:PROCESSOR_ARCHITECTURE
  }
}

# Null when this Windows can run the panel, else why not.
function Test-DmpWindows($Windows) {
  if ($Windows.Arch -eq 'ARM64') { return 'Windows on ARM is not supported yet (it is planned)' }
  if ($Windows.Arch -ne 'AMD64') { return "a 64-bit Windows is needed (found $($Windows.Arch))" }
  $min = if ($Windows.Name -eq 'Windows 11') { $script:Manifest.MinBuild11 } else { $script:Manifest.MinBuild10 }
  if ($Windows.Build -lt $min) { return "$($Windows.Name) build $($Windows.Build) is too old: update Windows to build $min or newer (Windows Update)" }
  return $null
}

# The WSL version from `wsl --version` (WSL_UTF8 output), or null when WSL is
# not installed from the Store (an inbox WSL answers with its help instead).
function ConvertFrom-DmpWslVersion([string]$Output) {
  $line = ($Output -split "`r?`n") | Where-Object { $_ -match '^\s*WSL[^:]*:\s*([0-9]+(\.[0-9]+){1,3})' } | Select-Object -First 1
  if (-not $line) { return $null }
  [void]($line -match '([0-9]+(\.[0-9]+){1,3})')
  return [version]$Matches[1]
}

# Distros from `wsl --list --verbose`: name, state, WSL version, default.
function ConvertFrom-DmpWslList([string]$Output) {
  foreach ($line in ($Output -split "`r?`n") | Select-Object -Skip 1) {
    if (-not $line.Trim()) { continue }
    $default = $line.TrimStart().StartsWith('*')
    $fields = @($line.Trim().TrimStart('*').Trim() -split '\s+')
    if ($fields.Count -lt 3) { continue }
    [pscustomobject]@{ Name = $fields[0]; State = $fields[1]; Version = [int]$fields[2]; Default = $default }
  }
}

# Ports 80, 443 and 3306 held on Windows by a program other than WSL's relay,
# from netstat -ano and tasklist's names by PID (both without WMI).
function Get-DmpPortHolder([string]$Netstat, [hashtable]$Names) {
  foreach ($line in ($Netstat -split "`r?`n")) {
    if ($line -notmatch '^\s*TCP\s+(\S+):(80|443|3306)\s+\S+\s+LISTENING\s+(\d+)') { continue }
    $name = $Names[[int]$Matches[3]]
    if ($name -match '^(wslrelay|wslhost|wslservice|vmmem|vmmemWSL)(\.exe)?$') { continue }
    [pscustomobject]@{ Address = $Matches[1]; Port = [int]$Matches[2]; Pid = [int]$Matches[3]; Program = $name }
  }
}

# True when .wslconfig turns localhost forwarding off, which the panel needs.
function Test-DmpForwardingOff([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $section = ''
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $t = $line.Trim()
    if ($t -match '^\[(.+)\]$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
    if ($section -eq 'wsl2' -and $t -match '^localhostForwarding\s*=\s*false\s*$') { return $true }
  }
  return $false
}

function Get-DmpFileSha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $stream.Close() }
}

# --- running wsl.exe, always with a time limit (WSL can hang, finding H) ---

function Get-DmpWslExe() { Join-Path $env:SystemRoot 'System32\wsl.exe' }

function Invoke-DmpWsl([string[]]$ArgumentList, [int]$TimeoutSeconds = 30) {
  $result = Invoke-DmpProgram (Get-DmpWslExe) $ArgumentList $TimeoutSeconds
  if ($result.TimedOut) { throw "WSL is not answering (wsl $($ArgumentList -join ' ') ran out of time): run 'dmp-win.ps1 wsl-restart', or restart Windows" }
  return $result
}

# A command in the distro as root, or as its default user; its output.
function Invoke-DmpInDistro([string]$Name, [string[]]$Command, [switch]$Root, [int]$TimeoutSeconds = 60, [string]$User = '') {
  $list = @('-d', $Name)
  if ($Root) { $list += @('-u', 'root') } elseif ($User) { $list += @('-u', $User) }
  $list += @('--exec') + $Command
  return Invoke-DmpWsl $list $TimeoutSeconds
}

# A command in its own console window, for the steps where you type (passwords).
# One quoted command line: Start-Process joins an array with plain spaces, which
# would hand bash -lc only the first word of a script.
function Start-DmpConsole([string[]]$ArgumentList) {
  $process = Start-Process -FilePath (Get-DmpWslExe) -ArgumentList (Join-DmpArgumentList $ArgumentList) -Wait -PassThru
  return $process.ExitCode
}

# --- the steps ---

function Assert-DmpWindows() {
  Write-DmpStep 'Checking Windows'
  $windows = Get-DmpWindows
  $problem = Test-DmpWindows $windows
  if ($problem) { throw $problem }
  Write-DmpOk "$($windows.Name), build $($windows.Build), x64"
  if (-not (Test-DmpAdminAccount)) {
    Write-DmpWarn 'you are not an administrator: Windows asks for an admin password at the steps that need one'
  }
  $uac = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue
  if ($uac -and $uac.ConsentPromptBehaviorAdmin -eq 0) {
    Write-DmpOk 'UAC is set to never notify: the admin steps below run without asking'
  }
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($env:LOCALAPPDATA))
  if ($drive.AvailableFreeSpace -lt 10GB) { throw "the distro needs about 10 GB on $($drive.Name), which has $([math]::Round($drive.AvailableFreeSpace / 1GB, 1)) GB free" }
}

# Virtualization: WSL 2 runs a small virtual machine, which needs Intel VT-x or AMD-V
# turned on in the computer's firmware (BIOS/UEFI). A hypervisor that runs already (WSL 2
# or Hyper-V on) means it is on; Windows then reports the firmware flag as off, so that
# flag only counts without one.
function Test-DmpVirtualization($HypervisorPresent, $FirmwareEnabled) {
  if ($HypervisorPresent -eq $true) { return 'on' }
  if ($FirmwareEnabled -eq $true) { return 'on' }
  if ($FirmwareEnabled -eq $false) { return 'off' }
  return 'unknown'
}

# on, off, or unknown when Windows does not say in time (WMI can hang, finding H).
function Get-DmpVirtualization() {
  try {
    $system = Get-CimInstance -ClassName Win32_ComputerSystem -OperationTimeoutSec 15 -ErrorAction Stop
    if ($system.HypervisorPresent) { return 'on' }
    $cpu = Get-CimInstance -ClassName Win32_Processor -OperationTimeoutSec 15 -ErrorAction Stop | Select-Object -First 1
    return Test-DmpVirtualization $system.HypervisorPresent $cpu.VirtualizationFirmwareEnabled
  } catch {
    Write-DmpLog "virtualization: Windows did not say ($($_.Exception.Message))"
    return 'unknown'
  }
}

$script:VirtualizationSteps = 'Virtualization is off in this computer''s firmware, and WSL 2 needs it. Turn it on: restart the computer, open its BIOS/UEFI setup ' +
  '(the key shows at power-on, often F2, F10, Del or Esc), turn on "Intel Virtualization Technology" (VT-x) or "SVM Mode" (AMD), save and start Windows, ' +
  'then run the setup again. Task Manager, Performance, CPU then shows "Virtualization: Enabled".'

function Assert-DmpVirtualization() {
  $state = Get-DmpVirtualization
  if ($state -eq 'off') { throw [DmpInputError]::new($script:VirtualizationSteps) }
  if ($state -eq 'on') { Write-DmpOk 'virtualization is on' }
  else { Write-DmpWarn 'Windows did not say whether virtualization is on; going on (if WSL then fails with 0x80370102, it is off in the BIOS/UEFI)' }
}

# Virtualization off: the setup turns WSL on before the restart that turns
# virtualization on, so one restart does both. One UAC prompt covers the two:
# wsl --install when WSL is off and, when asked, a restart into the firmware
# setup (shutdown /fw: UEFI computers that offer it).
$script:FirmwareRestartSeconds = 30

# The elevated PowerShell's script: exit 20 when wsl --install failed, 21 when
# this computer cannot restart into its firmware setup, 0 when all went.
function Get-DmpTurnOnWslScript([bool]$WslOff, [bool]$Firmware) {
  $lines = @()
  if ($WslOff) {
    $lines += "& '$(Get-DmpWslExe)' --install --no-distribution"
    $lines += 'if ($LASTEXITCODE -ne 0) { exit 20 }'
  }
  if ($Firmware) {
    $shutdown = Join-Path $env:SystemRoot 'System32\shutdown.exe'
    $lines += "& '$shutdown' /r /fw /t $($script:FirmwareRestartSeconds) /c 'devmagic-panel setup: Windows restarts into the BIOS/UEFI setup. Turn virtualization on there, save, and sign in again: the setup goes on by itself.'"
    $lines += 'if ($LASTEXITCODE -ne 0) { exit 21 }'
  }
  $lines += 'exit 0'
  return ($lines -join "`n")
}

# -TurnOnWsl: what the setup does when virtualization is off. Returns get.ps1's exit code.
function Invoke-DmpTurnOnWsl([switch]$Firmware) {
  Write-DmpStep 'Checking WSL'
  $status = Invoke-DmpProgram (Get-DmpWslExe) @('--status') 30
  # Not answering in time: WSL is there, so it is not installed again.
  $wslOff = (-not $status.TimedOut) -and ($status.ExitCode -ne 0)
  if (-not $wslOff -and -not $Firmware) { Write-DmpOk 'WSL is on already'; return 0 }
  if ($wslOff) { Write-DmpStep 'Turning WSL on (Windows asks with UAC)' } else { Write-DmpOk 'WSL is on already' }
  if ($Firmware) { Write-DmpStep "Restarting Windows into its BIOS/UEFI setup in $($script:FirmwareRestartSeconds) seconds" }
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Get-DmpTurnOnWslScript $wslOff $Firmware.IsPresent)))
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $code = Invoke-DmpElevatedProgram $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
  if ($code -eq 3) { throw [DmpInputError]::new('UAC was declined, so nothing changed: run the setup again and allow it') }
  if ($code -eq 20) { throw 'wsl --install did not finish: run wsl --install --no-distribution yourself in an admin PowerShell' }
  if ($code -eq 21) {
    Write-DmpWarn 'this computer does not offer a restart into its firmware setup: restart it yourself and press the setup key at power-on'
    return 12
  }
  if ($code -ne 0) { throw "the step with UAC ended with exit $code" }
  if ($Firmware) { Write-DmpOk 'Windows restarts into its BIOS/UEFI setup'; return 11 }
  Write-DmpOk 'WSL is on; Windows needs a restart before it works'
  return 10
}

# True when WSL was just turned on and Windows needs a restart before it works.
function Assert-DmpWsl() {
  Write-DmpStep 'Checking WSL'
  $status = Invoke-DmpProgram (Get-DmpWslExe) @('--status') 30
  if ($status.TimedOut) { throw "WSL is not answering: run 'dmp-win.ps1 wsl-restart', or restart Windows" }
  if ($status.ExitCode -ne 0) {
    Write-DmpStep 'Turning WSL on (Windows asks with UAC; a restart of Windows follows)'
    $code = Invoke-DmpElevatedProgram (Get-DmpWslExe) @('--install', '--no-distribution')
    if ($code -eq 3) { throw [DmpInputError]::new('UAC was declined, so WSL is still off: run the setup again and allow it') }
    if ($code -ne 0) { throw "wsl --install did not finish (exit $code): run it yourself in an admin PowerShell" }
    Write-DmpOk 'WSL is on; Windows needs a restart before it works'
    return $true
  }
  $version = ConvertFrom-DmpWslVersion (Invoke-DmpWsl @('--version')).Output
  if (-not $version -or $version -lt $script:Manifest.MinWsl) {
    Write-DmpStep "Updating WSL (found $version, the panel needs $($script:Manifest.MinWsl) or newer)"
    $update = Invoke-DmpWsl @('--update', '--web-download') 600
    if ($update.ExitCode -ne 0) { throw "wsl --update failed: $($update.Output.Trim()) $($update.Error.Trim())" }
    $version = ConvertFrom-DmpWslVersion (Invoke-DmpWsl @('--version')).Output
  }
  Write-DmpOk "WSL $version"
  if (Test-DmpForwardingOff (Join-Path $env:USERPROFILE '.wslconfig')) {
    Write-DmpWarn 'localhostForwarding = false in your .wslconfig: Windows cannot reach the panel until you take that line out (this script never changes .wslconfig)'
  }
  return $false
}

function Assert-DmpPortFree() {
  $netstat = (Invoke-DmpProgram (Join-Path $env:SystemRoot 'System32\NETSTAT.EXE') @('-ano', '-p', 'TCP') 15).Output
  $names = @{}
  foreach ($process in Get-Process) { $names[$process.Id] = $process.ProcessName }
  $holders = @(Get-DmpPortHolder $netstat $names)
  foreach ($holder in $holders) {
    Write-DmpWarn "$($holder.Program) (PID $($holder.Pid)) holds port $($holder.Port) on Windows: sites cannot be reached there until it lets go (IIS, XAMPP or another stack?)"
  }
}

# The distro: kept when it is there, else imported from Canonical's image with
# its checksum checked, the default distro put back as it was.
function Install-DmpDistro([string]$Name) {
  Write-DmpStep "The distro $Name"
  $list = Invoke-DmpWsl @('--list', '--verbose')
  $distros = @(ConvertFrom-DmpWslList $list.Output)
  $found = $distros | Where-Object { $_.Name -eq $Name }
  if ($found) {
    if ($found.Version -ne 2) { throw "$Name is a WSL 1 distro: run wsl --set-version $Name 2 (it can take a while), then this script again" }
    Write-DmpOk "$Name is there (WSL 2, $($found.State))"
    return $false
  }
  $default = $distros | Where-Object { $_.Default } | Select-Object -First 1
  $images = Join-Path $script:DataDir 'images'
  $image = Join-Path $images ([IO.Path]::GetFileName($script:Manifest.ImageUrl))
  New-Item -ItemType Directory -Force -Path $images | Out-Null
  if (-not (Test-Path -LiteralPath $image) -or (Get-DmpFileSha256 $image) -ne $script:Manifest.ImageSha256) {
    Write-DmpStep "Downloading Ubuntu 24.04 for WSL from $($script:Manifest.ImageUrl) (about 390 MB)"
    $part = "$image.part"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    (New-Object Net.WebClient).DownloadFile($script:Manifest.ImageUrl, $part)
    $sum = Get-DmpFileSha256 $part
    if ($sum -ne $script:Manifest.ImageSha256) { Remove-Item -LiteralPath $part -Force; throw "the download's SHA-256 is $sum, not $($script:Manifest.ImageSha256): nothing was imported" }
    Move-Item -LiteralPath $part -Destination $image -Force
  }
  Write-DmpOk "image checked: SHA-256 $($script:Manifest.ImageSha256)"
  $location = Join-Path $script:DataDir "wsl\$Name"
  New-Item -ItemType Directory -Force -Path $location | Out-Null
  $import = Invoke-DmpWsl @('--import', $Name, $location, $image, '--version', '2') 600
  if ($import.ExitCode -ne 0) { throw "wsl --import failed: $($import.Output.Trim()) $($import.Error.Trim())" }
  if ($default -and $default.Name -ne $Name) { Invoke-DmpWsl @('--set-default', $default.Name) | Out-Null }
  Write-DmpOk "$Name imported into $location"
  return $true
}

function Assert-DmpSystemd([string]$Name) {
  $init = (Invoke-DmpInDistro $Name @('cat', '/proc/1/comm') -Root).Output.Trim()
  if ($init -eq 'systemd') { Write-DmpOk 'systemd runs in the distro'; return }
  Write-DmpStep 'Turning systemd on in the distro ([boot] systemd=true in /etc/wsl.conf)'
  $fix = Invoke-DmpInDistro $Name @('sh', '-c', 'grep -q "^systemd=true" /etc/wsl.conf 2>/dev/null || printf "\n[boot]\nsystemd=true\n" >> /etc/wsl.conf') -Root
  if ($fix.ExitCode -ne 0) { throw "could not write /etc/wsl.conf: $($fix.Error.Trim())" }
  Invoke-DmpWsl @('--terminate', $Name) | Out-Null
  $init = (Invoke-DmpInDistro $Name @('cat', '/proc/1/comm') -Root).Output.Trim()
  if ($init -ne 'systemd') { throw "systemd still does not run in $Name (PID 1 is $init): update WSL, then run this script again" }
  Write-DmpOk 'systemd runs in the distro'
}

# The default user: Ubuntu's own first-run script, in a window where you type
# the name and password. This script never sees the password.
# --- without questions (the Windows setup's answers, or -Yes) ---

$script:Quiet = $false
$script:CreatedDistro = $false
$script:Answered = @{}

# The setup's answers, from its file, which goes as soon as it is read: a password
# never stays on disk longer than this, and never comes on a command line.
function Read-DmpAnswerFile([string]$Path) {
  $answers = @{}
  try {
    foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
      $at = $line.IndexOf('=')
      if ($at -gt 0) { $answers[$line.Substring(0, $at)] = $line.Substring($at + 1) }
    }
  } finally { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
  if ($answers.ContainsKey('linux-user') -and $answers['linux-user'] -cnotmatch '^[a-z_][a-z0-9_-]{0,31}$') {
    throw [DmpInputError]::new("not a Linux user name: '$($answers['linux-user'])' (lowercase letters, digits, _ and -, starting with a letter or _)")
  }
  return $answers
}

# wsl.exe with text on its stdin (a password), never on its command line. With
# -Passthrough what it prints goes straight to this script's own output as it
# comes, so the Windows setup shows the install in its Details box while it runs.
function Invoke-DmpWslInput([string[]]$ArgumentList, [string]$InputText, [int]$TimeoutSeconds = 60, [switch]$Passthrough) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = Get-DmpWslExe
  $info.Arguments = Join-DmpArgumentList $ArgumentList
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = -not $Passthrough
  $info.RedirectStandardError = -not $Passthrough
  $info.EnvironmentVariables['WSL_UTF8'] = '1'
  $process = [Diagnostics.Process]::Start($info)
  $out = $null
  $err = $null
  if (-not $Passthrough) {
    $out = $process.StandardOutput.ReadToEndAsync()
    $err = $process.StandardError.ReadToEndAsync()
  }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($InputText)
  $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $process.StandardInput.Close()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch { Write-Verbose "the program ended as it was stopped: $($_.Exception.Message)" }
    return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = ''; Error = '' }
  }
  [pscustomobject]@{ TimedOut = $false; ExitCode = $process.ExitCode; Output = $(if ($out) { $out.Result } else { '' }); Error = $(if ($err) { $err.Result } else { '' }) }
}

# The Linux user as Ubuntu's own first-run script makes it (adduser, the groups
# adm cdrom sudo dip plugdev, the default user in wsl.conf), as root, without a window.
# The account comes as the setup wrote it (user, password): plain text from its file, to stdin only.
function New-DmpLinuxUser([string]$Name, [hashtable]$Account) {
  $User = $Account.user
  $secret = $Account.secret
  Write-DmpStep "Making your Linux user $User"
  if (-not $secret) { throw [DmpInputError]::new('no password for the Linux user: run the setup again') }
  $add = Invoke-DmpInDistro $Name @('sh', '-c', '/usr/sbin/adduser --quiet --disabled-password --gecos "" "$1" && /usr/sbin/usermod -aG adm,cdrom,sudo,dip,plugdev "$1"', 'adduser', $User) -Root
  if ($add.ExitCode -ne 0) { throw "could not make the Linux user ${User}: $(($add.Error + $add.Output).Trim())" }
  $set = Invoke-DmpWslInput @('-d', $Name, '-u', 'root', '--exec', '/usr/sbin/chpasswd') "${User}:$secret`n"
  if ($set.TimedOut -or $set.ExitCode -ne 0) { throw "could not set the password of ${User}: $(($set.Error + $set.Output).Trim())" }
  $default = 'f=/etc/wsl.conf; touch "$f"; if ! grep -q "^\[user\]" "$f"; then printf "\n[user]\ndefault=%s\n" "$1" >> "$f"; elif ! sed -n "/^\[user\]/,/^\[/{/^[[:space:]]*default[[:space:]]*=/p}" "$f" | grep -q .; then sed -i "/^\[user\]/a default=$1" "$f"; fi'
  $conf = Invoke-DmpInDistro $Name @('sh', '-c', $default, 'default-user', $User) -Root
  if ($conf.ExitCode -ne 0) { throw "could not make $User the default user in /etc/wsl.conf: $(($conf.Error + $conf.Output).Trim())" }
  # The default user applies from the next start.
  Invoke-DmpWsl @('--terminate', $Name) | Out-Null
}

# The setup's own distro: devmagic-panel, or one it made under another name
# (Created in its settings). Only those may an uninstall remove.
function Test-DmpOwnDistro([string]$Name) {
  if ($Name -eq 'devmagic-panel') { return $true }
  $settings = Get-ItemProperty -Path $script:SettingsKey -ErrorAction SilentlyContinue
  return [bool]($settings -and $settings.Distro -eq $Name -and ($settings.PSObject.Properties.Name -contains 'Created') -and $settings.Created -eq 1)
}

# The Ubuntu and Debian family, as install.sh takes it (os-release ID or ID_LIKE).
function Test-DmpOsFamily([string]$Id, [string]$Like) {
  return ($Id -eq 'ubuntu' -or $Id -eq 'debian' -or $Like -match '\b(ubuntu|debian)\b')
}

# A distro's os-release: ID, ID_LIKE and PRETTY_NAME.
function Get-DmpDistroRelease([string]$Name) {
  $fields = (Invoke-DmpInDistro $Name @('sh', '-c', '. /etc/os-release 2>/dev/null; printf "%s|%s|%s" "$ID" "$ID_LIKE" "$PRETTY_NAME"') -Root).Output.Trim() -split '\|', 3
  [pscustomobject]@{ Id = $fields[0]; Like = $(if ($fields.Count -gt 1) { $fields[1] } else { '' }); Pretty = $(if ($fields.Count -gt 2) { $fields[2] } else { '' }) }
}

function Assert-DmpDistroFamily([string]$Name) {
  $os = Get-DmpDistroRelease $Name
  if (-not (Test-DmpOsFamily $os.Id $os.Like)) { throw [DmpInputError]::new("$Name runs $(if ($os.Pretty) { $os.Pretty } else { 'an unknown system' }): the panel needs Ubuntu or Debian. Pick another distro, or let the setup make one") }
  Write-DmpOk "$Name runs $($os.Pretty)"
}

# Whether the panel has its password already, for -Yes and -Probe.
function Test-DmpPanelPassword([string]$Name, [string]$User) {
  if (-not $User) { return $false }
  $check = Invoke-DmpInDistro $Name @('sh', '-c', 'grep -qs panelPasswordHash "$HOME/.config/devmagic-panel/secrets.json" && echo yes') -User $User
  return $check.Output.Trim() -eq 'yes'
}

# -Probe: read only, what is in place, so the setup asks only what it needs.
function Get-DmpProbe([string]$Name) {
  $state = [ordered]@{ wsl = $false; distro = $false; user = ''; panelPassword = $false; virtualization = (Get-DmpVirtualization); distros = ''; os = ''; osOk = $false; panel = $false }
  $status = Invoke-DmpProgram (Get-DmpWslExe) @('--status') 30
  if ($status.TimedOut -or $status.ExitCode -ne 0) { return $state }
  $state.wsl = $true
  $distros = @(ConvertFrom-DmpWslList (Invoke-DmpWsl @('--list', '--verbose')).Output)
  # One string the setup's Pascal reads easily: name|WSL version|state, ; between distros; Docker's own left out.
  $state.distros = (@($distros | Where-Object { $_.Name -notlike 'docker-desktop*' } | ForEach-Object { '{0}|{1}|{2}' -f $_.Name, $_.Version, $_.State }) -join ';')
  $found = $distros | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
  if (-not $found) { return $state }
  $state.distro = $true
  if ($found.Version -ne 2) { return $state }
  $os = Get-DmpDistroRelease $Name
  $state.os = $os.Pretty
  $state.osOk = Test-DmpOsFamily $os.Id $os.Like
  $state.user = (Invoke-DmpInDistro $Name @('sh', '-c', 'getent passwd 1000 | cut -d: -f1')).Output.Trim()
  $state.panelPassword = Test-DmpPanelPassword $Name $state.user
  $state.panel = (Invoke-DmpInDistro $Name @('sh', '-c', 'test -f /etc/devmagic-panel/config.env && echo yes')).Output.Trim() -eq 'yes'
  return $state
}

function Assert-DmpLinuxUser([string]$Name) {
  $user = (Invoke-DmpInDistro $Name @('sh', '-c', 'getent passwd 1000 | cut -d: -f1')).Output.Trim()
  if ($user) { Write-DmpOk "Linux user $user"; return $user }
  if ($script:Quiet) {
    if (-not $script:Answered.ContainsKey('linux-user')) { throw [DmpInputError]::new('the distro has no Linux user yet: run the setup without /SILENT, it asks for one') }
    New-DmpLinuxUser $Name @{ user = $script:Answered['linux-user']; secret = $script:Answered['linux-password'] }
    $user = (Invoke-DmpInDistro $Name @('sh', '-c', 'getent passwd 1000 | cut -d: -f1')).Output.Trim()
    if ($user -ne $script:Answered['linux-user']) { throw "the Linux user is not there after making it (found '$user'): run the setup again" }
    Write-DmpOk "Linux user $user"
    return $user
  }
  Write-DmpStep 'Making your Linux user: a window opens where you type a name and a password'
  $code = Start-DmpConsole @('-d', $Name, '-u', 'root', '--exec', '/usr/lib/wsl/wsl-setup')
  if ($code -ne 0) { throw "making the Linux user did not finish (exit $code): run this script again" }
  Invoke-DmpWsl @('--terminate', $Name) | Out-Null
  $user = (Invoke-DmpInDistro $Name @('sh', '-c', 'getent passwd 1000 | cut -d: -f1')).Output.Trim()
  if (-not $user) { throw 'no Linux user after the first-run script: run this script again' }
  Write-DmpOk "Linux user $user"
  return $user
}

# The panel inside the distro, in a window: install.sh asks for your sudo
# password there, then the panel's setup asks for the panel password.
# The sudo rule for the length of a quiet install: WSL gives root to whoever can
# run wsl.exe anyway, so it opens nothing new; it goes again however the install ends.
$script:SudoersFile = '/etc/sudoers.d/zz-devmagic-panel-setup'

function Install-DmpPanelQuietly([string]$Name, [string]$User, [string]$ReleasePath) {
  $keep = $script:Answered['keep-panel-password'] -eq 'yes' -or (-not $script:Answered.ContainsKey('panel-password') -and (Test-DmpPanelPassword $Name $User))
  if (-not $keep -and -not $script:Answered['panel-password']) { throw [DmpInputError]::new('no panel password yet: run the setup without /SILENT, it asks for one') }
  Write-DmpStep 'Installing the panel in the distro'
  $grant = Invoke-DmpInDistro $Name @('sh', '-c', 'umask 0337; printf "%s ALL=(ALL:ALL) NOPASSWD: ALL\n" "$1" > "$2" && visudo -cqf "$2"', 'grant', $User, $script:SudoersFile) -Root
  if ($grant.ExitCode -ne 0) { throw "could not let the install use sudo without a password: $(($grant.Error + $grant.Output).Trim())" }
  try {
    $setup = if ($keep) { 'setup --yes --keep-password' } else { 'setup --yes' }
    $cli = '~/.local/share/devmagic-panel/node/current/bin/node --disable-warning=ExperimentalWarning ~/.local/share/devmagic-panel/current/server/dist/cli.js ' + $setup
    # The password is read first, so install.sh never sees it; the panel's setup gets it on its stdin.
    if ($ReleasePath) {
      $full = (Resolve-Path -LiteralPath $ReleasePath).Path
      if ($full -notmatch '\.tar\.gz$') { throw "-Release takes a release package, devmagic-panel-<version>.tar.gz: $full" }
      $source = (Invoke-DmpInDistro $Name @('wslpath', '-a', $full)).Output.Trim()
      $get = 'tar -xzf "$1" -C "$d"; "$d"/devmagic-panel-*/install.sh --yes </dev/null'
    } else {
      $source = $script:Manifest.GetShUrl
      $get = 'curl -fsSL -o "$d/get.sh" "$1"; bash "$d/get.sh" --yes </dev/null'
    }
    $script = 'set -e; IFS= read -r pw || true; d=$(mktemp -d); ' + $get + '; printf "%s\n" "$pw" | ' + $cli
    $panelPassword = if ($keep) { '' } else { $script:Answered['panel-password'] }
    $run = Invoke-DmpWslInput @('-d', $Name, '-u', $User, '--exec', 'bash', '-c', $script, 'install', $source) "$panelPassword`n" 3600 -Passthrough
  } finally {
    $revoke = Invoke-DmpInDistro $Name @('rm', '-f', $script:SudoersFile) -Root
    if ($revoke.ExitCode -ne 0) { Write-DmpWarn "the install's sudo rule $($script:SudoersFile) is still there: remove it with wsl -d $Name -u root rm $($script:SudoersFile)" }
  }
  if ($run.TimedOut) { throw "the panel's installer did not finish within an hour: its log is in ~/.local/state/devmagic-panel/logs in the distro; run the setup again" }
  if ($run.ExitCode -eq 3) { throw [DmpInputError]::new('the panel password was refused (the reason is above): run the setup again and pick another') }
  if ($run.ExitCode -ne 0) { throw "the panel's installer did not finish (exit $($run.ExitCode)): its log is in ~/.local/state/devmagic-panel/logs in the distro; run the setup again" }
  Write-DmpOk 'the panel is installed in the distro'
}

function Install-DmpPanel([string]$Name, [string]$ReleasePath, [string]$User = '') {
  $installed = (Invoke-DmpInDistro $Name @('sh', '-c', 'test -f /etc/devmagic-panel/config.env && echo yes')).Output.Trim()
  if ($installed -eq 'yes' -and -not $ReleasePath) { Write-DmpOk 'the panel is installed in the distro (updates come from its Updates page)'; return }
  if ($script:Quiet) { Install-DmpPanelQuietly $Name $User $ReleasePath; return }
  Write-DmpStep 'Installing the panel in the distro: a window opens for your Linux password, then the panel password'
  if ($ReleasePath) {
    $full = (Resolve-Path -LiteralPath $ReleasePath).Path
    if ($full -notmatch '\.tar\.gz$') { throw "-Release takes a release package, devmagic-panel-<version>.tar.gz: $full" }
    $linux = (Invoke-DmpInDistro $Name @('wslpath', '-a', $full)).Output.Trim()
    $script = 'set -e; d=$(mktemp -d); tar -xzf "$1" -C "$d"; "$d"/devmagic-panel-*/install.sh --yes; ~/.local/share/devmagic-panel/node/current/bin/node --disable-warning=ExperimentalWarning ~/.local/share/devmagic-panel/current/server/dist/cli.js setup'
    # bash -c, not a login shell: Ubuntu's ~/.bash_logout runs clear_console,
    # which fails in this window, and under set -e its 1 would replace the result.
    $code = Start-DmpConsole @('-d', $Name, '--exec', 'bash', '-c', $script, 'install', $linux)
  } else {
    $script = 'set -e; d=$(mktemp -d); curl -fsSL -o "$d/get.sh" "$1"; bash "$d/get.sh" --yes; ~/.local/share/devmagic-panel/node/current/bin/node --disable-warning=ExperimentalWarning ~/.local/share/devmagic-panel/current/server/dist/cli.js setup'
    $code = Start-DmpConsole @('-d', $Name, '--exec', 'bash', '-c', $script, 'install', $script:Manifest.GetShUrl)
  }
  if ($code -ne 0) { throw "the panel's installer did not finish (exit $code): its log is in ~/.local/state/devmagic-panel/logs in the distro; run this script again" }
  Write-DmpOk 'the panel is installed in the distro'
}

# The Windows side, through the helper: hosts line (UAC), the CA, the logon task.
# True when this account is an administrator, also while UAC runs it without
# admin rights: the Administrators group is then in the session as deny-only,
# which WindowsIdentity.Groups leaves out but its claims keep.
function Test-DmpAdminAccount() {
  $sids = [Security.Principal.WindowsIdentity]::GetCurrent().Claims | ForEach-Object { $_.Value }
  return @($sids) -contains 'S-1-5-32-544'
}

# One helper command, its output shown indented, its exit code returned (and
# nothing else, so the caller compares a number).
function Invoke-DmpHelper([string[]]$ArgumentList) {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $all = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script:Helper) + $ArgumentList
  # Long enough for you to answer UAC or Windows' CA question.
  $result = Invoke-DmpProgram $powershell $all 600
  foreach ($line in (($result.Output + $result.Error) -split "`r?`n")) { if ($line.Trim()) { [Console]::Out.WriteLine("   $line"); Write-DmpLog "   $line" } }
  Write-DmpLog "helper $($ArgumentList[0]): exit $(if ($result.TimedOut) { 'timed out' } else { $result.ExitCode })"
  if ($result.TimedOut) { return 1 }
  return [int]$result.ExitCode
}

# The helper where the panel calls it: Program Files, which only admins may
# change, so nothing running as you can alter it before it asks for UAC.
function Get-DmpHelperTarget() { Join-Path $env:ProgramFiles 'devmagic-panel' }

function Install-DmpHelperFile() {
  $target = Get-DmpHelperTarget
  $installed = Join-Path $target 'dmp-win.ps1'
  if ((Test-Path -LiteralPath $installed) -and (Get-DmpFileSha256 $installed) -eq (Get-DmpFileSha256 $script:Helper)) {
    Write-DmpOk "the helper is in $target"
    return $true
  }
  Write-DmpStep "Putting the helper in $target, where the panel calls it (Windows asks with UAC)"
  # The helper copies itself, elevated, with PowerShell's own Copy-Item: no other program needed.
  $code = Invoke-DmpHelper @('self-install')
  if ($code -eq 3) { Write-DmpWarn 'UAC was declined: the panel cannot do the Windows steps until you run this script again'; return $false }
  if ($code -ne 0 -or -not (Test-Path -LiteralPath $installed)) { Write-DmpWarn "the helper was not copied (exit $code)"; return $false }
  Write-DmpOk "the helper is in $target"
  return $true
}

function Install-DmpWindowsSide([string]$Name) {
  Set-DmpSetting $Name -Created:([bool]$script:CreatedDistro)
  [void](Install-DmpHelperFile)
  $run = { param([string[]]$a) Invoke-DmpHelper $a }

  Write-DmpStep 'Keeping the distro running while you are logged in (a logon task, no window)'
  if ((& $run @('autostart-install')) -ne 0) { Write-DmpWarn 'the logon task is not in place: the distro stops a few minutes after its last window; run this script again' }

  Write-DmpStep "Trusting the panel's local CA for your user (Windows asks you to confirm)"
  if ((& $run @('ca-trust')) -ne 0) { Write-DmpWarn 'the CA is not trusted: browsers warn about the panel until you run this script again and confirm' }

  Write-DmpStep "Adding the panel's name to Windows' hosts file (Windows asks with UAC)"
  $block = (Invoke-DmpInDistro $Name @('sh', '-c', 'sed -n "/^# BEGIN devmagic-panel/,/^# END devmagic-panel/p" /etc/hosts')).Output
  $pairs = @(foreach ($line in ($block -split "`r?`n")) {
      if ($line -match '^\s*(127\.0\.0\.[12])\s+(.+?)\s*$') { foreach ($n in ($Matches[2] -split '\s+')) { "$n=$($Matches[1])" } }
    })
  $code = & $run (@('hosts-sync') + $pairs)
  switch ($code) {
    0 { Write-DmpOk "Windows' hosts file has the distro's $($pairs.Count) name(s), one per line" }
    3 { Write-DmpWarn "UAC was declined: add the names by hand, or run this script again ($($pairs -join ', '))" }
    default { Write-DmpWarn "Windows' hosts file was not changed (exit $code)" }
  }
}

function Test-DmpPanel() {
  Write-DmpStep 'Checking the panel answers from Windows'
  try {
    $answer = Invoke-WebRequest -Uri 'https://local.devmagic/healthz' -UseBasicParsing -TimeoutSec 20
    Write-DmpOk "https://local.devmagic answers: $($answer.Content)"
  } catch {
    Write-DmpWarn "https://local.devmagic does not answer yet ($($_.Exception.Message)); right after the install it can take a minute. Run this script again to check and repair"
  }
}

# A program elevated (UAC), with an argument array; its exit code, 3 when declined.
function Invoke-DmpElevatedProgram([string]$File, [string[]]$ArgumentList) {
  try {
    return (Start-Process -FilePath $File -ArgumentList $ArgumentList -Verb RunAs -Wait -PassThru).ExitCode
  } catch [ComponentModel.Win32Exception] {
    if ($_.Exception.NativeErrorCode -eq 1223) { return 3 }
    throw
  }
}

# -RemoveDistro answers the question for the Windows uninstaller, which asks in its own
# dialog; -NoBackup removes the distro without exporting a copy of it first.
function Uninstall-DmpPanel([string]$Name, [switch]$KeepDistro, [switch]$RemoveDistro, [switch]$NoBackup) {
  Write-DmpStep "Removing the Windows side: hosts block and nginx's relays (UAC), the logon task, the panel's CA"
  foreach ($command in @('hosts-sync', 'portproxy-off', 'autostart-remove', 'ca-untrust', 'self-remove')) {
    $code = Invoke-DmpHelper @($command)
    if ($code -ne 0) { Write-DmpWarn "$command did not finish (exit $code)" }
  }
  $distros = @(ConvertFrom-DmpWslList (Invoke-DmpWsl @('--list', '--verbose')).Output)
  if (-not ($distros | Where-Object { $_.Name -eq $Name })) { Write-DmpOk "no distro $Name"; Remove-DmpSetting; return }
  if (-not (Test-DmpOwnDistro $Name)) {
    Write-DmpOk "$Name is your own distro and stays: run ~/.local/share/devmagic-panel/current/install.sh --uninstall in it to remove the panel there"
  } else {
    $answer = if ($RemoveDistro) { $Name } elseif ($KeepDistro) { 'no' } else { Read-Host "Remove the distro $Name with its sites and databases? A copy is exported first. Type its name to remove it" }
    if ($answer -ceq $Name) {
      $export = $null
      if (-not $NoBackup) {
        $export = Join-Path $script:DataDir ("$Name-{0}.tar" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Write-DmpStep "Exporting $Name to $export (a copy, in case you want it back)"
        $result = Invoke-DmpWsl @('--export', $Name, $export) 3600
        if ($result.ExitCode -ne 0) { throw "the export failed, so $Name stays: $($result.Error.Trim())" }
      }
      Write-DmpStep "Removing the distro $Name"
      $gone = Invoke-DmpWsl @('--unregister', $Name) 300
      if ($gone.ExitCode -ne 0) { throw "wsl --unregister $Name failed: $(($gone.Error + $gone.Output).Trim())" }
      # Its folder, empty once WSL took its disk away.
      $folder = Join-Path $script:DataDir "wsl\$Name"
      if ((Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Force)) { Remove-Item -LiteralPath $folder -Force }
      if ($export) { Write-DmpOk "$Name removed; its copy is $export (wsl --import brings it back)" }
      else { Write-DmpOk "$Name removed, with no copy kept" }
    } else {
      Write-DmpOk "$Name stays"
    }
  }
  Remove-DmpSetting
}

# Dot-sourced (by the tests), it only defines its functions.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
  if ($Distro -cnotmatch '^[A-Za-z0-9._-]{1,64}$') { throw "not a distro name: '$Distro'" }
  if ($Probe) { [Console]::Out.WriteLine((Get-DmpProbe $Distro | ConvertTo-Json -Compress)); exit 0 }
  if ($Answers) { $script:Answered = Read-DmpAnswerFile $Answers }
  $script:Quiet = [bool]$Answers -or [bool]$Yes
  Start-DmpLog $(if ($Uninstall) { 'uninstall' } elseif ($TurnOnWsl) { 'turn-on-wsl' } else { 'install' })
  Write-DmpLog "arguments: -Distro $Distro$(if ($Release) { " -Release $Release" })$(if ($Yes) { ' -Yes' })$(if ($RemoveDistro) { ' -RemoveDistro' })$(if ($NoBackup) { ' -NoBackup' })$(if ($TurnOnWsl) { ' -TurnOnWsl' })$(if ($FirmwareRestart) { ' -FirmwareRestart' })"
  if ($Uninstall) { Uninstall-DmpPanel $Distro -KeepDistro:$Yes -RemoveDistro:$RemoveDistro -NoBackup:$NoBackup; Write-DmpLog 'done'; exit 0 }
  if ($TurnOnWsl) { $code = Invoke-DmpTurnOnWsl -Firmware:$FirmwareRestart; Write-DmpLog "done (exit $code)"; exit $code }
  Assert-DmpWindows
  Assert-DmpVirtualization
  if (Assert-DmpWsl) {
    Write-DmpStep 'Restart Windows, then run the setup again: it goes on from here'
    Write-DmpLog 'restart needed'
    exit 10
  }
  Assert-DmpPortFree
  $script:CreatedDistro = Install-DmpDistro $Distro
  Assert-DmpDistroFamily $Distro
  Assert-DmpSystemd $Distro
  $linuxUser = Assert-DmpLinuxUser $Distro
  Install-DmpPanel $Distro $Release $linuxUser
  Install-DmpWindowsSide $Distro
  Test-DmpPanel
  # Once more at the end: the helper finds the distro by this key.
  $saved = (Get-ItemProperty -Path $script:SettingsKey -ErrorAction SilentlyContinue).Distro
  if ($saved -ne $Distro) { Write-DmpWarn "the distro name is gone from $($script:SettingsKey) (reads '$saved') since it was written: run this script again" }
  Write-DmpOk "devmagic-panel runs in ${Distro}: https://local.devmagic"
  exit 0
} catch {
  [Console]::Error.WriteLine("error: $($_.Exception.Message)")
  Write-DmpLog "error: $($_.Exception.Message)"
  if ($script:LogFile) { [Console]::Error.WriteLine("the log of this run: $($script:LogFile)") }
  exit 1
}
