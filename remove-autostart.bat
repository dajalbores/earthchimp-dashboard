@echo off
set DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wyldsson-auto-rename.vbs

if exist "%DEST%" (
  del "%DEST%"
  echo Auto-start removed. The watcher will no longer start with Windows.
) else (
  echo Auto-start was not set up. Nothing to remove.
)
pause
