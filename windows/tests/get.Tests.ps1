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

Describe 'Invoke-DmpHelper' {
  It 'returns only the exit code, however much the helper prints' {
    Mock Invoke-DmpProgram { [pscustomobject]@{ TimedOut = $false; ExitCode = 0; Output = "ok: one`r`nok: two`r`n"; Error = '' } }
    $result = @(Invoke-DmpHelper @('ca-trust') 6>$null)
    $result.Count | Should -Be 1
    $result[0] | Should -BeOfType [int]
    $result[0] | Should -Be 0
  }

  It 'passes on an exit code, and counts running out of time as a failure' {
    Mock Invoke-DmpProgram { [pscustomobject]@{ TimedOut = $false; ExitCode = 3; Output = ''; Error = 'error: declined' } }
    Invoke-DmpHelper @('hosts-sync') | Should -Be 3
    Mock Invoke-DmpProgram { [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = ''; Error = '' } }
    Invoke-DmpHelper @('hosts-sync') | Should -Be 1
  }
}

Describe 'Install-DmpHelperFile' {
  BeforeEach {
    Mock Write-DmpStep { }
    Mock Write-DmpOk { }
    Mock Write-DmpWarn { }
    $script:Target = Join-Path ([IO.Path]::GetTempPath()) ("dmp-pf-{0}" -f ([guid]::NewGuid().ToString('N')))
    Mock Get-DmpHelperTarget { $script:Target }
  }

  It 'copies nothing when the same helper is there already' {
    New-Item -ItemType Directory -Path $script:Target | Out-Null
    Copy-Item -LiteralPath $script:Helper -Destination $script:Target
    Mock Invoke-DmpHelper { 0 }
    Install-DmpHelperFile | Should -BeTrue
    Should -Invoke Invoke-DmpHelper -Times 0 -Exactly
  }

  It 'has the helper copy itself, needing no other program, and says when UAC was declined' {
    Mock Invoke-DmpHelper { New-Item -ItemType Directory -Force -Path $script:Target | Out-Null; Copy-Item -LiteralPath $script:Helper -Destination $script:Target; 0 }
    Install-DmpHelperFile | Should -BeTrue
    Should -Invoke Invoke-DmpHelper -Times 1 -Exactly -ParameterFilter { ($ArgumentList -join ' ') -eq 'self-install' }
    Remove-Item -LiteralPath $script:Target -Recurse -Force
    Mock Invoke-DmpHelper { 3 }
    Install-DmpHelperFile | Should -BeFalse
    Should -Invoke Write-DmpWarn -Times 1 -Exactly -ParameterFilter { $Text -like 'UAC was declined*' }
  }
}

Describe 'Install-DmpWindowsSide' {
  BeforeEach {
    Mock Set-DmpSetting { }
    Mock Write-DmpStep { }
    Mock Write-DmpWarn { }
    Mock Install-DmpHelperFile { $true }
    Mock Invoke-DmpHelper { 0 }
    $block = "# BEGIN devmagic-panel (managed by the panel, edit sites there)`n127.0.0.1 local.devmagic`n127.0.0.2 local.wandworks-store.example`n# END devmagic-panel`n"
    Mock Invoke-DmpInDistro { [pscustomobject]@{ TimedOut = $false; ExitCode = 0; Output = $block; Error = '' } }
  }

  It 'warns about nothing when every helper step succeeds, and mirrors the distro hosts block' {
    Install-DmpWindowsSide 'devmagic-panel'
    Should -Invoke Write-DmpWarn -Times 0 -Exactly
    Should -Invoke Invoke-DmpHelper -Times 1 -Exactly -ParameterFilter { $ArgumentList[0] -eq 'autostart-install' }
    Should -Invoke Invoke-DmpHelper -Times 1 -Exactly -ParameterFilter { $ArgumentList[0] -eq 'ca-trust' }
    Should -Invoke Invoke-DmpHelper -Times 1 -Exactly -ParameterFilter {
      ($ArgumentList -join ' ') -eq 'hosts-sync local.devmagic=127.0.0.1 local.wandworks-store.example=127.0.0.2'
    }
  }

  It 'warns for the step that failed, and says UAC was declined' {
    Mock Invoke-DmpHelper { 1 } -ParameterFilter { $ArgumentList[0] -eq 'ca-trust' }
    Mock Invoke-DmpHelper { 3 } -ParameterFilter { $ArgumentList[0] -eq 'hosts-sync' }
    Install-DmpWindowsSide 'devmagic-panel'
    Should -Invoke Write-DmpWarn -Times 1 -Exactly -ParameterFilter { $Text -like 'the CA is not trusted*' }
    Should -Invoke Write-DmpWarn -Times 1 -Exactly -ParameterFilter { $Text -like 'UAC was declined*' }
    Should -Invoke Write-DmpWarn -Times 2 -Exactly
  }
}

Describe "Uninstall-DmpPanel" {
  BeforeEach {
    Mock Write-DmpStep { }
    Mock Write-DmpWarn { }
    Mock Write-DmpOk { }
    Mock Remove-DmpSetting { }
    $script:Order = [Collections.Generic.List[string]]::new()
    Mock Invoke-DmpHelper { $script:Order.Add($ArgumentList[0]); 0 }
    Mock Invoke-DmpWsl { [pscustomobject]@{ TimedOut = $false; ExitCode = 0; Output = "  NAME STATE VERSION`n* Ubuntu Running 2`n"; Error = "" } }
  }

  It "takes every Windows step back, nginx relays included, the helper itself last" {
    Uninstall-DmpPanel "devmagic-panel" -KeepDistro
    $script:Order | Should -Be @("hosts-sync", "portproxy-off", "autostart-remove", "ca-untrust", "self-remove")
    Should -Invoke Write-DmpWarn -Times 0 -Exactly
  }

  It "warns for a step that failed and goes on with the rest" {
    Mock Invoke-DmpHelper { $script:Order.Add($ArgumentList[0]); 1 } -ParameterFilter { $ArgumentList[0] -eq "portproxy-off" }
    Uninstall-DmpPanel "devmagic-panel" -KeepDistro
    Should -Invoke Write-DmpWarn -Times 1 -Exactly -ParameterFilter { $Text -like "portproxy-off did not finish*" }
    $script:Order[-1] | Should -Be "self-remove"
  }
}

Describe 'the settings key' {
  BeforeEach {
    $script:SettingsKey = 'HKCU:\Software\devmagic-panel-pester'
    Remove-Item -Path $script:SettingsKey -Recurse -Force -ErrorAction SilentlyContinue
    Mock Write-DmpWarn { }
  }
  AfterEach { Remove-Item -Path $script:SettingsKey -Recurse -Force -ErrorAction SilentlyContinue }

  It 'writes the distro and reads it back, without a warning' {
    Set-DmpSetting 'devmagic-panel'
    (Get-ItemProperty -Path $script:SettingsKey).Distro | Should -Be 'devmagic-panel'
    Should -Invoke Write-DmpWarn -Times 0 -Exactly
  }

  It 'warns when the value is not there when read back' {
    Mock Get-ItemProperty { [pscustomobject]@{ Distro = 'something-else' } }
    Set-DmpSetting 'devmagic-panel'
    Should -Invoke Write-DmpWarn -Times 1 -Exactly -ParameterFilter { $Text -like '*did not stay*' }
  }

  It 'removes it, and warns when it is still there' {
    Set-DmpSetting 'devmagic-panel'
    Remove-DmpSetting
    Test-Path $script:SettingsKey | Should -BeFalse
    Should -Invoke Write-DmpWarn -Times 0 -Exactly
    Mock Test-Path { $true }
    Remove-DmpSetting
    Should -Invoke Write-DmpWarn -Times 1 -Exactly -ParameterFilter { $Text -like '*is still there*' }
  }
}

Describe 'the log of a run' {
  It 'keeps every step, warning and ok with the time, in DataDir\logs' {
    $script:DataDir = Join-Path ([IO.Path]::GetTempPath()) ("dmp-data-{0}" -f ([guid]::NewGuid().ToString('N')))
    Start-DmpLog 'install'
    $script:LogFile | Should -BeLike "$($script:DataDir)\logs\get-install-*.log"
    Write-DmpStep 'a step' | Out-Null
    Write-DmpWarn 'a warning' | Out-Null
    Write-DmpOk 'done' | Out-Null
    $lines = Get-Content $script:LogFile
    $lines[0] | Should -Match '^\d\d:\d\d:\d\d get\.ps1 install as '
    $lines[1..3] | ForEach-Object { $_ | Should -Match '^\d\d:\d\d:\d\d ' }
    ($lines[1..3] -replace '^\d\d:\d\d:\d\d ', '') | Should -Be @('==> a step', 'warn: a warning', 'ok: done')
    $script:LogFile = $null
  }

  It 'goes on without a log when its folder cannot be made' {
    $script:DataDir = 'Z:\nowhere\at\all'
    Mock New-Item { throw 'no such drive' }
    { Start-DmpLog 'install'; Write-DmpStep 'still runs' | Out-Null } | Should -Not -Throw
    $script:LogFile | Should -BeNullOrEmpty
  }
}
