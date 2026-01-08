#include <Arduino.h>
#include <TFT_eSPI.h>
#include <SPI.h>
#include <FS.h> //filesystem
#include <SPIFFS.h>
#include <AnimatedGIF.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Use fs::File on ESP32
using File = fs::File;

// File handle used by the GIF callbacks
static fs::File gifFile;

static void * GIFOpenFile(const char *fname, int32_t *pSize) {
  gifFile = SPIFFS.open(fname, FILE_READ);
  if (!gifFile) return nullptr;
  *pSize = (int32_t)gifFile.size();
  return (void *)&gifFile;
}

static void GIFCloseFile(void *pHandle) {
  fs::File *f = (fs::File *)pHandle;
  if (f) f->close();
}

static int32_t GIFReadFile(GIFFILE *pFile, uint8_t *pBuf, int32_t iLen) {
  fs::File *f = (fs::File *)pFile->fHandle;
  if (!f) return 0;
  int32_t n = (int32_t)f->read(pBuf, iLen);
  pFile->iPos = (int32_t)f->position();
  return n;
}

static int32_t GIFSeekFile(GIFFILE *pFile, int32_t iPosition) {
  fs::File *f = (fs::File *)pFile->fHandle;
  if (!f) return 0;
  f->seek(iPosition);
  pFile->iPos = iPosition;
  return iPosition;
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    Serial.println("BLE connected");
  }
  void onDisconnect(BLEServer* pServer) override {
    Serial.println("BLE disconnected -> restart advertising");
    BLEDevice::startAdvertising();
  }
};

// ===== Display =====
TFT_eSPI tft = TFT_eSPI();
AnimatedGIF gif;

// ===== BLE UUIDs (random, but fixed) =====
static const char* DEV_NAME = "GIFCase";
static BLEUUID SVC_UUID("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
static BLEUUID CTRL_UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E"); // Write (strings)
static BLEUUID DATA_UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E"); // WriteNoRsp (binary)
static BLEUUID STAT_UUID("6E400004-B5A3-F393-E0A9-E50E24DCCA9E"); // Notify (status)

// ===== File receive state =====
static File rxFile;
static bool rxActive = false;
static uint32_t rxExpected = 0;
static uint32_t rxCount = 0;
static bool gifReady = false;

// ===== Status characteristic =====
static BLECharacteristic* statChr = nullptr;

static void notifyStatus(const String& s) {
  if (!statChr) return;
  statChr->setValue(s.c_str());
  statChr->notify();
  Serial.println("[STAT] " + s);
}

// ===== AnimatedGIF draw callback =====
// This library renders one line at a time (fast enough on ESP32-S3).
// Put near the top (global)
// Globals
static uint16_t lineBuf[320];

static void GIFDraw(GIFDRAW *pDraw) {
  // Center the GIF canvas on the TFT
  const int xOff = (tft.width()  - pDraw->iCanvasWidth)  / 2;
  // const int yOff = (tft.height() - pDraw->iCanvasHeight) / 2;

  // int y = yOff + pDraw->iY + pDraw->y;
  int y = pDraw->iY + pDraw->y;
  if (y < 0 || y >= tft.height()) return;

  int x = xOff + pDraw->iX;
  int w = pDraw->iWidth;

  int srcOffset = 0;
  if (x < 0) { srcOffset = -x; w += x; x = 0; }
  if (x + w > tft.width()) w = tft.width() - x;
  if (w <= 0) return;

  const uint8_t *s = pDraw->pPixels + srcOffset;
  const uint16_t *pal = (const uint16_t *)pDraw->pPalette;

  if (pDraw->ucHasTransparency) {
    uint8_t t = pDraw->ucTransparent;
    for (int i = 0; i < w; i++) {
      uint8_t idx = s[i];
      lineBuf[i] = (idx == t) ? TFT_BLACK : pal[idx];
    }
  } else {
    for (int i = 0; i < w; i++) lineBuf[i] = pal[s[i]];
  }

  tft.pushImage(x, y, w, 1, lineBuf);
}



// ===== BLE callbacks =====
class CtrlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;
    String cmd = String(v.c_str());
    cmd.trim();

    // Commands:
    // START:<bytes>
    // END
    // CLEAR
    // INFO
    if (cmd.startsWith("START:")) {
      uint32_t n = cmd.substring(6).toInt();
      if (n == 0) { notifyStatus("ERR:bad_len"); return; }

      if (rxActive) {
        if (rxFile) rxFile.close();
        rxActive = false;
      }

      // Ensure SPIFFS ready
      if (!SPIFFS.begin(true)) {
        notifyStatus("ERR:spiffs");
        return;
      }

      // Open file for overwrite
      rxFile = SPIFFS.open("/gif.gif", FILE_WRITE);
      if (!rxFile) {
        notifyStatus("ERR:file_open");
        return;
      }

      rxExpected = n;
      rxCount = 0;
      rxActive = true;
      gifReady = false;

      notifyStatus("OK:rx_start");
      return;
    }

    if (cmd == "END") {
      if (rxActive) {
        rxFile.flush();
        rxFile.close();
        rxActive = false;

        if (rxCount == rxExpected) {
          gifReady = true;
          notifyStatus("OK:rx_done");
        } else {
          notifyStatus("ERR:len_mismatch");
        }
      } else {
        notifyStatus("ERR:not_active");
      }
      return;
    }

    if (cmd == "CLEAR") {
      if (rxActive) { rxFile.close(); rxActive = false; }
      SPIFFS.remove("/gif.gif");
      gifReady = false;
      notifyStatus("OK:cleared");
      return;
    }

    if (cmd == "INFO") {
      notifyStatus(String("rx=") + (rxActive ? "1" : "0") +
                   " bytes=" + rxCount + "/" + rxExpected +
                   " ready=" + (gifReady ? "1" : "0"));
      return;
    }

    notifyStatus("ERR:unknown_cmd");
  }
};

class DataCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    if (!rxActive || !rxFile) return;

    std::string v = c->getValue();
    if (v.empty()) return;

    // Append chunk
    size_t wrote = rxFile.write((const uint8_t*)v.data(), v.size());
    rxCount += wrote;

    // Optional: periodic progress notify
    static uint32_t lastProg = 0;
    uint32_t now = millis();
    if (now - lastProg > 300) {
      lastProg = now;
      notifyStatus(String("PROG:") + rxCount + "/" + rxExpected);
    }

    // If we hit expected length, auto-close (END optional)
    if (rxCount >= rxExpected) {
      rxFile.flush();
      rxFile.close();
      rxActive = false;
      gifReady = true;
      notifyStatus("OK:rx_done_auto");
    }
  }
};

static void bleInit() {
  BLEDevice::init(DEV_NAME);

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());   // <-- add this
  BLEService* svc = server->createService(SVC_UUID);

  // BLECharacteristic* ctrl = svc->createCharacteristic(CTRL_UUID, BLECharacteristic::PROPERTY_WRITE);
  // ctrl->setCallbacks(new CtrlCallbacks());
  BLECharacteristic* ctrl = svc->createCharacteristic(
    CTRL_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  ctrl->setCallbacks(new CtrlCallbacks());  


  BLECharacteristic* data = svc->createCharacteristic(DATA_UUID, BLECharacteristic::PROPERTY_WRITE_NR);
  data->setCallbacks(new DataCallbacks());

  statChr = svc->createCharacteristic(STAT_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  statChr->addDescriptor(new BLE2902());

  svc->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();

  // Put UUID in the actual advertisement packet
  adv->addServiceUUID(SVC_UUID);

  // Put name in the advertisement packet (not only scan response)
  adv->setScanResponse(false);

  // Optional but often helps compatibility:
  adv->setMinPreferred(0x06);
  adv->setMinPreferred(0x12);

  BLEDevice::startAdvertising();
  notifyStatus("OK:adv");
}


// ===== GIF playback helper =====
static bool openGifFromSpiffs() {
  // if (!SPIFFS.begin(true)) return false;   // remove
  if (!SPIFFS.exists("/gif.gif")) return false;
  return gif.open("/gif.gif", GIFOpenFile, GIFCloseFile, GIFReadFile, GIFSeekFile, GIFDraw);
}


void setup() {
  Serial.begin(115200);
  delay(200);

  // Backlight
  pinMode(6, OUTPUT);
  digitalWrite(6, HIGH);

  // TFT
  tft.init();
  // tft.setSwapBytes(true);  // safer with RGB565 buffers

  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextSize(2);
  tft.setCursor(0, 0);
  tft.println("GIFCase");
  tft.println("Waiting BLE...");

  // SPIFFS
  SPIFFS.begin(true);
  //------------TESTING
  File f = SPIFFS.open("/hello.txt", FILE_WRITE);
  f.print("hello");
  f.close();
  f = SPIFFS.open("/hello.txt", FILE_READ);
  Serial.print("SPIFFS says: ");
  Serial.println(f.readString());
  f.close();


  // AnimatedGIF config
  gif.begin(LITTLE_ENDIAN_PIXELS); // we want RGB565 line output

  // BLE
  bleInit();
}

void loop() {
  // If we have a new GIF, play it in a loop.
  if (gifReady) {
    gifReady = false;

    tft.fillScreen(TFT_BLACK);
    tft.setCursor(0, 0);
    tft.println("Playing...");

    if (!openGifFromSpiffs()) {
      tft.println("GIF open failed");
      notifyStatus("ERR:gif_open");
      delay(1000);
      return;
    }

    // Playback loop: you can cap FPS by clamping delays if you want.
    // AnimatedGIF already obeys frame delays inside the file.
    while (gif.playFrame(true, NULL)) {
      // Optionally add thermal/perf cap:
      // delay(5);
      yield();
    }
    gif.close();

    tft.fillScreen(TFT_BLACK);
    tft.setCursor(0, 0);
    tft.println("Done. Send new GIF.");
    notifyStatus("OK:played");
  }

  delay(10);
}
