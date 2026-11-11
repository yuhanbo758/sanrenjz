!ifndef BUILD_UNINSTALLER
  Var preservedDataDir
  Var previousDataDir
  Var backupSuffix
!endif

!macro preserveDirectory source name
  IfFileExists "${source}\." 0 preserve_${name}_done
  ClearErrors
  CreateDirectory "$preservedDataDir\${name}"
  IfErrors preserve_${name}_failed
  IfFileExists "${source}\*.*" 0 preserve_${name}_done
  ClearErrors
  CopyFiles /SILENT "${source}\*.*" "$preservedDataDir\${name}"
  IfErrors 0 preserve_${name}_done
preserve_${name}_failed:
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "无法完整备份 ${name}，安装已停止。现有程序及备份保留在：$preservedDataDir" /SD IDOK
  Abort
preserve_${name}_done:
!macroend

!macro restoreDirectory name
  IfFileExists "$preservedDataDir\${name}\." 0 restore_${name}_done
  ClearErrors
  CreateDirectory "$INSTDIR\${name}"
  IfErrors restore_${name}_failed
  IfFileExists "$preservedDataDir\${name}\*.*" 0 restore_${name}_done
  ClearErrors
  CopyFiles /SILENT "$preservedDataDir\${name}\*.*" "$INSTDIR\${name}"
  IfErrors 0 restore_${name}_done
restore_${name}_failed:
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "无法完整恢复 ${name}，安装已停止。所有备份仍保留在：$preservedDataDir" /SD IDOK
  Abort
restore_${name}_done:
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
; 隐藏节在用户确认最终目录后、旧版卸载前执行；打开或取消安装不产生备份。
Section "-preserveData"
  !insertmacro CHECK_APP_RUNNING
  StrCpy $preservedDataDir "$INSTDIR.sanrenjz-update-backup"
  StrCpy $previousDataDir ""
  IfFileExists "$preservedDataDir" 0 preserve_start
  ; 上次可能只备份了一部分，不能直接覆盖当前插件，也不能删除恢复材料。
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $backupSuffix $0
preserve_previous_name:
  StrCpy $previousDataDir "$preservedDataDir.previous-$backupSuffix"
  IfFileExists "$previousDataDir" 0 preserve_previous_move
  IntOp $backupSuffix $backupSuffix + 1
  Goto preserve_previous_name
preserve_previous_move:
  ClearErrors
  Rename "$preservedDataDir" "$previousDataDir"
  IfErrors 0 preserve_previous_done
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "无法安全保留上次升级备份，安装已停止。请关闭占用文件的程序后重试：$preservedDataDir" /SD IDOK
  Abort
preserve_previous_done:
  DetailPrint "上次升级备份已保留：$previousDataDir"
preserve_start:
  !insertmacro preserveDirectory "$INSTDIR\plugins" plugins
  !insertmacro preserveDirectory "$INSTDIR\python-plugins" python-plugins
  !insertmacro preserveDirectory "$INSTDIR\plugin-configs" plugin-configs
  !insertmacro preserveDirectory "$INSTDIR\runtime" runtime
SectionEnd
!endif
!macroend

!macro customInstall
  ; 全部恢复成功后才清理备份，任何一步失败均保留完整备份。
  !insertmacro restoreDirectory plugins
  !insertmacro restoreDirectory python-plugins
  !insertmacro restoreDirectory plugin-configs
  !insertmacro restoreDirectory runtime
  RMDir /r "$preservedDataDir"
  StrCmp $previousDataDir "" preserve_install_done
  MessageBox MB_ICONINFORMATION "安装已完成，上次升级的恢复材料仍保留在以下位置。如需找回旧文件，可从这里检查：$previousDataDir" /SD IDOK
preserve_install_done:
!macroend
