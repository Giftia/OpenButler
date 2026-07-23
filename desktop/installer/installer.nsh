!macro openbutlerKillProcess PROCESS_NAME
  DetailPrint "Stopping ${PROCESS_NAME}..."
  nsExec::Exec `$SYSDIR\cmd.exe /d /c taskkill /IM "${PROCESS_NAME}" /T /F 1>nul 2>nul`
  Pop $0
  Sleep 500
  nsExec::Exec `$SYSDIR\cmd.exe /d /c taskkill /IM "${PROCESS_NAME}" /T /F 1>nul 2>nul`
  Pop $0
!macroend

!macro openbutlerKillRuntime
  !insertmacro openbutlerKillProcess "OpenButler.exe"
  !insertmacro openbutlerKillProcess "openbutler-backend.exe"
  Sleep 1000
  !insertmacro openbutlerKillProcess "openbutler-backend.exe"
  Sleep 500
!macroend

!macro customCheckAppRunning
  !insertmacro openbutlerKillRuntime
!macroend

!macro customInstall
  !insertmacro openbutlerKillRuntime
!macroend

!macro customRemoveFiles
  !insertmacro openbutlerKillRuntime
!macroend

!macro customUnInit
  !insertmacro openbutlerKillRuntime
!macroend

!macro customUnInstall
  !insertmacro openbutlerKillRuntime
!macroend
