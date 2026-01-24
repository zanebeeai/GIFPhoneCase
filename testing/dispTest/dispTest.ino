#include <Arduino.h>
#include <TFT_eSPI.h>

TFT_eSPI tft;

void showTestPattern(const char* label, uint16_t color) {
  tft.fillScreen(color);
  tft.setTextColor(TFT_WHITE, color);
  tft.setTextSize(2);
  tft.setCursor(10, 10);
  tft.println("ILI9341 Test");
  tft.println(label);

  tft.drawRect(0, 0, tft.width(), tft.height(), TFT_WHITE);
  tft.drawLine(0, 0, tft.width()-1, tft.height()-1, TFT_WHITE);
  tft.drawLine(tft.width()-1, 0, 0, tft.height()-1, TFT_WHITE);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  // Backlight pin from your wiring
  const int BL = 8;
  pinMode(BL, OUTPUT);
  digitalWrite(BL, HIGH); // most boards: HIGH = on

  tft.init();

  // Run through rotations so you can see if any are mirrored/flipped
  for (int r = 0; r < 4; r++) {
    tft.setRotation(r);
    Serial.printf("Rotation %d, w=%d h=%d\n", r, tft.width(), tft.height());

    showTestPattern((String("Rotation ") + r + " RED").c_str(), TFT_RED);
    delay(600);
    showTestPattern((String("Rotation ") + r + " GREEN").c_str(), TFT_GREEN);
    delay(600);
    showTestPattern((String("Rotation ") + r + " BLUE").c_str(), TFT_BLUE);
    delay(600);
    showTestPattern((String("Rotation ") + r + " BLACK").c_str(), TFT_BLACK);
    delay(600);
  }

  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setCursor(10, 10);
  tft.setTextSize(2);
  tft.println("If you see this,");
  tft.println("SPI wiring + setup OK.");
}

void loop() {
  // Simple heartbeat pixel
  static bool on = false;
  on = !on;
  tft.fillCircle(tft.width()-12, 12, 6, on ? TFT_YELLOW : TFT_BLACK);
  delay(300);
}
