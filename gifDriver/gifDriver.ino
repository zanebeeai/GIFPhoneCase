/*
  GIFCase Firmware (ESP32-S3 + ST7789 via TFT_eSPI)
  Reliable + faster BLE uploads on Windows

  What this version fixes/improves:
  1) Buffered SPIFFS writes (fewer flash writes => faster upload)
  2) STAT characteristic is READ + NOTIFY (host can poll even if notify subscription fails)
  3) END is idempotent: if RX already auto-finished, END returns OK instead of ERR:not_active
  4) INFO updates STAT with a full state string for deterministic validation
  5) Playback interrupt behavior preserved (START/REPLAY stops current playback)

  Keep your UUIDs and overall behavior identical.
*/

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <FS.h>
#include <SPIFFS.h>
#include <AnimatedGIF.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ===================== User knobs =====================
static const int PIN_BL = 8;
static const uint32_t PLAY_MS = 10000;

// RX buffering (increase if you want; 16–32 KB typically fine on ESP32-S3)
static constexpr size_t RX_BUF_SZ = 16 * 1024;
static constexpr size_t RX_FLUSH_THRESHOLD = 12 * 1024;

// ===================== Globals =====================
using File = fs::File;

TFT_eSPI tft = TFT_eSPI();
AnimatedGIF gif;

// BLE UUIDs (same as your original)
static const char* DEV_NAME = "GIFCase";
static BLEUUID SVC_UUID ("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
static BLEUUID CTRL_UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
static BLEUUID DATA_UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E");
static BLEUUID STAT_UUID("6E400004-B5A3-F393-E0A9-E50E24DCCA9E");

// RX state
static File rxFile;
static bool rxActive = false;
static uint32_t rxExpected = 0;
static uint32_t rxCount = 0;

// Playback state
static volatile bool playRequested = false;
static volatile bool stopPlayback  = false;

// BLE characteristics
static BLECharacteristic* statChr = nullptr;

// Cached status (for READ)
static String lastStatus = "BOOT";

// Throttles
static uint32_t lastProgMs = 0;

// RX buffer
static uint8_t rxBuf[RX_BUF_SZ];
static size_t rxBufUsed = 0;

// ===================== GIF file callbacks =====================
static fs::File gifFile;

static void* GIFOpenFile(const char *fname, int32_t *pSize) {
  gifFile = SPIFFS.open(fname, FILE_READ);
  if (!gifFile) return nullptr;
  *pSize = (int32_t)gifFile.size();
  return (void*)&gifFile;
}
static void GIFCloseFile(void *pHandle) {
  fs::File *f = (fs::File*)pHandle;
  if (f) f->close();
}
static int32_t GIFReadFile(GIFFILE *pFile, uint8_t *pBuf, int32_t iLen) {
  fs::File *f = (fs::File*)pFile->fHandle;
  if (!f) return 0;
  int32_t n = (int32_t)f->read(pBuf, iLen);
  pFile->iPos = (int32_t)f->position();
  return n;
}
static int32_t GIFSeekFile(GIFFILE *pFile, int32_t iPosition) {
  fs::File *f = (fs::File*)pFile->fHandle;
  if (!f) return 0;
  f->seek(iPosition);
  pFile->iPos = iPosition;
  return iPosition;
}

// ===================== Status helpers =====================
static void setStatus(const String& s, bool doNotify = true) {
  lastStatus = s;
  if (statChr) {
    statChr->setValue(lastStatus.c_str());
    if (doNotify) statChr->notify();
  }
  Serial.println("[STAT] " + lastStatus);
}

static uint32_t spiffsFileSize(const char* path) {
  if (!SPIFFS.exists(path)) return 0;
  File f = SPIFFS.open(path, FILE_READ);
  if (!f) return 0;
  uint32_t sz = (uint32_t)f.size();
  f.close();
  return sz;
}

static String infoString() {
  uint32_t sz = spiffsFileSize("/gif.gif");
  return String("rx=") + (rxActive ? "1" : "0") +
         " bytes=" + rxCount + "/" + rxExpected +
         " buf=" + rxBufUsed +
         " play=" + (playRequested ? "1" : "0") +
         " file=" + sz;
}

// ===================== Display draw =====================
static uint16_t lineBuf[320];

static void GIFDraw(GIFDRAW *pDraw) {
  const int xOff = (tft.width() - pDraw->iCanvasWidth) / 2;

  const int y = pDraw->iY + pDraw->y;
  if (y < 0 || y >= (int)tft.height()) return;

  int xBase = xOff + pDraw->iX;
  int w     = pDraw->iWidth;

  int srcOffset = 0;
  if (xBase < 0) { srcOffset = -xBase; w += xBase; xBase = 0; }
  if (xBase + w > (int)tft.width()) w = (int)tft.width() - xBase;
  if (w <= 0) return;

  const uint8_t  *src = pDraw->pPixels + srcOffset;
  const uint16_t *pal = (const uint16_t*)pDraw->pPalette;

  if (!pDraw->ucHasTransparency) {
    for (int i = 0; i < w; i++) lineBuf[i] = pal[src[i]];
    tft.pushImage(xBase, y, w, 1, lineBuf);
    return;
  }

  const uint8_t t = pDraw->ucTransparent;
  int i = 0;
  while (i < w) {
    while (i < w && src[i] == t) i++;
    if (i >= w) break;

    const int runStart = i;
    while (i < w && src[i] != t) i++;
    const int runLen = i - runStart;

    for (int k = 0; k < runLen; k++) lineBuf[k] = pal[src[runStart + k]];
    tft.pushImage(xBase + runStart, y, runLen, 1, lineBuf);
  }
}

// ===================== RX buffering =====================
static inline void rxResetBuffer() { rxBufUsed = 0; }

static inline bool rxFlushBuffer() {
  if (!rxActive || !rxFile) return false;
  if (rxBufUsed == 0) return true;

  size_t wrote = rxFile.write(rxBuf, rxBufUsed);
  if (wrote != rxBufUsed) {
    setStatus("ERR:spiffs_write");
    return false;
  }
  rxBufUsed = 0;
  return true;
}

static inline bool rxAppend(const uint8_t* data, size_t len) {
  while (len > 0) {
    size_t space = RX_BUF_SZ - rxBufUsed;
    if (space == 0) {
      if (!rxFlushBuffer()) return false;
      space = RX_BUF_SZ - rxBufUsed;
    }

    size_t take = (len < space) ? len : space;
    memcpy(rxBuf + rxBufUsed, data, take);
    rxBufUsed += take;
    data += take;
    len -= take;

    if (rxBufUsed >= RX_FLUSH_THRESHOLD) {
      if (!rxFlushBuffer()) return false;
    }
  }
  return true;
}

static inline void rxAbort(const char* reason) {
  stopPlayback = true;

  if (rxActive) {
    rxFlushBuffer();
    if (rxFile) rxFile.close();
    rxActive = false;
  }

  setStatus(String("ERR:") + reason);
}

static inline void rxFinishAndValidate(const char* okTag) {
  if (!rxActive) return;

  if (!rxFlushBuffer()) {
    if (rxFile) rxFile.close();
    rxActive = false;
    return;
  }

  rxFile.flush();
  rxFile.close();
  rxActive = false;

  // Validate by byte count
  if (rxCount == rxExpected) {
    playRequested = true;
    setStatus(String("OK:") + okTag);
  } else {
    setStatus("ERR:len_mismatch");
  }
}

// ===================== BLE callbacks =====================
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    Serial.println("BLE connected");
    setStatus("OK:connected");
  }
  void onDisconnect(BLEServer*) override {
    Serial.println("BLE disconnected -> restart advertising");
    BLEDevice::startAdvertising();
    setStatus("OK:adv", false);
  }
};

class CtrlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;

    String cmd = String(v.c_str());
    cmd.trim();

    // START:<bytes>
    if (cmd.startsWith("START:")) {
      stopPlayback = true;
      playRequested = false;

      uint32_t n = cmd.substring(6).toInt();
      if (n == 0) { setStatus("ERR:bad_len"); return; }

      if (!SPIFFS.begin(true)) { setStatus("ERR:spiffs"); return; }

      if (rxActive) {
        rxFlushBuffer();
        if (rxFile) rxFile.close();
        rxActive = false;
      }

      rxFile = SPIFFS.open("/gif.gif", FILE_WRITE);
      if (!rxFile) { setStatus("ERR:file_open"); return; }

      rxExpected = n;
      rxCount = 0;
      rxActive = true;
      rxResetBuffer();

      setStatus("OK:rx_start");
      return;
    }

    // END (idempotent)
    if (cmd == "END") {
      if (rxActive) {
        rxFinishAndValidate("rx_done");
        return;
      }

      // If already auto-finished, accept END if file size matches expected
      if (rxExpected > 0) {
        uint32_t sz = spiffsFileSize("/gif.gif");
        if (sz == rxExpected) {
          // Ensure playRequested is set (helpful if host wants END->OK->REPLAY)
          playRequested = true;
          setStatus("OK:rx_done");
          return;
        }
      }

      setStatus("ERR:not_active");
      return;
    }

    if (cmd == "REPLAY") {
      stopPlayback = true;
      if (SPIFFS.exists("/gif.gif")) {
        playRequested = true;
        setStatus("OK:replay");
      } else {
        setStatus("ERR:no_gif");
      }
      return;
    }

    if (cmd == "CLEAR") {
      stopPlayback = true;

      if (rxActive) {
        rxFlushBuffer();
        if (rxFile) rxFile.close();
        rxActive = false;
      }

      SPIFFS.remove("/gif.gif");
      playRequested = false;
      rxExpected = 0;
      rxCount = 0;
      rxResetBuffer();

      setStatus("OK:cleared");
      return;
    }

    if (cmd == "INFO") {
      setStatus(infoString());
      return;
    }

    setStatus("ERR:unknown_cmd");
  }
};

class DataCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    if (!rxActive || !rxFile) return;

    std::string v = c->getValue();
    if (v.empty()) return;

    const uint8_t* p = (const uint8_t*)v.data();
    const size_t n = v.size();

    if (!rxAppend(p, n)) {
      rxAbort("rx_append");
      return;
    }

    rxCount += (uint32_t)n;

    uint32_t now = millis();
    if (now - lastProgMs > 300) {
      lastProgMs = now;
      setStatus(String("PROG:") + rxCount + "/" + rxExpected);
    }

    // Auto-finish if we hit expected
    if (rxCount >= rxExpected) {
      rxFinishAndValidate("rx_done_auto");
    }
  }
};

// ===================== BLE init =====================
static void bleInit() {
  BLEDevice::init(DEV_NAME);

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* svc = server->createService(SVC_UUID);

  BLECharacteristic* ctrl = svc->createCharacteristic(
    CTRL_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  ctrl->setCallbacks(new CtrlCallbacks());

  BLECharacteristic* data = svc->createCharacteristic(
    DATA_UUID,
    BLECharacteristic::PROPERTY_WRITE_NR
  );
  data->setCallbacks(new DataCallbacks());

  // STAT: READ + NOTIFY so Windows host can poll if notify subscription is flaky
  statChr = svc->createCharacteristic(
    STAT_UUID,
    BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ
  );
  statChr->addDescriptor(new BLE2902());
  statChr->setValue(lastStatus.c_str());

  svc->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(false);
  adv->setMinPreferred(0x06);
  adv->setMinPreferred(0x12);

  BLEDevice::startAdvertising();
  setStatus("OK:adv");
}

// ===================== GIF open helper =====================
static bool openGifFromSpiffs() {
  if (!SPIFFS.exists("/gif.gif")) return false;
  return gif.open("/gif.gif", GIFOpenFile, GIFCloseFile, GIFReadFile, GIFSeekFile, GIFDraw);
}

// ===================== Setup / loop =====================
void setup() {
  Serial.begin(115200);
  delay(200);

  SPIFFS.begin(true);

  pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_BL, HIGH);

  tft.init();
  tft.setRotation(1);
  tft.setSwapBytes(true);
  tft.fillScreen(TFT_BLACK);

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextSize(2);
  tft.setCursor(0, 0);
  tft.println("GIFCase");
  tft.println("Waiting BLE...");

  gif.begin(LITTLE_ENDIAN_PIXELS);

  bleInit();
}

void loop() {
  if (playRequested) {
    playRequested = false;
    stopPlayback  = false;

    tft.fillScreen(TFT_BLACK);
    tft.setCursor(0, 0);
    tft.println("Playing...");

    uint32_t tStart = millis();

    while (!stopPlayback && (millis() - tStart) < PLAY_MS) {
      if (!openGifFromSpiffs()) {
        setStatus("ERR:gif_open");
        break;
      }

      while (!stopPlayback && gif.playFrame(true, NULL)) {
        yield();
      }

      gif.close();
      yield();
    }

    tft.fillScreen(TFT_BLACK);
    tft.setCursor(0, 0);
    tft.println("Done. Send GIF.");
    setStatus("OK:played");
  }

  delay(10);
}
