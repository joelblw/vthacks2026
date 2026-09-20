# LinuxLink protocol v1

Service UUID: `7b910001-6b21-4c45-8c62-55b14b3af100`.
Phone → ESP32 writable RX: `7b910002-6b21-4c45-8c62-55b14b3af100`.
ESP32 → phone indicating TX: `7b910003-6b21-4c45-8c62-55b14b3af100`.

Both directions carry UTF-8 JSON objects terminated by LF. A frame is at most 2048 bytes excluding LF. BLE fragments are at most 20 bytes, supporting the default ATT MTU; frame boundaries do not correspond to BLE packets. Phone writes use write-with-response, ESP32 output uses confirmed indications. Frames must be fully reassembled before UTF-8 decoding. Serial uses the same JSON lines at a nominal 115200 baud (USB CDC ignores the physical baud rate).

Use a fresh 1–64 character string ID for every request. Phone-generated IDs are UUIDs. The bridge rejects duplicate **execution** IDs until it restarts, capped at 10,000 IDs. This prevents a replay within one bridge session; it is not durable exactly-once execution across reboots.

| Request | Destination | Response |
| --- | --- | --- |
| `{"id":"a","op":"device"}` | ESP32 | `type: device` |
| `{"id":"b","op":"ping"}` | Linux | `type: ready`, `protocol: 1`, `root: true/false` |
| `{"id":"c","op":"exec","command":"lsblk --json","timeout":120}` | Linux | `started`, zero or more `stdout`/`stderr`, then `exit` or `error` |
| `{"id":"d","op":"cancel","target":"c"}` | Linux | `type: cancel`; target later emits its terminal result |
| `{"id":"e","op":"key","key":"F12"}` | ESP32 HID | `type: key` |

Supported keys: `F2`, `F12`, `UP`, `DOWN`, `ENTER`, `ESC`, `CTRL_ALT_F3`, `TYPE_TEST`, and `START_ARCH_BRIDGE`. The latter two type paced text on an Arch text console. `TYPE_TEST` enters `echo LINUXLINK-TYPING-TEST`; use it to verify that normal text entry works before setup. A key acknowledgement says the firmware sent the key, not that the target PC acted on it.

Output: `{"id":"c","type":"stdout","data":"..."}` (likewise `stderr`).
Exit: `{"id":"c","type":"exit","code":0,"reason":"completed"}`.
Reasons: `completed`, `cancelled`, `timeout`, `output_limit`.
Error: `{"id":"c","type":"error","message":"..."}`.

The command limit is 1200 UTF-8 bytes. Bash runs with stdin closed; there is no persistent shell state. The bridge reads output in small chunks, preserving split UTF-8 via incremental decoders, and caps output at 128 KiB. A transport queue applies backpressure. An incomplete transport message never implies command success. Do not retry commands automatically after uncertain delivery.

BLE pairing uses Secure Connections, MITM authentication, bonding, and a configured six-digit passkey. The app does not transmit the passkey itself; the Android system pairing UI handles it. Requests are accepted only after authentication. Firmware queues are tagged with a connection generation so requests queued by a previous phone session cannot execute in a new session. Fragment buffer overflow or an unacknowledged indication disconnects the phone.
# Computer chat relay

Linux may emit `chat_request` messages with a request `id`, zero-based `seq`, a
base64 UTF-8 JSON `chunk` (at most 1100 characters) and boolean `end`. The phone
reassembles the API planning body, sends it using its existing companion settings,
then returns the proposal or an error through `op: "ping", chat_reply: {id, seq,
chunk, end}`. Each reply fragment is acknowledged by `type: "chat_ack"` with the
outer ping ID. This uses the existing firmware's transparent ping forwarding;
it is not a shell command. The bridge caps payload sizes and expires requests.
Request chunks now advertise `flow: "ack"` and contain at most 768 base64 characters.
The phone sends `op: "ping", chat_received: {id, seq}` after receiving each chunk;
the bridge acknowledges the ping with `chat_ack` and only then sends the next chunk.
Missing acknowledgements expire the request instead of filling the ESP32 USB buffer.
Reply chunks are likewise at most 768 characters and individually acknowledged.
Disconnecting discards partial phone messages and pending Linux relay requests.

`ready` now includes `environment: {os:"linux", shell:"bash", live:boolean,
default_mode:"install"|"troubleshoot"}`. A running Arch live environment defaults to
installation; installed systems default to troubleshooting. Older bridges without
this field retain the phone's selected mode. Every planning request includes
`installation_context.mode`; the server selects a separate workflow prompt for each.
Changing modes clears previous task state and installer disk authorization.
