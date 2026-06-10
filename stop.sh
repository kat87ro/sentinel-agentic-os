#!/usr/bin/env bash
set -euo pipefail

echo "Stopping Agentic OS Dashboard..."
echo ""

# Resolve the port the same way start.sh does (settings.json → default 8080).
PORT=8080
if command -v python3 &>/dev/null; then
    PORT=$(python3 -c "import json; f=open('data/settings.json'); d=json.load(f); print(d.get('dashboard',{}).get('port',8080)); f.close()" 2>/dev/null || echo "8080")
fi

# Find the server PID(s): first by who is listening on the port, then fall back
# to matching the server.py process. Guard every lookup so an empty result
# doesn't trip `set -e`.
PIDS=""
if command -v lsof &>/dev/null; then
    PIDS=$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)
fi
# Match server.py as its own argument (preceded by a space or path slash) so we
# don't also match unrelated processes like an editor's lsp_server.py.
if [ -z "${PIDS}" ]; then
    PIDS=$(pgrep -f "[ /]server\.py" 2>/dev/null || true)
fi

if [ -z "${PIDS}" ]; then
    echo "No running server found on port ${PORT}."
    exit 0
fi

for PID in ${PIDS}; do
    echo "Sending SIGTERM to PID ${PID} (port ${PORT})..."
    kill "${PID}" 2>/dev/null || true
done

# Give the scheduler a moment to wind down, then escalate if still alive.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    STILL=""
    for PID in ${PIDS}; do
        if kill -0 "${PID}" 2>/dev/null; then
            STILL="${STILL} ${PID}"
        fi
    done
    if [ -z "${STILL}" ]; then
        echo "Server stopped."
        exit 0
    fi
    sleep 0.5
done

echo "Process(es) did not exit gracefully; sending SIGKILL:${STILL}"
for PID in ${STILL}; do
    kill -9 "${PID}" 2>/dev/null || true
done
echo "Server stopped (forced)."
