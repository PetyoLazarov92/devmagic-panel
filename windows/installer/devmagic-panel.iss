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
; The Windows part's fingerprint (release.json's windowsPart), written to Windows after an
; install or repair: the panel compares it with its release's and offers the Windows update.
#ifndef WindowsPart
  #define WindowsPart ""
#endif

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
; The panel's mark (web/public/favicon.svg), drawn by make-icon.py: the setup, Apps and features and the shortcuts.
SetupIconFile=devmagic-panel.ico
UninstallDisplayIcon={app}\devmagic-panel.ico
SetupLogging=yes

[Messages]
ConfirmUninstall=Remove %1 from Windows now? Its hosts lines, logon task, certificate and helper go, and the distro is kept or removed as you just chose.
WelcomeLabel2=This installs devmagic-panel {#AppVersion} inside WSL 2: a Linux distro with Apache, PHP and MySQL, and the panel at https://local.devmagic.%n%nThe next pages ask where it should run, for your Linux account and for the panel password; then everything happens in this window, with each step under Details. Windows asks with UAC for the few steps that need admin (turning WSL on, the hosts file, the helper in Program Files). Nothing else on this computer changes.

[Files]
Source: "..\get.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dmp-win.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseFile}"; DestDir: "{app}"; Flags: ignoreversion
Source: "devmagic-panel.ico"; DestDir: "{app}"; Flags: ignoreversion

[Tasks]
Name: desktopicon; Description: "Put a shortcut to the panel on the desktop"; GroupDescription: "Shortcuts that open https://local.devmagic in your browser:"
Name: startmenuicon; Description: "Add it to the Start menu, so typing devmagic finds it"; GroupDescription: "Shortcuts that open https://local.devmagic in your browser:"

[Icons]
; Internet shortcuts (.url): they open the panel in your default browser; the uninstall removes them.
Name: "{userdesktop}\devmagic-panel"; Filename: "https://local.devmagic"; IconFilename: "{app}\devmagic-panel.ico"; Tasks: desktopicon
; Its own name in Start: WSL adds a devmagic-panel entry of its own there for the distro (a terminal, Ubuntu's icon).
; A program shortcut (.lnk), not an internet one: Windows 11's Start lists only those as apps.
; Explorer given a URL opens it in the default browser.
Name: "{userprograms}\Open devmagic-panel"; Filename: "{win}\explorer.exe"; Parameters: "https://local.devmagic"; IconFilename: "{app}\devmagic-panel.ico"; Comment: "Opens https://local.devmagic in your browser"; Tasks: startmenuicon

[Registry]
; The name and icon the panel's Windows notifications show (the helper writes it too, for setups
; from before 1.69.0); removed with an uninstall.
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\devmagic.panel"; ValueType: string; ValueName: "DisplayName"; ValueData: "devmagic-panel"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\devmagic.panel"; ValueType: string; ValueName: "IconUri"; ValueData: "{app}\devmagic-panel.ico"

[InstallDelete]
; Earlier Start entries: internet shortcuts, which Start does not list (and one named like WSL's entry).
Type: files; Name: "{userprograms}\devmagic-panel.url"
Type: files; Name: "{userprograms}\Open devmagic-panel.url"

[Run]
Filename: "https://local.devmagic"; Description: "Open the panel"; \
  Flags: postinstall shellexec nowait skipifsilent; Check: InstallSucceeded

[Code]
const
  PanelPasswordMin = 8;
  PanelPasswordMax = 1024;
  WM_VSCROLL = $0115;
  SB_BOTTOM = 7;
  PM_REMOVE = 1;
  OwnDistro = 'devmagic-panel';

type
  // Windows' MSG, for letting the window handle its own events while get.ps1 runs.
  TMsg = record
    hwnd: HWND;
    message: UINT;
    wParam: Longint;
    lParam: Longint;
    time: DWORD;
    ptX: Longint;
    ptY: Longint;
    lPrivate: DWORD;
  end;

var
  // What get.ps1 -Probe found: the setup asks only what is not there yet.
  ProbeDone, HasWsl, HasDistro, HasPanelPassword, ProbeOsOk, ProbePanel: Boolean;
  ProbeUser, ProbeVirtualization, ProbeOs, ProbeDistros: String;
  // The distro the panel goes into, and the one an earlier install recorded.
  ChosenDistro, InstalledDistro: String;
  DistroIsNew: Boolean;
  // get.ps1 exit 10: WSL was just turned on, Windows needs a restart.
  RestartNeeded: Boolean;
  DistroPage: TWizardPage;
  RadioOwn, RadioNew, RadioExisting: TNewRadioButton;
  NewNameEdit: TNewEdit;
  ExistingCombo: TNewComboBox;
  DistroNote: TNewStaticText;
  AccountPage, PanelPage: TInputQueryWizardPage;
  KeepPanelPassword: TNewCheckBox;
  DetailsMemo: TNewMemo;
  Succeeded: Boolean;
  LastError: String;
  // The uninstaller's answers, and its Details box.
  UninstallDistro: String;
  RemoveDistroAnswer, NoBackupAnswer, UninstallOwnDistro: Boolean;
  UninstallDetails: TNewMemo;

function PeekMessage(var lpMsg: TMsg; hWnd: HWND; wMsgFilterMin, wMsgFilterMax, wRemoveMsg: UINT): BOOL; external 'PeekMessageW@user32.dll stdcall';
function TranslateMessage(const lpMsg: TMsg): BOOL; external 'TranslateMessage@user32.dll stdcall';
function DispatchMessage(const lpMsg: TMsg): Longint; external 'DispatchMessageW@user32.dll stdcall';

// Lets every window of this process handle what waits for it: dragging, scrolling, painting.
procedure HandleWindowEvents();
var
  Msg: TMsg;
begin
  while PeekMessage(Msg, 0, 0, 0, PM_REMOVE) do begin
    TranslateMessage(Msg);
    DispatchMessage(Msg);
  end;
end;

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

// A WSL distro name get.ps1 takes: letters, digits, . _ and -, up to 64.
function IsDistroName(const Name: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (Length(Name) >= 1) and (Length(Name) <= 64);
  if not Result then Exit;
  for I := 1 to Length(Name) do begin
    C := Name[I];
    if not (((C >= 'a') and (C <= 'z')) or ((C >= 'A') and (C <= 'Z')) or ((C >= '0') and (C <= '9')) or (C = '_') or (C = '-') or (C = '.')) then begin
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

// The next field of S up to Separator, taken off S.
function TakeField(var S: String; const Separator: String): String;
var
  At: Integer;
begin
  At := Pos(Separator, S);
  if At = 0 then begin
    Result := S;
    S := '';
  end else begin
    Result := Copy(S, 1, At - 1);
    S := Copy(S, At + Length(Separator), MaxInt);
  end;
end;

// The WSL version of a distro in the probe's list (name|version|state;...), '' when not there.
function DistroVersion(const Name: String): String;
var
  Rest, Entry, EntryName: String;
begin
  Result := '';
  Rest := ProbeDistros;
  while Rest <> '' do begin
    Entry := TakeField(Rest, ';');
    EntryName := TakeField(Entry, '|');
    if CompareText(EntryName, Name) = 0 then begin
      Result := TakeField(Entry, '|');
      Exit;
    end;
  end;
end;

// get.ps1 -Probe -Distro <name>, read only: WSL on, virtualization, the distros,
// and for that one its OS, its user, a panel and its password.
procedure RunProbe(const Distro: String);
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
    if ExecAndCaptureOutput(PowerShellExe(), '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\get.ps1') + '" -Probe -Distro "' + Distro + '"',
      ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode, Output) and (ResultCode = 0) then begin
      Json := '';
      for I := 0 to GetArrayLength(Output.StdOut) - 1 do Json := Json + Output.StdOut[I];
      HasWsl := JsonTrue(Json, 'wsl');
      HasDistro := JsonTrue(Json, 'distro');
      ProbeUser := JsonString(Json, 'user');
      HasPanelPassword := JsonTrue(Json, 'panelPassword');
      ProbeVirtualization := JsonString(Json, 'virtualization');
      ProbeDistros := JsonString(Json, 'distros');
      ProbeOs := JsonString(Json, 'os');
      ProbeOsOk := JsonTrue(Json, 'osOk');
      ProbePanel := JsonTrue(Json, 'panel');
      Log('probe ' + Distro + ': ' + Json);
    end else
      Log(Format('probe of %s did not answer (exit %d)', [Distro, ResultCode]));
  finally
    WizardForm.NextButton.Enabled := True;
  end;
end;

procedure KeepPanelPasswordClick(Sender: TObject);
begin
  PanelPage.Edits[0].Enabled := not KeepPanelPassword.Checked;
  PanelPage.Edits[1].Enabled := not KeepPanelPassword.Checked;
end;

procedure DistroChoiceClick(Sender: TObject);
begin
  NewNameEdit.Enabled := RadioNew.Checked;
  ExistingCombo.Enabled := RadioExisting.Checked;
end;

// The distro page from the probe's list: devmagic-panel when it is there, a new one, or one of yours.
procedure FillDistroPage();
var
  Rest, Entry, Name, Version: String;
  N: Integer;
begin
  ExistingCombo.Items.Clear();
  Rest := ProbeDistros;
  while Rest <> '' do begin
    Entry := TakeField(Rest, ';');
    Name := TakeField(Entry, '|');
    Version := TakeField(Entry, '|');
    if CompareText(Name, OwnDistro) <> 0 then begin
      if Version = '2' then ExistingCombo.Items.Add(Name)
      else ExistingCombo.Items.Add(Name + '  (WSL 1: not supported)');
    end;
  end;
  RadioOwn.Visible := DistroVersion(OwnDistro) <> '';
  RadioExisting.Enabled := ExistingCombo.Items.Count > 0;
  if ExistingCombo.Items.Count > 0 then ExistingCombo.ItemIndex := 0;
  // A free name for a new one: devmagic-panel, else devmagic-panel-2, -3...
  NewNameEdit.Text := OwnDistro;
  N := 2;
  while DistroVersion(NewNameEdit.Text) <> '' do begin
    NewNameEdit.Text := OwnDistro + '-' + IntToStr(N);
    N := N + 1;
  end;
  if RadioOwn.Visible then RadioOwn.Checked := True else RadioNew.Checked := True;
  DistroChoiceClick(nil);
end;

procedure InitializeWizard();
var
  Top: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Software\devmagic-panel', 'Distro', InstalledDistro) then InstalledDistro := '';
  // The distro of the install there, else devmagic-panel: a silent run (the panel's
  // Update the Windows part) asks nothing, so it repairs the distro the panel is in.
  if InstalledDistro <> '' then ChosenDistro := InstalledDistro else ChosenDistro := OwnDistro;

  DistroPage := CreateCustomPage(wpWelcome, 'Where should the panel run?',
    'The panel, Apache, PHP, MySQL and your sites live in a WSL distro.');
  Top := 0;
  RadioOwn := TNewRadioButton.Create(DistroPage);
  RadioOwn.Parent := DistroPage.Surface;
  RadioOwn.Top := Top;
  RadioOwn.Width := DistroPage.SurfaceWidth;
  RadioOwn.Caption := 'Use the devmagic-panel distro that is here already';
  RadioOwn.OnClick := @DistroChoiceClick;
  Top := Top + ScaleY(28);
  RadioNew := TNewRadioButton.Create(DistroPage);
  RadioNew.Parent := DistroPage.Surface;
  RadioNew.Top := Top;
  RadioNew.Width := DistroPage.SurfaceWidth;
  RadioNew.Caption := 'Make a new distro for the panel (Ubuntu 24.04), named:';
  RadioNew.OnClick := @DistroChoiceClick;
  Top := Top + ScaleY(22);
  NewNameEdit := TNewEdit.Create(DistroPage);
  NewNameEdit.Parent := DistroPage.Surface;
  NewNameEdit.Top := Top;
  NewNameEdit.Left := ScaleX(18);
  NewNameEdit.Width := ScaleX(220);
  Top := Top + ScaleY(34);
  RadioExisting := TNewRadioButton.Create(DistroPage);
  RadioExisting.Parent := DistroPage.Surface;
  RadioExisting.Top := Top;
  RadioExisting.Width := DistroPage.SurfaceWidth;
  RadioExisting.Caption := 'Install it into one of my WSL distros (Ubuntu or Debian):';
  RadioExisting.OnClick := @DistroChoiceClick;
  Top := Top + ScaleY(22);
  ExistingCombo := TNewComboBox.Create(DistroPage);
  ExistingCombo.Parent := DistroPage.Surface;
  ExistingCombo.Style := csDropDownList;
  ExistingCombo.Top := Top;
  ExistingCombo.Left := ScaleX(18);
  ExistingCombo.Width := ScaleX(260);
  Top := Top + ScaleY(34);
  DistroNote := TNewStaticText.Create(DistroPage);
  DistroNote.Parent := DistroPage.Surface;
  DistroNote.Top := Top;
  DistroNote.Width := DistroPage.SurfaceWidth;
  DistroNote.WordWrap := True;
  DistroNote.Caption := 'In a distro of yours, the setup turns systemd on (the distro restarts), stops WSL rewriting its /etc/hosts, ' +
    'keeps Apache on 127.0.0.1 and keeps the distro running while you are logged in. Its sites, databases and files stay, ' +
    'and uninstalling the panel never removes a distro of yours.';

  AccountPage := CreateInputQueryPage(DistroPage.ID, 'Your Linux account',
    'The distro is new, so it needs a Linux user.',
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

// An install already there (the setup recorded its distro, and the panel is in it): a repair, no distro question.
function IsRepair(): Boolean;
begin
  Result := (InstalledDistro <> '') and HasDistro and ProbePanel;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = DistroPage.ID then Result := IsRepair();
  // A distro that has its user already: nothing to ask for Linux.
  if PageID = AccountPage.ID then Result := HasDistro and (ProbeUser <> '');
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PanelPage.ID then begin
    // Only a distro with the panel's password already can keep it.
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

// The distro page's choice: checked, and probed when it is one of yours.
function ChooseDistro(): Boolean;
var
  Name: String;
begin
  Result := True;
  if RadioOwn.Checked then begin
    ChosenDistro := OwnDistro;
    DistroIsNew := False;
    RunProbe(ChosenDistro);
  end else if RadioNew.Checked then begin
    Name := Trim(NewNameEdit.Text);
    if not IsDistroName(Name) then begin
      MsgBox('A distro name takes letters, digits, . _ and -, up to 64 of them.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if DistroVersion(Name) <> '' then begin
      MsgBox('There is a distro called ' + Name + ' already: pick another name, or choose it below as one of yours.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    ChosenDistro := Name;
    DistroIsNew := True;
    HasDistro := False;
    ProbeUser := '';
    HasPanelPassword := False;
    ProbePanel := False;
  end else begin
    Name := ExistingCombo.Text;
    if Pos('(WSL 1', Name) > 0 then begin
      MsgBox('That distro runs under WSL 1, which has no systemd. In PowerShell, wsl --set-version <name> 2 moves it to WSL 2 (it can take a while); then run this setup again.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    WizardForm.NextButton.Enabled := False;
    RunProbe(Name);
    if not ProbeOsOk then begin
      MsgBox(Name + ' runs ' + ProbeOs + ', and the panel needs Ubuntu or Debian. Pick another distro, or let the setup make one.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    Result := MsgBox('Install the panel into ' + Name + ' (' + ProbeOs + ')?' + #13#10#13#10 +
      'The setup turns systemd on in it (the distro restarts), stops WSL rewriting its /etc/hosts, keeps Apache on 127.0.0.1 and keeps it running while you are logged in. ' +
      'Its sites, databases and files stay, and uninstalling the panel later never removes it.', mbConfirmation, MB_YESNO) = IDYES;
    if not Result then Exit;
    ChosenDistro := Name;
    DistroIsNew := False;
  end;
  if HasPanelPassword then KeepPanelPassword.Checked := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  User, Welcome, Target: String;
begin
  Result := True;
  if (CurPageID = wpWelcome) and not ProbeDone then begin
    Welcome := WizardForm.WelcomeLabel2.Caption;
    WizardForm.WelcomeLabel2.Caption := Welcome + #13#10#13#10 + 'Checking what is already in place...';
    WizardForm.Refresh();
    // A repair looks at the distro the last install recorded; a first install at devmagic-panel.
    if InstalledDistro <> '' then Target := InstalledDistro else Target := OwnDistro;
    RunProbe(Target);
    ChosenDistro := Target;
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
      Exit;
    end;
    FillDistroPage();
  end;
  if CurPageID = DistroPage.ID then Result := ChooseDistro();
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

// One line of get.ps1's output into a Details box, and the status line above it.
procedure ShowLine(Memo: TNewMemo; Status: TNewStaticText; const S: String);
begin
  Memo.Lines.Add(S);
  if Copy(S, 1, 4) = '==> ' then Status.Caption := Copy(S, 5, MaxInt);
  if Copy(S, 1, 7) = 'error: ' then LastError := Copy(S, 8, MaxInt);
  SendMessage(Memo.Handle, WM_VSCROLL, SB_BOTTOM, 0);
end;

// The complete lines of OutFile not shown yet; Shown counts the characters already taken.
// LoadStringFromLockedFile: cmd holds OutFile open for writing while get.ps1 runs, and
// LoadStringFromFile cannot open it then, which left Details empty until get.ps1 ended.
procedure ShowNewLines(Memo: TNewMemo; Status: TNewStaticText; const OutFile: String; var Shown: Integer; const Final: Boolean);
var
  Text: AnsiString;
  Rest, Line: String;
  At: Integer;
begin
  if not LoadStringFromLockedFile(OutFile, Text) then Exit;
  Rest := Copy(String(Text), Shown + 1, MaxInt);
  repeat
    At := Pos(#10, Rest);
    if At = 0 then Break;
    Line := Copy(Rest, 1, At - 1);
    if (Length(Line) > 0) and (Line[Length(Line)] = #13) then Delete(Line, Length(Line), 1);
    ShowLine(Memo, Status, Line);
    Shown := Shown + At;
    Rest := Copy(Rest, At + 1, MaxInt);
  until False;
  if Final and (Rest <> '') then begin
    ShowLine(Memo, Status, Rest);
    Shown := Shown + Length(Rest);
  end;
end;

// get.ps1 hidden, through cmd so its output goes to a file and its exit code to
// another when it ends (even if it crashes); meanwhile the window keeps handling
// its own events, so it moves, scrolls and repaints, and Details shows each line.
function RunGetPs1(const Params: String; Memo: TNewMemo; Status: TNewStaticText): Integer;
var
  OutFile, CodeFile: String;
  Code: AnsiString;
  Started, Shown, Ticks: Integer;
begin
  OutFile := AddBackslash(GetTempDir()) + 'devmagic-panel-get-output.txt';
  CodeFile := AddBackslash(GetTempDir()) + 'devmagic-panel-get-exitcode.txt';
  DeleteFile(OutFile);
  DeleteFile(CodeFile);
  // /v:on: !errorlevel! is read when PowerShell has ended, not when cmd reads the line.
  if not Exec(ExpandConstant('{cmd}'), '/v:on /c ""' + PowerShellExe() + '" ' + Params + ' > "' + OutFile + '" 2>&1 & echo !errorlevel!> "' + CodeFile + '""',
    '', SW_HIDE, ewNoWait, Started) then begin
    Result := -1;
    Exit;
  end;
  Shown := 0;
  Ticks := 0;
  // At most four hours, ten times a second.
  while not FileExists(CodeFile) and (Ticks < 144000) do begin
    HandleWindowEvents();
    Sleep(100);
    Ticks := Ticks + 1;
    if Ticks mod 3 = 0 then ShowNewLines(Memo, Status, OutFile, Shown, False);
  end;
  Sleep(200);
  ShowNewLines(Memo, Status, OutFile, Shown, True);
  Result := -1;
  if LoadStringFromFile(CodeFile, Code) then Result := StrToIntDef(Trim(String(Code)), -1);
  DeleteFile(OutFile);
  DeleteFile(CodeFile);
end;

procedure RunInstall();
var
  Params: String;
  ResultCode: Integer;
begin
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\get.ps1') + '" -Distro "' + ChosenDistro + '" -Release "' + ExpandConstant('{app}\{#ReleaseName}') + '"';
  if WizardSilent() then
    Params := Params + ' -Yes'
  else
    Params := Params + ' -Answers "' + WriteAnswers() + '"';
  WizardForm.StatusLabel.Caption := 'Installing devmagic-panel in WSL...';
  WizardForm.FilenameLabel.Caption := 'Every step is under Details below.';
  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    ResultCode := RunGetPs1(Params, DetailsMemo, WizardForm.StatusLabel);
  finally
    WizardForm.ProgressGauge.Style := npbstNormal;
    DeleteFile(ExpandConstant('{tmp}\answers.txt'));
  end;
  Succeeded := ResultCode = 0;
  RestartNeeded := ResultCode = 10;
  // After get.ps1, which writes this key anew: what this setup's Windows part is.
  if Succeeded and ('{#WindowsPart}' <> '') then
    RegWriteStringValue(HKEY_CURRENT_USER, 'Software\devmagic-panel', 'WindowsPart', '{#WindowsPart}');
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
  Result := 'devmagic-panel {#AppVersion} goes into the WSL distro ' + ChosenDistro;
  if DistroIsNew then Result := Result + ' (made now from Ubuntu 24.04)'
  else if IsRepair() then Result := Result + ' (a repair of the install there)'
  else if CompareText(ChosenDistro, OwnDistro) <> 0 then Result := Result + ' (yours: ' + ProbeOs + ')';
  Result := Result + '.' + NewLine + NewLine;
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

// --- uninstall: one question in a dialog, get.ps1 hidden, its output under Details ---

function InitializeUninstall(): Boolean;
var
  Buttons: TArrayOfString;
  Created: Cardinal;
begin
  Result := True;
  RemoveDistroAnswer := False;
  NoBackupAnswer := False;
  if not RegQueryStringValue(HKCU, 'Software\devmagic-panel', 'Distro', UninstallDistro) then UninstallDistro := OwnDistro;
  // Only the setup's own distro may go: devmagic-panel, or one it made under another name.
  UninstallOwnDistro := (UninstallDistro = OwnDistro) or
    (RegQueryDWordValue(HKCU, 'Software\devmagic-panel', 'Created', Created) and (Created = 1));
  // A silent uninstall keeps the distro, and a distro of your own always stays.
  if UninstallSilent() or not UninstallOwnDistro then Exit;
  // Buttons that say what they do, the safe one first (it is the default, Enter takes it).
  // TaskDialogMsgBox takes plain button sets only (no default-button flag), and a
  // Cancel button would make Esc one of the choices, so two questions with two buttons each.
  // (No line of [Code] may start with "[": Inno reads that as a new section.)
  SetArrayLength(Buttons, 2);
  Buttons[0] := 'Keep the distro';
  Buttons[1] := 'Remove it';
  RemoveDistroAnswer := TaskDialogMsgBox('What should happen to the ' + UninstallDistro + ' distro?',
    'It holds every site, database and file you made in the panel.' + #13#10#13#10 +
    'Keep it: running the setup again later finds it as it was.',
    mbConfirmation, MB_YESNO, Buttons, 0) = IDNO;
  if RemoveDistroAnswer then begin
    Buttons[0] := 'Keep a copy first';
    Buttons[1] := 'Remove it with no copy';
    NoBackupAnswer := TaskDialogMsgBox('Keep a copy of ' + UninstallDistro + ' before it goes?',
      'The copy goes to ' + ExpandConstant('{localappdata}') + '\devmagic-panel and takes as much space as the distro uses, often a few GB; wsl --import brings it back.' + #13#10#13#10 +
      'With no copy, its sites, databases and files are gone for good.',
      mbConfirmation, MB_YESNO, Buttons, 0) = IDNO;
  end;
  Log(Format('uninstall choice: remove distro %d, no copy %d', [Ord(RemoveDistroAnswer), Ord(NoBackupAnswer)]));
end;

function UninstallChoiceText(): String;
begin
  if not RemoveDistroAnswer then Result := 'keep the distro'
  else if NoBackupAnswer then Result := 'remove the distro, no copy'
  else Result := 'remove the distro, keep a copy first';
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
  if UninstallOwnDistro then UninstallDetails.Lines.Add('Your choice: ' + UninstallChoiceText())
  else UninstallDetails.Lines.Add(UninstallDistro + ' is your own distro: it stays, the panel in it too.');

  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\get.ps1') + '" -Uninstall -Distro "' + UninstallDistro + '"';
  if RemoveDistroAnswer then begin
    Params := Params + ' -RemoveDistro';
    if NoBackupAnswer then Params := Params + ' -NoBackup';
  end else
    Params := Params + ' -Yes';
  UninstallProgressForm.StatusLabel.Caption := 'Removing devmagic-panel from Windows...';
  UninstallProgressForm.ProgressBar.Style := npbstMarquee;
  try
    ResultCode := RunGetPs1(Params, UninstallDetails, UninstallProgressForm.StatusLabel);
  finally
    UninstallProgressForm.ProgressBar.Style := npbstNormal;
  end;
  Log(Format('get.ps1 -Uninstall ended with exit code %d', [ResultCode]));
  if (ResultCode <> 0) and not UninstallSilent() then
    MsgBox('Not everything was removed: ' + LastError + #13#10#13#10 +
      'Every step is in the log in ' + ExpandConstant('{localappdata}') + '\devmagic-panel\logs.', mbError, MB_OK);
end;
