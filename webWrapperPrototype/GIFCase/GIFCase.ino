#include <Arduino.h>
#include <TFT_eSPI.h>
#include <SPI.h>
#include <FS.h>
#include <SPIFFS.h>
#include <AnimatedGIF.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

using File = fs::File;

// ===================== CONFIG =====================
static const char* DEV_NAME = "GIFCase";

// Nordic UART-ish UUIDs you used:
static BLEUUID SVC_UUID ("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
static BLEUUID CTRL_UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E"); // Write / WriteNoRsp (text)
static BLEUUID DATA_UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E"); // WriteNoRsp (binary)
static BLEUUID STAT_UUID("6E400004-B5A3-F393-E0A9-E50E24DCCA9E"); // Notify (status)

static const char* GIF_PATH = "/gif.gif";

// Backlight pin (yours was GPIO6)
static const int PIN_BL = 6;

// ===================== DISPLAY / GIF =====================
TFT_eSPI tft;
AnimatedGIF gif;

// AnimatedGIF file handle for callbacks
static fs::File gifFile;

// Drawing buffer (max TFT width = 320 in your landscape mode)
static uint16_t lineBuf[320];

// ===================== BLE STATE =====================
static BLECharacteristic* statChr = nullptr;

static File rxFile;
static bool rxActive = false;
static uint32_t rxExpected = 0;
static uint32_t rxCount = 0;

static bool gifStored = false;

// Playback state machine
enum PlayState { PS_IDLE, PS_OPENING, PS_PLAYING, PS_DONE };
static PlayState playState = PS_IDLE;

static bool playRequested = false;
static uint32_t playDurationMs = 0;
static uint32_t playDeadlineMs = 0;

// ===================== HELPERS =====================
static void notifyStatus(const String& s) {
  if (statChr) {
    statChr->setValue(s.c_str());
    statChr->notify();
  }
  Serial.println("[STAT] " + s);
}

static void drawHeader(const char* l1, const char* l2 = nullptr) {
  tft.fillScreen(TFT_BLACK);
  tft.setCursor(0, 0);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextSize(2);
  if (l1) tft.println(l1);
  if (l2) tft.println(l2);
}

static void spiffsEnsure() {
  static bool mounted = false;
  if (!mounted) {
    mounted = SPIFFS.begin(true);
    Serial.println(mounted ? "SPIFFS mounted" : "SPIFFS mount failed");
  }
}

static void clearStoredGif() {
  if (rxActive && rxFile) {
    rxFile.close();
    rxActive = false;
  }
  spiffsEnsure();
  if (SPIFFS.exists(GIF_PATH)) {
    SPIFFS.remove(GIF_PATH);
  }
  gifStored = false;
  notifyStatus("OK:cleared");
}

// ===================== AnimatedGIF FS callbacks =====================
static void* GIFOpenFile(const char *fname, int32_t *pSize) {
  spiffsEnsure();
  gifFile = SPIFFS.open(fname, FILE_READ);
  if (!gifFile) return nullptr;
  *pSize = (int32_t)gifFile.size();
  return (void*)&gifFile;
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

// ===================== AnimatedGIF draw callback =====================
// This assumes AnimatedGIF is providing indexed pixels + RGB565 palette.
// We center horizontally; vertical alignment is top-left (you can center later).
static void GIFDraw(GIFDRAW *pDraw) {
  // Center horizontally based on canvas width
  const int xOff = (tft.width() - pDraw->iCanvasWidth) / 2;

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
    for (int i = 0; i < w; i++) {
      lineBuf[i] = pal[s[i]];
    }
  }

  // NOTE: Color issues are usually swap-bytes / BGR order. Keep this simple for now.
  tft.pushImage(x, y, w, 1, lineBuf);
}

// ===================== BLE CALLBACKS =====================
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    Serial.println("BLE connected");
    notifyStatus("OK:connected");
  }
  void onDisconnect(BLEServer* pServer) override {
    Serial.println("BLE disconnected -> restart advertising");
    BLEDevice::startAdvertising();
  }
};

static void requestPlaySeconds(uint32_t seconds) {
  if (!gifStored) {
    notifyStatus("ERR:no_gif");
    return;
  }
  playDurationMs = seconds * 1000UL;
  playRequested = true;
  notifyStatus(String("OK:play_req:") + seconds);
}

class CtrlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;

    String cmd(v.c_str());
    cmd.trim();

    // Commands:
    // CLEAR
    // START:<bytes>
    // END
    // PLAY:<seconds>
    // STOP
    // INFO
    if (cmd == "CLEAR") {
      clearStoredGif();
      return;
    }

    if (cmd.startsWith("START:")) {
      uint32_t n = cmd.substring(6).toInt();
      if (n == 0) { notifyStatus("ERR:bad_len"); return; }

      // New upload should clear old gif first (your requirement)
      clearStoredGif();

      spiffsEnsure();
      rxFile = SPIFFS.open(GIF_PATH, FILE_WRITE);
      if (!rxFile) { notifyStatus("ERR:file_open"); return; }

      rxExpected = n;
      rxCount = 0;
      rxActive = true;
      gifStored = false;

      notifyStatus("OK:rx_start");
      return;
    }

    if (cmd == "END") {
      if (!rxActive) { notifyStatus("ERR:not_active"); return; }
      rxFile.flush();
      rxFile.close();
      rxActive = false;

      if (rxCount == rxExpected) {
        gifStored = true;
        notifyStatus("OK:rx_done");
        // Optional: auto-play for 10s if you want, but keep explicit for now.
      } else {
        notifyStatus("ERR:len_mismatch");
      }
      return;
    }

    if (cmd.startsWith("PLAY:")) {
      uint32_t sec = cmd.substring(5).toInt();
      if (sec == 0) sec = 10;
      requestPlaySeconds(sec);
      return;
    }

    if (cmd == "STOP") {
      playRequested = false;
      playState = PS_IDLE;
      gif.close();
      notifyStatus("OK:stopped");
      drawHeader("GIFCase", "Waiting BLE...");
      return;
    }

    if (cmd == "INFO") {
      notifyStatus(
        String("rx=") + (rxActive ? "1" : "0") +
        " bytes=" + rxCount + "/" + rxExpected +
        " stored=" + (gifStored ? "1" : "0") +
        " play=" + (playState == PS_PLAYING ? "1" : "0")
      );
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

    size_t wrote = rxFile.write((const uint8_t*)v.data(), v.size());
    rxCount += wrote;

    static uint32_t lastProgMs = 0;
    uint32_t now = millis();
    if (now - lastProgMs > 400) {
      lastProgMs = now;
      notifyStatus(String("PROG:") + rxCount + "/" + rxExpected);
    }

    // Auto-close if exact/over
    if (rxCount >= rxExpected) {
      rxFile.flush();
      rxFile.close();
      rxActive = false;
      gifStored = true;
      notifyStatus("OK:rx_done_auto");
    }
  }
};

// ===================== BLE INIT =====================
static void bleInit() {
  BLEDevice::init(DEV_NAME);

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* svc = server->createService(SVC_UUID);

  // CTRL: accept both write + write without response
  BLECharacteristic* ctrl = svc->createCharacteristic(
    CTRL_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  ctrl->setCallbacks(new CtrlCallbacks());

  // DATA: write without response (binary)
  BLECharacteristic* data = svc->createCharacteristic(
    DATA_UUID,
    BLECharacteristic::PROPERTY_WRITE_NR
  );
  data->setCallbacks(new DataCallbacks());

  // STAT: notify
  statChr = svc->createCharacteristic(
    STAT_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  statChr->addDescriptor(new BLE2902());

  svc->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(false);
  adv->setMinPreferred(0x06);
  adv->setMinPreferred(0x12);

  BLEDevice::startAdvertising();
  notifyStatus("OK:adv");
}

// ===================== GIF OPEN =====================
static bool openGifFromSpiffs() {
  spiffsEnsure();
  if (!SPIFFS.exists(GIF_PATH)) return false;
  return gif.open(GIF_PATH, GIFOpenFile, GIFCloseFile, GIFReadFile, GIFSeekFile, GIFDraw);
}

// ===================== SETUP / LOOP =====================
void setup() {
  Serial.begin(115200);
  delay(150);

  pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_BL, HIGH);

  tft.init();
  tft.setRotation(1);   // 320x240 landscape
  // If colors are wrong later, the first toggles to test:
  // tft.setSwapBytes(true);

  drawHeader("GIFCase", "Waiting BLE...");

  spiffsEnsure();
  gif.begin(LITTLE_ENDIAN_PIXELS);

  bleInit();
}

static void handlePlaybackStateMachine() {
  // Start requested?
  if (playRequested) {
    playRequested = false;
    playDeadlineMs = millis() + playDurationMs;
    playState = PS_OPENING;
  }

  if (playState == PS_IDLE) return;

  if (playState == PS_OPENING) {
    drawHeader("Playing...");
    if (!openGifFromSpiffs()) {
      notifyStatus("ERR:gif_open");
      drawHeader("GIFCase", "Waiting BLE...");
      playState = PS_IDLE;
      return;
    }
    notifyStatus("OK:gif_open");
    playState = PS_PLAYING;
    return;
  }

  if (playState == PS_PLAYING) {
    // Time up?
    if ((int32_t)(millis() - playDeadlineMs) >= 0) {
      gif.close();
      playState = PS_DONE;
      return;
    }

    // Non-blocking: play ONE frame worth of work per loop.
    // playFrame(true, NULL) will delay internally for frame timing.
    // That’s acceptable here; if you need BLE ultra-responsive, switch to playFrame(false, ...).
    bool ok = gif.playFrame(true, NULL);
    if (!ok) {
      // Reached end of GIF. Loop by reopening if time remains.
      gif.close();
      if ((int32_t)(millis() - playDeadlineMs) < 0) {
        playState = PS_OPENING;
      } else {
        playState = PS_DONE;
      }
    }
    return;
  }

  if (playState == PS_DONE) {
    drawHeader("Done.", "Waiting BLE...");
    notifyStatus("OK:played");
    playState = PS_IDLE;
    return;
  }
}

void loop() {
  handlePlaybackStateMachine();
  delay(2);
}
