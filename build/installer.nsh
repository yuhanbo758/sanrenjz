!ifndef BUILD_UNINSTALLER
  Var preservedDataDir
!endif

!macro preserveDirectory source name
  IfFileExists "${source}\*.*" 0 preserve_${name}_done
  CreateDirectory "$preservedDataDir\${name}"
  ClearErrors
  CopyFiles /SILENT "${source}\*.*" "$preservedDataDir\${name}"
  IfErrors 0 preserve_${name}_done
  MessageBox MB_ICONSTOP "无法完整备份 ${name}，安装已停止。现有程序及备份保留在：$preservedDataDir"
  Abort
preserve_${name}_done:
!macroend

!macro restoreDirectory name
  IfFileExists "$preservedDataDir\${name}\*.*" 0 restore_${name}_done
  CreateDirectory "$INSTDIR\${name}"
  ClearErrors
  CopyFiles /SILENT "$preservedDataDir\${name}\*.*" "$INSTDIR\${name}"
  IfErrors 0 restore_${name}_done
  MessageBox MB_ICONSTOP "无法完整恢复 ${name}，安装已停止。所有备份仍保留在：$preservedDataDir"
  Abort
restore_${name}_done:
!macroend

!macro customInit
  ; 放在安装目录旁边，避免旧版卸载范围；残留备份先保留，禁止覆盖。
  StrCpy $preservedDataDir "$INSTDIR.sanrenjz-update-backup"
  IfFileExists "$preservedDataDir\*.*" 0 preserve_start
  MessageBox MB_ICONSTOP "发现上次升级保留的备份，请先恢复或移到安全位置后重新安装：$preservedDataDir"
  Abort
preserve_start:
  !insertmacro preserveDirectory "$INSTDIR\plugins" plugins
  !insertmacro preserveDirectory "$INSTDIR\python-plugins" python-plugins
  !insertmacro preserveDirectory "$INSTDIR\plugin-configs" plugin-configs
  !insertmacro preserveDirectory "$INSTDIR\runtime" runtime
!macroend

!macro customInstall
  ; 全部恢复成功后才清理备份，任何一步失败均保留完整备份。
  !insertmacro restoreDirectory plugins
  !insertmacro restoreDirectory python-plugins
  !insertmacro restoreDirectory plugin-configs
  !insertmacro restoreDirectory runtime
  RMDir /r "$preservedDataDir"
!macroend
