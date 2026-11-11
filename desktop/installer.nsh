# -*- coding: utf-8 -*-
!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

!ifndef TUJI_STORAGE_DIRECTORY
  !define TUJI_STORAGE_DIRECTORY "$APPDATA\Tuji"
!endif
!ifndef TUJI_LEGACY_DATA_DIRECTORY
  !define TUJI_LEGACY_DATA_DIRECTORY "$APPDATA\QIXUE-v2"
!endif

!ifndef BUILD_UNINSTALLER
Var TujiDataDir
Var TujiDataInput
Var TujiDataDialog
Var TujiDataError
Var TujiDataProbe

!macro customInit
  !insertmacro setInstallModePerUser
  SetShellVarContext current
  StrCpy $TujiDataDir "${TUJI_LEGACY_DATA_DIRECTORY}"
  IfFileExists "${TUJI_STORAGE_DIRECTORY}\data-directory.txt" 0 +5
    FileOpen $0 "${TUJI_STORAGE_DIRECTORY}\data-directory.txt" r
    FileReadUTF16LE $0 $TujiDataDir
    FileClose $0
    ClearErrors
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/DATA_DIR=" $1
  ${IfNot} ${Errors}
    StrCpy $TujiDataDir $1
  ${EndIf}
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

Function TujiValidateDataDirectory
  StrCpy $TujiDataError ""
  ${If} $TujiDataDir == ""
    StrCpy $TujiDataError "请选择数据存储文件夹。"
    Return
  ${EndIf}
  System::Call 'shlwapi::PathIsRelativeW(w "$TujiDataDir") i.r0'
  ${If} $0 != 0
    StrCpy $TujiDataError "请输入完整的文件夹路径，例如 F:\TujiData。"
    Return
  ${EndIf}
  # NSIS GetFullPathName can reject a not-yet-created folder. Normalize lexically.
  System::Call 'kernel32::GetFullPathNameW(w "$TujiDataDir", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0'
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    StrCpy $TujiDataError "数据目录路径无效或过长。"
    Return
  ${EndIf}
  StrCpy $TujiDataDir $1
  StrLen $0 $TujiDataDir
  ${If} $0 > 3
    StrCpy $1 $TujiDataDir 1 -1
    ${If} $1 == "\"
      StrCpy $TujiDataDir $TujiDataDir -1
    ${EndIf}
  ${EndIf}
  StrCpy $0 $TujiDataDir 2 1
  StrLen $1 $TujiDataDir
  ${If} $0 != ":\"
  ${OrIf} $1 <= 3
    StrCpy $TujiDataError "请选择本机磁盘中的专用文件夹，例如 F:\TujiData。"
    Return
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r2, p 0) i.r0'
  ${If} $0 == 0
    StrCpy $TujiDataError "程序安装目录无效，请重新选择。"
    Return
  ${EndIf}
  StrLen $0 "$2\"
  StrCpy $1 "$TujiDataDir\" $0
  ${If} $1 == "$2\"
    StrCpy $TujiDataError "数据目录不能放在程序安装目录内，请选择独立的文件夹。"
    Return
  ${EndIf}
  StrLen $0 "$TujiDataDir\"
  StrCpy $1 "$2\" $0
  ${If} $1 == "$TujiDataDir\"
    StrCpy $TujiDataError "程序安装目录不能放在数据目录内，请选择独立的文件夹。"
    Return
  ${EndIf}
  # Reject links in either path, so uninstalling cannot follow an alias into data.
  StrCpy $TujiDataProbe $TujiDataDir
  Call TujiCheckDirectoryLinks
  StrCpy $TujiDataProbe $2
  Call TujiCheckDirectoryLinks
  ${If} $TujiDataError != ""
    Return
  ${EndIf}
  ClearErrors
  CreateDirectory "$TujiDataDir"
  ${If} ${Errors}
    StrCpy $TujiDataError "无法创建数据目录，请检查磁盘和文件夹权限。"
    Return
  ${EndIf}
  GetTempFileName $TujiDataProbe "$TujiDataDir"
  ${If} ${Errors}
    StrCpy $TujiDataError "数据目录不可写，请选择当前 Windows 用户有写入权限的文件夹。"
    Return
  ${EndIf}
  Delete "$TujiDataProbe"
FunctionEnd

Function TujiCheckDirectoryLinks
  ${DoWhile} $TujiDataProbe != ""
    System::Call 'kernel32::GetFileAttributesW(w "$TujiDataProbe") i.r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x400
      ${If} $0 != 0
        StrCpy $TujiDataError "安装目录和数据目录不能经过目录链接，请选择实际文件夹路径。"
        Return
      ${EndIf}
    ${EndIf}
    ${GetParent} "$TujiDataProbe" $1
    ${If} $1 == $TujiDataProbe
      Return
    ${EndIf}
    StrCpy $TujiDataProbe $1
  ${Loop}
FunctionEnd

!macro customPageAfterChangeDir
  Page custom TujiDataPageCreate TujiDataPageLeave
  Function TujiDataPageCreate
    !ifdef allowToChangeInstallationDirectory
      Call instFilesPre
    !endif
    !insertmacro MUI_HEADER_TEXT "数据存储位置" "选择笔记、聊天记录和附件的保存位置"
    nsDialogs::Create 1018
    Pop $TujiDataDialog
    ${If} $TujiDataDialog == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 28u "数据文件夹用于保存笔记、聊天记录、附件、连接配置和应用缓存。请选择独立于程序安装目录的位置。"
    Pop $0
    ${NSD_CreateLabel} 0 38u 100% 12u "数据文件夹："
    Pop $0
    ${NSD_CreateDirRequest} 0 54u 78% 14u "$TujiDataDir"
    Pop $TujiDataInput
    ${NSD_CreateBrowseButton} 81% 53u 19% 16u "浏览…"
    Pop $0
    ${NSD_OnClick} $0 TujiBrowseDataDirectory
    ${NSD_CreateLabel} 0 84u 100% 55u "升级默认沿用原目录。选择已有图记数据目录可继续使用其中的数据；选择空目录将从空白数据开始。$\r$\n$\r$\n切换目录不会自动搬迁数据，卸载程序也不会删除这些数据。"
    Pop $0
    nsDialogs::Show
  FunctionEnd
  Function TujiBrowseDataDirectory
    Pop $0
    ${NSD_GetText} $TujiDataInput $TujiDataDir
    nsDialogs::SelectFolderDialog "选择图记数据文件夹" "$TujiDataDir"
    Pop $0
    ${If} $0 != error
      ${NSD_SetText} $TujiDataInput $0
    ${EndIf}
  FunctionEnd
  Function TujiDataPageLeave
    ${NSD_GetText} $TujiDataInput $TujiDataDir
    Call TujiValidateDataDirectory
    ${If} $TujiDataError != ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$TujiDataError"
      Abort
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  Call TujiValidateDataDirectory
  ${If} $TujiDataError != ""
    MessageBox MB_OK|MB_ICONSTOP "$TujiDataError" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  SetShellVarContext current
  ClearErrors
  CreateDirectory "${TUJI_STORAGE_DIRECTORY}"
  FileOpen $0 "${TUJI_STORAGE_DIRECTORY}\data-directory.tmp" w
  ${IfNot} ${Errors}
    FileWriteUTF16LE /BOM $0 "$TujiDataDir"
    FileClose $0
  ${EndIf}
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法保存数据目录设置，请检查用户配置目录权限后重新安装。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  System::Call 'kernel32::MoveFileExW(w "${TUJI_STORAGE_DIRECTORY}\data-directory.tmp", w "${TUJI_STORAGE_DIRECTORY}\data-directory.txt", i 9) i.r0 ?e'
  Pop $1
  ${If} $0 == 0
    ${If} $1 == 17
      # Some redirected profile folders report different devices for sibling files.
      # MOVEFILE_COPY_ALLOWED keeps these profiles usable; WRITE_THROUGH waits for the copy.
      System::Call 'kernel32::MoveFileExW(w "${TUJI_STORAGE_DIRECTORY}\data-directory.tmp", w "${TUJI_STORAGE_DIRECTORY}\data-directory.txt", i 11) i.r0'
    ${EndIf}
  ${EndIf}
  ${If} $0 == 0
    MessageBox MB_OK|MB_ICONSTOP "保存数据目录设置失败，请检查用户配置目录权限后重新运行安装程序。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend
!endif
