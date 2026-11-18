@echo off
cd /d "%~dp0"
echo SongSnip running at http://127.0.0.1:8888/  (close this window to stop)
start "" http://127.0.0.1:8888/
python -m http.server 8888 --bind 127.0.0.1
