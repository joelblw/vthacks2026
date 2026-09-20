export const INSPECT_ARCH = "lsblk --json --paths -o NAME,SIZE,MODEL,TYPE,MOUNTPOINTS,TRAN && printf '\\n---SYSTEM---\\n' && uname -m; test -d /sys/firmware/efi && echo BOOT=UEFI || echo BOOT=BIOS; ip -brief address; findmnt -rn -o SOURCE,TARGET /run/archiso/bootmnt /mnt/linuxlink-media; true";

function mounted(node) {
  return (node.mountpoints || []).some(Boolean) || (node.children || []).some(mounted);
}
export function inventory(text) {
  const data = JSON.parse(text.split('\n---SYSTEM---')[0]);
  if (!Array.isArray(data.blockdevices)) throw new Error('Disk inspection did not return a disk list. Run it again.');
  // For this first guided flow, only unmounted internal disks are offered.
  // USB media and any disk with mounted descendants are excluded.
  return data.blockdevices.filter(disk => disk.type === 'disk' && disk.tran !== 'usb' && !mounted(disk)
    && /^\/dev\/(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|mmcblk\d+)$/.test(disk.name));
}
export function archGoal(preferences, disks, confirmation, approved) {
  const {disk, hostname, username, timezone, desktop} = preferences;
  const selected = disks.find(item => item.name === disk);
  if (!selected) throw new Error('Inspect the computer and select an eligible internal disk first.');
  if (!approved || confirmation.trim() !== disk) throw new Error(`Type ${disk} exactly and check the erase confirmation.`);
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(hostname)) throw new Error('Use a hostname starting with a letter, followed by letters, numbers, or hyphens.');
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(username) || username === 'root') throw new Error('Choose a regular username, such as alex.');
  if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) throw new Error('Enter a timezone such as America/New_York or UTC.');
  if (!['minimal', 'gnome', 'kde'].includes(desktop)) throw new Error('Choose a desktop option.');
  return `Guide me through a fresh Arch Linux installation, one reviewed noninteractive command at a time.
I explicitly authorize erasing ONLY ${disk} (${selected.model || 'model unknown'}, ${selected.size}).
Preferences: hostname=${hostname}; username=${username}; timezone=${timezone}; desktop=${desktop}; filesystem=ext4; locale=en_US.UTF-8.
This is a whole-disk install, with no dual boot or disk encryption. Never erase any other device or the live medium.
Before any destructive step, revalidate the exact device, its identity, mounts and relationship to the live medium; stop if identity changed or uncertain. Use observed firmware mode and architecture, not assumptions. Validate internet, clock and disk capacity before installing. Prefer the normal Arch installation tools in small steps. Commands run in independent shells with stdin closed; combine dependent operations explicitly, and synchronize package operations. Do not repeat completed destructive steps. Diagnose nonzero exits, timeouts, or uncertain outcomes before proceeding.
Cover base system, fstab, timezone, locale, hostname, regular user, sudo, networking, firmware-appropriate bootloader, selected desktop and verification. For passwords or any necessary interactive action, return an empty command and explain what I must do locally on the target computer; never put passwords in commands, logs or this chat. After I confirm the local action in the notes, continue.
Do not reboot automatically. Do not declare installation complete without observed verification of the installed system and boot configuration. If essential context is missing, inspect it instead of guessing.`;
}
