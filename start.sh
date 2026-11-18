#!/usr/bin/env sh
# Serves SongSnip at http://127.0.0.1:8888 (Spotify requires 127.0.0.1, not "localhost").
cd "$(dirname "$0")"
PORT="${PORT:-8888}"
echo "SongSnip running at  http://127.0.0.1:$PORT/   (Ctrl+C to stop)"
( sleep 1; (command -v open >/dev/null && open "http://127.0.0.1:$PORT/") || (command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:$PORT/") ) >/dev/null 2>&1 &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
