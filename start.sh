#!/usr/bin/env bash
set -euo pipefail

echo "Starting Agentic OS Dashboard..."
echo ""

# Check if server.py exists
if [ ! -f server.py ]; then
    echo "ERROR: server.py not found. Are you in the right directory?"
    exit 1
fi

# Check dependencies
pip3 install -r requirements.txt --quiet 2>/dev/null

# Get port from settings or default
PORT=8080
if command -v python3 &>/dev/null; then
    PORT=$(python3 -c "import json; f=open('data/settings.json'); d=json.load(f); print(d.get('dashboard',{}).get('port',8080)); f.close()" 2>/dev/null || echo "8080")
fi

echo "Dashboard: http://127.0.0.1:${PORT}"
echo "Press Ctrl+C to stop"
echo ""

# Start server
python3 server.py --port "${PORT}"
