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

-Distro picks another name than devmagic-panel (an Ubuntu you have, to install
into it). The helper dmp-win.ps1 must be next to this script.
#>
[CmdletBinding()]
param(
  [string]$Distro = 'devmagic-panel',
  [string]$Release = '',
  [switch]$Uninstall,
  [switch]$Yes
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

function Write-DmpStep([string]$Text) { [Console]::Out.WriteLine("==> $Text") }
function Write-DmpWarn([string]$Text) { [Console]::Out.WriteLine("warn: $Text") }

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
function Invoke-DmpInDistro([string]$Name, [string[]]$Command, [switch]$Root, [int]$TimeoutSeconds = 60) {
  $list = @('-d', $Name)
  if ($Root) { $list += @('-u', 'root') }
  $list += @('--exec') + $Command
  return Invoke-DmpWsl $list $TimeoutSeconds
}

# A command in its own console window, for the steps where you type (passwords).
function Start-DmpConsole([string[]]$ArgumentList) {
  $process = Start-Process -FilePath (Get-DmpWslExe) -ArgumentList $ArgumentList -Wait -PassThru
  return $process.ExitCode
}

# --- the steps ---

function Assert-DmpWindows() {
  Write-DmpStep 'Checking Windows'
  $windows = Get-DmpWindows
  $problem = Test-DmpWindows $windows
  if ($problem) { throw $problem }
  Write-DmpOk "$($windows.Name), build $($windows.Build), x64"
  if (-not (Test-DmpAdmin)) {
    $groups = [Security.Principal.WindowsIdentity]::GetCurrent().Groups | ForEach-Object { $_.Value }
    if ($groups -notcontains 'S-1-5-32-544') { Write-DmpWarn 'you are not an administrator: Windows asks for an admin password at the steps that need one' }
  }
  $uac = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue
  if ($uac -and $uac.ConsentPromptBehaviorAdmin -eq 0) {
    Write-DmpWarn "UAC is set to never notify: every program you run gets admin rights without asking, WSL's included. The panel works either way; the default UAC level keeps that boundary"
  }
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($env:LOCALAPPDATA))
  if ($drive.AvailableFreeSpace -lt 10GB) { throw "the distro needs about 10 GB on $($drive.Name), which has $([math]::Round($drive.AvailableFreeSpace / 1GB, 1)) GB free" }
}

function Assert-DmpWsl() {
  Write-DmpStep 'Checking WSL'
  $status = Invoke-DmpProgram (Get-DmpWslExe) @('--status') 30
  if ($status.TimedOut) { throw "WSL is not answering: run 'dmp-win.ps1 wsl-restart', or restart Windows" }
  if ($status.ExitCode -ne 0) {
    Write-DmpStep 'Turning WSL on (Windows asks with UAC; a restart of Windows follows)'
    $code = Invoke-DmpElevatedProgram (Get-DmpWslExe) @('--install', '--no-distribution')
    if ($code -ne 0) { throw "wsl --install did not finish (exit $code): run it yourself in an admin PowerShell" }
    throw 'WSL is on: restart Windows, then run this script again'
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
    return
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
function Assert-DmpLinuxUser([string]$Name) {
  $user = (Invoke-DmpInDistro $Name @('sh', '-c', 'getent passwd 1000 | cut -d: -f1')).Output.Trim()
  if ($user) { Write-DmpOk "Linux user $user"; return $user }
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
function Install-DmpPanel([string]$Name, [string]$ReleasePath) {
  $installed = (Invoke-DmpInDistro $Name @('sh', '-c', 'test -f /etc/devmagic-panel/config.env && echo yes')).Output.Trim()
  if ($installed -eq 'yes' -and -not $ReleasePath) { Write-DmpOk 'the panel is installed in the distro (updates come from its Updates page)'; return }
  Write-DmpStep 'Installing the panel in the distro: a window opens for your Linux password, then the panel password'
  if ($ReleasePath) {
    $full = (Resolve-Path -LiteralPath $ReleasePath).Path
    if ($full -notmatch '\.tar\.gz$') { throw "-Release takes a release package, devmagic-panel-<version>.tar.gz: $full" }
    $linux = (Invoke-DmpInDistro $Name @('wslpath', '-a', $full)).Output.Trim()
    $script = 'set -e; d=$(mktemp -d); tar -xzf "$1" -C "$d"; "$d"/devmagic-panel-*/install.sh --yes; ~/.local/share/devmagic-panel/node/current/bin/node ~/.local/share/devmagic-panel/current/server/dist/cli.js setup'
    $code = Start-DmpConsole @('-d', $Name, '--exec', 'bash', '-lc', $script, 'install', $linux)
  } else {
    $script = 'set -e; d=$(mktemp -d); curl -fsSL -o "$d/get.sh" "$1"; bash "$d/get.sh" --yes; ~/.local/share/devmagic-panel/node/current/bin/node ~/.local/share/devmagic-panel/current/server/dist/cli.js setup'
    $code = Start-DmpConsole @('-d', $Name, '--exec', 'bash', '-lc', $script, 'install', $script:Manifest.GetShUrl)
  }
  if ($code -ne 0) { throw "the panel's installer did not finish (exit $code): its log is in ~/.local/state/devmagic-panel/logs in the distro; run this script again" }
  Write-DmpOk 'the panel is installed in the distro'
}

# The Windows side, through the helper: hosts line (UAC), the CA, the logon task.
function Install-DmpWindowsSide([string]$Name) {
  New-Item -Path $script:SettingsKey -Force | Out-Null
  Set-ItemProperty -Path $script:SettingsKey -Name Distro -Value $Name
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $run = { param([string[]]$a) & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:Helper @a; return $LASTEXITCODE }

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
    0 { }
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

function Uninstall-DmpPanel([string]$Name, [switch]$KeepDistro) {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Write-DmpStep "Removing the Windows side: hosts block (UAC), the logon task, the panel's CA"
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:Helper hosts-sync
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:Helper autostart-remove
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:Helper ca-untrust
  $distros = @(ConvertFrom-DmpWslList (Invoke-DmpWsl @('--list', '--verbose')).Output)
  if (-not ($distros | Where-Object { $_.Name -eq $Name })) { Write-DmpOk "no distro $Name"; Remove-Item -Path $script:SettingsKey -Recurse -Force -ErrorAction SilentlyContinue; return }
  if ($Name -ne 'devmagic-panel') {
    Write-DmpOk "$Name is your own distro and stays: run ~/.local/share/devmagic-panel/current/install.sh --uninstall in it to remove the panel there"
  } else {
    $answer = if ($KeepDistro) { 'no' } else { Read-Host "Remove the distro $Name with its sites and databases? A copy is exported first. Type its name to remove it" }
    if ($answer -ceq $Name) {
      $export = Join-Path $script:DataDir ("$Name-{0}.tar" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
      Write-DmpStep "Exporting $Name to $export"
      $result = Invoke-DmpWsl @('--export', $Name, $export) 3600
      if ($result.ExitCode -ne 0) { throw "the export failed, so $Name stays: $($result.Error.Trim())" }
      Invoke-DmpWsl @('--unregister', $Name) 300 | Out-Null
      Write-DmpOk "$Name removed; its copy is $export (wsl --import brings it back)"
    } else {
      Write-DmpOk "$Name stays"
    }
  }
  Remove-Item -Path $script:SettingsKey -Recurse -Force -ErrorAction SilentlyContinue
}

# Dot-sourced (by the tests), it only defines its functions.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
  if ($Distro -cnotmatch '^[A-Za-z0-9._-]{1,64}$') { throw "not a distro name: '$Distro'" }
  if ($Uninstall) { Uninstall-DmpPanel $Distro -KeepDistro:$Yes; exit 0 }
  Assert-DmpWindows
  Assert-DmpWsl
  Assert-DmpPortFree
  Install-DmpDistro $Distro
  Assert-DmpSystemd $Distro
  [void](Assert-DmpLinuxUser $Distro)
  Install-DmpPanel $Distro $Release
  Install-DmpWindowsSide $Distro
  Test-DmpPanel
  Write-DmpOk "devmagic-panel runs in ${Distro}: https://local.devmagic"
  exit 0
} catch {
  [Console]::Error.WriteLine("error: $($_.Exception.Message)")
  exit 1
}
