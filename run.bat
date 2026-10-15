@echo off
rem Opens the Windows pack and runs ADBoard (ADBoard.exe).
title ADBoard
cd /d "%~dp0dist\windows"
call "%~dp0dist\windows\run.bat"
