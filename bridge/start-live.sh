#!/usr/bin/env bash
# Start LinuxLink in the currently running Arch live environment.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root (the Arch live console normally already is root)." >&2
  exit 1
fi
if ! command -v python >/dev/null; then
  echo "Python is missing from this live environment." >&2
  exit 1
fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
install -Dm644 "$source_dir/linuxlink.py" /usr/local/lib/linuxlink/linuxlink.py
install -Dm644 "$source_dir/phone_ai.py" /usr/local/lib/linuxlink/phone_ai.py
install -Dm644 "$source_dir/console.py" /usr/local/lib/linuxlink/console.py
install -Dm755 "$source_dir/linuxlink-chat" /usr/local/bin/linuxlink-chat
install -Dm644 "$source_dir/linuxlink.service" /etc/systemd/system/linuxlink.service
systemctl daemon-reload
systemctl restart linuxlink.service
echo
echo "LinuxLink bridge started for this live session."
echo "On your phone, connect to LinuxLink, then tap Inspect computer."
echo "Logs: journalctl -u linuxlink -f"
echo "Stop: systemctl stop linuxlink"
echo "The LinuxLink automatic boot entry runs this script on every live boot."
if [[ "${1:-}" == "--console" && -t 0 ]]; then
  /usr/local/bin/linuxlink-chat || true
  echo "Back at the Arch terminal. Type linuxlink-chat to reopen the assistant."
fi
