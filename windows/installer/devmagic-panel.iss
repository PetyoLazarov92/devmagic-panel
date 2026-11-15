; devmagic-panel setup for Windows (Inno Setup 6). The setup carries the panel's
; release package, get.ps1 and the helper, and runs get.ps1 with that package:
; get.ps1 does every step, with its checks and fallbacks, and asks for UAC only
; for the steps that need admin. The setup itself runs as you (no admin), so the
; distro is always made for you, never for an admin account typed into UAC.
;
; Built by .github/workflows/windows.yml:
;   ISCC /DAppVersion=1.67.1 /DFileVersion=1.67.1.0 /DReleaseFile=<path to the .tar.gz> devmagic-panel.iss
; Unsigned until phase 3's signing (SignPath) is set up: Windows SmartScreen
; warns (More info, Run anyway).
;
; /SILENT or /VERYSILENT run get.ps1 with -Yes: no questions, the distro kept on uninstall.

#ifndef AppVersion
  #error Pass /DAppVersion=<version>
#endif
#ifndef FileVersion
  #error Pass /DFileVersion=<a.b.c.d>
#endif
#ifndef ReleaseFile
  #error Pass /DReleaseFile=<path to devmagic-panel-<version>.tar.gz>
#endif
#define ReleaseName ExtractFileName(ReleaseFile)

[Setup]
AppId={{6F5D2E1B-8C4A-4F0E-9B7D-3A2C1E5F4D60}
AppName=devmagic-panel
AppVersion={#AppVersion}
AppVerName=devmagic-panel {#AppVersion}
AppPublisher=devmagic-panel
AppPublisherURL=https://github.com/PetyoLazarov92/devmagic-panel
AppSupportURL=https://github.com/PetyoLazarov92/devmagic-panel/blob/master/docs/installation.md
VersionInfoVersion={#FileVersion}
; As you, never as admin: get.ps1 asks UAC for single steps.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\devmagic-panel-setup
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19045
OutputBaseFilename=devmagic-panel-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=devmagic-panel
UninstallDisplayIcon={sys}\wsl.exe
SetupLogging=yes

[Messages]
WelcomeLabel2=This installs devmagic-panel {#AppVersion} inside WSL 2: a Linux distro of its own with Apache, PHP and MySQL, and the panel at https://local.devmagic.%n%nWindows asks you with UAC for the steps that need admin (turning WSL on, the hosts file, the helper in Program Files), and a window opens where you type your Linux and panel passwords. Nothing else on this computer changes.

[Files]
Source: "..\get.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dmp-win.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseFile}"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\get.ps1"" -Release ""{app}\{#ReleaseName}""{code:SilentSwitch}"; \
  StatusMsg: "Installing devmagic-panel in WSL (a window shows each step)..."; \
  Flags: waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\get.ps1"" -Uninstall{code:SilentSwitch}"; \
  RunOnceId: "devmagic-panel-uninstall"; \
  Flags: waituntilterminated

[Code]
// -Yes when Windows runs the setup or its uninstall silently (IT, winget).
// WizardSilent exists only in setup and UninstallSilent only in the uninstaller.
function SilentSwitch(Param: String): String;
begin
  Result := '';
  if IsUninstaller() then begin
    if UninstallSilent() then Result := ' -Yes';
  end else begin
    if WizardSilent() then Result := ' -Yes';
  end;
end;
