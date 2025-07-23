#!/usr/bin/env bash
# save.sh - encrypt config.yaml and upload it via POST

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <base64_key_24chars> <symm_key_256bits>" >&2
  exit 1
fi

KEY="$1"
SYM_KEY="$2"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

if [ ! -f config.yaml ]; then
  echo "config.yaml not found" >&2
  exit 1
fi

# Encrypt config.yaml using AES-256-CBC and base64
openssl enc -aes-256-cbc -e -base64 -in config.yaml -out encrypted.dat -pass pass:"$SYM_KEY"

# Upload via POST
curl -fsSL -X POST -H "Content-Type: application/octet-stream" --data-binary @encrypted.dat "https://NSI2.sturmel.com/backup/${KEY}"

