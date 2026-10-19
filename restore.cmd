@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0factory-zh.ps1" -Action restore
if errorlevel 1 pause
