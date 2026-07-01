#!/bin/bash
# This file is executed every time the dev container starts up or resumes.
# It automatically checks if tailscaled, sshd, and socat are running and starts them if not.

LOG_FILE="/workspaces/agent-swarm/.devcontainer/post-start-setup.log"
echo "=== $(date) ===" >> "$LOG_FILE"
echo "INFO: Checking SSH service status..." >> "$LOG_FILE"
if ! pgrep -x sshd >/dev/null; then
    echo "INFO: SSH service not running. Starting it..." >> "$LOG_FILE"
    sudo service ssh start >> "$LOG_FILE" 2>&1
else
    echo "INFO: SSH service is already running." >> "$LOG_FILE"
fi

echo "INFO: Checking Tailscale status..." >> "$LOG_FILE"
if ! pgrep -x tailscaled >/dev/null; then
    echo "INFO: Tailscale daemon not running. Starting it..." >> "$LOG_FILE"
    sudo start-stop-daemon --start --background --oknodo --exec /usr/sbin/tailscaled -- --state=/var/lib/tailscale/tailscaled.state >> "$LOG_FILE" 2>&1
    # Sleep a bit and check if it successfully started
    sleep 2
    if pgrep -x tailscaled >/dev/null; then
        echo "INFO: Tailscale daemon started successfully." >> "$LOG_FILE"
    else
        echo "ERROR: Tailscale daemon failed to start." >> "$LOG_FILE"
    fi
else
    echo "INFO: Tailscale daemon is already running." >> "$LOG_FILE"
fi

echo "INFO: Checking socat tunnel status..." >> "$LOG_FILE"
if ! pgrep -x socat >/dev/null; then
    echo "INFO: socat tunnel not running. Starting it..." >> "$LOG_FILE"
    sudo start-stop-daemon --start --background --oknodo --chuid node:node --exec /usr/bin/socat -- TCP-LISTEN:9222,fork,bind=127.0.0.1 TCP:host.docker.internal:9222 >> "$LOG_FILE" 2>&1
    sleep 1
    if pgrep -x socat >/dev/null; then
        echo "INFO: socat tunnel started successfully." >> "$LOG_FILE"
    else
        echo "ERROR: socat tunnel failed to start." >> "$LOG_FILE"
    fi
else
    echo "INFO: socat tunnel is already running." >> "$LOG_FILE"
fi

echo "INFO: Services check/startup complete." >> "$LOG_FILE"
