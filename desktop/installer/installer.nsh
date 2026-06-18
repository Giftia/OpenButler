!macro openbutlerKillProcess PROCESS_NAME
  DetailPrint "Stopping ${PROCESS_NAME}..."
  nsExec::ExecToLog `$SYSDIR\cmd.exe /c taskkill /IM "${PROCESS_NAME}" /T /F`
!macroend

!macro openbutlerKillRuntime
  !insertmacro openbutlerKillProcess "OpenButler.exe"
  !insertmacro openbutlerKillProcess "openbutler-backend.exe"
  Sleep 1000
!macroend

!macro customInit
  !insertmacro openbutlerKillRuntime
!macroend

!macro customCheckAppRunning
  !insertmacro openbutlerKillRuntime
!macroend

!macro customInstall
  !insertmacro openbutlerKillRuntime
!macroend

!macro customUnInit
  !insertmacro openbutlerKillRuntime
!macroend

!macro customUnInstall
  !insertmacro openbutlerKillRuntime
!macroend
