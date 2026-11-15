# Pester 5 tests for windows/dmp-win.ps1. They never touch the real hosts file,
# the real trusted roots or Task Scheduler: hosts files are temp copies, the CA
# goes into the private store Cert:\CurrentUser\DevmagicTest, and programs and
# elevation are mocked.

BeforeAll {
  . "$PSScriptRoot/../dmp-win.ps1"
  $ErrorActionPreference = 'Stop'
  $script:TestStore = 'DevmagicTest'

  # A temp hosts file with your own lines, ending its lines with $Newline.
  function New-TestHostsFile([string]$Newline = "`r`n", [switch]$Bom, [string]$Extra = '') {
    $path = Join-Path ([IO.Path]::GetTempPath()) ("dmp-hosts-{0}" -f ([guid]::NewGuid().ToString('N')))
    $text = (@('# Copyright (c) Microsoft Corp.', '127.0.0.1 localhost', '10.0.0.5 nas.wandworks.test # by hand') -join $Newline) + $Newline + $Extra
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($Bom.IsPresent)))
    return $path
  }

  # A self-signed certificate written to a temp .cer file: the panel's CA by default.
  function New-TestCa([string]$Subject = 'CN=devmagic-panel Local CA (DESKTOP-TEST), O=devmagic-panel', [switch]$NotCa, [switch]$NoCertSign) {
    $key = [Security.Cryptography.RSA]::Create(2048)
    $request = New-Object Security.Cryptography.X509Certificates.CertificateRequest -ArgumentList $Subject, $key, ([Security.Cryptography.HashAlgorithmName]::SHA256), ([Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509BasicConstraintsExtension -ArgumentList (-not $NotCa), $false, 0, $true))
    $usage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    if (-not $NoCertSign) { $usage = $usage -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign }
    $request.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509KeyUsageExtension -ArgumentList $usage, $true))
    $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(1))
    $path = Join-Path ([IO.Path]::GetTempPath()) ("dmp-ca-{0}.cer" -f ([guid]::NewGuid().ToString('N')))
    [IO.File]::WriteAllBytes($path, $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    return $path
  }
}

AfterAll {
  # The private test store goes again.
  Remove-Item -Path "HKCU:\Software\Microsoft\SystemCertificates\$($script:TestStore)" -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Test-DmpLocalName' {
  # The list isLocalName and dmp_is_local_name check too, so all three copies agree.
  $cases = foreach ($line in [IO.File]::ReadAllLines((Join-Path $PSScriptRoot '../../shared/test/local-names.txt'))) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    @{ Want = $line.Substring(0, $line.IndexOf(' ')); Name = $line.Substring($line.IndexOf(' ') + 1) }
  }

  It 'has cases to check' -TestCases @(@{ Count = @($cases).Count }) {
    $Count | Should -BeGreaterThan 10
  }

  It '<Want>s <Name>' -TestCases $cases {
    Test-DmpLocalName $Name | Should -Be ($Want -eq 'accept')
  }
}

Describe 'ConvertFrom-DmpPair' {
  It 'reads name=ip pairs on the panel addresses' {
    $entries = @(ConvertFrom-DmpPair @('local.spellbook.example=127.0.0.1', 'local.wandworks-store.example=127.0.0.2'))
    $entries.Count | Should -Be 2
    $entries[1].Name | Should -Be 'local.wandworks-store.example'
    $entries[1].Address | Should -Be '127.0.0.2'
  }

  It 'refuses <Pair>' -TestCases @(
    @{ Pair = 'www.spellbook.example=127.0.0.1' }
    @{ Pair = 'local.shop.com=10.0.0.1' }
    @{ Pair = 'local.shop.com=::1' }
    @{ Pair = 'local.shop.com' }
    @{ Pair = 'local.shop.com=127.0.0.1=x' }
    @{ Pair = 'local.shop.com=127.0.0.1;calc' }
    @{ Pair = 'LOCAL.shop.com=127.0.0.1' }
    @{ Pair = '' }
  ) {
    { ConvertFrom-DmpPair @($Pair) } | Should -Throw -ExceptionType ([DmpInputError])
  }

  It 'refuses a name twice' {
    { ConvertFrom-DmpPair @('local.shop.com=127.0.0.1', 'local.shop.com=127.0.0.2') } | Should -Throw -ExceptionType ([DmpInputError])
  }
}

Describe 'Set-DmpHostsBlock' {
  It 'adds the block after your lines, one name per line, and keeps a copy first' {
    $backups = Join-Path ([IO.Path]::GetTempPath()) ("dmp-backups-{0}" -f ([guid]::NewGuid().ToString('N')))
    $hosts = New-TestHostsFile
    $before = [IO.File]::ReadAllText($hosts)
    Set-DmpHostsBlock -Path $hosts -Entries @(ConvertFrom-DmpPair @('local.spellbook.example=127.0.0.1', 'www.local.spellbook.example=127.0.0.1')) -BackupDir $backups
    $text = [IO.File]::ReadAllText($hosts)
    $text | Should -BeLike "$($before)`r`n# BEGIN devmagic-panel*`r`n127.0.0.1 local.spellbook.example`r`n127.0.0.1 www.local.spellbook.example`r`n# END devmagic-panel`r`n"
    @(Get-DmpHostsBlock $hosts) | Should -Be @('127.0.0.1 local.spellbook.example', '127.0.0.1 www.local.spellbook.example')
    $copies = @(Get-ChildItem $backups)
    $copies.Count | Should -Be 1
    [IO.File]::ReadAllText($copies[0].FullName) | Should -Be $before
  }

  It 'replaces the block it wrote, and removes it when no names are left' {
    $hosts = New-TestHostsFile
    $before = [IO.File]::ReadAllText($hosts)
    Set-DmpHostsBlock -Path $hosts -Entries @(ConvertFrom-DmpPair @('local.a.test=127.0.0.1', 'local.b.test=127.0.0.2')) -BackupDir ''
    Set-DmpHostsBlock -Path $hosts -Entries @(ConvertFrom-DmpPair @('local.b.test=127.0.0.2')) -BackupDir ''
    @(Get-DmpHostsBlock $hosts) | Should -Be @('127.0.0.2 local.b.test')
    ([regex]::Matches([IO.File]::ReadAllText($hosts), 'BEGIN devmagic-panel')).Count | Should -Be 1
    Set-DmpHostsBlock -Path $hosts -Entries @() -BackupDir ''
    [IO.File]::ReadAllText($hosts) | Should -Be $before
  }

  It 'takes over a block the spike or an older helper wrote, whatever its BEGIN line says' {
    $hosts = New-TestHostsFile -Extra "`r`n# BEGIN devmagic-panel`r`n::1 local.devmagic`r`n127.0.0.1 a1.spike.test a2.spike.test`r`n# END devmagic-panel`r`n"
    Set-DmpHostsBlock -Path $hosts -Entries @(ConvertFrom-DmpPair @('local.devmagic=127.0.0.1')) -BackupDir ''
    @(Get-DmpHostsBlock $hosts) | Should -Be @('127.0.0.1 local.devmagic')
    [IO.File]::ReadAllText($hosts) | Should -Not -Match 'spike'
  }

  It 'keeps LF line ends and a byte order mark as they were' {
    $hosts = New-TestHostsFile -Newline "`n" -Bom
    Set-DmpHostsBlock -Path $hosts -Entries @(ConvertFrom-DmpPair @('local.a.test=127.0.0.1')) -BackupDir ''
    $bytes = [IO.File]::ReadAllBytes($hosts)
    $bytes[0..2] | Should -Be @(0xEF, 0xBB, 0xBF)
    [Text.Encoding]::UTF8.GetString($bytes) | Should -Not -Match "`r"
  }

  It 'refuses a file with two blocks, or a BEGIN without an END, and changes nothing' {
    foreach ($extra in @("# BEGIN devmagic-panel`r`n# END devmagic-panel`r`n# BEGIN devmagic-panel`r`n# END devmagic-panel`r`n", "# BEGIN devmagic-panel`r`n127.0.0.1 local.a.test`r`n")) {
      $hosts = New-TestHostsFile -Extra $extra
      $before = [IO.File]::ReadAllText($hosts)
      { Set-DmpHostsBlock -Path $hosts -Entries @() -BackupDir '' } | Should -Throw '*fix it by hand*'
      [IO.File]::ReadAllText($hosts) | Should -Be $before
    }
  }

  It 'refuses a read-only hosts file' {
    $hosts = New-TestHostsFile
    Set-ItemProperty -LiteralPath $hosts -Name IsReadOnly -Value $true
    { Set-DmpHostsBlock -Path $hosts -Entries @() -BackupDir '' } | Should -Throw '*read-only*'
    Set-ItemProperty -LiteralPath $hosts -Name IsReadOnly -Value $false
  }
}

Describe 'the panel CA' {
  It 'accepts the panel CA, with or without the computer name, and checks its subject' {
    (Get-DmpCaCertificate (New-TestCa)).Subject | Should -Be 'CN=devmagic-panel Local CA (DESKTOP-TEST), O=devmagic-panel'
    (Get-DmpCaCertificate (New-TestCa -Subject 'CN=devmagic-panel Local CA, O=devmagic-panel')).Subject | Should -BeLike 'CN=devmagic-panel Local CA,*'
  }

  It 'refuses another subject, a certificate that is no CA, and one that may not sign' {
    { Get-DmpCaCertificate (New-TestCa -Subject 'CN=LocalhostCA, O=Wandworks') } | Should -Throw '*is not the panel*'
    { Get-DmpCaCertificate (New-TestCa -NotCa) } | Should -Throw '*CA:TRUE*'
    { Get-DmpCaCertificate (New-TestCa -NoCertSign) } | Should -Throw '*keyCertSign*'
    { Get-DmpCaCertificate (Join-Path ([IO.Path]::GetTempPath()) 'no-such-ca.pem') } | Should -Throw '*no CA at*'
  }

  It 'trusts it once by thumbprint and takes it out again' {
    $cert = Get-DmpCaCertificate (New-TestCa)
    Add-DmpCaTrust $cert $script:TestStore | Should -Be 'added'
    Add-DmpCaTrust $cert $script:TestStore | Should -Be 'already'
    @(Get-ChildItem "Cert:\CurrentUser\$($script:TestStore)" | Where-Object Thumbprint -EQ $cert.Thumbprint).Count | Should -Be 1
    Remove-DmpCaTrust $cert.Thumbprint $script:TestStore | Should -Be 1
    @(Get-ChildItem "Cert:\CurrentUser\$($script:TestStore)" | Where-Object Thumbprint -EQ $cert.Thumbprint).Count | Should -Be 0
  }

  It 'without a thumbprint takes out only certificates with the panel subject' {
    $panel = Get-DmpCaCertificate (New-TestCa)
    $other = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (New-TestCa -Subject 'CN=LocalhostCA, O=Wandworks')
    Add-DmpCaTrust $panel $script:TestStore | Out-Null
    $store = Open-DmpStore $script:TestStore
    $store.Add($other)
    $store.Close()
    Remove-DmpCaTrust $null $script:TestStore | Should -Be 1
    @(Get-ChildItem "Cert:\CurrentUser\$($script:TestStore)" | Where-Object Thumbprint -EQ $other.Thumbprint).Count | Should -Be 1
  }
}

Describe 'New-DmpLogonTaskXml' {
  It 'keeps the distro running at your logon, with no window and no time limit' {
    [xml]$xml = New-DmpLogonTaskXml -User 'DESKTOP-TEST\alex' -Distro 'devmagic-panel'
    $xml.Task.Triggers.LogonTrigger.UserId | Should -Be 'DESKTOP-TEST\alex'
    $xml.Task.Principals.Principal.RunLevel | Should -Be 'LeastPrivilege'
    $xml.Task.Settings.ExecutionTimeLimit | Should -Be 'PT0S'
    $xml.Task.Actions.Exec.Command | Should -Be '%SystemRoot%\System32\conhost.exe'
    $xml.Task.Actions.Exec.Arguments | Should -Be '--headless wsl.exe -d devmagic-panel --exec sleep infinity'
  }

  It 'refuses a distro name that could carry more arguments' -TestCases @(@{ Distro = 'Ubuntu --exec rm' }, @{ Distro = 'a"b' }, @{ Distro = '' }) {
    { New-DmpLogonTaskXml -User 'DESKTOP-TEST\alex' -Distro $Distro } | Should -Throw -ExceptionType ([DmpInputError])
  }
}

Describe 'Invoke-DmpCommand' {
  BeforeEach {
    Mock Invoke-DmpElevated { 0 }
    Mock Test-DmpAdmin { $false }
  }

  It 'refuses an unknown command, arguments to one that takes none, and bad characters' {
    { Invoke-DmpCommand 'shell' @() } | Should -Throw -ExceptionType ([DmpInputError])
    { Invoke-DmpCommand 'ca-trust' @('now') } | Should -Throw -ExceptionType ([DmpInputError])
    { Invoke-DmpCommand 'hosts-sync' @('local.a.test=127.0.0.1 && calc') } | Should -Throw -ExceptionType ([DmpInputError])
  }

  It 'checks hosts-sync input before UAC asks, and asks only for good input' {
    { Invoke-DmpCommand 'hosts-sync' @('www.spellbook.example=127.0.0.1') } | Should -Throw -ExceptionType ([DmpInputError])
    Should -Invoke Invoke-DmpElevated -Times 0 -Exactly
    Invoke-DmpCommand 'hosts-sync' @('local.spellbook.example=127.0.0.1') | Should -Be 0
    Should -Invoke Invoke-DmpElevated -Times 1 -Exactly -ParameterFilter { $Name -eq 'hosts-sync' -and $ArgumentList[0] -eq 'local.spellbook.example=127.0.0.1' }
  }

  It 'passes on that UAC was declined' {
    Mock Invoke-DmpElevated { 3 }
    Invoke-DmpCommand 'hosts-sync' @() | Should -Be 3
  }

  It 'says WSL is not answering when wsl --shutdown runs out of time' {
    Mock Invoke-DmpProgram { [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = ''; Error = '' } }
    Invoke-DmpCommand 'wsl-restart' @() 2>$null | Should -Be 4
  }
}

Describe 'self-install and self-remove' {
  BeforeEach {
    $script:Folder = Join-Path ([IO.Path]::GetTempPath()) ("dmp-pf-{0}\devmagic-panel" -f ([guid]::NewGuid().ToString('N')))
    $script:Source = Join-Path ([IO.Path]::GetTempPath()) ("dmp-src-{0}.ps1" -f ([guid]::NewGuid().ToString('N')))
    [IO.File]::WriteAllText($script:Source, '# a helper')
  }

  It 'copies the running script into the folder once, and keeps a copy that is the same' {
    Install-DmpSelf $script:Source $script:Folder | Should -Be 'copied'
    [IO.File]::ReadAllText((Join-Path $script:Folder 'dmp-win.ps1')) | Should -Be '# a helper'
    Install-DmpSelf $script:Source $script:Folder | Should -Be 'already'
    [IO.File]::WriteAllText($script:Source, '# a newer helper')
    Install-DmpSelf $script:Source $script:Folder | Should -Be 'copied'
    [IO.File]::ReadAllText((Join-Path $script:Folder 'dmp-win.ps1')) | Should -Be '# a newer helper'
  }

  It 'removes only a folder named devmagic-panel that holds the helper' {
    Remove-DmpSelf $script:Folder | Should -Be 'none'
    Install-DmpSelf $script:Source $script:Folder | Out-Null
    Remove-DmpSelf $script:Folder | Should -Be 'removed'
    Test-Path -LiteralPath $script:Folder | Should -BeFalse
    $other = Join-Path ([IO.Path]::GetTempPath()) ("dmp-other-{0}" -f ([guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $other | Out-Null
    { Remove-DmpSelf $other } | Should -Throw "*not the helper's folder*"
    Test-Path -LiteralPath $other | Should -BeTrue
    $empty = Join-Path $other 'devmagic-panel'
    New-Item -ItemType Directory -Path $empty | Out-Null
    { Remove-DmpSelf $empty } | Should -Throw "*not the helper's folder*"
  }

  It 'take no arguments, and ask UAC when not elevated' {
    Mock Test-DmpAdmin { $false }
    Mock Invoke-DmpElevated { 0 }
    { Invoke-DmpCommand 'self-install' @('c:/temp') } | Should -Throw -ExceptionType ([DmpInputError])
    Invoke-DmpCommand 'self-remove' @() | Should -Be 0
    Should -Invoke Invoke-DmpElevated -Times 1 -Exactly -ParameterFilter { $Name -eq 'self-remove' }
  }
}
