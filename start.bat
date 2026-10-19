@echo off
setlocal
cd /d "%~dp0"

set PORT=8765

python -c "import fastapi, uvicorn, openpyxl, multipart" 2>nul
if errorlevel 1 (
  echo Installing dependencies...
  python -m pip install -r requirements.txt || goto :fail
)

start "" "http://127.0.0.1:%PORT%"
echo CCS / MS4 Price Upload Tool is running on http://127.0.0.1:%PORT%
echo Close this window or use the Log out icon to stop it.
python -m uvicorn app.main:app --host 127.0.0.1 --port %PORT%
goto :eof

:fail
echo.
echo Failed to install dependencies.
pause
