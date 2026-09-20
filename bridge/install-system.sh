#!/usr/bin/env bash
# One-time bridge setup on installed Arch, or --root /mnt from the live system.
set -euo pipefail
target=/
if [[ $# == 2 && $1 == --root ]]; then
  target="$(realpath -- "$2")"
elif [[ $# != 0 ]]; then
  echo 'Usage: sudo bash install-system.sh [--root /mounted/arch-root]' >&2
  exit 1
fi
if [[ $EUID != 0 ]]; then
  echo 'Run this setup with sudo or as root.' >&2
  exit 1
fi
if [[ ! -f "$target/etc/arch-release" ]]; then
  echo 'The target must be an existing Arch Linux root filesystem.' >&2
  exit 1
fi
if [[ ! -x "$target/usr/bin/python" ]]; then
  echo 'Install Python in the target first: sudo pacman -S python' >&2
  exit 1
fi
if [[ $target == / && -d /run/archiso/airootfs ]]; then
  echo 'This is the live system. Use --root /mnt for the installed system.' >&2
  exit 1
fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for name in linuxlink.py phone_ai.py console.py; do
  install -Dm644 "$source_dir/$name" "$target/usr/local/lib/linuxlink/$name"
done
install -Dm755 "$source_dir/linuxlink-chat" "$target/usr/local/bin/linuxlink-chat"
install -Dm644 "$source_dir/linuxlink.service" "$target/etc/systemd/system/linuxlink.service"
systemctl --root="$target" enable linuxlink.service
if [[ $target == / ]]; then
  systemctl daemon-reload
  systemctl restart linuxlink.service
fi
echo 'LinuxLink installed. It will wait for the USB device on each boot.'
echo 'Boot installed Arch, plug in LinuxLink, and connect the phone.'
echo 'Troubleshooting mode is selected automatically by the installed-system bridge.'
echo 'Optional computer chat: sudo linuxlink-chat --mode troubleshoot'
echo 'Disable later: sudo systemctl disable --now linuxlink.service'
