#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! -f "$1/profiledef.sh" ]]; then
  echo "Usage: bash bridge/install-archiso.sh /path/to/copied/archiso/profile" >&2
  exit 1
fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
profile="$(cd -- "$1" && pwd)"
install -Dm644 "$source_dir/linuxlink.py" "$profile/airootfs/usr/local/lib/linuxlink/linuxlink.py"
install -Dm644 "$source_dir/phone_ai.py" "$profile/airootfs/usr/local/lib/linuxlink/phone_ai.py"
install -Dm644 "$source_dir/console.py" "$profile/airootfs/usr/local/lib/linuxlink/console.py"
install -Dm755 "$source_dir/linuxlink-chat" "$profile/airootfs/usr/local/bin/linuxlink-chat"
install -Dm644 "$source_dir/linuxlink.service" "$profile/airootfs/etc/systemd/system/linuxlink.service"
mkdir -p "$profile/airootfs/etc/systemd/system/multi-user.target.wants"
ln -sfn ../linuxlink.service "$profile/airootfs/etc/systemd/system/multi-user.target.wants/linuxlink.service"
if ! grep -qxF python "$profile/packages.x86_64"; then
  printf '\npython\n' >> "$profile/packages.x86_64"
fi
echo "Bridge added to $profile. Build the ISO with mkarchiso."
