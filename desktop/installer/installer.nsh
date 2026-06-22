!macro openbutlerKillProcess PROCESS_NAME
  DetailPrint "Stopping ${PROCESS_NAME}..."
  nsExec::ExecToLog `$SYSDIR\cmd.exe /d /c taskkill /IM "${PROCESS_NAME}" /T /F 1>nul 2>nul`
  Sleep 500
  nsExec::ExecToLog `$SYSDIR\cmd.exe /d /c taskkill /IM "${PROCESS_NAME}" /T /F 1>nul 2>nul`
!macroend

!macro openbutlerKillRuntime
  !insertmacro openbutlerKillProcess "OpenButler.exe"
  !insertmacro openbutlerKillProcess "openbutler-backend.exe"
  Sleep 1000
  !insertmacro openbutlerKillProcess "openbutler-backend.exe"
  Sleep 500
!macroend

!macro preInit
  !insertmacro openbutlerKillRuntime
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

!macro customRemoveFiles
  !insertmacro openbutlerKillRuntime
!macroend

!macro customUnInit
  !insertmacro openbutlerKillRuntime
!macroend

!macro customUnInstall
  !insertmacro openbutlerKillRuntime
!macroend
