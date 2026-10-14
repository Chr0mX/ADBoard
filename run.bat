@echo off
rem Opens the Windows pack and runs Rasiel (RasielControl.exe).
title Rasiel
cd /d "%~dp0dist\windows"
call "%~dp0dist\windows\run.bat"
