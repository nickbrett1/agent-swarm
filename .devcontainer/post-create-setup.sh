#!/bin/bash
# This file is executed once per session to set up the devcontainer.
# For example:
# echo "Running devcontainer setup script..."
# npm install

CURRENT_USER=$(whoami)
USER_HOME_DIR="$HOME"


echo "INFO: Creating Oh My Zsh custom directories..."
mkdir -p "$USER_HOME_DIR/.oh-my-zsh/custom/themes" "$USER_HOME_DIR/.oh-my-zsh/custom/plugins"

if [ -f "/workspaces/agent-swarm/.devcontainer/.zshrc" ]; then
    echo "INFO: Copying .zshrc to $USER_HOME_DIR/.zshrc"
    cp "/workspaces/agent-swarm/.devcontainer/.zshrc" "$USER_HOME_DIR/.zshrc"
    sudo chown "$CURRENT_USER:$CURRENT_USER" "$USER_HOME_DIR/.zshrc"
else
    echo "INFO: /workspaces/agent-swarm/.devcontainer/.zshrc not found, skipping copy."
fi

if [ -f "/workspaces/agent-swarm/.devcontainer/.p10k.zsh" ]; then
    echo "INFO: Copying .p10k.zsh to $USER_HOME_DIR/.p10k.zsh"
    cp "/workspaces/agent-swarm/.devcontainer/.p10k.zsh" "$USER_HOME_DIR/.p10k.zsh"
    sudo chown "$CURRENT_USER:$CURRENT_USER" "$USER_HOME_DIR/.p10k.zsh"
else
    echo "INFO: /workspaces/agent-swarm/.devcontainer/.p10k.zsh not found, skipping copy."
fi

echo "INFO: Installing uv tool..."
curl -LsSf https://astral.sh/uv/install.sh | sudo env CARGO_HOME=/usr/local UV_INSTALL_DIR=/usr/local/bin sh

echo "INFO: Installing Cursor CLI..."
curl https://cursor.com/install -fsS | bash



echo "INFO: Configuring git safe directory..."
git config --global --add safe.directory /workspaces/agent-swarm




echo "INFO: Installing Gemini CLI and Specify CLI..."
if ! command -v npm &> /dev/null; then
    echo "npm not found. Installing nodejs and npm..."
    sudo apt-get update
    sudo apt-get install -y nodejs npm
fi
sudo npm install -g @google/gemini-cli @specifyapp/cli
echo "INFO: Gemini CLI and Specify CLI installation complete."

echo "Setup bridget to access Chrome DevTools Protocol over a secure tunnel..."
socat TCP-LISTEN:9222,fork,bind=127.0.0.1 TCP:host.docker.internal:9222 &
