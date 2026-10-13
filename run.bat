@echo off
rem Opens the Windows pack and runs Rasiel (PhoneControl.exe).
title Rasiel
cd /d "%~dp0dist\windows"
call "%~dp0dist\windows\run.bat"
