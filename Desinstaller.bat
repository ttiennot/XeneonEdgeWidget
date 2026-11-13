@echo off
rem Arrete Xeneon Edge Widget et retire son lancement au demarrage de Windows.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
echo.
pause
