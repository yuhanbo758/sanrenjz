!ifndef BUILD_UNINSTALLER
  Var preservedDataDir
  Var previousDataDir
  Var backupSuffix
  Var directoryCopyExit
  Var directoryCopyOutput
  Var unsafePreservedPath

Function SanrenjzExtendedPath
  Exch $0
  Push $1
  StrCpy $1 $0 4
  StrCmp $1 "\\?\" extended_path_done
  StrCpy $1 $0 2
  StrCmp $1 "\\" 0 extended_path_local
  StrCpy $0 $0 "" 2
  StrCpy $0 "\\?\UNC\$0"
  Goto extended_path_done
extended_path_local:
  StrCpy $0 "\\?\$0"
extended_path_done:
  Pop $1
  Exch $0
FunctionEnd

Function SanrenjzCheckPreservedLinks
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  System::Call 'kernel32::GetFileAttributesW(w "$R0") i .s'
  Pop $R4
  IntOp $R4 $R4 & 0x400
  StrCmp $R4 0 check_preserved_entries
  StrCpy $unsafePreservedPath $R0
  Goto check_preserved_return
check_preserved_entries:
  FindFirst $R1 $R2 "$R0\*"
  IfErrors check_preserved_return
check_preserved_next:
  StrCmp $R2 "." check_preserved_advance
  StrCmp $R2 ".." check_preserved_advance
  StrCpy $R3 "$R0\$R2"
  System::Call 'kernel32::GetFileAttributesW(w "$R3") i .s'
  Pop $R4
  IntOp $R4 $R4 & 0x400
  StrCmp $R4 0 check_preserved_directory
  StrCpy $unsafePreservedPath $R3
  Goto check_preserved_close
check_preserved_directory:
  IfFileExists "$R3\." 0 check_preserved_advance
  Push $R3
  Call SanrenjzCheckPreservedLinks
  StrCmp $unsafePreservedPath "" check_preserved_advance check_preserved_close
check_preserved_advance:
  FindNext $R1 $R2
  IfErrors check_preserved_close check_preserved_next
check_preserved_close:
  FindClose $R1
check_preserved_return:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
!endif

!macro copyDirectoryLongPath source destination log
  ; Shell CopyFiles 在目标路径超过 MAX_PATH 时失败；Robocopy 原生支持长路径。
  ; 不使用 /MIR、/MOVE 或 /256；保留空目录和属性，链接按链接复制，不遍历外部目标。
  nsExec::ExecToStack '"$SYSDIR\robocopy.exe" "${source}" "${destination}" /E /COPY:DAT /DCOPY:DAT /SL /SJ /R:1 /W:1 /NP /NFL /NDL /UNILOG:"${log}"'
  Pop $directoryCopyExit
  Pop $directoryCopyOutput
!macroend

!macro preserveDirectory source name
  IfFileExists "${source}\." 0 preserve_${name}_done
  ; 旧 NSIS 卸载器会沿目录联接递归删除，必须在卸载前拒绝，不能只跳过复制。
  StrCpy $unsafePreservedPath ""
  Push "${source}"
  Call SanrenjzExtendedPath
  Call SanrenjzCheckPreservedLinks
  StrCmp $unsafePreservedPath "" preserve_${name}_copy
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "${name} 中发现目录链接或无法读取属性的路径，安装已停止，尚未卸载旧程序。请检查后重试：$unsafePreservedPath" /SD IDOK
  Abort
preserve_${name}_copy:
  StrCpy $directoryCopyExit "create-directory-error"
  ClearErrors
  CreateDirectory "$preservedDataDir\${name}"
  IfErrors preserve_${name}_failed
  !insertmacro copyDirectoryLongPath "${source}" "$preservedDataDir\${name}" "$preservedDataDir\backup-${name}.log"
  StrCmp $directoryCopyExit "error" preserve_${name}_failed
  StrCmp $directoryCopyExit "timeout" preserve_${name}_failed
  ; Robocopy 的 0～7 都是成功状态，8 及以上表示复制失败。
  IntCmpU $directoryCopyExit 8 preserve_${name}_failed preserve_${name}_done preserve_${name}_failed
preserve_${name}_failed:
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "无法完整备份 ${name}，安装已停止。现有程序及备份保留在：$preservedDataDir$\r$\n复制返回：$directoryCopyExit。具体原因见：$preservedDataDir\backup-${name}.log" /SD IDOK
  Abort
preserve_${name}_done:
!macroend

!macro restoreDirectory name
  IfFileExists "$preservedDataDir\${name}\." 0 restore_${name}_done
  StrCpy $directoryCopyExit "create-directory-error"
  ClearErrors
  CreateDirectory "$INSTDIR\${name}"
  IfErrors restore_${name}_failed
  !insertmacro copyDirectoryLongPath "$preservedDataDir\${name}" "$INSTDIR\${name}" "$preservedDataDir\restore-${name}.log"
  StrCmp $directoryCopyExit "error" restore_${name}_failed
  StrCmp $directoryCopyExit "timeout" restore_${name}_failed
  IntCmpU $directoryCopyExit 8 restore_${name}_failed restore_${name}_done restore_${name}_failed
restore_${name}_failed:
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "无法完整恢复 ${name}，安装已停止。所有备份仍保留在：$preservedDataDir$\r$\n复制返回：$directoryCopyExit。具体原因见：$preservedDataDir\restore-${name}.log" /SD IDOK
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
  ; 清理也必须使用扩展路径，否则复制成功后仍会残留超长路径文件。
  Push $preservedDataDir
  Call SanrenjzExtendedPath
  Pop $0
  RMDir /r "$0"
  StrCmp $previousDataDir "" preserve_install_done
  MessageBox MB_ICONINFORMATION "安装已完成，上次升级的恢复材料仍保留在以下位置。如需找回旧文件，可从这里检查：$previousDataDir" /SD IDOK
preserve_install_done:
!macroend
