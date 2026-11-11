!define /ifndef SANRENJZ_UPDATE_HELPER "${__FILEDIR__}\windows-update-transaction.ps1"
!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_ABORT SanrenjzUpdateOnUserAbort

Var updateTransactionDir
Var updatePrepareAttempted
Var updateRegisteredDir
Var updateSecondaryRegisteredDir
Var updateRegisteredArgument
Var updateHelperPhase
Var updateHelperOptions
Var updateHelperExit
Var updateHelperOutput
Var updateUninstallerName
Var updateProductVersion
Var updateProductAppId
Var updateRegistryKey
Var updateUninstallRegistryKey
Var updateRegistryHive
Var updateTempActive
Var updateTempReady
Var updateOldTemp
Var updateOldTmp
Var updateOldTempExists
Var updateOldTmpExists
Var updateUninstallExit
Var updateUninstallFailed

Function SanrenjzRunUpdateHelper
  StrCpy $updateRegisteredArgument ""
  StrCmp $updateRegisteredDir "" update_helper_run
  StrCpy $updateRegisteredArgument '-RegisteredInstallDir "$updateRegisteredDir"'
update_helper_run:
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-update-transaction.ps1" -Phase $updateHelperPhase -InstallDir "$INSTDIR" -UninstallerName "$updateUninstallerName" -Version "$updateProductVersion" -AppId "$updateProductAppId" -RegistryKey "$updateRegistryKey" -UninstallRegistryKey "$updateUninstallRegistryKey" -RegistryHive "$updateRegistryHive" -RegistryView "Registry64" $updateRegisteredArgument $updateHelperOptions'
  Pop $updateHelperExit
  Pop $updateHelperOutput
FunctionEnd

Function SanrenjzCheckAppRunning
  Call SanrenjzInitializeUpdateHelper
update_close_app_retry:
  StrCpy $updateHelperPhase close-app
  ; 旧卸载器按同名进程操作，先拒绝其它安装目录的宿主，避免它误关另一份程序。
  StrCpy $updateHelperOptions -RefuseOtherInstallations
  Call SanrenjzRunUpdateHelper
  StrCpy $updateHelperOptions ""
  StrCmp $updateHelperExit "0" update_close_app_done
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP "无法关闭当前安装目录中的三人聚智，安装尚未继续。请保存工作并关闭程序后重试。返回：$updateHelperExit$\r$\n详情：$updateHelperOutput" /SD IDCANCEL IDRETRY update_close_app_retry
  SetErrorLevel 2
  Abort
update_close_app_done:
FunctionEnd

Function SanrenjzRestoreChildTemp
  Push $0
  StrCmp $updateTempActive "1" 0 update_temp_restored
  StrCmp $updateOldTempExists "1" 0 update_temp_remove_original
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$updateOldTemp") i .r0'
  Goto update_tmp_restore
update_temp_remove_original:
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", p 0) i .r0'
update_tmp_restore:
  StrCmp $updateOldTmpExists "1" 0 update_tmp_remove_original
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$updateOldTmp") i .r0'
  Goto update_temp_restore_done
update_tmp_remove_original:
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", p 0) i .r0'
update_temp_restore_done:
  StrCpy $updateTempActive "0"
update_temp_restored:
  Pop $0
FunctionEnd

Function SanrenjzUseChildTemp
  Push $0
  StrCpy $updateTempReady "0"
  ClearErrors
  ReadEnvStr $updateOldTemp TEMP
  StrCpy $updateOldTempExists "1"
  IfErrors 0 +2
  StrCpy $updateOldTempExists "0"
  ClearErrors
  ReadEnvStr $updateOldTmp TMP
  StrCpy $updateOldTmpExists "1"
  IfErrors 0 +2
  StrCpy $updateOldTmpExists "0"
  ClearErrors
  CreateDirectory "$updateTransactionDir\active\temp"
  IfErrors update_temp_setup_done
  ; 只修改安装器进程环境。旧卸载器的逐文件 Rename 必须在安装目录同盘完成。
  StrCpy $updateTempActive "1"
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$updateTransactionDir\active\temp") i .r0'
  StrCmp $0 0 update_temp_setup_failed
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$updateTransactionDir\active\temp") i .r0'
  StrCmp $0 0 update_temp_setup_failed
  StrCpy $updateTempReady "1"
  Goto update_temp_setup_done
update_temp_setup_failed:
  Call SanrenjzRestoreChildTemp
update_temp_setup_done:
  Pop $0
FunctionEnd

Function SanrenjzRollbackUpdate
  Call SanrenjzRestoreChildTemp
  ; 预检拒绝和开始安装前取消都不触发事务，也不能创建空备份目录。
  StrCmp $updatePrepareAttempted "1" 0 update_rollback_done
  StrCmp $updateTransactionDir "" update_rollback_done
  IfFileExists "$PLUGINSDIR\windows-update-transaction.ps1" 0 update_rollback_done
  ; 主安装节会再次进入 INSTDIR，回滚整目录前同样必须释放当前目录句柄。
  SetOutPath "$PLUGINSDIR"
  StrCpy $updateHelperPhase rollback
  Call SanrenjzRunUpdateHelper
  StrCmp $updateHelperExit "0" update_rollback_done
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "安装未完成，自动恢复旧程序也未完成。请保留以下恢复材料并查看 transaction.log：$updateTransactionDir" /SD IDOK
update_rollback_done:
FunctionEnd

Function SanrenjzUpdateOnUserAbort
  Call SanrenjzRollbackUpdate
FunctionEnd

Function .onInstFailed
  Call SanrenjzRollbackUpdate
FunctionEnd

Function .onGUIEnd
  Call SanrenjzRollbackUpdate
FunctionEnd
!endif

; 两种可执行文件都按 Unicode 完整路径检查，不能用 tasklist/find 文本匹配中文名。
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.SanrenjzCheckAppRunning
  !else
    Call SanrenjzCheckAppRunning
  !endif
!macroend

!macro customHeader
!ifdef BUILD_UNINSTALLER
Function un.SanrenjzCheckAppRunning
  Push $0
  Push $1
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=windows-update-transaction.ps1 "${SANRENJZ_UPDATE_HELPER}"
un_update_close_app_retry:
  ; un.onInit 的首次检查早于 initMultiUser；关闭进程不依赖注册表安装范围。
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-update-transaction.ps1" -Phase close-app -InstallDir "$INSTDIR" -UninstallerName "${UNINSTALL_FILENAME}" -Version "${VERSION}" -AppId "${APP_ID}"'
  Pop $0
  Pop $1
  StrCmp $0 "0" un_update_close_app_done
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP "无法关闭当前安装目录中的三人聚智，卸载已停止。请保存工作并关闭程序后重试。返回：$0$\r$\n详情：$1" /SD IDCANCEL IDRETRY un_update_close_app_retry
  SetErrorLevel 2
  Pop $1
  Pop $0
  Abort
un_update_close_app_done:
  Pop $1
  Pop $0
FunctionEnd
!else
Function SanrenjzInitializeUpdateHelper
  ; common.nsh 在自定义 include 之后加载，编译期标识必须延后到本宏展开。
  StrCpy $updateUninstallerName "${UNINSTALL_FILENAME}"
  StrCpy $updateProductVersion "${VERSION}"
  StrCpy $updateProductAppId "${APP_ID}"
  StrCpy $updateRegistryKey "${INSTALL_REGISTRY_KEY}"
  StrCpy $updateUninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"
  StrCpy $updateRegistryHive "CurrentUser"
  ${If} $installMode == "all"
    StrCpy $updateRegistryHive "LocalMachine"
  ${EndIf}
  StrCpy $updateTransactionDir "$INSTDIR.sanrenjz-update-backup"
  ReadRegStr $updateRegisteredDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; 同时存在两种安装范围时，不允许 stock 卸载器操作另一个未保护的目录。
  ${If} $installMode == "all"
    ReadRegStr $updateSecondaryRegisteredDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $updateSecondaryRegisteredDir != ""
      SetErrorLevel 2
      MessageBox MB_ICONSTOP "检测到当前用户另有安装记录。为保护另一份安装及数据，本次安装已停止。" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
  InitPluginsDir
  ; .onInit 曾把工作目录设为 INSTDIR，必须先释放，才能原子暂存整个旧目录。
  SetOutPath "$PLUGINSDIR"
  IfFileExists "$PLUGINSDIR\windows-update-transaction.ps1" update_helper_initialized
  File /oname=windows-update-transaction.ps1 "${SANRENJZ_UPDATE_HELPER}"
update_helper_initialized:
FunctionEnd

; 最终目录确认后才开始事务，打开和取消安装不会生成备份。
Section "-prepareUpdateTransaction"
  ; stock 的静默提权发生在后面的主节，不能先暂存再由另一个进程接管事务。
  ${If} $installMode == "all"
    ${IfNot} ${UAC_IsAdmin}
      SetErrorLevel 2
      MessageBox MB_ICONSTOP "这份旧程序属于全用户安装，请以管理员身份运行安装器后重试。尚未移动旧程序或用户数据。" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
  ; 安装器必须按真实路径调用 Unicode 进程 API，不能用 tasklist/find 文本匹配中文名。
  !insertmacro CHECK_APP_RUNNING
update_prepare_retry:
  StrCpy $updatePrepareAttempted "1"
  StrCpy $updateHelperPhase prepare
  Call SanrenjzRunUpdateHelper
  StrCmp $updateHelperExit "0" update_prepare_ready
  SetErrorLevel 2
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP "无法安全准备安装更新，旧程序和恢复材料已保留。请检查日志后重试：$updateTransactionDir\transaction.log$\r$\n返回：$updateHelperExit" /SD IDCANCEL IDRETRY update_prepare_retry
  Abort
update_prepare_ready:
  Call SanrenjzUseChildTemp
  StrCmp $updateTempReady "1" update_prepare_done
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "无法准备旧版卸载器的同盘临时目录，安装已停止。恢复材料保留在：$updateTransactionDir" /SD IDOK
  Abort
update_prepare_done:
SectionEnd
!endif
!macroend

!macro SanrenjzCheckOldUninstallResult suffix
  ; stock 函数大量复用寄存器，先保存真实退出结果，再恢复进程环境。
  StrCpy $updateUninstallExit $R0
  StrCpy $updateUninstallFailed "0"
  IfErrors 0 +2
  StrCpy $updateUninstallFailed "1"
  Call SanrenjzRestoreChildTemp
  StrCmp $updateUninstallFailed "0" 0 update_uninstall_failed_${suffix}
  StrCmp $updateUninstallExit "0" update_uninstall_done_${suffix}
update_uninstall_failed_${suffix}:
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "旧版卸载未完成，安装已停止，原安装事务保留供重试。返回：$updateUninstallExit。详情见：$updateTransactionDir\transaction.log" /SD IDOK
  Call SanrenjzRollbackUpdate
  Quit
update_uninstall_done_${suffix}:
!macroend

!macro customUnInstallCheck
  !insertmacro SanrenjzCheckOldUninstallResult shell
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro SanrenjzCheckOldUninstallResult user
!macroend

!macro customInstall
  Call SanrenjzRestoreChildTemp
update_restore_retry:
  StrCpy $updateHelperPhase restore
  Call SanrenjzRunUpdateHelper
  StrCmp $updateHelperExit "0" update_restore_done
  SetErrorLevel 2
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP "新版程序已解包，用户目录尚未完整恢复。恢复材料继续保留，重试将使用同一事务：$updateTransactionDir$\r$\n详情见 transaction.log；返回：$updateHelperExit" /SD IDCANCEL IDRETRY update_restore_retry
  Abort
update_restore_done:
  ; 数据已提交，退出回调不能再回滚或重新创建已清理的备份目录。
  StrCpy $updatePrepareAttempted "0"
  ; 用户在同一安装窗口重试成功后，不遗留先前失败的进程退出码。
  SetErrorLevel 0
update_cleanup_retry:
  StrCpy $updateHelperPhase cleanup
  Call SanrenjzRunUpdateHelper
  StrCmp $updateHelperExit "0" update_cleanup_done
  DetailPrint "新版与用户资料已恢复成功，旧恢复材料尚未清理：$updateTransactionDir；返回：$updateHelperExit"
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "新版程序与用户资料已恢复成功，旧恢复材料尚未清理。可以重试清理，或取消清理并完成安装。$\r$\n保留位置：$updateTransactionDir$\r$\n返回：$updateHelperExit$\r$\n详情：$updateHelperOutput" /SD IDCANCEL IDRETRY update_cleanup_retry
update_cleanup_done:
  ; 清理失败不等于安装失败，未核验的恢复材料继续保留。
  SetErrorLevel 0
!macroend
