#!/bin/zsh
cd "${0:A:h}"
PORT=8787
python3 -m http.server "$PORT" --bind 127.0.0.1 &
SERVER_PID=$!
sleep 0.6
open "http://127.0.0.1:${PORT}/index.html#1"
wait "$SERVER_PID"
