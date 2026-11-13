@echo off
rem Installe Xeneon Edge Widget (widgets iCUE + agent) : double-cliquez sur ce fichier.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
