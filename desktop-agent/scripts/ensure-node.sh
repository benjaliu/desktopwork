#!/bin/bash
set -e
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//')
if [ -z "$NODE_VERSION" ]; then
  echo "❌ Node.js not found. Install Node.js 22.3.0+:"
  echo "  brew install node@22   # macOS"
  echo "  winget install node   # Windows"
  echo "  https://nodejs.org    # Linux"
  exit 1
fi
REQUIRED_MAJOR=22
ACTUAL_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$ACTUAL_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  echo "❌ Node $NODE_VERSION < required v$REQUIRED_MAJOR"
  exit 1
fi
echo "✅ Node $NODE_VERSION"