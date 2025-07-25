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

# Install Node.js in user space using nvm
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.4/install.sh | bash
fi
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Explicit Node.js version so nvm doesn't rely on unset PROVIDED_VERSION
NODE_VERSION="v22.17.1"
nvm install "$NODE_VERSION" >/dev/null
nvm use "$NODE_VERSION" >/dev/null

# Download encrypted config
curl -fsSL "https://NSI2.sturmel.com/backup/${KEY}" -o encrypted.dat

# Decrypt using AES-256-CBC
openssl enc -aes-256-cbc -d -base64 -in encrypted.dat -out config.yml -pass pass:"$SYM_KEY"
# Install production dependencies
npm ci --omit=dev

# Start the server
exec node server.js

