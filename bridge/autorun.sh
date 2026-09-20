#!/usr/bin/env bash
# Archiso copies its script= argument to /tmp/startup_script before executing.
# Use the stable mount configured in our boot entry, not this script's directory.
set -euo pipefail
exec bash /mnt/linuxlink-media/linuxlink/start-live.sh --console
