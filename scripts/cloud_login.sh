#!/bin/bash
set -e


# Doppler login/setup
if command -v doppler &> /dev/null; then
  if doppler whoami &> /dev/null; then
    echo "Already logged in to Doppler."
  else
    echo "INFO: Logging into Doppler..."
    doppler login --no-check-version --no-timeout --yes
    echo "INFO: Setting up Doppler..."
    doppler setup --no-interactive --project agent-swarm --config dev
  fi
else
  echo "Doppler CLI not found. Skipping Doppler login."
fi







echo "Cloud login script finished."
