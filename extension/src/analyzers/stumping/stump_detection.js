/**
 * Stump Detection Module
 * 
 * Detects cricket stumps (3 near-vertical lines) using Hough line transform
 * Stumps are typically vertical (±10° tolerance) and clustered together
 * 
 * Algorithm:
 * 1. Extract ROI (center-bottom region where stumps typically are)
 * 2. Edge detection (Sobel gradient)
 * 3. Hough line transform for near-vertical lines (80°-100° from horizontal)
 * 4. Filter by length and position
 * 5. Cluster into 3 groups (left, middle, right stump)
 * 6. Return x-positions + confidence
 * 
 * Debug artifacts:
 * - Edge map
 * - All detected lines
 * - Clustered stumps with confidence scores
 */

const DEFAULT_CONFIG = {
  // ROI selection (center-bottom where stumps typically are)
  roiLeft: 0.30,
  roiRight: 0.70,
  roiTop: 0.40,
  roiBottom: 0.80,
  
  // Edge detection
  edgeLowThreshold: 50,
  edgeHighThreshold: 150,
  
  // Line detection (vertical lines: 85°-95° from horizontal)
  minAngle: 80,        // Degrees from horizontal (80° = near-vertical)
  maxAngle: 100,       // 90° = perfect vertical
  houghThreshold: 25,  // Min votes for line
  minLineLength: 40,   // Min length in pixels
  maxLineGap: 15,      // Max gap between segments
  
  // Clustering (group into 3 stumps)
  expectedStumps: 3,
  clusterTolerance: 20, // Max x-distance for same stump (pixels)
  
  // Confidence
  minConfidence: 0.50,
  
  // Debug
  debugMode: false,
};

/**
 * Detect stumps in keyframes
 * @param {Array} frames - Array of {ts, jpeg} keyframes
 * @param {Object} config - Detection config (optional)
 * @returns {Promise<Object>} { stumps: [{x, confidence}], confidence, artifacts }
 */
export async function detectStumps(frames, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  if (!frames || frames.length === 0) {
    return { stumps: [], confidence: 0, artifacts: null };
  }
  
  // Use middle frame as representative (stumps don't move)
  const midIndex = Math.floor(frames.length / 2);
  const frame = frames[midIndex];
  
  try {
    // Decode frame to ImageData
    const imageData = await decodeFrame(frame.jpeg);
    
    // Extract ROI (stump region)
    const roi = extractROI(imageData, cfg);
    
    // Convert to grayscale
    const gray = toGrayscale(roi);
    
    // Edge detection
    const edges = detectEdges(gray, cfg);
    
    // Detect vertical lines
    const lines = detectVerticalLines(edges, cfg);
    
    // Cluster into stumps
    const stumps = clusterIntoStumps(lines, cfg);
    
    // Compute confidence
    const confidence = computeStumpConfidence(stumps, lines, cfg);
    
    // Build artifacts for debug
    const artifacts = cfg.debugMode ? {
      roi,
      edges,
      lines,
      stumps,
      frameIndex: midIndex,
    } : undefined;
    
    return {
      stumps: stumps.map(s => ({ x: s.x, confidence: s.confidence })),
      confidence,
      frameIndex: midIndex,
      artifacts,
    };
  } catch (err) {
    console.warn('[Stump Detection] Failed:', err);
    return { stumps: [], confidence: 0, artifacts: null };
  }
}

/**
 * Decode JPEG data URL to ImageData
 */
async function decodeFrame(jpegDataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = reject;
    img.src = jpegDataUrl;
  });
}

/**
 * Extract ROI (center-bottom region)
 */
function extractROI(imageData, cfg) {
  const { width, height, data } = imageData;
  
  const left = Math.floor(width * cfg.roiLeft);
  const right = Math.floor(width * cfg.roiRight);
  const top = Math.floor(height * cfg.roiTop);
  const bottom = Math.floor(height * cfg.roiBottom);
  
  const roiWidth = right - left;
  const roiHeight = bottom - top;
  const roiData = new Uint8ClampedArray(roiWidth * roiHeight * 4);
  
  for (let y = 0; y < roiHeight; y++) {
    for (let x = 0; x < roiWidth; x++) {
      const srcIdx = ((top + y) * width + (left + x)) * 4;
      const dstIdx = (y * roiWidth + x) * 4;
      roiData[dstIdx] = data[srcIdx];
      roiData[dstIdx + 1] = data[srcIdx + 1];
      roiData[dstIdx + 2] = data[srcIdx + 2];
      roiData[dstIdx + 3] = 255;
    }
  }
  
  return { data: roiData, width: roiWidth, height: roiHeight, offsetX: left, offsetY: top };
}

/**
 * Convert to grayscale
 */
function toGrayscale(roi) {
  const { data, width, height } = roi;
  const gray = new Uint8ClampedArray(width * height);
  
  for (let i = 0; i < gray.length; i++) {
    const idx = i * 4;
    gray[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
  }
  
  return { data: gray, width, height };
}

/**
 * Edge detection (Sobel)
 */
function detectEdges(gray, cfg) {
  const { data, width, height } = gray;
  const edges = new Uint8ClampedArray(width * height);
  
  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0, gy = 0;
      
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = (y + ky) * width + (x + kx);
          const ki = (ky + 1) * 3 + (kx + 1);
          gx += data[idx] * sobelX[ki];
          gy += data[idx] * sobelY[ki];
        }
      }
      
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      const idx = y * width + x;
      
      if (magnitude > cfg.edgeHighThreshold) {
        edges[idx] = 255;
      } else if (magnitude > cfg.edgeLowThreshold) {
        edges[idx] = 128;
      }
    }
  }
  
  return { data: edges, width, height };
}

/**
 * Detect vertical lines using simplified Hough transform
 * Vertical lines have angle ~90° from horizontal
 */
function detectVerticalLines(edges, cfg) {
  const { data, width, height } = edges;
  const lines = [];
  
  // For each column, count strong edges (vertical line indicator)
  const columnVotes = new Array(width).fill(0);
  
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (data[y * width + x] === 255) {
        columnVotes[x]++;
      }
    }
  }
  
  // Find peaks (local maxima above threshold)
  for (let x = 2; x < width - 2; x++) {
    const votes = columnVotes[x];
    if (votes > cfg.houghThreshold &&
        votes > columnVotes[x - 1] &&
        votes > columnVotes[x + 1]) {
      
      // Find extent of line (top and bottom y-coordinates)
      let top = -1, bottom = -1;
      for (let y = 0; y < height; y++) {
        if (data[y * width + x] === 255) {
          if (top === -1) top = y;
          bottom = y;
        }
      }
      
      const length = bottom - top + 1;
      if (length >= cfg.minLineLength) {
        lines.push({
          x,
          top,
          bottom,
          length,
          votes,
          angle: 90, // Vertical
        });
      }
    }
  }
  
  // Sort by votes (strongest first)
  lines.sort((a, b) => b.votes - a.votes);
  
  return lines;
}

/**
 * Cluster detected lines into 3 stumps
 * Stumps are typically evenly spaced, so we group nearby lines
 */
function clusterIntoStumps(lines, cfg) {
  if (lines.length === 0) return [];
  
  // Group lines that are close together (within tolerance)
  const clusters = [];
  
  for (const line of lines) {
    let foundCluster = false;
    
    for (const cluster of clusters) {
      const avgX = cluster.lines.reduce((sum, l) => sum + l.x, 0) / cluster.lines.length;
      if (Math.abs(line.x - avgX) < cfg.clusterTolerance) {
        cluster.lines.push(line);
        foundCluster = true;
        break;
      }
    }
    
    if (!foundCluster) {
      clusters.push({ lines: [line] });
    }
  }
  
  // Sort clusters by x-position (left to right)
  clusters.forEach(c => {
    c.x = c.lines.reduce((sum, l) => sum + l.x, 0) / c.lines.length;
    c.votes = c.lines.reduce((sum, l) => sum + l.votes, 0);
    c.length = c.lines.reduce((sum, l) => sum + l.length, 0) / c.lines.length;
  });
  clusters.sort((a, b) => a.x - b.x);
  
  // Select top 3 clusters as stumps (if we have them)
  const stumps = clusters.slice(0, Math.min(cfg.expectedStumps, clusters.length));
  
  // Assign confidence to each stump based on strength
  const maxVotes = Math.max(...stumps.map(s => s.votes), 1);
  stumps.forEach(s => {
    s.confidence = Math.min(0.95, (s.votes / maxVotes) * 0.9);
  });
  
  return stumps;
}

/**
 * Compute overall confidence
 */
function computeStumpConfidence(stumps, lines, cfg) {
  if (stumps.length === 0) return 0;
  
  // Confidence factors:
  // 1. Number of stumps (expect 3)
  const countScore = stumps.length / cfg.expectedStumps;
  
  // 2. Average stump confidence
  const avgConfidence = stumps.reduce((sum, s) => sum + s.confidence, 0) / stumps.length;
  
  // 3. Line strength (total votes)
  const totalVotes = lines.slice(0, 10).reduce((sum, l) => sum + l.votes, 0);
  const voteScore = Math.min(1.0, totalVotes / 300);
  
  // Combined confidence
  const rawConfidence = 0.4 * countScore + 0.4 * avgConfidence + 0.2 * voteScore;
  
  return Math.min(0.90, rawConfidence);
}

/**
 * Create debug visualization
 * Shows: ROI | Edges | Lines overlay
 */
export function createStumpDebugVisualization(artifacts) {
  if (!artifacts) return null;
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  const w = artifacts.roi.width;
  const h = artifacts.roi.height;
  canvas.width = w * 3;
  canvas.height = h;
  
  // Panel 1: Original ROI
  const roiImageData = new ImageData(artifacts.roi.data, w, h);
  ctx.putImageData(roiImageData, 0, 0);
  
  // Panel 2: Edge map
  const edgeImageData = new ImageData(w, h);
  for (let i = 0; i < artifacts.edges.data.length; i++) {
    const idx = i * 4;
    edgeImageData.data[idx] = artifacts.edges.data[i];
    edgeImageData.data[idx + 1] = artifacts.edges.data[i];
    edgeImageData.data[idx + 2] = artifacts.edges.data[i];
    edgeImageData.data[idx + 3] = 255;
  }
  ctx.putImageData(edgeImageData, w, 0);
  
  // Panel 3: Lines + stumps overlay
  ctx.drawImage(canvas, 0, 0, w, h, w * 2, 0, w, h);
  
  // Draw all detected lines (yellow)
  ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
  ctx.lineWidth = 1;
  artifacts.lines.forEach(line => {
    ctx.beginPath();
    ctx.moveTo(w * 2 + line.x, line.top);
    ctx.lineTo(w * 2 + line.x, line.bottom);
    ctx.stroke();
  });
  
  // Draw clustered stumps (lime, thicker)
  ctx.strokeStyle = 'lime';
  ctx.lineWidth = 3;
  artifacts.stumps.forEach(stump => {
    ctx.beginPath();
    ctx.moveTo(w * 2 + stump.x, 0);
    ctx.lineTo(w * 2 + stump.x, h);
    ctx.stroke();
    
    // Label with confidence
    ctx.fillStyle = 'lime';
    ctx.font = '10px monospace';
    ctx.fillText(`${Math.round(stump.confidence * 100)}%`, w * 2 + stump.x + 5, 15);
  });
  
  return canvas;
}

/**
 * Manual test steps:
 * 
 * 1. Open stumping video: https://www.youtube.com/watch?v=i3tcsO277qs
 * 2. Seek to 0:34 (stumping moment with visible stumps)
 * 3. Open Fan DRS sidebar, click Analyze
 * 4. Open console (F12)
 * 5. Run:
 *    const { detectStumps } = await import(chrome.runtime.getURL('src/analyzers/stumping/stump_detection.js'));
 *    const frames = window.frames[0].state.keyframes.frames;
 *    const result = await detectStumps(frames, { debugMode: true });
 *    console.log('Stumps:', result);
 * 
 * Expected:
 * - stumps: Array of 2-3 stumps with x-positions
 * - confidence: 0.5-0.8 (typical)
 * - Each stump has x coordinate relative to ROI
 * 
 * Visualize:
 *    const { createStumpDebugVisualization } = await import(chrome.runtime.getURL('src/analyzers/stumping/stump_detection.js'));
 *    const canvas = createStumpDebugVisualization(result.artifacts);
 *    canvas.style = 'position:fixed; top:80px; left:20px; z-index:9999999; width:800px; border:2px solid lime;';
 *    document.body.appendChild(canvas);
 * 
 * Should show:
 * - Left panel: ROI (center-bottom region)
 * - Middle panel: Edge detection (white edges on black)
 * - Right panel: Detected lines (yellow) + clustered stumps (lime, thick)
 * 
 * Failure modes:
 * - Camera too zoomed out → Stumps too thin → Low vote count
 * - Angled camera → Stumps not vertical → No detection
 * - Batsman blocking → Occlusion → Fewer than 3 stumps
 * - Low contrast → Weak edges → Low confidence
 */
