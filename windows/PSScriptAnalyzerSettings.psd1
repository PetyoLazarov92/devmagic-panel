@{
  # The rules for windows/: everything at Warning and Error, but for ShouldProcess.
  # dmp-win.ps1 is no module of cmdlets: its functions run only from its fixed
  # commands, each a change the panel asked for, so -WhatIf and -Confirm have
  # nothing to stand in for.
  Severity     = @('Warning', 'Error')
  ExcludeRules = @('PSUseShouldProcessForStateChangingFunctions')
}
