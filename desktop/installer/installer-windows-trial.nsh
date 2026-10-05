; This separate appId/product must never stop or replace the user's old Preview
; or stable runtime. Electron-builder's default check targets this product only.
; Use an unambiguous default directory and fail before writing outside it.
!undef APP_FILENAME
!define APP_FILENAME "OpenButlerWindowsTrial"

!macro customInit
  ; .onInit runs after directory resolution and before the install section,
  ; including existing-version uninstall, extraction and registry writes.
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\OpenButlerWindowsTrial" checkTrialCache
  SetErrorLevel 87
  Quit
  checkTrialCache:
  ReadRegStr $0 HKCU "Software\8c9dcaf3-8e86-55f2-ba5d-7cbf64cf7301" InstallLocation
  StrCmp $0 "" checkTrialUninstaller
  StrCmp $0 "$LOCALAPPDATA\Programs\OpenButlerWindowsTrial" checkTrialUninstaller
  SetErrorLevel 87
  Quit
  checkTrialUninstaller:
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\8c9dcaf3-8e86-55f2-ba5d-7cbf64cf7301" UninstallString
  StrCmp $0 "" trialInitAllowed
  StrCmp $0 '$\"$LOCALAPPDATA\Programs\OpenButlerWindowsTrial\Uninstall OpenButler Preview Windows Trial.exe$\" /currentuser' trialInitAllowed
  SetErrorLevel 87
  Quit
  trialInitAllowed:
!macroend
