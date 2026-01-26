/* app.js
   requirements (include in index.html before this file):
   - gifuct-js (parseGIF, decompressFrames)
   - gif.js (GIF constructor) and (optional but recommended) gif.worker.js in same folder
*/

// Configuration
const CONFIG = {
    GIPHY_API_KEY: 'mhpttv5MCqejur7dwoIqgYCyDQfOrW6C',
    TFT_WIDTH: 320,
    TFT_HEIGHT: 240,
    MAX_DURATION_MS: 3000,
    MAX_FILE_SIZE: 500 * 1024,
    TARGET_FPS: 8,
    BLE_SERVICE_UUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    BLE_CTRL_UUID: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    BLE_DATA_UUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    BLE_STAT_UUID: '6e400004-b5a3-f393-e0a9-e50e24dcca9e',
    CHUNK_SIZE: 240,
    YIELD_EVERY_WRITES: 200,
    BREATHER_EVERY_BYTES: 240 * 2000,
    BREATHER_SLEEP_MS: 10,
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
  const fileInput = document.getElementById('fileInput');
  const fileName = document.getElementById('fileName');
  const urlInput = document.getElementById('urlInput');
  const loadUrlBtn = document.getElementById('loadUrlBtn');
  const uploadError = document.getElementById('uploadError');
  
  // Detect iOS
  function isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }
  
  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    searchBtn.addEventListener('click', handleSearch);
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSearch();
    });
    fileInput.addEventListener('change', handleFileUpload);
    loadUrlBtn.addEventListener('click', handleUrlLoad);
    urlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleUrlLoad();
    });
    connectBtn.addEventListener('click', handleConnect);
    disconnectBtn.addEventListener('click', handleDisconnect);
    uploadBtn.addEventListener('click', handleUpload);
    replayBtn.addEventListener('click', handleReplay);
  
    if (isIOS()) {
      const iosWarning = document.getElementById('iosWarning');
      if (iosWarning) iosWarning.style.display = 'block';
      connectBtn.disabled = true;
      connectBtn.title = 'Web Bluetooth not supported on iOS';
    }
  
    if (!navigator.bluetooth && !isIOS()) {
      connectBtn.disabled = true;
      connectBtn.title = 'Web Bluetooth not supported in this browser';
    }
  
    if (CONFIG.GIPHY_API_KEY === 'YOUR_GIPHY_API_KEY') {
      showError('Please set your Giphy API key in app.js (CONFIG.GIPHY_API_KEY)');
    }
  
    uploadBtn.disabled = true;
    replayBtn.disabled = true;
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
        `https://api.giphy.com/v1/gifs/search?api_key=${CONFIG.GIPHY_API_KEY}&q=${encodeURIComponent(
          query
        )}&limit=20&rating=g`
      );
      const data = await response.json();
  
      if (data.data && data.data.length > 0) {
        displayGifResults(data.data);
      } else {
        gifResults.innerHTML = '<p>No GIFs found. Try a different search term.</p>';
      }
    } catch (error) {
      console.error('Search error:', error);
      gifResults.innerHTML =
        '<p style="color: red;">Error searching GIFs. Check your API key and connection.</p>';
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
    }
  }
  
  function displayGifResults(gifs) {
    gifResults.innerHTML = '';
    gifs.forEach((gif) => {
      const item = document.createElement('div');
      item.className = 'gif-result-item';
      item.innerHTML = `<img src="${gif.images.fixed_height_small.url}" alt="${gif.title}" loading="lazy">`;
      item.addEventListener('click', () => selectGif(gif.images.original.url, gif.title));
      gifResults.appendChild(item);
    });
  }
  
  async function selectGif(url, title) {
    selectedGifUrl = url;

    selectedGifContainer.innerHTML = `<img src="${url}" alt="${title || 'Selected image'}">`;
    previewContainer.classList.remove('active');
    processingStatus.classList.remove('active');
    processedGifBlob = null;
    uploadBtn.disabled = true;
    
    // Clear any previous errors
    if (uploadError) {
      uploadError.textContent = '';
      uploadError.classList.remove('active');
    }

    await processGif(url);
  }

  // Handle file upload
  async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Clear previous errors
    uploadError.textContent = '';
    uploadError.classList.remove('active');

    // Validate file type
    const validTypes = ['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      showUploadError(`Unsupported file type: ${file.type}. Please use GIF, JPEG, PNG, or WebP.`);
      return;
    }

    // Validate file size
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      showUploadError(`File too large: ${(file.size / 1024).toFixed(2)} KB. Maximum size is ${(CONFIG.MAX_FILE_SIZE / 1024).toFixed(0)} KB.`);
      return;
    }

    fileName.textContent = file.name;
    
    try {
      // For file uploads, use FileReader to avoid CORS issues
      // Check both file.type and file name extension to catch GIFs
      const isGif = file.type === 'image/gif' || 
                    file.name.toLowerCase().endsWith('.gif');
      
      if (isGif) {
        // It's a GIF, use object URL and process as multi-frame GIF
        const fileUrl = URL.createObjectURL(file);
        await processImageOrGif(fileUrl, 'image/gif', file.name);
      } else {
        // Static image - use FileReader to load it without CORS issues
        await processStaticImageFromFile(file);
      }
    } catch (error) {
      console.error('File upload error:', error);
      showUploadError(`Failed to process file: ${error.message}`);
    }
  }

  // Process static image from file (no CORS issues)
  async function processStaticImageFromFile(file) {
    processingStatus.classList.add('active');
    processingStatus.textContent = 'Processing image: Loading...';
    processingStatus.classList.remove('error');
    
    try {
      // Use FileReader to load the file as data URL (no CORS)
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      // Show image in preview
      selectedGifUrl = dataUrl;
      selectedGifContainer.innerHTML = `<img src="${dataUrl}" alt="${file.name}">`;
      previewContainer.classList.remove('active');
      processedGifBlob = null;
      uploadBtn.disabled = true;

      // Load image from data URL (same-origin, no CORS issues)
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load image from file'));
        img.src = dataUrl;
      });

      processingStatus.textContent = 'Processing image: Creating single-frame GIF...';

      // Create canvas and draw image
      const canvas = document.createElement('canvas');
      canvas.width = CONFIG.TFT_WIDTH;
      canvas.height = CONFIG.TFT_HEIGHT;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Verify canvas is not tainted (shouldn't be with data URL, but check anyway)
      try {
        ctx.getImageData(0, 0, 1, 1);
      } catch (e) {
        throw new Error('Canvas is tainted. This should not happen with file uploads. Please try again.');
      }

      // Use the existing createGifFromFrames function which already works
      // This avoids potential issues with GIF.js configuration
      processingStatus.textContent = 'Processing image: Creating GIF...';
      const frame = { canvas: canvas, delay: 1000 };
      const singleFrameBlob = await createGifFromFrames([frame], 7, (progress) => {
        if (progress < 1) {
          processingStatus.textContent = `Processing image: Creating GIF... ${Math.round(progress * 100)}%`;
        }
      });

      // Create object URL and process through existing pipeline
      const gifUrl = URL.createObjectURL(singleFrameBlob);
      await processGif(gifUrl);
      URL.revokeObjectURL(gifUrl);
      
    } catch (error) {
      console.error('Static image file processing error:', error);
      throw error;
    }
  }

  // Handle URL load
  async function handleUrlLoad() {
    const url = urlInput.value.trim();
    if (!url) {
      showUploadError('Please enter a valid URL');
      return;
    }

    // Clear previous errors
    uploadError.textContent = '';
    uploadError.classList.remove('active');

    // Basic URL validation
    try {
      new URL(url);
    } catch (e) {
      showUploadError('Invalid URL format. Please enter a valid URL (e.g., https://example.com/image.gif)');
      return;
    }

    try {
      // Show the image immediately in Selected GIF (it will load if valid)
      selectedGifUrl = url;
      selectedGifContainer.innerHTML = `<img src="${url}" alt="Loading image..." onerror="this.parentElement.innerHTML='<p class=\\'placeholder\\'>Failed to load image</p>'">`;
      previewContainer.classList.remove('active');
      processedGifBlob = null;
      uploadBtn.disabled = true;

      // Try to determine if it's a GIF or static image by checking the URL extension
      // If we can't determine, we'll try processing as GIF first, then fall back to static image
      const urlLower = url.toLowerCase();
      let mimeType = null; // unknown - will try GIF first
      
      if (urlLower.includes('.gif')) {
        mimeType = 'image/gif';
      } else if (urlLower.includes('.png')) {
        mimeType = 'image/png';
      } else if (urlLower.includes('.webp')) {
        mimeType = 'image/webp';
      } else if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) {
        mimeType = 'image/jpeg';
      }

      // Process the image/GIF
      // If mimeType is unknown, try as GIF first (GIFs can be multi-frame)
      if (mimeType === null) {
        try {
          // Try processing as GIF first
          await processImageOrGif(url, 'image/gif');
        } catch (gifError) {
          // If it fails, try as static image
          console.log('Failed to process as GIF, trying as static image:', gifError);
          await processImageOrGif(url, 'image/jpeg');
        }
      } else {
        await processImageOrGif(url, mimeType);
      }
    } catch (error) {
      console.error('URL load error:', error);
      showUploadError(`Failed to load from URL: ${error.message}`);
      processingStatus.classList.remove('active');
      // Clear the selected GIF container on error
      selectedGifContainer.innerHTML = '<p class="placeholder">Failed to load image</p>';
    }
  }

  // Show upload error
  function showUploadError(message) {
    uploadError.textContent = message;
    uploadError.classList.add('active');
    processingStatus.classList.remove('active');
  }

  // Process image or GIF (handles both)
  async function processImageOrGif(url, mimeType, fileName = 'image') {
    // Image may already be displayed in selectedGifContainer if called from handleUrlLoad
    selectedGifUrl = url;
    if (!selectedGifContainer.querySelector('img')) {
      // Only set if not already set (e.g., if called from file upload)
      selectedGifContainer.innerHTML = `<img src="${url}" alt="${fileName}">`;
    }
    previewContainer.classList.remove('active');
    processingStatus.classList.add('active');
    processingStatus.textContent = 'Processing...';
    processingStatus.classList.remove('error');
    processedGifBlob = null;
    uploadBtn.disabled = true;

    try {
      if (mimeType === 'image/gif') {
        // It's a GIF, process normally
        await processGif(url);
      } else {
        // It's a static image, convert to single-frame GIF
        await processStaticImage(url);
      }
    } catch (error) {
      console.error('Processing error:', error);
      showUploadError(`Failed to process image: ${error.message}`);
      processingStatus.classList.remove('active');
      throw error;
    }
  }

  // Process static image from URL: convert to single-frame GIF and run through existing pipeline
  async function processStaticImage(url) {
    processingStatus.textContent = 'Processing image: Loading...';
    
    try {
      // Try to fetch the image as a blob
      // If CORS blocks it, use a CORS proxy
      processingStatus.textContent = 'Processing image: Fetching...';
      let blob;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
        }
        blob = await response.blob();
      } catch (fetchError) {
        // CORS blocked or any fetch error - try using a CORS proxy
        // Check if it's a CORS error or network error
        const isCorsError = fetchError.message.includes('CORS') || 
                           fetchError.message.includes('Failed to fetch') ||
                           fetchError.message.includes('network') ||
                           fetchError.name === 'TypeError';
        
        if (isCorsError || fetchError.message === 'Failed to fetch') {
          processingStatus.textContent = 'Processing image: Using CORS proxy...';
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
          try {
            const proxyResponse = await fetch(proxyUrl);
            if (!proxyResponse.ok) {
              throw new Error(`CORS proxy failed: ${proxyResponse.status}`);
            }
            blob = await proxyResponse.blob();
          } catch (proxyError) {
            // Try alternative proxy
            try {
              processingStatus.textContent = 'Processing image: Trying alternative proxy...';
              const altProxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
              const altResponse = await fetch(altProxyUrl);
              if (!altResponse.ok) {
                throw new Error(`Alternative proxy failed: ${altResponse.status}`);
              }
              blob = await altResponse.blob();
            } catch (altError) {
              throw new Error('Failed to fetch image via CORS proxy. The image server blocks cross-origin requests. Please upload the image as a file instead.');
            }
          }
        } else {
          throw fetchError;
        }
      }
      
      // Convert blob to data URL (same-origin, no CORS issues)
      processingStatus.textContent = 'Processing image: Converting...';
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to convert image to data URL'));
        reader.readAsDataURL(blob);
      });
      
      // Now load the image from the data URL (same-origin, no CORS)
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load image from data URL'));
        img.src = dataUrl;
      });

      processingStatus.textContent = 'Processing image: Creating single-frame GIF...';

      // Create a canvas and draw the image (resized to TFT dimensions)
      const canvas = document.createElement('canvas');
      canvas.width = CONFIG.TFT_WIDTH;
      canvas.height = CONFIG.TFT_HEIGHT;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Fill with black background
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw and scale the image to fill the canvas
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Verify canvas is not tainted
      try {
        ctx.getImageData(0, 0, 1, 1);
      } catch (e) {
        if (e.name === 'SecurityError') {
          throw new Error('Canvas is tainted due to CORS restrictions. The image server needs to allow cross-origin requests. Try uploading the image as a file instead.');
        }
        throw e;
      }

      // Use the existing createGifFromFrames function which already works
      processingStatus.textContent = 'Processing image: Creating GIF...';
      const frame = { canvas: canvas, delay: 1000 };
      const singleFrameBlob = await createGifFromFrames([frame], 7, (progress) => {
        if (progress < 1) {
          processingStatus.textContent = `Processing image: Creating GIF... ${Math.round(progress * 100)}%`;
        }
      });

      // Create object URL from the blob and pass to existing processGif pipeline
      const gifUrl = URL.createObjectURL(singleFrameBlob);
      
      // Now process it through the existing GIF processing pipeline
      await processGif(gifUrl);
      
      // Clean up the temporary URL
      URL.revokeObjectURL(gifUrl);
      
    } catch (error) {
      console.error('Static image processing error:', error);
      throw error;
    }
  }
  
  // GIF Processing
  async function processGif(url) {
    processingStatus.classList.add('active');
    processingStatus.textContent = 'Processing GIF: Downloading...';
    processingStatus.classList.remove('error');
  
    try {
      // Try to fetch the GIF, with CORS proxy fallback if needed
      let blob;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch GIF: ${response.status} ${response.statusText}`);
        }
        blob = await response.blob();
      } catch (fetchError) {
        // CORS blocked or any fetch error - try using a CORS proxy
        const isCorsError = fetchError.message.includes('CORS') || 
                           fetchError.message.includes('Failed to fetch') ||
                           fetchError.message.includes('network') ||
                           fetchError.name === 'TypeError';
        
        if (isCorsError || fetchError.message === 'Failed to fetch') {
          processingStatus.textContent = 'Processing GIF: Using CORS proxy...';
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
          try {
            const proxyResponse = await fetch(proxyUrl);
            if (!proxyResponse.ok) {
              throw new Error(`CORS proxy failed: ${proxyResponse.status}`);
            }
            blob = await proxyResponse.blob();
          } catch (proxyError) {
            // Try alternative proxy
            try {
              processingStatus.textContent = 'Processing GIF: Trying alternative proxy...';
              const altProxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
              const altResponse = await fetch(altProxyUrl);
              if (!altResponse.ok) {
                throw new Error(`Alternative proxy failed: ${altResponse.status}`);
              }
              blob = await altResponse.blob();
            } catch (altError) {
              throw new Error('Failed to fetch GIF via CORS proxy. The server blocks cross-origin requests. Please upload the GIF as a file instead.');
            }
          }
        } else {
          throw fetchError;
        }
      }
      
      // Pass the blob directly to avoid another fetch (which might fail with object URLs)
      processingStatus.textContent = 'Processing GIF: Extracting frames...';
      
      // Validate blob type
      if (!blob.type.includes('gif') && !blob.type.includes('octet-stream')) {
        console.warn(`[GIF Processing] Unexpected blob type: ${blob.type}, size: ${blob.size} bytes`);
      }
      
      // Convert blob to arrayBuffer for direct processing
      const arrayBuffer = await blob.arrayBuffer();
      console.log(`[GIF Processing] Blob converted to ArrayBuffer: ${arrayBuffer.byteLength} bytes`);
      
      // Validate it's actually a GIF by checking the header
      const header = new Uint8Array(arrayBuffer.slice(0, 6));
      const headerStr = String.fromCharCode(...header);
      console.log(`[GIF Processing] File header: ${headerStr}`);
      if (!headerStr.startsWith('GIF')) {
        throw new Error(`Invalid GIF file. Header: ${headerStr}. The file may have been corrupted by the CORS proxy.`);
      }
      
      const frames = await extractGifFrames(arrayBuffer);
      if (!frames.length) throw new Error('No frames extracted');
      
      console.log(`[GIF Processing] Extracted ${frames.length} frames from GIF`);

      // truncate to 3 seconds
      let totalTime = 0;
      const maxFrames = [];
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const nextTotal = totalTime + frame.delay;
        if (nextTotal <= CONFIG.MAX_DURATION_MS || maxFrames.length === 0) {
          maxFrames.push(frame);
          totalTime = nextTotal;
        } else {
          break;
        }
      }
      if (!maxFrames.length) throw new Error('No frames after truncation');

      console.log(
        `[GIF Processing] Truncated to ${maxFrames.length} frames (${(totalTime / 1000).toFixed(
          2
        )}s of ${CONFIG.MAX_DURATION_MS / 1000}s)`
      );
  
      processingStatus.textContent = `Processing GIF: Resizing (${maxFrames.length} frames)...`;
  
      // resize to TFT, flatten alpha to avoid "contours"/holes
      const resizedFrames = maxFrames.map((frame) => {
        const canvas = document.createElement('canvas');
        canvas.width = CONFIG.TFT_WIDTH;
        canvas.height = CONFIG.TFT_HEIGHT;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
  
        // hard-flatten alpha just in case
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let p = 0; p < d.length; p += 4) d[p + 3] = 255;
        ctx.putImageData(img, 0, 0);
  
        return { canvas, delay: frame.delay };
      });
  
      // limit frames for encoding
      const MAX_FRAMES_FOR_ENCODING = 15;
      let framesToEncode = resizedFrames;
      if (resizedFrames.length > MAX_FRAMES_FOR_ENCODING) {
        processingStatus.textContent = `Processing GIF: Limiting to ${MAX_FRAMES_FOR_ENCODING} frames (from ${resizedFrames.length})...`;
        const step = Math.ceil(resizedFrames.length / MAX_FRAMES_FOR_ENCODING);
        framesToEncode = [];
        for (let i = 0; i < resizedFrames.length; i += step) framesToEncode.push(resizedFrames[i]);
        console.log(`[GIF Processing] Reduced from ${resizedFrames.length} to ${framesToEncode.length} frames`);
      }
  
      console.log(`[GIF Processing] About to encode ${framesToEncode.length} frames`);
      processingStatus.textContent = `Processing GIF: Encoding (${framesToEncode.length} frames)...`;

      let quality = 7;
      let finalBlob = null;
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        processingStatus.textContent = `Processing GIF: Encoding (quality: ${quality}, attempt ${
          attempts + 1
        }/${maxAttempts})...`;

        const startTime = Date.now();
        console.log(`[GIF Encoding] Starting encoding with ${framesToEncode.length} frames, quality ${quality}`);
        finalBlob = await createGifFromFrames(framesToEncode, quality, (progress) => {
          processingStatus.textContent = `Processing GIF: Encoding... ${Math.round(progress * 100)}%`;
        });
  
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(
          `[GIF Encoding] Completed in ${elapsed}s, size: ${(finalBlob.size / 1024).toFixed(2)} KB`
        );
  
        if (finalBlob.size <= CONFIG.MAX_FILE_SIZE || quality <= 1) break;
  
        quality = Math.max(1, Math.floor(quality * 0.7));
        attempts++;
        processingStatus.textContent = `Processing GIF: File too large (${(finalBlob.size / 1024).toFixed(
          2
        )} KB), retrying...`;
      }
  
      processedGifBlob = finalBlob;
  
      const previewUrl = URL.createObjectURL(finalBlob);
      previewGif.innerHTML = `<img src="${previewUrl}" alt="Processed GIF">`;
  
      const dur = framesToEncode.reduce((sum, f) => sum + f.delay, 0) / 1000;
      gifInfo.innerHTML = `
        <strong>Processed GIF Info:</strong><br>
        Size: ${(finalBlob.size / 1024).toFixed(2)} KB<br>
        Frames: ${framesToEncode.length}${framesToEncode.length < resizedFrames.length ? ` (reduced from ${resizedFrames.length})` : ''}<br>
        Dimensions: ${CONFIG.TFT_WIDTH}x${CONFIG.TFT_HEIGHT}<br>
        Duration: ${dur.toFixed(2)}s
      `;
  
      previewContainer.classList.add('active');
      processingStatus.textContent = `✓ Processing complete! Size: ${(finalBlob.size / 1024).toFixed(
        2
      )} KB`;
      processingStatus.classList.remove('error');
  
      uploadBtn.disabled = !(bleDevice && bleDevice.gatt && bleDevice.gatt.connected);
    } catch (error) {
      console.error('Processing error:', error);
      processingStatus.textContent = `✗ Error processing GIF: ${error.message}`;
      processingStatus.classList.add('error');
      uploadBtn.disabled = true;
      
      // Also show error in upload error area if it's a custom upload
      if (uploadError) {
        showUploadError(`Failed to process: ${error.message}`);
      }
    }
  }
  
  // Frame extraction using omggif (GifReader) - already loaded in HTML
  // Can accept either a URL (string) or an ArrayBuffer
  async function extractGifFrames(gifUrlOrBuffer) {
    let buf;
    if (gifUrlOrBuffer instanceof ArrayBuffer) {
      buf = gifUrlOrBuffer;
    } else {
      const r = await fetch(gifUrlOrBuffer);
      if (!r.ok) throw new Error(`Failed to fetch GIF: ${r.status} ${r.statusText}`);
      buf = await r.arrayBuffer();
    }

    // Check for omggif (GifReader)
    const GifReader = window.GifReader || (typeof GifReader !== 'undefined' ? GifReader : null);
    if (!GifReader) {
      console.error('omggif (GifReader) not available!');
      console.error('Available globals:', Object.keys(window).filter(k => k.toLowerCase().includes('gif')));
      // For fallback, we need a URL, so if we got a buffer, create a blob URL
      if (gifUrlOrBuffer instanceof ArrayBuffer) {
        const blob = new Blob([gifUrlOrBuffer], { type: 'image/gif' });
        const url = URL.createObjectURL(blob);
        const result = await extractFramesFallback(url);
        URL.revokeObjectURL(url);
        return result;
      }
      return await extractFramesFallback(gifUrlOrBuffer);
    }

    // Parse GIF using omggif
    const gif = new GifReader(new Uint8Array(buf));
    const width = gif.width;
    const height = gif.height;
    const numFrames = gif.numFrames();
    
    console.log(`[GIF Extraction] Parsed GIF: ${width}x${height}, ${numFrames} frames`);
  
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    const compositeCtx = compositeCanvas.getContext('2d', { willReadFrequently: true });
  
    // Start with black background
    compositeCtx.fillStyle = '#000000';
    compositeCtx.fillRect(0, 0, width, height);
  
    const frames = [];
    console.log(`[GIF Extraction] Processing ${numFrames} frames...`);
  
    for (let i = 0; i < numFrames; i++) {
      if (i === 0 || i === numFrames - 1 || i % 10 === 0) {
        console.log(`[GIF Extraction] Processing frame ${i + 1}/${numFrames}`);
      }
  
      const frameInfo = gif.frameInfo(i);
      const imageData = compositeCtx.createImageData(width, height);
      gif.decodeAndBlitFrameRGBA(i, imageData.data);
  
      // Apply disposal method from previous frame
      if (i > 0) {
        const prevFrameInfo = gif.frameInfo(i - 1);
        const disposal = prevFrameInfo.disposal;
        
        if (disposal === 2) {
          // DISPOSE_BACKGROUND - clear the frame area
          compositeCtx.clearRect(prevFrameInfo.x, prevFrameInfo.y, prevFrameInfo.width, prevFrameInfo.height);
        } else if (disposal === 3) {
          // DISPOSE_PREVIOUS - restore to previous state (we'd need to save it, but omggif doesn't provide this easily)
          // For now, we'll just continue compositing
        }
      }
  
      // Draw current frame onto composite
      compositeCtx.putImageData(imageData, 0, 0);
  
      // Capture full-frame canvas copy
      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = width;
      frameCanvas.height = height;
      const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
      frameCtx.fillStyle = '#000000';
      frameCtx.fillRect(0, 0, width, height);
      frameCtx.drawImage(compositeCanvas, 0, 0);
  
      // Get delay - omggif returns delay in hundredths of a second
      let delayMs = frameInfo.delay * 10; // Convert to milliseconds
      if (delayMs < 20) delayMs = 20; // Minimum delay
      if (delayMs > 1000) delayMs = 1000; // Maximum delay
  
      frames.push({ canvas: frameCanvas, delay: delayMs });
    }
  
    console.log(`[GIF Extraction] Extracted ${frames.length} frames via omggif`);
    return frames;
  }
  
  // Fallback: first frame only
  async function extractFramesFallback(gifUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Failed to load GIF image'));
      img.src = gifUrl;
    });
  
    const canvas = document.createElement('canvas');
    canvas.width = img.width || 1;
    canvas.height = img.height || 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  
    return [{ canvas, delay: 100 }];
  }
  
  function createGifFromFrames(frames, quality, progressCallback) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof GIF !== 'function') {
          reject(new Error('gif.js (GIF) not loaded. Include gif.js before app.js'));
          return;
        }
  
        const width = frames[0].canvas.width;
        const height = frames[0].canvas.height;
  
        const workerScript = 'gif.worker.js';
        const useWorkers = true; // if worker is missing, gif.js will throw; you'll see it in console
  
        const gif = new GIF({
          workers: useWorkers ? 2 : 0,
          workerScript: useWorkers ? workerScript : undefined,
          quality: quality,
          width,
          height,
          repeat: 0,
          background: '#000000',
          transparent: null,
        });
  
        // Add all frames directly - don't skip frames based on timing
        // The frame delays are already set correctly from extraction
        console.log(`[GIF Encoding] Adding ${frames.length} frames to GIF encoder`);
        frames.forEach((frame, idx) => {
          // Ensure minimum delay for smooth playback
          const delay = Math.max(frame.delay, 20);
          gif.addFrame(frame.canvas, { delay: delay, copy: true });
          if (idx === 0 || idx === frames.length - 1 || idx % 5 === 0) {
            console.log(`[GIF Encoding] Added frame ${idx + 1}/${frames.length}, delay: ${delay}ms`);
          }
        });
  
        gif.on('progress', (p) => {
          if (progressCallback) progressCallback(0.3 + p * 0.7);
        });
  
        gif.on('finished', (blob) => {
          if (progressCallback) progressCallback(1.0);
          resolve(blob);
        });
  
        gif.on('error', (err) => {
          reject(new Error('GIF encoding failed: ' + (err && err.message ? err.message : String(err))));
        });
  
        if (progressCallback) progressCallback(0.05);
  
        gif.render();
      } catch (e) {
        reject(e);
      }
    });
  }
  
  // Web Bluetooth BLE Communication
  async function handleConnect() {
    if (!navigator.bluetooth) {
      if (isIOS()) {
        showError(
          'Web Bluetooth is not supported on iOS devices (iPhone/iPad). Please use Android Chrome/Edge or desktop Chrome/Edge.'
        );
      } else {
        showError('Web Bluetooth is not supported in this browser. Please use Chrome or Edge.');
      }
      return;
    }
  
    try {
      connectBtn.disabled = true;
      connectionStatus.textContent = 'Connecting...';
  
      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ name: 'GIFCase' }],
        optionalServices: [CONFIG.BLE_SERVICE_UUID],
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
      replayBtn.disabled = false;
  
      uploadBtn.disabled = !processedGifBlob;
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
    if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
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
  
      uploadProgress.textContent = 'Clearing existing GIF...';
      await ctrlCharacteristic.writeValueWithoutResponse(new TextEncoder().encode('CLEAR'));
      await sleep(100);
  
      uploadProgress.textContent = 'Sending START command...';
      await ctrlCharacteristic.writeValueWithoutResponse(new TextEncoder().encode(`START:${total}`));
      await sleep(50);
  
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
          await sleep(0);
        }
  
        if (sent % CONFIG.BREATHER_EVERY_BYTES === 0) {
          uploadProgress.textContent = `Uploading: ${sent}/${total} bytes (${((sent / total) * 100).toFixed(
            1
          )}%)`;
          await sleep(CONFIG.BREATHER_SLEEP_MS);
        }
      }
  
      uploadProgress.textContent = 'Upload complete. Sending END...';
      await ctrlCharacteristic.writeValueWithoutResponse(new TextEncoder().encode('END'));
      await sleep(200);
  
      const statValue = await statCharacteristic.readValue();
      const statText = new TextDecoder().decode(statValue).trim();
      uploadProgress.textContent = `Status: ${statText}`;
  
      if (
        statText.includes('OK:rx_done') ||
        statText.includes('OK:rx_done_auto') ||
        statText.includes(`bytes=${total}/${total}`) ||
        statText.includes(`file=${total}`)
      ) {
        uploadProgress.textContent = '✓ Upload successful! Sending REPLAY...';
        await ctrlCharacteristic.writeValueWithoutResponse(new TextEncoder().encode('REPLAY'));
        uploadProgress.textContent = '✓ GIF uploaded and playing on ESP32!';
        uploadBtn.disabled = false;
      } else {
        await ctrlCharacteristic.writeValueWithoutResponse(new TextEncoder().encode('INFO'));
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
    if (!bleDevice || !bleDevice.gatt || !bleDevice.gatt.connected) {
      showError('Not connected to ESP32.');
      return;
    }
  
    try {
      replayBtn.disabled = true;
      uploadProgress.classList.add('active');
      uploadProgress.textContent = 'Sending REPLAY command...';
  
      await ctrlCharacteristic.writeValueWithoutResponse(new TextEncoder().encode('REPLAY'));
      await sleep(200);
  
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
  
  // Utility
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  function showError(message) {
    alert(message);
    console.error(message);
  }
  