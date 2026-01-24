# Troubleshooting Guide

## GIF Processing Error: "parseGIF is not defined"

This error means the `gifuct-js` library isn't loading correctly. Here are solutions:

### Solution 1: Check Browser Console
1. Open DevTools (F12)
2. Go to Console tab
3. Look for errors loading `gifuct.min.js`
4. Check Network tab to see if the CDN request failed

### Solution 2: Try Different CDN
If the CDN is blocked or slow, you can download the library locally:

1. Download from: https://unpkg.com/gifuct-js@2.1.2/dist/gifuct.min.js
2. Save as `gifuct.min.js` in the `frontendProto` folder
3. Update `index.html`:
   ```html
   <script src="gifuct.min.js"></script>
   ```

### Solution 3: Use Alternative Library
If gifuct-js continues to have issues, we can switch to a different GIF processing library. Let me know and I can update the code.

### Solution 4: Check CORS/Network Issues
- Some CDNs may be blocked by your network/firewall
- Try accessing the CDN URL directly in your browser
- If it fails, use Solution 2 (download locally)

## BLE Connection Issues

### "GIFCase device not found"
- Ensure ESP32 is powered on
- Check that device name is exactly "GIFCase"
- Try resetting the ESP32
- Check ESP32 serial output for BLE advertising status

### Connection drops during upload
- Move devices closer together
- Reduce `CHUNK_SIZE` in config (try 200 or 160)
- Increase `BREATHER_SLEEP_MS` (try 20 or 30)

## General Issues

### API Key Not Working
- Verify key is correct in `app.js`
- Check Giphy dashboard for rate limits
- Ensure no extra spaces in the key

### GIF Processing Takes Too Long
- Large GIFs take time to process
- Check browser console for progress
- Consider reducing `MAX_DURATION_MS` or `MAX_FILE_SIZE`
