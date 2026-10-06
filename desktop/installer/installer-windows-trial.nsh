; This separate appId/product must never stop or replace the user's old Preview
; or stable runtime. Electron-builder's default check targets this product only.
; Use an unambiguous default directory and fail before writing outside it.
!undef APP_FILENAME
!define APP_FILENAME "OpenButlerWindowsTrial"
!define OPENBUTLER_TRIAL_STOP_CHECK "${__FILEDIR__}\check-windows-trial-stopped.ps1"

; Both installer and uninstaller use this override instead of builder's
; image-name cleanup. Never stop a process: require an already stopped Trial.
!macro customCheckAppRunning
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\OpenButlerWindowsTrial" +3
  SetErrorLevel 87
  Quit
  InitPluginsDir
  File /oname=$PLUGINSDIR\check-windows-trial-stopped.ps1 "${OPENBUTLER_TRIAL_STOP_CHECK}"
  !ifdef BUILD_UNINSTALLER
    nsExec::ExecToStack /TIMEOUT=15000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "$PLUGINSDIR\check-windows-trial-stopped.ps1" -Lifecycle Uninstall`
  !else
    nsExec::ExecToStack /TIMEOUT=15000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "$PLUGINSDIR\check-windows-trial-stopped.ps1" -Lifecycle Install`
  !endif
  Pop $0
  Pop $1
  StrCmp $0 "0" +3
  SetErrorLevel 87
  Quit
!macroend

; Assisted interactive uninstall does not always call CHECK_APP_RUNNING.
; Check before any removal, including a silent upgrade's old-version uninstall.
!macro customUnInit
  !insertmacro customCheckAppRunning
!macroend

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
