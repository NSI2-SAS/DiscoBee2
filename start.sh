#!/usr/bin/env bash
# start.sh - setup environment, fetch config, and run the server

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <base64_key_24chars> <symm_key_256bits>" >&2
  exit 1
fi

KEY="$1"
SYM_KEY="$2"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# Install Node.js and npm in user space using nvm if not present
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  if [ ! -d "$HOME/.nvm" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.4/install.sh | bash
  fi
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install --lts
fi

# Download encrypted config
curl -fsSL "https://NSI2.sturmel.com/backup/${KEY}" -o encrypted.dat

# Decrypt using AES-256-CBC
openssl enc -aes-256-cbc -d -base64 -in encrypted.dat -out config.yaml -pass pass:"$SYM_KEY"
# Install npm dependencies
npm install --production

# Start the server
exec node server.js

