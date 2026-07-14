; Callboard Windows installer.
;
; Build: makensis build\windows\install.nsi  (after `npm run build:win`,
; which must have produced dist\callboard.exe)
;
; Installs to Program Files (needs admin -- RequestExecutionLevel below),
; adds a Start Menu shortcut, launches the app (which drops to the system
; tray), and opens a firewall hole for the port so other devices on the
; LAN can actually reach it (Windows Firewall blocks unsolicited inbound
; connections to new listeners by default).
;
; No auto-start-on-login entry: like the macOS build, Callboard is an app
; you launch (from the Start Menu) and that then lives in the tray until
; you Quit it -- it doesn't run itself in the background across reboots.
;
; This build is not code-signed, so expect a SmartScreen "Windows
; protected your PC" prompt on first run -- click "More info" -> "Run
; anyway".

!define APP_NAME "Callboard"
!define APP_EXE "callboard.exe"
!define APP_ICON "app-icon.ico"
!define FIREWALL_RULE_NAME "Callboard"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME}"
OutFile "..\..\dist\CallboardSetup.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
RequestExecutionLevel admin
Icon "..\icons\${APP_ICON}"
UninstallIcon "..\icons\${APP_ICON}"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "..\..\dist\${APP_EXE}"
  File "..\icons\${APP_ICON}"

  ; Start Menu entry -- searchable/pinnable, the way to (re)launch
  ; Callboard after a Quit. This is the only launcher shortcut: there's
  ; deliberately no Startup-folder entry (see header note).
  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_ICON}"

  ; Allow inbound connections on the configured port from the LAN --
  ; without this, other devices on the network get a connection timeout
  ; even with the right IP from Connect. Scoped to this program (not a
  ; blanket port rule)
  ; so it only opens when Callboard itself is listening.
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow program="$INSTDIR\${APP_EXE}" enable=yes profile=private,domain'

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_ICON}"

  ; Start it now instead of waiting for the next login.
  Exec '"$INSTDIR\${APP_EXE}"'

  MessageBox MB_OK "${APP_NAME} installed and running.$\r$\nOpen the Settings drawer -> Connect for this PC's address and QR code to open from any device on this network."
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}"'
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\${APP_ICON}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"

  MessageBox MB_OK "${APP_NAME} uninstalled. Settings in %APPDATA%\${APP_NAME} were left in place -- delete that folder by hand if you want them gone too."
SectionEnd
