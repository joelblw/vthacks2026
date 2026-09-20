"""Stage/apply a reversible Arch USB boot configuration for LinuxLink.

Staging only reads the card. Applying checks every original hash before writing,
backs up existing files, writes payloads first, and changes defaults last.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
PARAMETERS = ("systemd.mount-extra=/dev/disk/by-label/ARCH_202608:/mnt/linuxlink-media:vfat:"
              "ro,x-systemd.automount,x-systemd.device-timeout=30s "
              "script=/mnt/linuxlink-media/linuxlink/autorun.sh")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def under(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError("Path escapes deployment root")
    return path


def add_parameters(line):
    if re.search(r"(?:^|\s)script=", line) or "systemd.mount-extra=" in line:
        raise ValueError("The original Arch entry already has startup customizations; review it manually")
    return line.rstrip() + " " + PARAMETERS


def validate_media(card, boot_files_only=False):
    if not boot_files_only and not (card / "arch/x86_64/airootfs.sfs").is_file():
        raise ValueError("Expected Arch installation media not found")
    for relative in ("loader/entries/01-archiso-linux.conf", "loader/loader.conf",
                     "boot/syslinux/archiso_sys.cfg", "boot/syslinux/archiso_sys-linux.cfg"):
        if not (card / relative).is_file():
            raise ValueError(f"Expected Arch boot configuration missing: {relative}")
    if boot_files_only:
        print("Boot-files-only update: Arch image health is unverified; image will not be modified.")


def stage(card, output, boot_files_only=False):
    validate_media(card, boot_files_only)
    baseline = (card / "loader/entries/01-archiso-linux.conf").read_text(encoding="utf-8")
    lines = baseline.splitlines()
    if not any(line.startswith("options ") for line in lines):
        raise ValueError("No Arch boot options found")
    uefi = []
    for line in lines:
        if line.startswith("title "): line = "title    LinuxLink (automatic bridge)"
        elif line.startswith("sort-key "): line = "sort-key 00"
        elif line.startswith("options "): line = add_parameters(line)
        uefi.append(line)
    bios_path = "boot/syslinux/archiso_sys-linux.cfg"
    original_bios = (card / bios_path).read_text(encoding="utf-8")
    original_bios = re.sub(r"# BEGIN LINUXLINK\n.*?# END LINUXLINK\n\n?", "", original_bios, flags=re.S)
    append = next((line for line in original_bios.splitlines() if line.startswith("APPEND ")), None)
    if append is None: raise ValueError("No BIOS Arch boot options found")
    bios = ("# BEGIN LINUXLINK\nLABEL linuxlink\nMENU LABEL LinuxLink (automatic bridge)\n"
            "LINUX /arch/boot/x86_64/vmlinuz-linux\nINITRD /arch/boot/x86_64/initramfs-linux.img\n"
            + add_parameters(append) + "\n# END LINUXLINK\n\n" + original_bios)
    loader = (card / "loader/loader.conf").read_text(encoding="utf-8")
    loader, count = re.subn(r"(?m)^default\s+.*$", "default 00-linuxlink.conf", loader)
    if count != 1: raise ValueError("Expected one UEFI default entry")
    bios_default = (card / "boot/syslinux/archiso_sys.cfg").read_text(encoding="utf-8")
    bios_default, count = re.subn(r"(?m)^DEFAULT\s+.*$", "DEFAULT linuxlink", bios_default)
    if count != 1: raise ValueError("Expected one BIOS default entry")
    payloads = {}
    for name in ("linuxlink.py", "phone_ai.py", "console.py", "linuxlink-chat", "linuxlink.service", "start-live.sh", "autorun.sh", "install-system.sh", "START-HERE.txt"):
        payloads[f"linuxlink/{name}"] = (ROOT / "bridge" / name).read_bytes()
    # Insertion order deliberately installs defaults after payloads and entries.
    payloads.update({"loader/entries/00-linuxlink.conf": ("\n".join(uefi) + "\n").encode(),
                     bios_path: bios.encode(), "loader/loader.conf": loader.encode(),
                     "boot/syslinux/archiso_sys.cfg": bios_default.encode()})
    manifest = []
    for relative, content in payloads.items():
        target = under(output, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        manifest.append({"path": relative, "before": digest(under(card, relative)), "after": digest(target)})
    (output / "deployment.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Staged {len(manifest)} files in {output}. Normal Arch boot entries are retained.")


def apply(card, output, boot_files_only=False):
    validate_media(card, boot_files_only)
    manifest = json.loads((output / "deployment.json").read_text(encoding="utf-8"))
    for item in manifest:
        if digest(under(card, item["path"])) != item["before"]:
            raise ValueError(f"Card changed since staging: {item['path']}. Nothing copied.")
        if digest(under(output, item["path"])) != item["after"]:
            raise ValueError("Staged content changed. Nothing copied.")
    backup = card / "linuxlink" / ("backup-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    backup.mkdir(parents=True, exist_ok=False)
    for item in manifest:
        if item["before"] is not None:
            target = under(backup, item["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(under(card, item["path"]), target)
    (backup / "deployment.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    written = []
    try:
        for item in manifest:
            target = under(card, item["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            written.append(item)
            shutil.copyfile(under(output, item["path"]), target)
            if digest(target) != item["after"]: raise OSError(f"Copy verification failed: {item['path']}")
    except Exception:
        for item in reversed(written):
            target = under(card, item["path"])
            if item["before"] is None: target.unlink(missing_ok=True)
            else: shutil.copyfile(under(backup, item["path"]), target)
        raise
    print(f"Copied and verified {len(manifest)} files. Backup: {backup}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--card", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "build/media-update")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--boot-files-only", action="store_true",
                        help="Update boot configuration without inspecting or changing the Arch filesystem image")
    args = parser.parse_args()
    (apply if args.apply else stage)(args.card.resolve(), args.output.resolve(), args.boot_files_only)
