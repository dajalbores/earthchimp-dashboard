@echo off
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SRC=%~dp0start-watcher-silent.vbs
set DEST=%STARTUP%\wyldsson-auto-rename.vbs

echo Copying watcher to Startup folder...
copy "%SRC%" "%DEST%" /Y

if %errorlevel%==0 (
  echo.
  echo SUCCESS! The auto-rename watcher will now start automatically every time Windows starts.
  echo.
  echo To stop auto-start, run remove-autostart.bat
) else (
  echo.
  echo ERROR: Could not copy to Startup folder. Try running as Administrator.
)
pause
