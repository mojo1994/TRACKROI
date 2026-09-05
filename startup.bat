@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND_PORT=4100"
set "FRONTEND_PORT=5180"

echo ============================================
echo  TrackROI - Inicializador
echo ============================================
echo.

echo [1/3] Liberando portas %BACKEND_PORT% e %FRONTEND_PORT% caso estejam em uso...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %BACKEND_PORT%,%FRONTEND_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host ('  -> PID ' + $_ + ' encerrado') }"

echo [2/3] Iniciando servidores...
start "TrackROI Backend" cmd /k "cd /d ""%ROOT%backend"" && npm run dev"
start "TrackROI Frontend" cmd /k "cd /d ""%ROOT%frontend"" && npm run dev"

echo [3/3] Aguardando servidores subirem...
timeout /t 5 /nobreak >nul

echo Abrindo o painel em http://localhost:%FRONTEND_PORT%
start "" "http://localhost:%FRONTEND_PORT%"

endlocal