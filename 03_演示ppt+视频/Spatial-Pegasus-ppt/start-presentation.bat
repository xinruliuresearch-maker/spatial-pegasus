@echo off
cd /d "%~dp0"
start "Spatial Pegasus Presentation Server" /B py -m http.server 8787 --bind 127.0.0.1
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8787/index.html#1"
