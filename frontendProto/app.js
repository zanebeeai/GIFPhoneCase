// Configuration
// For personal/local use: Just paste your Giphy API key here
const CONFIG = {
    GIPHY_API_KEY: 'mhpttv5MCqejur7dwoIqgYCyDQfOrW6C', // Your Giphy API key
    TFT_WIDTH: 320,  // Screen width
    TFT_HEIGHT: 240, // Screen height
    MAX_DURATION_MS: 3000, // 3 seconds
    MAX_FILE_SIZE: 500 * 1024, // 500KB target (adjust as needed)
    TARGET_FPS: 8, // Target frame rate after compression
    BLE_SERVICE_UUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    BLE_CTRL_UUID: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    BLE_DATA_UUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    BLE_STAT_UUID: '6e400004-b5a3-f393-e0a9-e50e24dcca9e',
    CHUNK_SIZE: 240,
    YIELD_EVERY_WRITES: 200,
    BREATHER_EVERY_BYTES: 240 * 2000,
    BREATHER_SLEEP_MS: 10
};

// State
let selectedGifUrl = null;
let processedGifBlob = null;
let bleDevice = null;
let bleServer = null;
let ctrlCharacteristic = null;
let dataCharacteristic = null;
let statCharacteristic = null;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const gifResults = document.getElementById('gifResults');
const selectedGifContainer = document.getElementById('selectedGifContainer');
const processingStatus = document.getElementById('processingStatus');
const previewContainer = document.getElementById('previewContainer');
const previewGif = document.getElementById('previewGif');
const gifInfo = document.getElementById('gifInfo');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectionStatus = document.getElementById('connectionStatus');
const uploadBtn = document.getElementById('uploadBtn');
const replayBtn = document.getElementById('replayBtn');
const uploadProgress = document.getElementById('uploadProgress');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    searchBtn.addEventListener('click', handleSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });
    connectBtn.addEventListener('click', handleConnect);
    disconnectBtn.addEventListener('click', handleDisconnect);
    uploadBtn.addEventListener('click', handleUpload);
    replayBtn.addEventListener('click', handleReplay);
    
    // Check for Giphy API key
    if (CONFIG.GIPHY_API_KEY === 'YOUR_GIPHY_API_KEY') {
        showError('Please set your Giphy API key in app.js (CONFIG.GIPHY_API_KEY)');
    }
});

// Giphy Search
async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) return;
    
    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching...';
    gifResults.innerHTML = '<div class="spinner"></div> Loading...';
    
    try {
        const response = await fetch(
            `https://api.giphy.com/v1/gifs/search?api_key=${CONFIG.GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=20&rating=g`
        );
        const data = await response.json();
        
        if (data.data && data.data.length > 0) {
            displayGifResults(data.data);
        } else {
            gifResults.innerHTML = '<p>No GIFs found. Try a different search term.</p>';
        }
    } catch (error) {
        console.error('Search error:', error);
        gifResults.innerHTML = '<p style="color: red;">Error searching GIFs. Check your API key and connection.</p>';
    } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
    }
}

function displayGifResults(gifs) {
    gifResults.innerHTML = '';
    gifs.forEach(gif => {
        const item = document.createElement('div');
        item.className = 'gif-result-item';
        item.innerHTML = `<img src="${gif.images.fixed_height_small.url}" alt="${gif.title}" loading="lazy">`;
        item.addEventListener('click', () => selectGif(gif.images.original.url, gif.title));
        gifResults.appendChild(item);
    });
}

async function selectGif(url, title) {
    selectedGifUrl = url;
    
    // Update UI
    selectedGifContainer.innerHTML = `<img src="${url}" alt="${title}">`;
    previewContainer.classList.remove('active');
    processingStatus.classList.remove('active');
    processedGifBlob = null;
    
    // Process the GIF
    await processGif(url);
}

// GIF Processing using libgif.js for decoding
async function processGif(url) {
    processingStatus.classList.add('active');
    processingStatus.textContent = 'Processing GIF: Downloading...';
    processingStatus.classList.remove('error');
    
    try {
        // Download the GIF
        const response = await fetch(url);
        const blob = await response.blob();
        const gifUrl = URL.createObjectURL(blob);
        
        processingStatus.textContent = 'Processing GIF: Extracting frames...';
        
        // Use libgif to decode frames
        const frames = await extractGifFrames(gifUrl);
        
        if (frames.length === 0) {
            throw new Error('No frames extracted');
        }
        
        // Calculate frame timing and truncate to 3 seconds
        // Include frames up to (but not exceeding) 3 seconds
        let totalTime = 0;
        const maxFrames = [];
        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const nextTotalTime = totalTime + frame.delay;
            
            // Include frame if adding it doesn't exceed limit, or if it's the first frame
            if (nextTotalTime <= CONFIG.MAX_DURATION_MS || maxFrames.length === 0) {
                maxFrames.push(frame);
                totalTime = nextTotalTime;
            } else {
                // Stop here - we've reached the limit
                break;
            }
        }
        
        if (maxFrames.length === 0) {
            throw new Error('No frames after truncation');
        }
        
        console.log(`[GIF Processing] Truncated to ${maxFrames.length} frames (${(totalTime / 1000).toFixed(2)}s of ${CONFIG.MAX_DURATION_MS / 1000}s)`);
        
        processingStatus.textContent = `Processing GIF: Resizing and compressing (${maxFrames.length} frames)...`;
        
        // Resize frames to fill TFT screen (320x240) - stretch to fit
        const resizedFrames = maxFrames.map(frame => {
            const canvas = document.createElement('canvas');
            // Use willReadFrequently for better performance with gif.js
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const img = frame.canvas;
            
            // Set canvas to full screen size (320 width x 240 height)
            canvas.width = CONFIG.TFT_WIDTH;   // 320
            canvas.height = CONFIG.TFT_HEIGHT; // 240
            
            // Fill with black background first
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Draw image stretched to fill the entire canvas
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return { canvas, delay: frame.delay };
        });
        
        // Limit frame count to avoid encoding hangs (gif.js without workers is slow)
        const MAX_FRAMES_FOR_ENCODING = 15; // Limit to prevent hangs
        let framesToEncode = resizedFrames;
        if (resizedFrames.length > MAX_FRAMES_FOR_ENCODING) {
            processingStatus.textContent = `Processing GIF: Limiting to ${MAX_FRAMES_FOR_ENCODING} frames (from ${resizedFrames.length})...`;
            // Sample frames evenly
            const step = Math.ceil(resizedFrames.length / MAX_FRAMES_FOR_ENCODING);
            framesToEncode = [];
            for (let i = 0; i < resizedFrames.length; i += step) {
                framesToEncode.push(resizedFrames[i]);
            }
            console.log(`[GIF Processing] Reduced from ${resizedFrames.length} to ${framesToEncode.length} frames`);
        }
        
        // Adjust frame rate and compress
        processingStatus.textContent = `Processing GIF: Creating optimized GIF (${framesToEncode.length} frames)...`;
        
        let quality = 7; // Start with medium quality (lower = faster encoding)
        let finalBlob = null;
        let attempts = 0;
        const maxAttempts = 5;
        
        while (attempts < maxAttempts) {
            processingStatus.textContent = `Processing GIF: Encoding (quality: ${quality}, attempt ${attempts + 1}/${maxAttempts})...`;
            console.log(`[GIF Encoding] Starting attempt ${attempts + 1} with quality ${quality}, ${framesToEncode.length} frames`);
            
            const startTime = Date.now();
            try {
                finalBlob = await createGifFromFrames(framesToEncode, quality, (progress) => {
                    processingStatus.textContent = `Processing GIF: Encoding... ${Math.round(progress * 100)}%`;
                });
                
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[GIF Encoding] Completed in ${elapsed}s, size: ${(finalBlob.size / 1024).toFixed(2)} KB`);
                
                if (finalBlob.size <= CONFIG.MAX_FILE_SIZE || quality <= 1) {
                    break;
                }
                
                quality = Math.max(1, Math.floor(quality * 0.7)); // Reduce quality
                attempts++;
                processingStatus.textContent = `Processing GIF: File too large (${(finalBlob.size / 1024).toFixed(2)} KB), retrying with lower quality...`;
            } catch (error) {
                console.error(`[GIF Encoding] Error on attempt ${attempts + 1}:`, error);
                processingStatus.textContent = `Processing GIF: Encoding error, retrying...`;
                quality = Math.max(1, Math.floor(quality * 0.7));
                attempts++;
                
                if (attempts >= maxAttempts) {
                    throw error;
                }
            }
        }
        
        processedGifBlob = finalBlob;
        
        // Display preview
        const previewUrl = URL.createObjectURL(finalBlob);
        previewGif.innerHTML = `<img src="${previewUrl}" alt="Processed GIF">`;
        gifInfo.innerHTML = `
            <strong>Processed GIF Info:</strong><br>
            Size: ${(finalBlob.size / 1024).toFixed(2)} KB<br>
            Frames: ${framesToEncode.length}${framesToEncode.length < resizedFrames.length ? ` (reduced from ${resizedFrames.length})` : ''}<br>
            Dimensions: ${CONFIG.TFT_WIDTH}x${framesToEncode[0].canvas.height}<br>
            Duration: ${(framesToEncode.reduce((sum, f) => sum + f.delay, 0) / 1000).toFixed(2)}s
        `;
        previewContainer.classList.add('active');
        
        processingStatus.textContent = `✓ Processing complete! Size: ${(finalBlob.size / 1024).toFixed(2)} KB`;
        processingStatus.classList.remove('error');
        
        uploadBtn.disabled = !bleDevice;
        
        URL.revokeObjectURL(gifUrl);
        
    } catch (error) {
        console.error('Processing error:', error);
        processingStatus.textContent = `✗ Error processing GIF: ${error.message}`;
        processingStatus.classList.add('error');
    }
}

// Extract frames from GIF using a proper decoder
// We'll use a fetch-based approach to get the raw GIF data and parse it
async function extractGifFrames(gifUrl) {
    try {
        // Download the GIF as binary data
        const response = await fetch(gifUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch GIF: ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Check if we have a GIF decoder available
        // Try omggif first (more reliable CDN)
        const GifReaderClass = typeof GifReader !== 'undefined' ? GifReader : 
                                (typeof window !== 'undefined' && window.GifReader) ? window.GifReader : null;
        
        if (GifReaderClass) {
            return extractFramesWithOmggif(uint8Array);
        }
        
        // Fallback: Use a simple canvas-based extraction
        // This will only get the first frame, but it's better than nothing
        console.warn('GIF decoder not available, using fallback (first frame only)');
        return await extractFramesFallback(gifUrl);
        
    } catch (error) {
        console.error('GIF extraction error:', error);
        throw new Error('Failed to decode GIF: ' + error.message);
    }
}

// Extract frames using omggif library
function extractFramesWithOmggif(uint8Array) {
    try {
        // omggif exports GifReader - check if it's available
        const GifReaderClass = typeof GifReader !== 'undefined' ? GifReader : 
                              (typeof window !== 'undefined' && window.GifReader) ? window.GifReader : null;
        
        if (!GifReaderClass) {
            throw new Error('GifReader not found. omggif library may not be loaded correctly.');
        }
        
        const reader = new GifReaderClass(uint8Array);
        const frames = [];
        const width = reader.width;
        const height = reader.height;
        
        // Create a composite canvas to handle frame disposal methods correctly
        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        const compositeCtx = compositeCanvas.getContext('2d');
        
        // Initialize with background color (usually transparent/black)
        compositeCtx.fillStyle = '#000000';
        compositeCtx.fillRect(0, 0, width, height);
        
        // Process each frame with proper compositing
        for (let i = 0; i < reader.numFrames(); i++) {
            const frameInfo = reader.frameInfo(i);
            
            // Handle disposal method from previous frame
            if (i > 0) {
                const prevFrameInfo = reader.frameInfo(i - 1);
                const disposal = prevFrameInfo.disposal;
                
                if (disposal === 2) {
                    // Restore to background - clear the previous frame area
                    compositeCtx.clearRect(
                        prevFrameInfo.x,
                        prevFrameInfo.y,
                        prevFrameInfo.width,
                        prevFrameInfo.height
                    );
                    // Fill with background color
                    compositeCtx.fillStyle = '#000000';
                    compositeCtx.fillRect(
                        prevFrameInfo.x,
                        prevFrameInfo.y,
                        prevFrameInfo.width,
                        prevFrameInfo.height
                    );
                } else if (disposal === 3) {
                    // Restore to previous - we'd need to save state, but for simplicity, keep current
                    // (This is a simplification - full implementation would restore previous frame)
                }
                // disposal 0 (no disposal) or 1 (do not dispose) - keep current composite
            }
            
            // Create image data for the full frame
            const imageData = new ImageData(width, height);
            
            // Decode and blit this frame into the composite
            reader.decodeAndBlitFrameRGBA(i, imageData.data);
            
            // Draw the frame patch onto composite
            const frameImageData = compositeCtx.createImageData(frameInfo.width, frameInfo.height);
            // Copy the relevant portion from the full imageData
            for (let y = 0; y < frameInfo.height; y++) {
                for (let x = 0; x < frameInfo.width; x++) {
                    const srcIdx = ((frameInfo.y + y) * width + (frameInfo.x + x)) * 4;
                    const dstIdx = (y * frameInfo.width + x) * 4;
                    frameImageData.data[dstIdx] = imageData.data[srcIdx];
                    frameImageData.data[dstIdx + 1] = imageData.data[srcIdx + 1];
                    frameImageData.data[dstIdx + 2] = imageData.data[srcIdx + 2];
                    frameImageData.data[dstIdx + 3] = imageData.data[srcIdx + 3];
                }
            }
            
            // Draw frame patch onto composite
            compositeCtx.putImageData(frameImageData, frameInfo.x, frameInfo.y);
            
            // Create a copy of the current composite for this frame
            const frameCanvas = document.createElement('canvas');
            frameCanvas.width = width;
            frameCanvas.height = height;
            const frameCtx = frameCanvas.getContext('2d');
            frameCtx.drawImage(compositeCanvas, 0, 0);
            
            // Get delay (in ms) - omggif returns delay in centiseconds
            const delay = (frameInfo.delay || 10) * 10; // Convert to milliseconds
            // Ensure minimum delay
            const finalDelay = Math.max(delay, 20); // At least 20ms
            
            frames.push({ canvas: frameCanvas, delay: finalDelay });
        }
        
        if (frames.length === 0) {
            throw new Error('No frames extracted from GIF');
        }
        
        console.log(`[GIF Extraction] Extracted ${frames.length} frames from GIF`);
        return frames;
    } catch (error) {
        console.error('omggif extraction error:', error);
        throw error;
    }
}

// Fallback: Extract first frame using canvas (limited but works)
async function extractFramesFallback(gifUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load GIF image'));
        img.src = gifUrl;
    });
    
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    
    // Return single frame with default delay
    return [{ canvas, delay: 100 }];
}

function createGifFromFrames(frames, quality, progressCallback) {
    return new Promise((resolve, reject) => {
        try {
            console.log(`[GIF Encoding] Starting with ${frames.length} frames, quality: ${quality}`);
            
            // Check frame dimensions - if too large, it might hang
            const width = frames[0].canvas.width;
            const height = frames[0].canvas.height;
            const totalPixels = width * height * frames.length;
            console.log(`[GIF Encoding] Dimensions: ${width}x${height}, Total pixels: ${totalPixels.toLocaleString()}`);
            
            if (totalPixels > 2000000) { // 2M pixels
                console.warn(`[GIF Encoding] Large GIF detected, this may take a while...`);
            }
            
            // Try to use workers if available, otherwise fall back to no workers
            // Workers make encoding much faster and prevent hanging
            const workerScript = 'gif.worker.js'; // Local worker file (download from CDN if needed)
            let useWorkers = false;
            let workerCount = 0;
            
            // Check if worker file exists by trying to fetch it
            try {
                // We'll assume it exists if we're using workers
                // User needs to download gif.worker.js for this to work
                useWorkers = true;
                workerCount = 2;
            } catch (e) {
                console.warn('[GIF Encoding] Workers not available, using single-threaded encoding (may be slow)');
            }
            
            const gif = new GIF({
                workers: useWorkers ? workerCount : 0,
                workerScript: useWorkers ? workerScript : undefined,
                quality: quality,
                width: width,
                height: height,
                repeat: 0, // Don't repeat
                background: '#000000',
                transparent: null // No transparency for faster encoding
            });
            
            if (!useWorkers) {
                console.warn('[GIF Encoding] ⚠️ Encoding without workers - this may be slow. Download gif.worker.js for better performance.');
            }
            
            // Adjust frame rate - sample frames to target FPS
            const targetFrameInterval = 1000 / CONFIG.TARGET_FPS;
            let accumulatedTime = 0;
            
            const adjustedFrames = [];
            for (let i = 0; i < frames.length; i++) {
                accumulatedTime += frames[i].delay;
                if (accumulatedTime >= targetFrameInterval || i === frames.length - 1) {
                    adjustedFrames.push({
                        canvas: frames[i].canvas,
                        delay: Math.round(targetFrameInterval)
                    });
                    accumulatedTime = 0;
                }
            }
            
            console.log(`[GIF Encoding] Adjusted to ${adjustedFrames.length} frames for ${CONFIG.TARGET_FPS} FPS`);
            
            // Add frames with progress tracking
            let framesAdded = 0;
            console.log(`[GIF Encoding] Adding ${adjustedFrames.length} frames...`);
            
            adjustedFrames.forEach((frame, index) => {
                try {
                    // Ensure canvas is valid
                    if (!frame.canvas || frame.canvas.width === 0 || frame.canvas.height === 0) {
                        throw new Error(`Invalid canvas at frame ${index}`);
                    }
                    
                    gif.addFrame(frame.canvas, { 
                        delay: frame.delay,
                        copy: true // Copy the image data to avoid issues
                    });
                    framesAdded++;
                    
                    // Update progress as we add frames
                    if (progressCallback && index % Math.max(1, Math.floor(adjustedFrames.length / 10)) === 0) {
                        const addProgress = framesAdded / adjustedFrames.length * 0.3; // Adding frames is ~30% of work
                        progressCallback(addProgress);
                    }
                } catch (error) {
                    console.error(`[GIF Encoding] Error adding frame ${index}:`, error);
                    throw error;
                }
            });
            
            console.log(`[GIF Encoding] Successfully added ${framesAdded} frames, starting render...`);
            
            // Set up event handlers
            let renderStarted = false;
            const timeout = setTimeout(() => {
                if (!renderStarted) {
                    console.error('[GIF Encoding] Timeout: Render did not start within 5 seconds');
                    reject(new Error('GIF encoding timeout: render did not start'));
                }
            }, 5000);
            
            gif.on('finished', (blob) => {
                clearTimeout(timeout);
                console.log(`[GIF Encoding] Finished! Size: ${(blob.size / 1024).toFixed(2)} KB`);
                if (progressCallback) progressCallback(1.0);
                resolve(blob);
            });
            
            gif.on('progress', (p) => {
                if (!renderStarted) {
                    renderStarted = true;
                    clearTimeout(timeout);
                    console.log('[GIF Encoding] Render started, progress:', p);
                }
                
                // Progress is 0-1, map to 30-100% (since adding frames was 0-30%)
                if (progressCallback) {
                    const totalProgress = 0.3 + (p * 0.7);
                    progressCallback(totalProgress);
                }
                
                console.log(`[GIF Encoding] Progress: ${Math.round(p * 100)}%`);
            });
            
            // Add error handler
            gif.on('error', (error) => {
                clearTimeout(timeout);
                console.error('[GIF Encoding] Error event:', error);
                reject(new Error('GIF encoding failed: ' + (error.message || error)));
            });
            
            // Start rendering with timeout
            console.log('[GIF Encoding] Calling gif.render()...');
            
            // Use requestAnimationFrame to ensure we're not blocking
            requestAnimationFrame(() => {
                try {
                    gif.render();
                    console.log('[GIF Encoding] gif.render() called successfully');
                } catch (error) {
                    clearTimeout(timeout);
                    console.error('[GIF Encoding] Error calling render():', error);
                    reject(new Error('Failed to start GIF encoding: ' + error.message));
                }
            });
            
            // Overall timeout - reduce for faster feedback, but allow more time for large GIFs
            const timeoutDuration = totalPixels > 1000000 ? 120000 : 30000; // 2 min for large, 30s for small
            setTimeout(() => {
                console.error(`[GIF Encoding] Timeout after ${timeoutDuration/1000}s`);
                reject(new Error(`GIF encoding timed out after ${timeoutDuration/1000} seconds. Try reducing frame count or quality.`));
            }, timeoutDuration);
            
        } catch (error) {
            console.error('[GIF Encoding] Exception:', error);
            reject(error);
        }
    });
}

// Web Bluetooth BLE Communication
async function handleConnect() {
    if (!navigator.bluetooth) {
        showError('Web Bluetooth is not supported in this browser. Please use Chrome/Edge.');
        return;
    }
    
    try {
        connectBtn.disabled = true;
        connectionStatus.textContent = 'Connecting...';
        
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'GIFCase' }],
            optionalServices: [CONFIG.BLE_SERVICE_UUID]
        });
        
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        
        bleServer = await bleDevice.gatt.connect();
        
        const service = await bleServer.getPrimaryService(CONFIG.BLE_SERVICE_UUID);
        
        ctrlCharacteristic = await service.getCharacteristic(CONFIG.BLE_CTRL_UUID);
        dataCharacteristic = await service.getCharacteristic(CONFIG.BLE_DATA_UUID);
        statCharacteristic = await service.getCharacteristic(CONFIG.BLE_STAT_UUID);
        
        connectionStatus.textContent = 'Connected';
        connectionStatus.classList.add('connected');
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        uploadBtn.disabled = !processedGifBlob;
        replayBtn.disabled = false;
        
    } catch (error) {
        console.error('Connection error:', error);
        if (error.name === 'NotFoundError') {
            showError('GIFCase device not found. Make sure it is powered on and advertising.');
        } else {
            showError(`Connection failed: ${error.message}`);
        }
        connectionStatus.textContent = 'Connection failed';
        connectionStatus.classList.remove('connected');
        connectBtn.disabled = false;
    }
}

function onDisconnected() {
    bleDevice = null;
    bleServer = null;
    ctrlCharacteristic = null;
    dataCharacteristic = null;
    statCharacteristic = null;
    
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.classList.remove('connected');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    uploadBtn.disabled = true;
    replayBtn.disabled = true;
}

function handleDisconnect() {
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
    onDisconnected();
}

async function handleUpload() {
    if (!processedGifBlob || !bleDevice || !bleDevice.gatt.connected) {
        showError('Not ready to upload. Check connection and processed GIF.');
        return;
    }
    
    try {
        uploadBtn.disabled = true;
        uploadProgress.classList.add('active');
        uploadProgress.textContent = 'Starting upload...';
        
        const total = processedGifBlob.size;
        const arrayBuffer = await processedGifBlob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Clear any existing GIF first (firmware START also handles this, but being explicit)
        uploadProgress.textContent = 'Clearing existing GIF...';
        await ctrlCharacteristic.writeValueWithoutResponse(
            new TextEncoder().encode('CLEAR')
        );
        await sleep(100);
        
        // Send START command (this will also clear/overwrite any existing file)
        uploadProgress.textContent = 'Sending START command...';
        await ctrlCharacteristic.writeValueWithoutResponse(
            new TextEncoder().encode(`START:${total}`)
        );
        await sleep(50);
        
        // Send data in chunks
        let sent = 0;
        let writesSinceYield = 0;
        
        while (sent < total) {
            const chunkSize = Math.min(CONFIG.CHUNK_SIZE, total - sent);
            const chunk = uint8Array.slice(sent, sent + chunkSize);
            
            await dataCharacteristic.writeValueWithoutResponse(chunk);
            sent += chunkSize;
            
            writesSinceYield++;
            if (writesSinceYield >= CONFIG.YIELD_EVERY_WRITES) {
                writesSinceYield = 0;
                await sleep(0); // Yield to event loop
            }
            
            if (sent % CONFIG.BREATHER_EVERY_BYTES === 0) {
                uploadProgress.textContent = `Uploading: ${sent}/${total} bytes (${((sent/total)*100).toFixed(1)}%)`;
                await sleep(CONFIG.BREATHER_SLEEP_MS);
            }
        }
        
        uploadProgress.textContent = 'Upload complete. Sending END...';
        
        // Send END command
        await ctrlCharacteristic.writeValueWithoutResponse(
            new TextEncoder().encode('END')
        );
        await sleep(200);
        
        // Validate upload
        const statValue = await statCharacteristic.readValue();
        const statText = new TextDecoder().decode(statValue).trim();
        
        uploadProgress.textContent = `Status: ${statText}`;
        
        if (statText.includes('OK:rx_done') || statText.includes('OK:rx_done_auto') || 
            statText.includes(`bytes=${total}/${total}`) || statText.includes(`file=${total}`)) {
            
            uploadProgress.textContent = '✓ Upload successful! Sending REPLAY...';
            
            // Send REPLAY to start playback
            await ctrlCharacteristic.writeValueWithoutResponse(
                new TextEncoder().encode('REPLAY')
            );
            
            uploadProgress.textContent = '✓ GIF uploaded and playing on ESP32!';
            uploadBtn.disabled = false;
            
        } else {
            // Try INFO command to get more details
            await ctrlCharacteristic.writeValueWithoutResponse(
                new TextEncoder().encode('INFO')
            );
            await sleep(200);
            const infoValue = await statCharacteristic.readValue();
            const infoText = new TextDecoder().decode(infoValue).trim();
            uploadProgress.textContent = `Upload may have failed. Status: ${infoText}`;
            uploadBtn.disabled = false;
        }
        
    } catch (error) {
        console.error('Upload error:', error);
        uploadProgress.textContent = `✗ Upload failed: ${error.message}`;
        uploadBtn.disabled = false;
    }
}

async function handleReplay() {
    if (!bleDevice || !bleDevice.gatt.connected) {
        showError('Not connected to ESP32.');
        return;
    }
    
    try {
        replayBtn.disabled = true;
        uploadProgress.classList.add('active');
        uploadProgress.textContent = 'Sending REPLAY command...';
        
        await ctrlCharacteristic.writeValueWithoutResponse(
            new TextEncoder().encode('REPLAY')
        );
        
        await sleep(200);
        
        // Check status
        const statValue = await statCharacteristic.readValue();
        const statText = new TextDecoder().decode(statValue).trim();
        
        uploadProgress.textContent = `Replay status: ${statText}`;
        replayBtn.disabled = false;
        
    } catch (error) {
        console.error('Replay error:', error);
        uploadProgress.textContent = `✗ Replay failed: ${error.message}`;
        replayBtn.disabled = false;
    }
}

// Utility functions
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function showError(message) {
    alert(message); // Simple alert for now, could be improved with a toast
    console.error(message);
}
