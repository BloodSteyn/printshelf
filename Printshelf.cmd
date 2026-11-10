@echo off
rem Starts Printshelf without keeping a console window open.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" call npm install
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
