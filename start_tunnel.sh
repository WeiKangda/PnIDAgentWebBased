#!/bin/bash
# Start Flask app + Cloudflare Named Tunnel
# Fixed URL: https://pnid-agent.com
# Usage: bash start_tunnel.sh

cd "$(dirname "$0")"

# Start Flask app in background
python app.py &
FLASK_PID=$!
echo "Flask app started (PID: $FLASK_PID) on port 5001"

# Give Flask a moment to start
sleep 2

# Start Cloudflare Named Tunnel
echo "Starting Cloudflare Tunnel..."
echo "Your fixed URL: https://pnid-agent.com"
echo "Press Ctrl+C to stop"
cloudflared tunnel run pnid-agent

# Cleanup when tunnel exits
kill $FLASK_PID 2>/dev/null
echo "Flask app stopped"
