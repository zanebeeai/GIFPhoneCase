# GIFCase Web Controller

A standalone web application for searching Giphy GIFs, processing them for ESP32-S3 display, and uploading via Bluetooth Low Energy (BLE).

## Features

- 🔍 **Giphy Search**: Search and browse GIFs directly from Giphy API
- 🎨 **GIF Processing**: 
  - Automatic resizing to 240px width (TFT screen width)
  - Truncation to maximum 3 seconds
  - Frame rate compression to 8 FPS
  - Quality compression until file size threshold is met
- 📱 **BLE Upload**: Send processed GIFs to ESP32-S3 via Web Bluetooth
- ▶️ **Replay Control**: Replay GIFs on ESP32 without re-uploading
- 👀 **Live Preview**: Preview processed GIFs before uploading

## Setup

### 1. Get a Giphy API Key

1. Go to [Giphy Developers](https://developers.giphy.com/)
2. Create an account and create a new app
3. Copy your API key

### 2. Configure the API Key

**Option A: Using config.js (Recommended - keeps key out of git)**

1. Copy the example config file:
   ```bash
   cp config.js.example config.js
   ```

2. Edit `config.js` and add your API key:
   ```javascript
   const USER_CONFIG = {
       GIPHY_API_KEY: 'your-actual-api-key-here',
   };
   ```

3. The `config.js` file is already in `.gitignore`, so your key won't be committed.

**Option B: Direct in app.js**

Alternatively, you can edit `app.js` directly and replace `YOUR_GIPHY_API_KEY` with your actual key. 

⚠️ **Security Note:** In client-side web apps, API keys will be visible in browser DevTools regardless of storage method. The `config.js` approach keeps your key out of git but doesn't provide true security. See `SECURITY.md` for details and best practices. Giphy API keys are designed for client-side use with rate limiting and domain restrictions.

### 3. Serve the Application

Since Web Bluetooth requires HTTPS (or localhost), you have a few options:

#### Option A: Local Development Server (Recommended for testing)

Using Python:
```bash
cd frontendProto
python -m http.server 8000
```

Then open: `http://localhost:8000`

#### Option B: HTTPS Server

For production or if you need HTTPS:
- Use a service like [Netlify](https://www.netlify.com/), [Vercel](https://vercel.com/), or [GitHub Pages](https://pages.github.com/)
- Or set up a local HTTPS server using tools like `mkcert` or `ngrok`

### 4. Browser Requirements

- **Chrome/Edge**: Full Web Bluetooth support
- **Firefox/Safari**: Web Bluetooth not supported (use Chrome/Edge)

## Usage

1. **Search for GIFs**: Enter a search term and click "Search"
2. **Select a GIF**: Click on any GIF from the search results
3. **Wait for Processing**: The GIF will be automatically processed (resized, truncated, compressed)
4. **Connect to ESP32**: Click "Connect to GIFCase" and select your device
5. **Upload**: Click "Upload & Play" to send the GIF to your ESP32
6. **Replay**: Use the "Replay on ESP32" button to replay the GIF without re-uploading

## Configuration

You can adjust processing parameters in `app.js`:

```javascript
const CONFIG = {
    TFT_WIDTH: 240,              // Screen width
    TFT_HEIGHT: 320,             // Screen height
    MAX_DURATION_MS: 3000,       // Maximum GIF duration (3 seconds)
    MAX_FILE_SIZE: 500 * 1024,   // Target file size (500KB)
    TARGET_FPS: 8,               // Target frame rate
    CHUNK_SIZE: 240,             // BLE chunk size
    // ... BLE UUIDs
};
```

## How It Works

### GIF Processing Pipeline

1. **Download**: GIF is downloaded from Giphy
2. **Decode**: Frames are extracted using `gifuct-js`
3. **Truncate**: Frames beyond 3 seconds are removed
4. **Resize**: Frames are resized to 240px width (maintaining aspect ratio)
5. **Frame Rate**: Frames are sampled to target 8 FPS
6. **Compress**: Quality is reduced iteratively until file size is acceptable
7. **Encode**: New GIF is created using `gif.js`

### BLE Communication

The app communicates with ESP32 using the same protocol as `gifSender3.py`:

- **CTRL Characteristic**: Commands (`START:<bytes>`, `END`, `REPLAY`, `INFO`)
- **DATA Characteristic**: GIF binary data (chunked)
- **STAT Characteristic**: Status updates (read-only for reliability)

### Memory Management

- When uploading a **new GIF**: ESP32 automatically clears old GIF from memory (via `START` command)
- When using **Replay**: ESP32 plays the existing GIF without clearing memory
- GIFs remain in ESP32 memory until a new upload starts

## Troubleshooting

### "Web Bluetooth is not supported"
- Use Chrome or Edge browser
- Ensure you're using HTTPS or localhost

### "GIFCase device not found"
- Ensure ESP32 is powered on and advertising
- Check that the device name is "GIFCase"
- Try disconnecting and reconnecting

### "Processing error"
- Check browser console for detailed error messages
- Ensure Giphy API key is set correctly
- Some GIFs may be too complex to process
- If `parseGIF` or `decompressFrames` are undefined, check that gifuct-js loaded correctly
- Try refreshing the page or checking browser console for library loading errors

### Upload fails
- Check ESP32 serial output for error messages
- Try reducing `MAX_FILE_SIZE` in config
- Ensure stable BLE connection

## File Structure

```
frontendProto/
├── index.html      # Main HTML structure
├── styles.css      # Styling
├── app.js          # Main application logic
└── README.md       # This file
```

## Dependencies

All dependencies are loaded via CDN:
- `gif.js` - GIF encoding
- `gifuct-js` - GIF decoding
- Web Bluetooth API (browser native)

## License

This project is part of the GIFCase firmware project.
