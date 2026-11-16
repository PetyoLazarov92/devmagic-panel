; devmagic-panel setup for Windows (Inno Setup 6). The setup carries the panel's
; release package, get.ps1 and the helper, and runs get.ps1 with that package:
; get.ps1 does every step, with its checks and fallbacks, and asks for UAC only
; for the steps that need admin. The setup asks for the Linux account and the
; panel password on its own pages and runs get.ps1 hidden, its output under Details. The setup itself runs as you (no admin), so the
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
WelcomeLabel2=This installs devmagic-panel {#AppVersion} inside WSL 2: a Linux distro of its own with Apache, PHP and MySQL, and the panel at https://local.devmagic.%n%nThe next pages ask for your Linux account and the panel password; then everything happens in this window, with each step under Details. Windows asks with UAC for the few steps that need admin (turning WSL on, the hosts file, the helper in Program Files). Nothing else on this computer changes.

[Files]
Source: "..\get.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dmp-win.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseFile}"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "https://local.devmagic"; Description: "Open the panel"; \
  Flags: postinstall shellexec nowait skipifsilent; Check: InstallSucceeded

[Code]
const
  PanelPasswordMin = 8;
  PanelPasswordMax = 1024;
  WM_VSCROLL = $0115;
  SB_BOTTOM = 7;

var
  // What get.ps1 -Probe found: the setup asks only what is not there yet.
  ProbeDone, HasWsl, HasDistro, HasPanelPassword: Boolean;
  ProbeUser, ProbeVirtualization: String;
  // get.ps1 exit 10: WSL was just turned on, Windows needs a restart.
  RestartNeeded: Boolean;
  AccountPage, PanelPage: TInputQueryWizardPage;
  KeepPanelPassword: TNewCheckBox;
  DetailsMemo: TNewMemo;
  Succeeded: Boolean;
  LastError: String;
  // The uninstaller's answers, and its Details box.
  UninstallDistro: String;
  RemoveDistroAnswer, NoBackupAnswer: Boolean;
  UninstallDetails: TNewMemo;

function InstallSucceeded(): Boolean;
begin
  Result := Succeeded;
end;

function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

// The Windows user name as Ubuntu's first run offers it: lowercase letters,
// digits, _ and -, starting with a letter or _.
function DefaultLinuxUser(): String;
var
  I: Integer;
  C: Char;
  Name: String;
begin
  Name := Lowercase(GetUserNameString());
  Result := '';
  for I := 1 to Length(Name) do begin
    C := Name[I];
    if ((C >= 'a') and (C <= 'z')) or ((C >= '0') and (C <= '9')) or (C = '_') or (C = '-') then
      Result := Result + C;
  end;
  while (Length(Result) > 0) and not (((Result[1] >= 'a') and (Result[1] <= 'z')) or (Result[1] = '_')) do
    Delete(Result, 1, 1);
  if Length(Result) > 32 then Result := Copy(Result, 1, 32);
end;

function IsLinuxUserName(const Name: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (Length(Name) >= 1) and (Length(Name) <= 32) and (((Name[1] >= 'a') and (Name[1] <= 'z')) or (Name[1] = '_'));
  if not Result then Exit;
  for I := 2 to Length(Name) do begin
    C := Name[I];
    if not (((C >= 'a') and (C <= 'z')) or ((C >= '0') and (C <= '9')) or (C = '_') or (C = '-')) then begin
      Result := False;
      Exit;
    end;
  end;
end;

function LettersOnly(const S: String): String;
var
  I: Integer;
  L: String;
begin
  L := Lowercase(S);
  Result := '';
  for I := 1 to Length(L) do
    if (L[I] >= 'a') and (L[I] <= 'z') then Result := Result + L[I];
end;

// The panel's own rules that can be checked here (shared/src/password.ts); the
// list of common passwords is the panel's, which says so when it refuses one.
function PanelPasswordProblem(const Password, User: String): String;
var
  I: Integer;
  Same: Boolean;
begin
  Result := '';
  if Length(Password) < PanelPasswordMin then begin Result := Format('The panel password needs at least %d characters.', [PanelPasswordMin]); Exit; end;
  if Length(Password) > PanelPasswordMax then begin Result := Format('The panel password can have at most %d characters.', [PanelPasswordMax]); Exit; end;
  Same := True;
  for I := 2 to Length(Password) do
    if Password[I] <> Password[1] then Same := False;
  if Same then begin Result := 'One character repeated is too easy to guess.'; Exit; end;
  if (Length(User) >= 3) and (LettersOnly(Password) = LettersOnly(User)) then Result := 'The panel password is too close to your user name.';
end;

// The value of "key":... in get.ps1's one-line JSON.
function JsonTrue(const Json, Key: String): Boolean;
begin
  Result := Pos('"' + Key + '":true', Json) > 0;
end;

function JsonString(const Json, Key: String): String;
var
  At: Integer;
  Rest: String;
begin
  Result := '';
  At := Pos('"' + Key + '":"', Json);
  if At = 0 then Exit;
  Rest := Copy(Json, At + Length(Key) + 4, MaxInt);
  At := Pos('"', Rest);
  if At > 0 then Result := Copy(Rest, 1, At - 1);
end;

// get.ps1 -Probe, read only: WSL on, the distro there, its user, a panel password set.
procedure RunProbe();
var
  Output: TExecOutput;
  ResultCode, I: Integer;
  Json: String;
begin
  ProbeDone := True;
  ExtractTemporaryFile('get.ps1');
  ExtractTemporaryFile('dmp-win.ps1');
  WizardForm.NextButton.Enabled := False;
  try
    if ExecAndCaptureOutput(PowerShellExe(), '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\get.ps1') + '" -Probe',
      ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode, Output) and (ResultCode = 0) then begin
      Json := '';
      for I := 0 to GetArrayLength(Output.StdOut) - 1 do Json := Json + Output.StdOut[I];
      HasWsl := JsonTrue(Json, 'wsl');
      HasDistro := JsonTrue(Json, 'distro');
      ProbeUser := JsonString(Json, 'user');
      HasPanelPassword := JsonTrue(Json, 'panelPassword');
      ProbeVirtualization := JsonString(Json, 'virtualization');
      Log('probe: ' + Json);
    end else
      Log(Format('probe did not answer (exit %d): asking everything', [ResultCode]));
  finally
    WizardForm.NextButton.Enabled := True;
  end;
end;

procedure KeepPanelPasswordClick(Sender: TObject);
begin
  PanelPage.Edits[0].Enabled := not KeepPanelPassword.Checked;
  PanelPage.Edits[1].Enabled := not KeepPanelPassword.Checked;
end;

procedure InitializeWizard();
begin
  AccountPage := CreateInputQueryPage(wpWelcome, 'Your Linux account',
    'The panel runs in a Linux distro of its own, with this account.',
    'Pick a user name and a password for Linux. You type the password when Linux asks for it (sudo), so keep it somewhere safe.');
  AccountPage.Add('User name (lowercase letters, digits, _ and -):', False);
  AccountPage.Add('Password:', True);
  AccountPage.Add('Repeat the password:', True);
  AccountPage.Values[0] := DefaultLinuxUser();

  PanelPage := CreateInputQueryPage(AccountPage.ID, 'Panel password',
    'You sign in to the panel at https://local.devmagic with it.',
    Format('At least %d characters, not a common one, and not your user name with digits around it.', [PanelPasswordMin]));
  PanelPage.Add('Panel password:', True);
  PanelPage.Add('Repeat it:', True);
  KeepPanelPassword := TNewCheckBox.Create(PanelPage);
  KeepPanelPassword.Parent := PanelPage.Surface;
  KeepPanelPassword.Top := PanelPage.Edits[1].Top + PanelPage.Edits[1].Height + ScaleY(16);
  KeepPanelPassword.Width := PanelPage.SurfaceWidth;
  KeepPanelPassword.Height := ScaleY(20);
  KeepPanelPassword.Caption := 'Keep the current panel password';
  KeepPanelPassword.Visible := False;
  KeepPanelPassword.OnClick := @KeepPanelPasswordClick;

  // The Details box under the progress bar: get.ps1's output, line by line as it comes.
  DetailsMemo := TNewMemo.Create(WizardForm);
  DetailsMemo.Parent := WizardForm.InstallingPage;
  DetailsMemo.Left := WizardForm.ProgressGauge.Left;
  DetailsMemo.Top := WizardForm.FilenameLabel.Top + WizardForm.FilenameLabel.Height + ScaleY(8);
  DetailsMemo.Width := WizardForm.ProgressGauge.Width;
  DetailsMemo.Height := WizardForm.InstallingPage.ClientHeight - DetailsMemo.Top - ScaleY(4);
  DetailsMemo.ReadOnly := True;
  DetailsMemo.ScrollBars := ssVertical;
  DetailsMemo.WordWrap := True;
  DetailsMemo.Font.Name := 'Consolas';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  // A distro that has its user already: nothing to ask for Linux.
  if PageID = AccountPage.ID then Result := HasDistro and (ProbeUser <> '');
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PanelPage.ID then begin
    // Only a repair can keep a password: a fresh distro has none.
    KeepPanelPassword.Visible := HasPanelPassword;
    if not HasPanelPassword then KeepPanelPassword.Checked := False;
    KeepPanelPasswordClick(nil);
  end;
  if (CurPageID = wpFinished) and RestartNeeded then begin
    WizardForm.FinishedHeadingLabel.Caption := 'Restart Windows to finish';
    WizardForm.FinishedLabel.Caption := 'WSL is on now, and Windows needs a restart before it works.' + #13#10#13#10 +
      'After the restart, when you sign in, this setup starts again by itself and goes on from where it stopped (it asks for your passwords again; they are never kept).';
  end else if (CurPageID = wpFinished) and not Succeeded then begin
    WizardForm.FinishedHeadingLabel.Caption := 'The install did not finish';
    WizardForm.FinishedLabel.Caption := LastError + #13#10#13#10 +
      'Every step is in the log in ' + ExpandConstant('{localappdata}') + '\devmagic-panel\logs. ' +
      'Run this setup again: it skips what is in place and goes on from there.';
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  User, Welcome: String;
begin
  Result := True;
  if (CurPageID = wpWelcome) and not ProbeDone then begin
    Welcome := WizardForm.WelcomeLabel2.Caption;
    WizardForm.WelcomeLabel2.Caption := Welcome + #13#10#13#10 + 'Checking what is already in place...';
    WizardForm.Refresh();
    RunProbe();
    WizardForm.WelcomeLabel2.Caption := Welcome;
    if HasPanelPassword then KeepPanelPassword.Checked := True;
    // Before anything changes: WSL 2 cannot run without it.
    if ProbeVirtualization = 'off' then begin
      MsgBox('Virtualization is off in this computer''s firmware, and WSL 2 needs it.' + #13#10#13#10 +
        '1. Restart the computer and open its BIOS/UEFI setup: the key shows at power-on, often F2, F10, Del or Esc.' + #13#10 +
        '2. Turn on "Intel Virtualization Technology" (VT-x), or "SVM Mode" on AMD.' + #13#10 +
        '3. Save, start Windows, and run this setup again.' + #13#10#13#10 +
        'Task Manager, Performance, CPU then shows "Virtualization: Enabled". Nothing was changed on this computer.', mbError, MB_OK);
      ProbeDone := False;
      Result := False;
    end;
  end;
  if CurPageID = AccountPage.ID then begin
    if not IsLinuxUserName(AccountPage.Values[0]) then begin
      MsgBox('The Linux user name takes lowercase letters, digits, _ and -, starts with a letter or _, and has at most 32 characters.', mbError, MB_OK);
      Result := False;
    end else if AccountPage.Values[1] = '' then begin
      MsgBox('Pick a password for the Linux user.', mbError, MB_OK);
      Result := False;
    end else if AccountPage.Values[1] <> AccountPage.Values[2] then begin
      MsgBox('The two Linux passwords are not the same.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if (CurPageID = PanelPage.ID) and not (KeepPanelPassword.Visible and KeepPanelPassword.Checked) then begin
    if ProbeUser <> '' then User := ProbeUser else User := AccountPage.Values[0];
    if PanelPasswordProblem(PanelPage.Values[0], User) <> '' then begin
      MsgBox(PanelPasswordProblem(PanelPage.Values[0], User), mbError, MB_OK);
      Result := False;
    end else if PanelPage.Values[0] <> PanelPage.Values[1] then begin
      MsgBox('The two panel passwords are not the same.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// The answers for get.ps1, in Setup's own temporary folder (yours only); get.ps1
// deletes the file as soon as it has read it, and Setup removes the folder.
function WriteAnswers(): String;
var
  Lines: TArrayOfString;
  N: Integer;
begin
  Result := ExpandConstant('{tmp}\answers.txt');
  N := 0;
  if not (HasDistro and (ProbeUser <> '')) then begin
    SetArrayLength(Lines, N + 2);
    Lines[N] := 'linux-user=' + AccountPage.Values[0];
    Lines[N + 1] := 'linux-password=' + AccountPage.Values[1];
    N := N + 2;
  end;
  SetArrayLength(Lines, N + 1);
  if KeepPanelPassword.Visible and KeepPanelPassword.Checked then
    Lines[N] := 'keep-panel-password=yes'
  else
    Lines[N] := 'panel-password=' + PanelPage.Values[0];
  SaveStringsToUTF8File(Result, Lines, False);
end;

procedure DetailsLine(const S: String; const Error, FirstLine: Boolean);
begin
  if Error then begin
    DetailsMemo.Lines.Add('(' + S + ')');
    Exit;
  end;
  DetailsMemo.Lines.Add(S);
  if Copy(S, 1, 4) = '==> ' then WizardForm.StatusLabel.Caption := Copy(S, 5, MaxInt);
  if Copy(S, 1, 7) = 'error: ' then LastError := Copy(S, 8, MaxInt);
  SendMessage(DetailsMemo.Handle, WM_VSCROLL, SB_BOTTOM, 0);
end;

// get.ps1 hidden, its output in the Details box as it comes.
procedure RunInstall();
var
  Params: String;
  ResultCode: Integer;
begin
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\get.ps1') + '" -Release "' + ExpandConstant('{app}\{#ReleaseName}') + '"';
  if WizardSilent() then
    Params := Params + ' -Yes'
  else
    Params := Params + ' -Answers "' + WriteAnswers() + '"';
  WizardForm.StatusLabel.Caption := 'Installing devmagic-panel in WSL...';
  WizardForm.FilenameLabel.Caption := 'Every step is under Details below.';
  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    if not ExecAndLogOutput(PowerShellExe(), Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode, @DetailsLine) then
      ResultCode := -1;
  finally
    WizardForm.ProgressGauge.Style := npbstNormal;
    DeleteFile(ExpandConstant('{tmp}\answers.txt'));
  end;
  Succeeded := ResultCode = 0;
  RestartNeeded := ResultCode = 10;
  // After the restart, when you sign in, this setup starts again by itself (once) and goes on.
  if RestartNeeded then
    RegWriteStringValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\RunOnce', 'devmagic-panel-setup', '"' + ExpandConstant('{srcexe}') + '"');
  Log(Format('get.ps1 ended with exit code %d', [ResultCode]));
end;

function NeedRestart(): Boolean;
begin
  Result := RestartNeeded;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunInstall();
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'devmagic-panel {#AppVersion} goes into the WSL distro devmagic-panel.' + NewLine + NewLine;
  if HasDistro and (ProbeUser <> '') then
    Result := Result + 'Linux user: ' + ProbeUser + ' (already there)' + NewLine
  else
    Result := Result + 'Linux user: ' + AccountPage.Values[0] + ' (made now)' + NewLine;
  if KeepPanelPassword.Visible and KeepPanelPassword.Checked then
    Result := Result + 'Panel password: kept as it is' + NewLine
  else
    Result := Result + 'Panel password: the one you typed' + NewLine;
  if not HasWsl then
    Result := Result + NewLine + 'WSL is off: Windows turns it on (UAC), then asks for a restart; after it the setup starts again by itself and goes on.' + NewLine;
end;

// --- uninstall: its two questions in dialogs, get.ps1 hidden, its output under Details ---

function InitializeUninstall(): Boolean;
begin
  Result := True;
  RemoveDistroAnswer := False;
  NoBackupAnswer := False;
  if not RegQueryStringValue(HKCU, 'Software\devmagic-panel', 'Distro', UninstallDistro) then UninstallDistro := 'devmagic-panel';
  // A silent uninstall keeps the distro, and a distro of your own always stays.
  if UninstallSilent() or (UninstallDistro <> 'devmagic-panel') then Exit;
  RemoveDistroAnswer := MsgBox('Remove the devmagic-panel distro as well, with every site, database and file in it?' + #13#10#13#10 +
    'No keeps it: running the setup again later finds it as it was.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  if not RemoveDistroAnswer then Exit;
  NoBackupAnswer := MsgBox('Keep a copy of the distro before it goes?' + #13#10#13#10 +
    'Yes exports it to ' + ExpandConstant('{localappdata}') + '\devmagic-panel first (as much space as the distro uses, often a few GB); wsl --import brings it back.' + #13#10 +
    'No removes it for good, with no copy.', mbConfirmation, MB_YESNO) = IDNO;
end;

procedure UninstallLine(const S: String; const Error, FirstLine: Boolean);
begin
  if Error then begin
    UninstallDetails.Lines.Add('(' + S + ')');
    Exit;
  end;
  UninstallDetails.Lines.Add(S);
  if Copy(S, 1, 4) = '==> ' then UninstallProgressForm.StatusLabel.Caption := Copy(S, 5, MaxInt);
  if Copy(S, 1, 7) = 'error: ' then LastError := Copy(S, 8, MaxInt);
  SendMessage(UninstallDetails.Handle, WM_VSCROLL, SB_BOTTOM, 0);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Params: String;
  ResultCode: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  UninstallDetails := TNewMemo.Create(UninstallProgressForm);
  UninstallDetails.Parent := UninstallProgressForm.InstallingPage;
  UninstallDetails.Left := UninstallProgressForm.ProgressBar.Left;
  UninstallDetails.Top := UninstallProgressForm.ProgressBar.Top + UninstallProgressForm.ProgressBar.Height + ScaleY(12);
  UninstallDetails.Width := UninstallProgressForm.ProgressBar.Width;
  UninstallDetails.Height := UninstallProgressForm.InstallingPage.ClientHeight - UninstallDetails.Top - ScaleY(4);
  UninstallDetails.ReadOnly := True;
  UninstallDetails.ScrollBars := ssVertical;
  UninstallDetails.WordWrap := True;
  UninstallDetails.Font.Name := 'Consolas';

  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\get.ps1') + '" -Uninstall -Distro "' + UninstallDistro + '"';
  if RemoveDistroAnswer then begin
    Params := Params + ' -RemoveDistro';
    if NoBackupAnswer then Params := Params + ' -NoBackup';
  end else
    Params := Params + ' -Yes';
  UninstallProgressForm.StatusLabel.Caption := 'Removing devmagic-panel from Windows...';
  UninstallProgressForm.ProgressBar.Style := npbstMarquee;
  try
    if not ExecAndLogOutput(PowerShellExe(), Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode, @UninstallLine) then
      ResultCode := -1;
  finally
    UninstallProgressForm.ProgressBar.Style := npbstNormal;
  end;
  Log(Format('get.ps1 -Uninstall ended with exit code %d', [ResultCode]));
  if (ResultCode <> 0) and not UninstallSilent() then
    MsgBox('Not everything was removed: ' + LastError + #13#10#13#10 +
      'Every step is in the log in ' + ExpandConstant('{localappdata}') + '\devmagic-panel\logs.', mbError, MB_OK);
end;
