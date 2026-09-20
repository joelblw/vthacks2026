// ESP32-S3, Arduino-ESP32 3.3.7, ArduinoJson 7.4.2.
// USB Mode: USB-OTG (TinyUSB); USB CDC On Boot: Disabled.
#include <Arduino.h>
#include <USB.h>
#include <USBCDC.h>
#include <USBHIDKeyboard.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLESecurity.h>
#include <host/ble_gatt.h>
#include <host/ble_hs_mbuf.h>
#include <ArduinoJson.h>
#include <atomic>
#include "config.h"

static_assert(LINK_PAIRING_PIN >= 100000 && LINK_PAIRING_PIN <= 999999,
              "Choose a six-digit pairing PIN in config.h");
const char *SERVICE = "7b910001-6b21-4c45-8c62-55b14b3af100";
const char *RX_UUID = "7b910002-6b21-4c45-8c62-55b14b3af100";
const char *TX_UUID = "7b910003-6b21-4c45-8c62-55b14b3af100";
constexpr size_t MAX_LINE = 2048;
struct Request { char data[MAX_LINE + 1]; uint32_t session; };
QueueHandle_t requests;
USBCDC linkSerial;
USBHIDKeyboard keyboard;
BLEServer *server;
BLECharacteristic *tx;
std::atomic<bool> connected{false}, authenticated{false}, restartAdvertising{false};
std::atomic<int> indicationResult{0};
std::atomic<bool> subscribed{false};
std::atomic<uint32_t> session{0};
String usbLine;
bool usbOverflow = false;

// The Arch virtual console can miss a burst of HID reports. Send text one
// character at a time. The virtual console accepts a much lower reliable HID
// rate than a desktop terminal, so use a deliberately conservative gap.
bool typeText(const char *text) {
  for (const char *cursor = text; *cursor; ++cursor) {
    if (keyboard.write(static_cast<uint8_t>(*cursor)) != 1) {
      keyboard.releaseAll();
      return false;
    }
    delay(90);
  }
  return true;
}

class Security : public BLESecurityCallbacks {
  uint32_t onPassKeyRequest() override { return LINK_PAIRING_PIN; }
  void onPassKeyNotify(uint32_t) override {}
  bool onConfirmPIN(uint32_t) override { return false; }
  bool onSecurityRequest() override { return true; }
  void onAuthenticationComplete(ble_gap_conn_desc *result) override {
    authenticated = result->sec_state.encrypted && result->sec_state.authenticated;
  }
};

class Connections : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    session++;
    authenticated = false;
    subscribed = false;
    connected = true;
  }
  void onDisconnect(BLEServer *) override {
    connected = false;
    authenticated = false;
    subscribed = false;
    restartAdvertising = true;
  }
};

class Receive : public BLECharacteristicCallbacks {
  String line;
  bool overflow = false;
  uint32_t previousSession = 0;
  void onWrite(BLECharacteristic *characteristic) override {
    if (!authenticated) return;
    uint32_t current = session.load();
    if (current != previousSession) {
      line = ""; overflow = false; previousSession = current;
    }
    String bytes = characteristic->getValue();
    for (size_t i = 0; i < bytes.length(); i++) {
      char c = bytes[i];
      if (c == '\n') {
        Request request{};
        request.session = current;
        if (!overflow && line.length()) {
          line.toCharArray(request.data, sizeof(request.data));
          // Overflow is never silently accepted: disconnect and require reconnection.
          if (xQueueSend(requests, &request, 0) != pdTRUE) server->disconnect(server->getConnId());
        } else if (overflow) server->disconnect(server->getConnId());
        line = ""; overflow = false;
      } else if (!overflow) {
        if (line.length() < MAX_LINE) line += c;
        else overflow = true;
      }
    }
  }
};

class Transmit : public BLECharacteristicCallbacks {
  void onStatus(BLECharacteristic *, Status status, uint32_t) override {
    indicationResult = status == SUCCESS_INDICATE ? 1 : -1;
  }
  void onSubscribe(BLECharacteristic *, ble_gap_conn_desc *, uint16_t value) override {
    subscribed = (value & 2) != 0;
  }
};

// Indications have an ATT acknowledgement. A failed fragment closes the link so
// the phone cannot mistake a truncated result for a complete command response.
bool sendLine(const String &line) {
  if (!connected || !authenticated || !subscribed) return false;
  uint32_t current = session.load();
  String packet = line + '\n';
  for (size_t offset = 0; offset < packet.length(); offset += 20) {
    if (!connected || current != session.load()) return false;
    size_t count = min(size_t(20), packet.length() - offset);
    // Use NimBLE's asynchronous indication primitive. In Arduino core 3.3.7,
    // the wrapper's blocking wait is not released by its NimBLE completion path.
    // BLEServer dispatches the ATT confirmation to Transmit::onStatus above.
    indicationResult = 0;
    os_mbuf *buffer = ble_hs_mbuf_from_flat(packet.c_str() + offset, count);
    if (!buffer || ble_gatts_indicate_custom(server->getConnId(), tx->getHandle(), buffer) != 0) {
      if (connected) server->disconnect(server->getConnId());
      return false;
    }
    uint32_t started = millis();
    while (connected && current == session.load() && indicationResult == 0 && millis() - started < 1500) delay(1);
    if (indicationResult != 1) {
      if (connected) server->disconnect(server->getConnId());
      return false;
    }
  }
  return true;
}

void reply(const String &id, const char *type, const char *message) {
  JsonDocument result;
  result["id"] = id; result["type"] = type; result["message"] = message;
  String line; serializeJson(result, line); sendLine(line);
}

void processRequest(const Request &request) {
  if (!connected || !authenticated || request.session != session.load()) return;
  JsonDocument doc;
  if (deserializeJson(doc, request.data)) return;
  String id = doc["id"] | "";
  String op = doc["op"] | "";
  if (op == "device") {
    reply(id, "device", "LinuxLink ESP32-S3 ready");
  } else if (op == "key") {
    String key = doc["key"] | "";
    if (key == "TYPE_TEST") {
      if (!typeText("echo LINUXLINK-TYPING-TEST")) {
        reply(id, "error", "Typing test could not be queued");
        return;
      }
      delay(300); keyboard.press(KEY_RETURN); delay(300); keyboard.releaseAll();
      reply(id, "key", "Typing test sent");
      return;
    }
    if (key == "MOUNT_ARCH_CARD" || key == "INSTALL_ARCH_BRIDGE") {
      // Split setup into short commands. This keeps local sudo/password and
      // mount failures visible instead of hiding them in one long command.
      const char *command = key == "MOUNT_ARCH_CARD"
          ? "sudo mount -o ro /dev/disk/by-label/ARCH_202608 /mnt"
          : "sudo bash /mnt/linuxlink/install-system.sh";
      keyboard.releaseAll();
      if (!typeText(command)) {
        keyboard.releaseAll();
        reply(id, "error", "Setup typing incomplete; inspect and clear the terminal line before retrying");
        return;
      }
      delay(300); keyboard.press(KEY_RETURN); delay(300); keyboard.releaseAll();
      reply(id, "key", key == "MOUNT_ARCH_CARD" ? "Mount command typed" : "Bridge installation command typed");
      return;
    }
    if (key == "CTRL_ALT_F3") {
      keyboard.press(KEY_LEFT_CTRL);
      keyboard.press(KEY_LEFT_ALT);
      keyboard.press(KEY_F3);
      delay(50);
      keyboard.releaseAll();
      reply(id, "key", "Ctrl+Alt+F3 sent");
      return;
    }
    uint8_t code = 0;
    if (key == "ENTER") code = KEY_RETURN;
    else if (key == "ESC") code = KEY_ESC;
    else if (key == "UP") code = KEY_UP_ARROW;
    else if (key == "DOWN") code = KEY_DOWN_ARROW;
    else if (key == "F2") code = KEY_F2;
    else if (key == "F12") code = KEY_F12;
    if (!code) { reply(id, "error", "Unsupported key"); return; }
    keyboard.press(code); delay(30); keyboard.releaseAll();
    reply(id, "key", "Key sent; firmware menu compatibility depends on the PC");
  } else if (op == "ping" || op == "exec" || op == "cancel") {
    if (!linkSerial) { reply(id, "error", "Linux USB serial bridge is not open"); return; }
    linkSerial.println(request.data);
  } else reply(id, "error", "Unknown operation");
}

void setup() {
  requests = xQueueCreate(4, sizeof(Request));
  if (!requests) abort();
  usbLine.reserve(MAX_LINE);
  USB.productName("LinuxLink");
  USB.manufacturerName("LinuxLink Project");
  USB.serialNumber("LINUXLINK-S3-001");
  linkSerial.setRxBufferSize(4096);
  linkSerial.begin(115200);
  keyboard.begin();
  USB.begin();
  BLEDevice::init(LINK_DEVICE_NAME);
  BLEDevice::setSecurityCallbacks(new Security());
  auto security = new BLESecurity();
  security->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
  security->setCapability(ESP_IO_CAP_OUT);
  security->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  security->setPassKey(true, LINK_PAIRING_PIN);
  server = BLEDevice::createServer();
  server->setCallbacks(new Connections());
  auto service = server->createService(SERVICE);
  auto rx = service->createCharacteristic(RX_UUID, BLECharacteristic::PROPERTY_WRITE |
      BLECharacteristic::PROPERTY_WRITE_ENC | BLECharacteristic::PROPERTY_WRITE_AUTHEN);
  rx->setCallbacks(new Receive());
  tx = service->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_INDICATE);
  // NimBLE creates the CCCD automatically for indicating characteristics.
  tx->setCallbacks(new Transmit());
  service->start();
  BLEDevice::getAdvertising()->addServiceUUID(SERVICE);
  BLEDevice::getAdvertising()->setScanResponse(true);
  BLEDevice::startAdvertising();
}

void loop() {
  if (restartAdvertising.exchange(false)) {
    keyboard.releaseAll();
    BLEDevice::startAdvertising();
  }
  Request request;
  if (xQueueReceive(requests, &request, 0) == pdTRUE) processRequest(request);
  // Drain even when disconnected. Linux retains no results for later sessions.
  while (linkSerial.available()) {
    char c = linkSerial.read();
    if (c == '\n') {
      if (!usbOverflow && usbLine.length()) sendLine(usbLine);
      else if (usbOverflow) reply("", "error", "USB frame exceeds 2048 bytes");
      usbLine = ""; usbOverflow = false;
      break; // Let queued cancellation requests run between output frames.
    } else if (c != '\r' && !usbOverflow) {
      if (usbLine.length() < MAX_LINE) usbLine += c;
      else usbOverflow = true;
    }
  }
  delay(1);
}
