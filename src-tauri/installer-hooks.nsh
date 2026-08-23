; DSH Desktop — NSIS installer hooks (CLI isolation contract)
; ---------------------------------------------------------------------------
; The global `dsh` npm CLI and DSH Desktop are fully decoupled:
;
;   * The Desktop installer NEVER installs, upgrades, or uninstalls the CLI.
;   * The Desktop uninstaller NEVER deletes the npm global directory
;     (%APPDATA%\npm) or the `dsh` command shims (dsh.cmd / dsh.ps1 / dsh)
;     that live inside it.
;
; These hooks snapshot the CLI shim before uninstall and re-check it after,
; so any future regression that removes the CLI is surfaced at uninstall time
; instead of silently breaking `dsh` on the user's machine.
;
; This file is injected by Tauri's `bundle.windows.nsis.installerHooks` and is
; !include'd at the top of the generated installer.nsi (after MUI2/FileFunc),
; so `${If}` / `${FileExists}` / `SetShellVarContext` are all available here.
; ---------------------------------------------------------------------------

Var DshCliShimPresent
Var DshCliShimAfter
Var DshCliDetected

!macro NSIS_HOOK_PREINSTALL
  ; Warn (non-silent) when the global `dsh` CLI is not installed, since the
  ; Desktop relies on `dsh web` to launch its backend. The installer never
  ; installs the CLI itself — it only reminds the user.
  SetShellVarContext current
  StrCpy $DshCliDetected "0"
  ${If} ${FileExists} "$APPDATA\npm\dsh.cmd"
    StrCpy $DshCliDetected "1"
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\npm\dsh"
    StrCpy $DshCliDetected "1"
  ${EndIf}
  ${If} $DshCliDetected == "0"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "未检测到 dsh 命令。DSH Desktop 依赖 dsh 后端才能启动 Web UI。$\r$\n请先安装：npm install -g @deepseek-ai/dsh"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Snapshot whether the global `dsh` CLI shim exists before we delete anything.
  SetShellVarContext current
  StrCpy $DshCliShimPresent "0"
  ${If} ${FileExists} "$APPDATA\npm\dsh.cmd"
    StrCpy $DshCliShimPresent "1"
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\npm\dsh"
    StrCpy $DshCliShimPresent "1"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Verify the global `dsh` CLI survived the uninstall. DSH Desktop must never
  ; remove it — only warn here; the CLI is owned by npm, not by this app.
  SetShellVarContext current
  ${If} $DshCliShimPresent == "1"
    StrCpy $DshCliShimAfter "0"
    ${If} ${FileExists} "$APPDATA\npm\dsh.cmd"
      StrCpy $DshCliShimAfter "1"
    ${EndIf}
    ${If} ${FileExists} "$APPDATA\npm\dsh"
      StrCpy $DshCliShimAfter "1"
    ${EndIf}
    ${If} $DshCliShimAfter == "0"
      DetailPrint "WARNING: the global dsh CLI under $APPDATA\npm was removed during uninstall."
      DetailPrint "         DSH Desktop must not uninstall the CLI; this is a regression."
    ${EndIf}
  ${EndIf}
!macroend
