# LinuxLink

Android phone → Bluetooth LE → ESP32-S3 → USB keyboard + serial → Arch Linux.

This repository contains an Android Chrome web app, ESP32-S3 firmware, an Arch live-image command bridge, and an optional AI companion server. It is an installation **development prototype**, not a finished unattended Linux installer. It runs real shell commands after review and returns stdout, stderr, and exit status. It does not capture the screen or BIOS menus.

## Hardware

```text
PC USB host
  └─ powered/data USB hub
      ├─ USB MicroSD reader with customized Arch live image
      ├─ ESP32-S3 Mini native USB port
      │   └─ Bluetooth LE ↔ Android phone
      └─ spare installation-media port
```

The PC is the USB host; the ESP32 is a USB device. The SD card is in its own USB reader, not exported by this firmware. “ESP32-S3 Mini” is used by several vendors: verify your board really has an S3, its flash size, and that the connector exposes native USB (GPIO19 D− / GPIO20 D+). A connector wired only to a USB-UART chip cannot provide HID + CDC. The firmware uses no external GPIO and assumes no specific LED or button layout.

## 1. Flash the ESP32

Install Arduino IDE 2 or Arduino CLI. Add this Boards Manager URL:

```text
https://espressif.github.io/arduino-esp32/package_esp32_index.json
```

Install **esp32 by Espressif Systems 3.3.7** and **ArduinoJson 7.4.2**.

1. Copy `firmware/LinuxLink/config.example.h` to `firmware/LinuxLink/config.h`.
2. Set a personal six-digit `LINK_PAIRING_PIN`. This file is gitignored.
3. Open `firmware/LinuxLink/LinuxLink.ino`.
4. Board: **ESP32S3 Dev Module**. USB Mode: **USB-OTG (TinyUSB)**. USB CDC On Boot: **Disabled**. The sketch explicitly creates the CDC interface.
5. Match flash size and PSRAM options to your board. For a 4 MB board, select **Huge APP (3 MB No OTA/1 MB SPIFFS)** because Bluetooth + USB may exceed the default application partition. Do not enable PSRAM unless your board has it.
6. Upload through the board's supported programming port. If necessary, hold BOOT, tap RESET, then release BOOT to enter download mode. Reconnect the native USB port to the target PC afterwards.

The device advertises as `LinuxLink`. Pair with the PIN from `config.h` when Android asks. BLE writes require encrypted, authenticated pairing. Changing a PIN does not revoke existing bonds; erase board flash and forget the device on Android when resetting ownership. Use a unique USB serial number if deploying multiple boards, and update the bridge's discovery match accordingly.

CLI equivalent for the generic 4 MB build (adjust flash/partition options for the actual board):

```sh
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.7 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli lib install ArduinoJson@7.4.2
arduino-cli compile --fqbn 'esp32:esp32:esp32s3:USBMode=default,CDCOnBoot=default,PartitionScheme=huge_app' firmware/LinuxLink
```

## 2. Put the bridge in your Arch image

On an Arch Linux build machine, from this repository:

```sh
sudo pacman -S --needed archiso
cp -r /usr/share/archiso/configs/releng ./linuxlink-profile
bash bridge/install-archiso.sh ./linuxlink-profile
sudo mkarchiso -v -w ./iso-work -o ./iso-out ./linuxlink-profile
```

Write the generated ISO to your MicroSD with an image-writing tool, carefully selecting the MicroSD rather than an internal disk. Boot it on the target PC. The included systemd service starts the Python bridge as root and waits for the ESP32's stable USB serial identity. It requires no network to exchange commands.

For a quick test on an already-running Linux machine (this gives the connected phone root command access):

```sh
sudo python3 bridge/linuxlink.py --device /dev/ttyACM0
```

Service troubleshooting on the live image:

```sh
systemctl status linuxlink
journalctl -u linuxlink -f
ls -l /dev/serial/by-id/
```

Boot selection remains a firmware/user step. Some PCs need boot-menu selection or Secure Boot changes. HID works only when the PC firmware accepts the device; the app cannot see these menus.

## 3. Run the phone app

Requires Python 3.11+ on a companion machine. No Python packages or frontend build step are needed:

```sh
python server.py
```

Open `http://localhost:8000` on the companion machine to try **Demo**. Demo is visibly labeled and never talks to hardware or the AI provider.

For Android Chrome, Web Bluetooth requires a secure context. For local development, enable USB debugging on Android, install Android platform tools, connect the phone to the companion machine, then run:

```sh
adb reverse tcp:8000 tcp:8000
```

Open **http://localhost:8000** in Android Chrome. This localhost address is forwarded to your companion machine; the ESP32 connection is still Bluetooth. Enable Bluetooth and any permissions/location services requested by Android. Tap **Connect LinuxLink**, complete pairing, boot the live image, and tap **Check Linux connection**. Then choose **Inspect disks → Review & run**.

For use without the phone's development USB cable, serve on a trusted HTTPS origin. The built-in server supports a TLS certificate that Android trusts:

```sh
python server.py --host 0.0.0.0 --cert /path/to/cert.pem --key /path/to/key.pem
```

A plain `http://192.168.x.x` address or an untrusted self-signed certificate is insufficient. This prototype is a browser app, not an APK. Keep the app in the foreground; Android may suspend Bluetooth work in the background. It does not support iOS Safari.

## 4. Enable the AI assistant

The manual controls work without an API account. Gemini is the default provider for its limited free API tier. OpenAI is also supported, with separate API billing (ChatGPT Plus does not include API usage).

Create your own Gemini key at [Google AI Studio](https://aistudio.google.com/apikey). Use a free-tier project if you want to avoid API charges; model availability and quotas depend on your account. Google states that free-tier content can be used to improve its products. Never include secrets in terminal output sent to the assistant. See [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).

From the project directory in PowerShell:

```powershell
.\build\tools\python\python.exe configure_ai.py
```

Or use `python configure_ai.py` if Python is installed normally. Keep the default `gemini` provider and `gemini-3.6-flash` model, then paste your key at the hidden prompt. Setup saves `linuxlink.local.json` (gitignored). With the default localhost server and `adb reverse`, no companion token is needed: tap **Test AI connection** directly. For HTTPS/LAN hosting, the token field appears; enter the `access_token` from the configuration file. The test makes one small request; it never runs a computer command. The running server reads configuration changes on each request, so no restart is required after setup.

Keep the local configuration file private: it contains your API key in plaintext on your computer. It is outside the app's served directory and is never copied to the MicroSD. Token-free access is enabled only when the server and client are both on loopback. Local requests validate the Host and Origin and require a custom header and JSON body to reject requests from unrelated websites. Network listeners still require the full token, even for local clients. The phone keeps any network access token in memory, not local storage.

For OpenAI, choose `openai` in setup and supply a model that supports Structured Outputs. Environment variables can alternatively override the local file:

```powershell
$env:OPENAI_API_KEY = '<your API key>'
$env:OPENAI_MODEL = '<your model ID>'
$env:LINUXLINK_PROVIDER = 'openai'
$env:LINUXLINK_TOKEN = '<a random secret of at least 24 characters>'
python server.py
```

For Gemini, use `LINUXLINK_PROVIDER=gemini`, `GEMINI_API_KEY`, and `GEMINI_MODEL`. On Linux/macOS use `export NAME=value` instead. Enter only the companion token in the app; never put an API key in the phone app or firmware.

Enter a goal and tap **Send**. This sends your goal, conversation, saved installation preferences/progress and recent terminal output to the companion server and chosen AI provider. Manual mode places suggested commands in the editor. **Install automatically** enables the execution loop described below. OpenAI requests use `store: false`. Quota errors are shown directly, with no paid-provider fallback.

## Guided Arch setup in the phone app

Connect to the live Arch bridge and type or dictate any preferences in the installation chat. User answers and a compact agent progress record are retained separately from rolling chat history for this page session. The agent is instructed to reuse answers and use defaults instead of asking routine questions repeatedly. **Microphone** transcribes into the message box; review it and press **Send**. Browser speech support varies and may use an external speech service; the phone keyboard microphone is a fallback.

Open **Choose installation disk**, then **Inspect computer** to populate the disk selector. This read-only inspection runs immediately and retries the Linux bridge handshake if Bluetooth connected before the bridge started. The status distinguishes **BLUETOOTH CONNECTED** from **LINUX READY**. The selector excludes USB disks and disks with mounted partitions.

**Fast test mode** is enabled by default in this test build. Choose the target and tap **Use this disk (erase allowed)**; typing its path and checking an erasure checkbox are skipped. Tap **Run installation step** to execute each AI suggestion immediately without a review dialog. Turn fast test mode off to restore those confirmations. Commands still run one at a time, and **Stop command** remains available. After a step finishes, press **Continue** to share the result with the assistant. Never enter passwords in chat; set them locally when instructed. Manual controls and terminal output are collapsed below the conversation. This prototype supports whole-disk installation, without dual boot or encryption.

Temporary provider HTTP 500/502/503/504 errors receive up to three attempts with short backoff. **Retry message** resends a failed suggestion request without duplicating the chat message or executing any command. Conversation stays in page memory until reload/disconnect; a service outage can still require waiting.

After authorizing a target disk, tap **Install automatically** to let the agent request and execute successive commands, feeding each result into its next decision. Defaults are GNOME, hostname `archlinux`, username `linuxuser`, UTC, en_US.UTF-8 and ext4; explicit preferences override defaults. This button authorizes automatic execution independently of the manual fast-test setting. Keep the phone page open and connected. **Pause automatic install** stops subsequent steps, while **Stop command** also cancels the running command. Errors, unknown outcomes, repeated successful commands, provider failures, missing essential input, or 60 steps pause the loop. Resuming does not retry a failed command automatically; it asks the agent to assess actual progress. Password setup is deferred to a local step at the end, not replaced with an insecure default password. Completion is reported by the AI after instructed verification; it is not an independent boot test. No automatic reboot occurs.

Suggestions use a 30-minute command timeout by default (editable). The bridge's existing 128 KiB output limit still applies. This is an experimental, supervised AI workflow, not a deterministic or fully tested installer: inspect every suggested command. It does not independently enforce a sandbox around disk operations, automatically verify every AI claim, or reboot automatically. Disconnecting invalidates the disk selection and requires inspection again. Reloading the page loses the session context; do not blindly repeat installation steps after a disconnect/reload.

## Automatic startup on the existing writable MicroSD

The automatic boot entry now also opens **LinuxLink computer chat** on the first Arch console. Type a request at `You>`; `quit` or `exit` returns to the regular terminal, and `linuxlink-chat` reopens the assistant. Keep the updated phone page open, paired over Bluetooth, and the Windows companion running. Prompts travel from the Linux bridge through the ESP32 to the phone, which uses its existing companion API connection; no API credentials are stored on the card. There is no ESP32 reflash requirement.

Computer chat commands: `/disks` lists eligible disks, `/disk /dev/DEVICE` authorizes erasure of one listed target, `/run` executes the last suggestion, and `/auto` starts or resumes automatic installation. Ctrl+C stops the current operation and returns to the chat prompt. Local and phone conversations retain separate agent state; do not run two installation agents at once. A shared command lock prevents simultaneous shell execution. Chat hides raw commands and their output while retaining results for the AI. Explanations and progress updates appear on both screens, with a running update every 30 seconds during quiet local commands. Ordinary conversational questions receive conversational answers without commands.

Completed commands with a nonzero exit code go back to the AI for diagnosis and repair automatically, within the authorized installation scope. Cancellation, unknown outcomes, and genuine blockers still pause execution. The automatic loop remains bounded to 60 steps. Updated phone browsers negotiate compressed console requests, reducing repeated history traffic over BLE; older browsers keep the acknowledged plain transfer. Refresh the phone page and reboot the updated card to enable these changes.

For this disposable-computer test build, typing **install linux** or **please install Arch Linux with KDE** starts automatic installation without an additional confirmation. Computer chat enables this by default; the phone enables it while **Fast test mode** is checked. The program inspects disks and selects the only eligible unmounted internal disk, excluding USB/live media. With multiple disks, name a target explicitly (`install linux on /dev/nvme0n1`). An existing authorized target is retained for resuming within the same session. The agent uses defaults for missing preferences and has explicit permission for routine installation operations on that disk. Real errors or necessary local actions can still pause the workflow.

`tools/prepare_media.py` prepares a separate **LinuxLink (automatic bridge)** boot entry for this project's `ARCH_202608` FAT32 card. It uses Archiso's built-in `script=` startup mechanism and systemd's `systemd.mount-extra=` support to mount the card at `/mnt/linuxlink-media`. This avoids depending on `/run/archiso/bootmnt`, which was absent on the tested machine.

```powershell
.\build\tools\python\python.exe tools\prepare_media.py --card D:\
# Inspect build/media-update, then apply to the same card:
.\build\tools\python\python.exe tools\prepare_media.py --card D:\ --apply
```

The apply step verifies that card files have not changed since staging, backs up replaced files under `linuxlink/backup-<timestamp>/`, copies the bridge, and updates UEFI/BIOS defaults last. It leaves the kernel, initramfs, compressed Arch image, and normal Arch boot entries unchanged. A failed copy triggers rollback of changed files. Do not apply to an unreadable or damaged card.

On boot, choose **LinuxLink (automatic bridge)** or wait for its default countdown. Arch's first-console autologin runs the startup script, which installs the bridge into the live RAM filesystem and starts its systemd service. It does not partition or install to internal disks. Boot testing on the target machine is still required after deploying these settings. Selecting the original Arch boot entry provides the manual fallback.

Sources: [Archiso startup script](https://github.com/archlinux/archiso/blob/master/configs/releng/airootfs/root/.automated_script.sh), [systemd mount parameters](https://github.com/systemd/systemd/blob/main/man/systemd-fstab-generator.xml).

The bridge executes noninteractive commands in separate shells, with stdin closed; `cd` and exported variables do not persist between requests. Use explicit paths or combine dependent operations in one reviewed command. Interactive `archinstall`, password prompts, full-screen terminals, and PTYs are not implemented. There is no automatic disk-selection or partitioning wizard yet.

## Protocol and behavior

See [docs/protocol.md](docs/protocol.md). All three components use the same UUIDs and newline-delimited JSON, fragmented into 20-byte BLE writes/indications. Results are correlated by request ID. Commands are serialized, bounded by a timeout (1–3600 seconds) and 128 KiB of output, and can be cancelled by ID. Keep generated output modest: 20-byte acknowledged indications prioritize a simple baseline over throughput.

The Linux service has root authority to perform installation. Bluetooth pairing controls device access. Fast test mode executes commands on one tap; standard mode adds a review dialog. Neither UI confirmation nor the AI prompt is a sandbox. Use a test VM or expendable disk for initial installation experiments. Do not expose the companion development server publicly.

If Bluetooth disconnects, the command may keep running on the PC until its timeout; the app marks its outcome unknown. Results are not replayed on reconnect. Do not repeat a destructive command simply because its result was lost. USB disconnects stop the bridge's active process group. Cancellation kills the process group and can leave an installation step partially complete. Rebooting into the installed OS ends control unless you separately install/configure the bridge there.

## Validation

### Troubleshooting an installed Arch system

Choose **Troubleshoot / do a task** on the phone, then describe the problem or task.
The agent inspects the system, performs ordinary steps within your request, and verifies
the result. Progress appears on both screens when computer chat is open. Mode changes
clear previous task context and disk authorization. Installation mode is retained.
The **Troubleshoot — open Ctrl+Alt+F3** button selects this mode and sends that keyboard
shortcut to the PC. Chat and Microphone remain available; dictation fills the message,
then Send submits it. This shortcut requires the updated ESP32 firmware. No physical
button is required. The PC may show a login prompt; the bridge still handles commands
and results in the background rather than typing blindly into that prompt.

After signing in at the text console, first tap **Mount setup card**. If `sudo` requests
a password, type it only on the computer and wait for the prompt to return. Then tap
**Install Arch connection**. Once setup finishes, tap **Check Linux connection**;
then chat and microphone prompts can run commands and return their results.

The installed system needs a one-time bridge setup. Boot **installed Arch**, plug in
the microSD reader, and run this in a terminal (or a Ctrl+Alt+F3 text console):

```sh
sudo pacman -S --needed python
sudo mkdir -p /mnt/linuxlink-card
sudo mount -o ro /dev/disk/by-label/ARCH_202608 /mnt/linuxlink-card
sudo bash /mnt/linuxlink-card/linuxlink/install-system.sh
```

If the card is already mounted, use its existing mount path instead. The script copies
only the bridge and chat files, enables `linuxlink.service`, and starts it. The paired
phone can execute commands as root through this service. Disable with
`sudo systemctl disable --now linuxlink.service` when no longer wanted.

After setup, boot Arch normally and plug in LinuxLink. Connect the phone; the installed
bridge reports **Troubleshoot** as its default mode. There is no need to switch TTYs or
boot the microSD. The Windows companion and phone connection are still required for AI.
Optional local chat: `sudo linuxlink-chat --mode troubleshoot`; `exit` returns to the
shell. In computer chat, `/mode install` and `/mode troubleshoot` change that session's
mode. Do not run independent phone and console tasks simultaneously.

For a mounted installation while still in the live environment, first install Python
in the target, then run `bash /mnt/linuxlink-media/linuxlink/install-system.sh --root /mnt`
(use the actual media path and verified target mount). New AI-guided installs are instructed
to perform and verify this setup when the updated helper is available on the media.

Troubleshooting mode also works from the live media as a rescue environment, but that
environment is separate from the installed OS. The agent must identify an offline target
before changing it. This is a command-based assistant, not desktop screen capture or GUI
automation. Ctrl+Alt+F3 alone cannot provide command output to the ESP32.

```sh
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
node --check app/app.js
```

Linux-only runner tests cover real stdout/stderr, exit codes, cancellation, timeout, duplicate command IDs, and output limits. They are skipped on Windows. Portable tests cover fragmented protocol messages, malformed/oversized frames, and the AI request/response boundary with a mocked provider. CI runs Linux tests and compiles the generic ESP32-S3 firmware. Hardware acceptance remains necessary: pairing, HID enumeration, CDC discovery, boot firmware compatibility, disconnects during output, and your board's exact flash configuration.

## References

- [Espressif USB device stack](https://docs.espressif.com/projects/esp-usb/en/latest/esp32s3/usb_device.html)
- [Chrome Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)
- [Archiso](https://wiki.archlinux.org/title/Archiso)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
