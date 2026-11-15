# Pester 5 tests for windows/get.ps1: what it reads from Windows and WSL, on
# samples of their real output, and the distro step with wsl.exe mocked. No
# test runs wsl.exe, downloads or changes anything on the machine.

BeforeAll {
  . "$PSScriptRoot/../get.ps1"
  $ErrorActionPreference = 'Stop'

  # `wsl --list --verbose` as WSL_UTF8 prints it.
  $script:WslList = @"
  NAME                   STATE           VERSION
* devmagic-panel         Running         2
  Ubuntu-24.04           Stopped         2
  Legacy                 Stopped         1
"@
}

Describe 'Test-DmpWindows' {
  It 'accepts <Name> build <Build>' -TestCases @(
    @{ Name = 'Windows 11'; Build = 26200 }
    @{ Name = 'Windows 11'; Build = 22631 }
    @{ Name = 'Windows 10'; Build = 19045 }
  ) {
    Test-DmpWindows ([pscustomobject]@{ Name = $Name; Build = $Build; Arch = 'AMD64' }) | Should -BeNullOrEmpty
  }

  It 'names the update an older build needs' {
    Test-DmpWindows ([pscustomobject]@{ Name = 'Windows 10'; Build = 19044; Arch = 'AMD64' }) | Should -BeLike '*build 19045 or newer*'
    Test-DmpWindows ([pscustomobject]@{ Name = 'Windows 11'; Build = 22621; Arch = 'AMD64' }) | Should -BeLike '*build 22631 or newer*'
  }

  It 'says ARM is planned, and refuses a 32-bit Windows' {
    Test-DmpWindows ([pscustomobject]@{ Name = 'Windows 11'; Build = 26200; Arch = 'ARM64' }) | Should -BeLike '*ARM*not supported yet*'
    Test-DmpWindows ([pscustomobject]@{ Name = 'Windows 10'; Build = 19045; Arch = 'x86' }) | Should -BeLike '*64-bit*'
  }
}

Describe 'ConvertFrom-DmpWslVersion' {
  It 'reads the WSL version from wsl --version' {
    $output = "WSL version: 2.6.3.0`r`nKernel version: 6.6.87.2-1`r`nWSLg version: 1.0.71`r`n"
    ConvertFrom-DmpWslVersion $output | Should -Be ([version]'2.6.3.0')
  }

  It 'knows no version when an inbox WSL answers with its help' {
    ConvertFrom-DmpWslVersion "Usage: wsl.exe [Argument] [Options...] [CommandLine]`r`n" | Should -BeNullOrEmpty
  }
}

Describe 'ConvertFrom-DmpWslList' {
  It 'reads every distro with its state, WSL version and the default' {
    $distros = @(ConvertFrom-DmpWslList $script:WslList)
    $distros.Count | Should -Be 3
    $distros[0].Name | Should -Be 'devmagic-panel'
    $distros[0].Default | Should -BeTrue
    $distros[1].State | Should -Be 'Stopped'
    $distros[2].Version | Should -Be 1
    $distros[2].Default | Should -BeFalse
  }
}

Describe 'Get-DmpPortHolder' {
  It 'names Windows programs on 80, 443 and 3306, and leaves out WSL relaying the distro' {
    $netstat = @"
  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:443          0.0.0.0:0              LISTENING       812
  TCP    127.0.0.1:3306         0.0.0.0:0              LISTENING       900
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       77
  TCP    [::1]:443              [::]:0                 LISTENING       812
"@
    $holders = @(Get-DmpPortHolder $netstat @{ 4 = 'System'; 812 = 'wslrelay'; 900 = 'mysqld'; 77 = 'node' })
    ($holders | ForEach-Object { "$($_.Program):$($_.Port)" }) | Should -Be @('System:80', 'mysqld:3306')
  }
}

Describe 'Test-DmpForwardingOff' {
  It 'sees localhostForwarding = false in [wsl2] only' {
    $file = Join-Path ([IO.Path]::GetTempPath()) ("dmp-wslconfig-{0}" -f ([guid]::NewGuid().ToString('N')))
    [IO.File]::WriteAllText($file, "[wsl2]`r`nmemory=8GB`r`nlocalhostForwarding = false`r`n")
    Test-DmpForwardingOff $file | Should -BeTrue
    [IO.File]::WriteAllText($file, "[wsl2]`r`nlocalhostForwarding=true`r`n[experimental]`r`nlocalhostForwarding=false`r`n")
    Test-DmpForwardingOff $file | Should -BeFalse
    Test-DmpForwardingOff (Join-Path ([IO.Path]::GetTempPath()) 'no-such-wslconfig') | Should -BeFalse
  }
}

Describe 'Get-DmpFileSha256' {
  It 'gives the lowercase SHA-256 of a file' {
    $file = Join-Path ([IO.Path]::GetTempPath()) ("dmp-sha-{0}" -f ([guid]::NewGuid().ToString('N')))
    [IO.File]::WriteAllText($file, 'abc')
    Get-DmpFileSha256 $file | Should -Be 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  }
}

Describe 'Install-DmpDistro' {
  BeforeEach {
    Mock Invoke-DmpWsl { [pscustomobject]@{ TimedOut = $false; ExitCode = 0; Output = $script:WslList; Error = '' } } -ParameterFilter { $ArgumentList[0] -eq '--list' }
    Mock Invoke-DmpWsl { [pscustomobject]@{ TimedOut = $false; ExitCode = 0; Output = ''; Error = '' } }
    Mock Write-DmpOk { }
    Mock Write-DmpStep { }
  }

  It 'keeps a distro that is there, and imports nothing' {
    Install-DmpDistro 'Ubuntu-24.04'
    Should -Invoke Invoke-DmpWsl -Times 0 -ParameterFilter { $ArgumentList[0] -eq '--import' }
  }

  It 'refuses a WSL 1 distro with how to convert it' {
    { Install-DmpDistro 'Legacy' } | Should -Throw '*wsl --set-version Legacy 2*'
  }

  It 'imports a new distro from the checked image and puts the default distro back' {
    Mock Test-Path { $true }
    Mock Get-DmpFileSha256 { $script:Manifest.ImageSha256 }
    Mock New-Item { }
    Install-DmpDistro 'devmagic-test'
    Should -Invoke Invoke-DmpWsl -Times 1 -Exactly -ParameterFilter { $ArgumentList[0] -eq '--import' -and $ArgumentList[1] -eq 'devmagic-test' -and $ArgumentList[-1] -eq '2' }
    Should -Invoke Invoke-DmpWsl -Times 1 -Exactly -ParameterFilter { $ArgumentList[0] -eq '--set-default' -and $ArgumentList[1] -eq 'devmagic-panel' }
  }
}
