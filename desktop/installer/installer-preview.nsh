!macro openbutlerPreviewKillProcess PROCESS_NAME
  DetailPrint "Stopping ${PROCESS_NAME}..."
  nsExec::Exec `$SYSDIR\cmd.exe /d /c taskkill /IM "${PROCESS_NAME}" /T /F 1>nul 2>nul`
  Pop $0
  Sleep 500
!macroend

!macro openbutlerPreviewKillRuntime
  !insertmacro openbutlerPreviewKillProcess "OpenButler Preview.exe"
  !insertmacro openbutlerPreviewKillProcess "openbutler-backend-preview.exe"
!macroend

!macro customCheckAppRunning
  !insertmacro openbutlerPreviewKillRuntime
!macroend

!macro customInstall
  !insertmacro openbutlerPreviewKillRuntime
!macroend

!macro customUnInstall
  !insertmacro openbutlerPreviewKillRuntime
!macroend
