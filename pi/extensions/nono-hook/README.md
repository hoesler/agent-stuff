# Nono Hook Extension

This extension provides sandbox-aware error handling for pi when running inside the [nono](https://nono.sh) security sandbox.

## How It Works

1. On startup, checks for `NONO_CAP_FILE` environment variable
2. Reads the capabilities file to get allowed paths
3. Subscribes to `tool_result` events
4. When errors occur, detects permission-related errors and injects context about the sandbox
